// Blackbox end-to-end tests driving the REAL HTTP stack (ported from
// GLM-Free-API/tests/: integration_test.go, session_pool_test.go,
// toolcall_stream_test.go, vision_test.go):
//
//   createHandler() -> cors/auth middleware -> route handler -> sendToZAI ->
//   streamSSEResponse -> OpenAI/Anthropic SSE on the wire.
//
// Only the Z.AI upstream is mocked (a node:http server); BASE_URL points at
// it via setBaseURL, guest auth is skipped via overrideSessionState, and the
// captcha machinery is bypassed by seeding the agent-mode cache
// (seedCaptchaParam) — the same seams the Go tests use (testhooks.go).
//
// These tests share process-global state (BASE_URL, session, config), so
// they run sequentially within this file.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { config, setBaseURL } from '../src/config.js';
import { seedCaptchaParam } from '../src/captcha.js';
import {
    SessionPool,
    newZAIChatBackend,
    attachSessionPool,
} from '../src/sessionPool.js';
import { createHandler } from '../src/server.js';
import { overrideSessionState, flushModelsCache } from '../src/handlers.js';

// ============================================================================
// HELPERS
// ============================================================================

const tinyPNGBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const tinyPNG = Buffer.from(tinyPNGBase64, 'base64');

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

// startMockUpstream starts a mock chat.z.ai on a random port.
async function startMockUpstream(handlerFn) {
    const server = http.createServer(handlerFn);
    const url = await listen(server);
    return { server, url, close: () => new Promise((r) => server.close(r)) };
}

// startBridge starts the real bridge handler on a random port.
async function startBridge() {
    const server = http.createServer(createHandler());
    const url = await listen(server);
    return { server, url, close: () => new Promise((r) => server.close(r)) };
}

// pointBridgeAt mocks the whole "live Z.AI" environment: BASE_URL, a
// pre-authenticated session, the agent-mode captcha cache, and a fresh model
// cache. Returns a restore function.
function pointBridgeAt(upstreamURL, { agentMode = true } = {}) {
    setBaseURL(upstreamURL);
    const restoreSession = overrideSessionState('test-token', 'test-user', true);
    const oldAgentMode = config.agentMode;
    config.agentMode = agentMode;
    if (agentMode) seedCaptchaParam('test-captcha-param');
    flushModelsCache();
    return () => {
        config.agentMode = oldAgentMode;
        restoreSession();
        setBaseURL('https://chat.z.ai');
    };
}

// waitFor polls cond until it holds or the timeout elapses.
async function waitFor(what, timeoutMs, cond) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.fail(`timed out waiting for ${what}`);
}

const authHeaders = { Authorization: 'Bearer ' + config.auth.token };

function postChat(bridgeURL, body, headers = {}) {
    return fetch(bridgeURL + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders, ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

// sseChatBody posts a streaming chat request and returns the raw SSE text.
async function sseChatBody(bridgeURL, body) {
    const resp = await postChat(bridgeURL, body);
    if (resp.status !== 200) assert.fail(`status ${resp.status}: ${await resp.text()}`);
    assert.match(resp.headers.get('content-type') ?? '', /^text\/event-stream/);
    return resp.text();
}

// parseOpenAISSE splits raw OpenAI SSE text into data payloads.
function parseOpenAISSE(text) {
    const out = [];
    for (const line of text.split('\n')) {
        const t = line.trim();
        if (t.startsWith('data: ')) out.push(t.slice(6));
    }
    return out;
}

// The "write an SSE event" helper for mock upstreams.
function sseWrite(res, payload) {
    res.write(`data: ${payload}\n\n`);
    res.flush?.();
}

// completionMock replies to /api/v2/chat/completions by streaming `events`
// (raw JSON payloads) followed by [DONE].
function completionMockHandler(events, extra) {
    return (req, res) => {
        if (new URL(req.url, 'http://x').pathname === '/api/v2/chat/completions' && req.method === 'POST') {
            if (extra?.onCompletion) {
                let buf = '';
                req.on('data', (c) => { buf += c; });
                req.on('end', () => extra.onCompletion(buf));
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            for (const e of events) sseWrite(res, e);
            sseWrite(res, '[DONE]');
            res.end();
            return;
        }
        if (extra?.handler) return extra.handler(req, res);
        res.writeHead(404);
        res.end('404 page not found\n');
    };
}

// ============================================================================
// AUTH / CORS / SIMPLE ENDPOINTS
// ============================================================================

test('auth: rejects missing and invalid tokens, accepts Bearer and x-api-key', async () => {
    const bridge = await startBridge();
    try {
        const noAuth = await postChat(bridge.url, { messages: [{ role: 'user', content: 'hi' }] },
            { Authorization: '' });
        assert.equal(noAuth.status, 401);
        const noAuthBody = await noAuth.json();
        assert.equal(noAuthBody.type, 'error');
        assert.equal(noAuthBody.error.type, 'authentication_error');

        const badAuth = await fetch(bridge.url + '/v1/models', {
            headers: { Authorization: 'Bearer wrong' },
        });
        assert.equal(badAuth.status, 401);

        const okAuth = await fetch(bridge.url + '/v1/models', { headers: authHeaders });
        assert.equal(okAuth.status, 200);
        await okAuth.text();

        const apiKeyAuth = await fetch(bridge.url + '/v1/models', {
            headers: { 'x-api-key': config.auth.token },
        });
        assert.equal(apiKeyAuth.status, 200);
        await apiKeyAuth.text();
    } finally {
        await bridge.close();
    }
});

test('CORS: preflight answers 200 with allow headers; headers ride normal responses', async () => {
    const bridge = await startBridge();
    try {
        const preflight = await fetch(bridge.url + '/v1/chat/completions', { method: 'OPTIONS' });
        assert.equal(preflight.status, 200);
        assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
        assert.equal(
            preflight.headers.get('access-control-allow-methods'), 'GET, POST, DELETE, OPTIONS');
        assert.equal(
            preflight.headers.get('access-control-allow-headers'),
            'Content-Type, Authorization, Include-All-Features, x-api-key, anthropic-version');
        await preflight.text();

        const health = await fetch(bridge.url + '/health');
        assert.equal(health.headers.get('access-control-allow-origin'), '*');
        await health.text();
    } finally {
        await bridge.close();
    }
});

test('/health, / dashboard redirect, unknown path 404, method not allowed', async () => {
    const bridge = await startBridge();
    try {
        // Uninitialized session -> 503.
        const unhealthy = await fetch(bridge.url + '/health');
        assert.equal(unhealthy.status, 503);
        assert.deepEqual(await unhealthy.json(), { healthy: false, mode: 'direct', tokenCount: -1 });

        const restore = overrideSessionState('test-token', 'test-user', true);
        const healthy = await fetch(bridge.url + '/health');
        assert.equal(healthy.status, 200);
        assert.deepEqual(await healthy.json(), { healthy: true, mode: 'direct', tokenCount: -1 });
        restore();

        const root = await fetch(bridge.url + '/', { redirect: 'manual' });
        assert.equal(root.status, 302);
        assert.equal(root.headers.get('location'), '/health');
        await root.text();

        const missing = await fetch(bridge.url + '/nope');
        assert.equal(missing.status, 404);
        await missing.text();

        const wrongMethod = await fetch(bridge.url + '/v1/chat/completions', { headers: authHeaders });
        assert.equal(wrongMethod.status, 405);
        await wrongMethod.text();

        const badJSON = await fetch(bridge.url + '/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders },
            body: '{not json',
        });
        assert.equal(badJSON.status, 400);
        await badJSON.text();

        const noMessages = await postChat(bridge.url, { model: 'glm-4.7' });
        assert.equal(noMessages.status, 400);
        await noMessages.text();
    } finally {
        await bridge.close();
    }
});

// ============================================================================
// /v1/models
// ============================================================================

// Mock /api/models payload: a vision model, a text-only model, and a model
// older than the glm-4.7 cutoff (verbatim from Go vision_test.go).
const modelsPayload = JSON.stringify({
    data: [
        {
            id: 'glm-5v-turbo', name: 'GLM-5V-Turbo', created: 1774521032,
            info: {
                name: 'GLM-5V-Turbo', params: { max_tokens: 128000 },
                meta: {
                    description: 'Vision model with evolved intelligence',
                    capabilities: { vision: true, think: true },
                },
            },
        },
        {
            id: 'glm-4.7', name: 'GLM-4.7', created: 1700000000,
            info: {
                name: 'GLM-4.7', params: {},
                meta: { description: 'Classic high-performance model', capabilities: { vision: false } },
            },
        },
        {
            id: 'glm-4.6-legacy', name: 'GLM-4.6', created: 1690000000,
            info: { name: 'GLM-4.6', params: {}, meta: { description: 'Older model', capabilities: {} } },
        },
    ],
});

test('/v1/models: capped at glm-4.7, architecture object, plus /models simple list', async () => {
    const upstream = await startMockUpstream((req, res) => {
        if (req.url === '/api/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(modelsPayload);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    const bridge = await startBridge();
    const restore = pointBridgeAt(upstream.url, { agentMode: false });
    try {
        const resp = await fetch(bridge.url + '/v1/models', { headers: authHeaders });
        assert.equal(resp.status, 200);
        const body = await resp.json();
        assert.equal(body.object, 'list');

        const byID = new Map(body.data.map((m) => [m.id, m]));
        // newest..glm-4.7 inclusive; glm-4.6-legacy cut off.
        assert.equal(body.data.length, 2);
        assert.ok(byID.has('glm-5v-turbo'));
        assert.ok(byID.has('glm-4.7'));
        assert.ok(!byID.has('glm-4.6-legacy'));

        const v = byID.get('glm-5v-turbo');
        assert.equal(v.architecture.modality, 'text+image->text');
        assert.deepEqual(v.architecture.input_modalities, ['text', 'image']);
        assert.deepEqual(v.architecture.output_modalities, ['text']);
        assert.equal(v.created, 1774521032);
        assert.equal(v.description, 'Vision model with evolved intelligence');

        const tx = byID.get('glm-4.7');
        assert.equal(tx.architecture.modality, 'text->text');
        assert.deepEqual(tx.architecture.input_modalities, ['text']);

        const simple = await fetch(bridge.url + '/models', { headers: authHeaders });
        assert.equal(simple.status, 200);
        const simpleBody = await simple.json();
        assert.deepEqual(simpleBody.models, ['glm-5v-turbo', 'glm-4.7']);
        assert.equal(simpleBody.currentModel, 'glm-5v-turbo');
    } finally {
        restore();
        await bridge.close();
        await upstream.close();
    }
});

test('/v1/models: falls back to the built-in list when the upstream is unreachable', async () => {
    // Grab a port and immediately release it so nothing is listening.
    const dead = http.createServer();
    const deadURL = await listen(dead);
    await new Promise((r) => dead.close(r));

    const bridge = await startBridge();
    const restore = pointBridgeAt(deadURL, { agentMode: false });
    try {
        const resp = await fetch(bridge.url + '/v1/models', { headers: authHeaders });
        assert.equal(resp.status, 200);
        const body = await resp.json();
        const ids = body.data.map((m) => m.id);
        assert.ok(ids.includes('glm-5.2'));
        assert.ok(ids.includes('glm-4.7'));
    } finally {
        restore();
        await bridge.close();
    }
});

// ============================================================================
// /v1/chat/completions
// ============================================================================

test('chat completions: non-stream response', async () => {
    const upstream = await startMockUpstream(completionMockHandler([
        '{"data":{"delta_content":"Hello "}}',
        '{"data":{"delta_content":"world"}}',
        '{"data":{"phase":"done"}}',
    ]));
    const bridge = await startBridge();
    const restore = pointBridgeAt(upstream.url);
    try {
        const resp = await postChat(bridge.url, {
            model: 'glm-4.7', stream: false,
            messages: [{ role: 'user', content: 'hi' }],
        });
        assert.equal(resp.status, 200);
        const body = await resp.json();
        assert.equal(body.object, 'chat.completion');
        assert.equal(body.choices[0].message.role, 'assistant');
        assert.equal(body.choices[0].message.content, 'Hello world');
        assert.equal(body.choices[0].finish_reason, 'stop');
        assert.ok(body.usage.total_tokens >= 0);
    } finally {
        restore();
        await bridge.close();
        await upstream.close();
    }
});

test('chat completions: stream assembles deltas, ends with stop + [DONE]', async () => {
    const upstream = await startMockUpstream(completionMockHandler([
        '{"data":{"delta_content":"Hello "}}',
        '{"data":{"delta_content":"streamed "}}',
        '{"data":{"delta_content":"world"}}',
        '{"data":{"phase":"done"}}',
    ]));
    const bridge = await startBridge();
    const restore = pointBridgeAt(upstream.url);
    try {
        const text = await sseChatBody(bridge.url, {
            model: 'glm-4.7', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
        });
        const chunks = parseOpenAISSE(text);
        assert.equal(chunks[chunks.length - 1], '[DONE]');

        let clientText = '';
        let finishReason = null;
        for (const data of chunks) {
            if (data === '[DONE]') continue;
            const chunk = JSON.parse(data);
            assert.equal(chunk.object, 'chat.completion.chunk');
            const choice = chunk.choices[0];
            if (choice.delta.content) clientText += choice.delta.content;
            if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        assert.equal(clientText, 'Hello streamed world');
        assert.equal(finishReason, 'stop');
    } finally {
        restore();
        await bridge.close();
        await upstream.close();
    }
});

// Port of TestHTTPEndToEndGarbleFix (integration_test.go, issue #23):
// multibyte text, a <details> reasoning tag streamed character by character,
// and an edit_content tail revision — through the full HTTP stack.
test('chat completions: end-to-end garble fix (multibyte + details tag + edit_content)', async () => {
    const longPrefix = '长'.repeat(30);
    const upstream = await startMockUpstream(completionMockHandler([
        JSON.stringify({ data: { delta_content: longPrefix } }),
        '{"data":{"delta_content":"<det"}}',
        '{"data":{"delta_content":"ails>让我想想。</details>"}}',
        '{"data":{"delta_content":"答案是："}}',
        '{"data":{"delta_content":"42。"}}',
        // Tail revision: replace "42。". edit_index counts the RAW accumulated
        // text, which INCLUDES the <details> block:
        //   30 (长×30) + 9 (<details>) + 5 (让我想想。) + 10 (</details>)
        //   + 4 (答案是：) = 58
        '{"data":{"edit_content":"四十二！","edit_index":58}}',
        '{"data":{"delta_content":" 🙂"}}',
        '{"data":{"phase":"done"}}',
    ]));
    const bridge = await startBridge();
    const oldHoldback = config.streamHoldback;
    config.streamHoldback = 24;
    const restore = pointBridgeAt(upstream.url);
    try {
        const text = await sseChatBody(bridge.url, {
            model: 'glm-4.7', stream: true,
            messages: [{ role: 'user', content: 'hi' }],
        });

        let clientText = '';
        let reasoning = '';
        let contentChunks = 0;
        for (const data of parseOpenAISSE(text)) {
            if (data === '[DONE]') continue;
            const chunk = JSON.parse(data);
            assert.ok(!chunk.error, `client received error chunk: ${chunk.error?.message}`);
            for (const ch of chunk.choices ?? []) {
                if (ch.delta?.content) {
                    clientText += ch.delta.content;
                    contentChunks++;
                }
                if (ch.delta?.reasoning_content) reasoning += ch.delta.reasoning_content;
            }
        }

        assert.ok(!clientText.includes('<det'), `details fragment leaked: ${JSON.stringify(clientText)}`);
        assert.ok(contentChunks >= 2, `expected multiple chunks, got ${contentChunks}`);
        assert.equal(clientText, longPrefix + '答案是：四十二！ 🙂');
        assert.equal(reasoning, '让我想想。');
    } finally {
        config.streamHoldback = oldHoldback;
        restore();
        await bridge.close();
        await upstream.close();
        // Let the fire-and-forget session GC hit the mock before teardown.
        await new Promise((r) => setTimeout(r, 50));
    }
});

// ============================================================================
// STREAMED TOOL CALLS (toolcall_stream_test.go)
// ============================================================================

const calculateTools = [{
    type: 'function',
    function: {
        name: 'calculate',
        description: 'Perform arithmetic',
        parameters: {
            type: 'object',
            properties: {
                operation: { type: 'string', enum: ['add', 'subtract', 'multiply', 'divide'] },
                a: { type: 'number' },
                b: { type: 'number' },
            },
            required: ['operation', 'a', 'b'],
        },
    },
}];

// mockToolCallUpstream streams `text` as delta_content events split into
// `every`-byte pieces (worst-case chunking), like the Go helper.
async function toolCallUpstream(text, every) {
    return startMockUpstream((req, res) => {
        if (new URL(req.url, 'http://x').pathname !== '/api/v2/chat/completions') {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        for (let i = 0; i < text.length; i += every) {
            sseWrite(res, JSON.stringify({ data: { delta_content: text.slice(i, i + every) } }));
        }
        sseWrite(res, '{"data":{"phase":"done"}}');
        sseWrite(res, '[DONE]');
        res.end();
    });
}

function collectToolCallStream(chunks) {
    const acc = {
        sawDone: false, toolChunksTotal: 0, argsByIndex: new Map(),
        names: new Map(), ids: new Map(), finishReason: null, contentLeak: '',
    };
    for (const data of chunks) {
        if (data === '[DONE]') { acc.sawDone = true; continue; }
        const chunk = JSON.parse(data);
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        for (const tc of choice.delta?.tool_calls ?? []) {
            acc.toolChunksTotal++;
            const idx = tc.index ?? 0;
            if (tc.id) {
                acc.ids.set(idx, tc.id);
                acc.names.set(idx, tc.function?.name);
            }
            const frag = tc.function?.arguments;
            if (frag) acc.argsByIndex.set(idx, (acc.argsByIndex.get(idx) ?? '') + frag);
        }
        if (!choice.delta?.tool_calls && typeof choice.delta?.content === 'string') {
            acc.contentLeak += choice.delta.content;
        }
        if (choice.finish_reason) acc.finishReason = choice.finish_reason;
    }
    return acc;
}

test('chat completions: streamed tool calls surface incrementally (worst-case chunking)', async () => {
    const upstreamText = '<<<TOOL_CALL>>>\n' +
        '{"name":"calculate","arguments": {"operation": "multiply", "a": 234, "b": 567}}' +
        '\n<<<END_TOOL_CALL>>>';

    for (const every of [1, 40]) {
        const upstream = await toolCallUpstream(upstreamText, every);
        const bridge = await startBridge();
        const restore = pointBridgeAt(upstream.url);
        try {
            const text = await sseChatBody(bridge.url, {
                model: 'glm-4.7', stream: true, tool_choice: 'auto',
                messages: [{ role: 'user', content: 'What is 234 * 567? Calculate this using arithmetic.' }],
                tools: calculateTools,
            });
            const acc = collectToolCallStream(parseOpenAISSE(text));

            assert.ok(acc.toolChunksTotal >= 2,
                `every=${every}: only ${acc.toolChunksTotal} tool_calls chunks — buffered behaviour regressed`);
            assert.equal(acc.names.get(0), 'calculate', `every=${every}`);
            assert.ok(acc.ids.get(0)?.startsWith('call_'), `every=${every}: id ${acc.ids.get(0)}`);
            assert.equal(acc.argsByIndex.get(0),
                '{"operation": "multiply", "a": 234, "b": 567}', `every=${every}`);
            assert.ok(!acc.contentLeak.includes('TOOL_CALL') && !acc.contentLeak.includes('calculate'),
                `every=${every}: block leaked as content: ${JSON.stringify(acc.contentLeak)}`);
            assert.equal(acc.finishReason, 'tool_calls', `every=${every}`);
            assert.ok(acc.sawDone, `every=${every}: missing [DONE]`);
        } finally {
            restore();
            await bridge.close();
            await upstream.close();
            await new Promise((r) => setTimeout(r, 50));
        }
    }
});

// Port of TestHTTPEndToEndStreamedToolCallsLiveTiming: the upstream stalls
// mid-tool-call-block; tool_calls chunks must reach the client BEFORE the
// closing marker is ever sent.
test('chat completions: tool_calls chunks flow while the upstream is stalled mid-block', async () => {
    const part1 = '<<<TOOL_CALL>>>\n' + '{"name":"calculate","arguments": {"a": 234,';
    const part2 = ' "b": 567, "operation": "multiply"}}' + '\n<<<END_TOOL_CALL>>>';

    let release;
    const released = new Promise((r) => { release = r; });
    const upstream = await startMockUpstream((req, res) => {
        if (new URL(req.url, 'http://x').pathname !== '/api/v2/chat/completions') {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        sseWrite(res, JSON.stringify({ data: { delta_content: part1 } }));
        released.then(() => {
            sseWrite(res, JSON.stringify({ data: { delta_content: part2 } }));
            sseWrite(res, '{"data":{"phase":"done"}}');
            sseWrite(res, '[DONE]');
            res.end();
        });
    });
    const bridge = await startBridge();
    const oldHoldback = config.streamHoldback;
    config.streamHoldback = 0; // emit upstream bytes immediately: exact timing
    const restore = pointBridgeAt(upstream.url);
    try {
        const resp = await postChat(bridge.url, {
            model: 'glm-4.7', stream: true,
            messages: [{ role: 'user', content: 'What is 234 * 567?' }],
            tools: calculateTools,
        });
        assert.equal(resp.status, 200);

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        const chunks = [];
        // Read until a tool_calls delta arrives while the upstream is stalled.
        const deadline = Date.now() + 5000;
        let sawMidBlockToolCall = false;
        while (!sawMidBlockToolCall && Date.now() < deadline) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                chunks.push(data);
                if (data.includes('"tool_calls":[')) sawMidBlockToolCall = true;
            }
        }
        assert.ok(sawMidBlockToolCall,
            'no tool_calls chunk while the block was still open (upstream stalled before <<<END_TOOL_CALL>>>)');
        release();

        // Drain the rest and assert the full contract.
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx).trim();
                buf = buf.slice(idx + 1);
                if (line.startsWith('data: ')) chunks.push(line.slice(6));
            }
        }

        const acc = collectToolCallStream(chunks);
        assert.equal(acc.names.get(0), 'calculate');
        assert.equal(acc.argsByIndex.get(0), '{"a": 234, "b": 567, "operation": "multiply"}');
        assert.equal(acc.finishReason, 'tool_calls');
        assert.ok(acc.sawDone);
        assert.ok(!acc.contentLeak.includes('TOOL_CALL') && !acc.contentLeak.includes('calculate'),
            `block leaked as content: ${JSON.stringify(acc.contentLeak)}`);
    } finally {
        release();
        config.streamHoldback = oldHoldback;
        restore();
        await bridge.close();
        await upstream.close();
        await new Promise((r) => setTimeout(r, 50));
    }
});

// ============================================================================
// ANTHROPIC /v1/messages
// ============================================================================

test('/v1/messages: streaming event sequence and assembled text', async () => {
    const upstream = await startMockUpstream(completionMockHandler([
        '{"data":{"delta_content":"<details>思考过程</details>"}}',
        '{"data":{"delta_content":"Hello "}}',
        '{"data":{"delta_content":"from Anthropic"}}',
        '{"data":{"phase":"done"}}',
    ]));
    const bridge = await startBridge();
    const restore = pointBridgeAt(upstream.url);
    try {
        const resp = await fetch(bridge.url + '/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.auth.token,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'glm-4.7', stream: true, max_tokens: 100,
                system: 'You are helpful.',
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        assert.equal(resp.status, 200);
        assert.match(resp.headers.get('content-type') ?? '', /^text\/event-stream/);

        const raw = await resp.text();
        const events = [];
        for (const block of raw.split('\n\n')) {
            const lines = block.split('\n').filter((l) => l !== '');
            let type = null, data = null;
            for (const l of lines) {
                if (l.startsWith('event: ')) type = l.slice(7);
                if (l.startsWith('data: ')) data = l.slice(6);
            }
            if (type) events.push({ type, data: data ? JSON.parse(data) : null });
        }

        const types = events.map((e) => e.type);
        assert.equal(types[0], 'message_start');
        assert.ok(types.includes('ping'));
        assert.equal(types[types.length - 1], 'message_stop');
        assert.ok(types.includes('message_delta'));
        assert.equal(
            events.find((e) => e.type === 'message_delta').data.delta.stop_reason, 'end_turn');

        const msgStart = events.find((e) => e.type === 'message_start');
        assert.equal(msgStart.data.message.role, 'assistant');
        assert.equal(msgStart.data.message.model, 'glm-4.7');
        assert.ok(msgStart.data.message.id.startsWith('msg_'));

        let thinking = '';
        let text = '';
        for (const e of events) {
            if (e.type !== 'content_block_delta') continue;
            if (e.data.delta.type === 'thinking_delta') thinking += e.data.delta.thinking;
            if (e.data.delta.type === 'text_delta') text += e.data.delta.text;
        }
        assert.equal(thinking, '思考过程');
        assert.equal(text, 'Hello from Anthropic');
    } finally {
        restore();
        await bridge.close();
        await upstream.close();
        await new Promise((r) => setTimeout(r, 50));
    }
});

test('/v1/messages: non-stream single message object', async () => {
    const upstream = await startMockUpstream(completionMockHandler([
        '{"data":{"delta_content":"plain answer"}}',
        '{"data":{"phase":"done"}}',
    ]));
    const bridge = await startBridge();
    const restore = pointBridgeAt(upstream.url);
    try {
        const resp = await fetch(bridge.url + '/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': config.auth.token },
            body: JSON.stringify({
                model: 'glm-4.7', max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        assert.equal(resp.status, 200);
        const body = await resp.json();
        assert.equal(body.type, 'message');
        assert.equal(body.role, 'assistant');
        assert.deepEqual(body.content, [{ type: 'text', text: 'plain answer' }]);
        assert.equal(body.stop_reason, 'end_turn');
        assert.ok(body.id.startsWith('msg_'));
    } finally {
        restore();
        await bridge.close();
        await upstream.close();
        await new Promise((r) => setTimeout(r, 50));
    }
});

// ============================================================================
// SESSION POOL THROUGH THE HTTP SURFACE (session_pool_test.go)
// ============================================================================

// Port of TestHTTPChatCompletionsUsesPooledSessionThenDeletes: the handler
// draws a pooled chat_id, the completion references it upstream, and after
// the response the used chat is deleted on the mock while the pool refills.
test('chat completions: handler draws a pooled session and deletes it after use', async () => {
    const completionChatIDs = [];
    const deletedChatIDs = [];

    const upstream = await startMockUpstream((req, res) => {
        if (new URL(req.url, 'http://x').pathname === '/api/v2/chat/completions') {
            let buf = '';
            req.on('data', (c) => { buf += c; });
            req.on('end', () => {
                try {
                    completionChatIDs.push(JSON.parse(buf).chat_id ?? '');
                } catch { completionChatIDs.push(''); }
            });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            sseWrite(res, '{"data":{"delta_content":"hello"}}');
            sseWrite(res, '{"data":{"phase":"done"}}');
            sseWrite(res, '[DONE]');
            res.end();
            return;
        }
        if (req.method === 'DELETE' && req.url.startsWith('/api/v1/chats/')) {
            deletedChatIDs.push(req.url.slice('/api/v1/chats/'.length));
            res.writeHead(200);
            res.end('true');
            return;
        }
        res.writeHead(404);
        res.end();
    });
    const bridge = await startBridge();
    const restore = pointBridgeAt(upstream.url);

    // Attach a real pool backed by the production Z.AI backend.
    const pool = new SessionPool(newZAIChatBackend(), 2);
    // Pin throwaway semantics for this test (default reuse is 10).
    pool.setMaxUses(1);
    const restorePool = attachSessionPool(pool, 1000);
    try {
        pool.start();
        await waitFor('warmup to stock 2 sessions', 3000, () => pool.ready() === 2);

        const resp = await postChat(bridge.url, {
            model: 'glm-4.7', stream: false,
            messages: [{ role: 'user', content: 'hi' }],
        });
        if (resp.status !== 200) assert.fail(`status ${resp.status}: ${await resp.text()}`);
        const body = await resp.json();
        assert.ok(body.choices[0].message.content.includes('hello'));

        assert.equal(completionChatIDs.length, 1, 'upstream must see exactly one completion');
        const usedID = completionChatIDs[0];
        assert.notEqual(usedID, '', 'completion went upstream without a chat_id');

        // After the response is fully written, the handler's deferred release
        // must delete the used chat upstream and refill the batch to full.
        await waitFor('used chat deleted upstream + pool refilled', 5000,
            () => deletedChatIDs.length === 1 && deletedChatIDs[0] === usedID && pool.ready() === 2);
    } finally {
        restore();
        await bridge.close();
        await pool.shutdown(); // deletes the 2 leftovers on the mock
        restorePool();
        await upstream.close();
    }
});

// ============================================================================
// VISION (vision_test.go)
// ============================================================================

// visionMock serves /api/models, /img.png, multipart uploads and completions,
// recording what it receives.
function visionMock(downloadBytes, downloadCT) {
    const rec = { uploads: [], uploadCounter: 0, completionsBody: null };
    const handler = (req, res) => {
        if (req.url === '/api/models') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(modelsPayload);
            return;
        }
        if (req.url === '/img.png') {
            res.writeHead(200, { 'Content-Type': downloadCT });
            res.end(downloadBytes);
            return;
        }
        if (req.url === '/api/v1/files/' && req.method === 'POST') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const raw = Buffer.concat(chunks);
                // Hand-rolled multipart from vision.js: one "file" part.
                const headEnd = raw.indexOf('\r\n\r\n');
                const head = raw.subarray(0, headEnd).toString('latin1');
                const tail = raw.lastIndexOf('\r\n--');
                const data = raw.subarray(headEnd + 4, tail);
                const ctMatch = head.match(/Content-Type: ([^\r\n]+)/);
                const nameMatch = head.match(/filename="([^"]*)"/);
                rec.uploadCounter++;
                const id = `file-id-${rec.uploadCounter}`;
                rec.uploads.push({
                    id,
                    filename: nameMatch ? nameMatch[1] : '',
                    contentType: ctMatch ? ctMatch[1] : '',
                    bytes: data,
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id,
                    user_id: 'test-user',
                    hash: null,
                    filename: nameMatch ? nameMatch[1] : '',
                    data: {},
                    meta: {
                        name: nameMatch ? nameMatch[1] : '',
                        content_type: ctMatch ? ctMatch[1] : '',
                        size: data.length,
                        cdn_url: 'https://cdn.example/' + id,
                        data: {},
                        oss_endpoint: 'bj',
                    },
                    created_at: Math.floor(Date.now() / 1000),
                    updated_at: Math.floor(Date.now() / 1000),
                }));
            });
            return;
        }
        if (new URL(req.url, 'http://x').pathname === '/api/v2/chat/completions' && req.method === 'POST') {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => { rec.completionsBody = Buffer.concat(chunks).toString('utf8'); });
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            sseWrite(res, '{"data":{"delta_content":"looks good"}}');
            sseWrite(res, '{"data":{"phase":"done"}}');
            sseWrite(res, '[DONE]');
            res.end();
            return;
        }
        if (req.method === 'DELETE' && req.url.startsWith('/api/v1/chats/')) {
            res.writeHead(200);
            res.end('true');
            return;
        }
        res.writeHead(404);
        res.end();
    };
    return rec && { rec, handler };
}

// Port of TestOpenAIVisionEndToEnd: data: URL + http URL images are uploaded,
// referenced by file id, and never leak into the upstream request body.
test('vision: OpenAI image_url parts end to end (data URL + download)', async () => {
    const downloadPayload = Buffer.from('FAKE-IMAGE-BYTES-FOR-DOWNLOAD-TEST');
    const { rec, handler } = visionMock(downloadPayload, 'image/png');
    const upstream = await startMockUpstream(handler);
    const bridge = await startBridge();
    const restore = pointBridgeAt(upstream.url);
    try {
        const resp = await postChat(bridge.url, {
            model: 'glm-5v-turbo', stream: false,
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: 'describe these' },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,' + tinyPNGBase64 } },
                    { type: 'image_url', image_url: { url: upstream.url + '/img.png' } },
                ],
            }],
        });
        if (resp.status !== 200) assert.fail(`status ${resp.status}: ${await resp.text()}`);

        assert.equal(rec.uploads.length, 2);
        const gotPayloads = new Set(rec.uploads.map((u) => u.bytes.toString('latin1')));
        for (const u of rec.uploads) {
            assert.equal(u.contentType, 'image/png', `upload ${u.id} content-type`);
        }
        assert.ok(gotPayloads.has(tinyPNG.toString('latin1')), 'data: URL bytes not uploaded');
        assert.ok(gotPayloads.has(downloadPayload.toString('latin1')), 'downloaded bytes not uploaded');

        assert.ok(rec.completionsBody, 'upstream completions request not captured');
        assert.ok(!rec.completionsBody.includes('base64,' + tinyPNGBase64),
            'original data: URL payload leaked upstream');
        assert.ok(!rec.completionsBody.includes('/img.png'), 'original download URL leaked upstream');

        const comp = JSON.parse(rec.completionsBody);
        assert.equal(comp.files.length, 2);
        const byID = new Map(rec.uploads.map((u) => [u.id, u]));
        for (const fe of comp.files) {
            assert.ok(fe.id, 'files entry missing id');
            assert.equal(fe.url, '/api/v1/files/' + fe.id);
            assert.equal(fe.type, 'image');
            assert.equal(fe.status, 'uploaded');
            assert.equal(fe.media, 'image');
            assert.ok(fe.name !== '');
            assert.ok(fe.size > 0);
            assert.ok(fe.file && typeof fe.file === 'object');
            assert.ok(byID.has(fe.id), `files id ${fe.id} not an uploaded file`);
            assert.ok(typeof fe.ref_user_msg_id === 'string');
            assert.ok(typeof fe.itemId === 'string');
        }
        // Same source message -> same ref_user_msg_id; distinct itemId per file.
        assert.equal(comp.files[0].ref_user_msg_id, comp.files[1].ref_user_msg_id);
        assert.notEqual(comp.files[0].itemId, comp.files[1].itemId);

        // The agent shim flattens content to plain text; the image refs must
        // be re-attached so the model still receives the pixels.
        const refs = [];
        for (const m of comp.messages) {
            if (!Array.isArray(m.content)) continue;
            for (const p of m.content) {
                if (p?.type === 'image_url' && p.image_url?.url) refs.push(p.image_url.url);
            }
        }
        assert.equal(refs.length, 2, 'upstream messages must reference both uploaded images');
        for (const id of refs) assert.ok(byID.has(id), `image ref ${id} not an uploaded file`);

        const body = await resp.json();
        assert.ok(body.choices[0].message.content.includes('looks good'));
    } finally {
        restore();
        await bridge.close();
        await upstream.close();
        await new Promise((r) => setTimeout(r, 50));
    }
});

// Port of TestAnthropicVisionEndToEnd: a base64 Anthropic image block is
// uploaded and referenced by file id.
test('vision: Anthropic base64 image block end to end', async () => {
    const { rec, handler } = visionMock(Buffer.from('unused'), 'image/png');
    const upstream = await startMockUpstream(handler);
    const bridge = await startBridge();
    const restore = pointBridgeAt(upstream.url);
    try {
        const resp = await fetch(bridge.url + '/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': config.auth.token,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'glm-5v-turbo', stream: false, max_tokens: 100,
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: 'what is in this image' },
                        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: tinyPNGBase64 } },
                    ],
                }],
            }),
        });
        if (resp.status !== 200) assert.fail(`status ${resp.status}: ${await resp.text()}`);

        assert.equal(rec.uploads.length, 1);
        assert.ok(rec.uploads[0].bytes.equals(tinyPNG), 'uploaded bytes mismatch');
        assert.equal(rec.uploads[0].contentType, 'image/png');

        assert.ok(!rec.completionsBody.includes('base64,' + tinyPNGBase64),
            'original base64 payload leaked upstream');
        const comp = JSON.parse(rec.completionsBody);
        assert.equal(comp.files.length, 1);
        assert.equal(comp.files[0].type, 'image');
        assert.ok(comp.files[0].id !== '');
        await resp.text();
    } finally {
        restore();
        await bridge.close();
        await upstream.close();
        await new Promise((r) => setTimeout(r, 50));
    }
});

// Port of TestVisionTooManyImages: >10 images rejected before any upload.
test('vision: more than 10 images is a 400 before any upload', async () => {
    const { rec, handler } = visionMock(Buffer.from('x'), 'image/png');
    const upstream = await startMockUpstream(handler);
    const bridge = await startBridge();
    const restore = pointBridgeAt(upstream.url);
    try {
        const parts = [{ type: 'text', text: 'too many' }];
        for (let i = 0; i < 11; i++) {
            parts.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,' + tinyPNGBase64 } });
        }
        const resp = await postChat(bridge.url, {
            model: 'glm-5v-turbo', stream: false,
            messages: [{ role: 'user', content: parts }],
        });
        assert.equal(resp.status, 400);
        const text = await resp.text();
        assert.ok(text.includes('too many images'), text);
        assert.equal(rec.uploads.length, 0);
    } finally {
        restore();
        await bridge.close();
        await upstream.close();
    }
});
