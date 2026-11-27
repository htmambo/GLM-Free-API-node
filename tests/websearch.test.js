// Port of internal/zbridge/websearch_test.go + tests/websearch_e2e_test.go —
// the WebSearch / Advanced Search (MCP) request contract (issue #42), plus
// the signed query params and Origin/Referer headers sent upstream.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { config, setBaseURL } from '../src/config.js';
import { seedCaptchaParam, setCaptchaParamOverrideForTests } from '../src/captcha.js';
import { createHandler } from '../src/server.js';
import { overrideSessionState, flushModelsCache } from '../src/handlers.js';

const authHeaders = { Authorization: 'Bearer ' + config.auth.token };

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

// Captures the completion request and answers with a minimal SSE stream.
async function startCapture() {
    const seen = [];
    const server = http.createServer((req, res) => {
        let buf = '';
        req.on('data', (c) => { buf += c; });
        req.on('end', () => {
            seen.push({ url: req.url, headers: req.headers, body: buf ? JSON.parse(buf) : null });
            if (req.url.startsWith('/api/v2/chat/completions')) {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                res.write('data: {"data":{"delta_content":"ok"}}\n\n');
                res.write('data: {"data":{"phase":"done"}}\n\n');
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            if (req.url === '/api/models') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end('{}');
                return;
            }
            res.writeHead(404).end('not found');
        });
    });
    const url = await listen(server);
    return { seen, server, url };
}

function pointAt(upstreamURL, agentMode) {
    setBaseURL(upstreamURL);
    const restoreSession = overrideSessionState('test-token', 'test-user', true);
    const oldAgentMode = config.agentMode;
    config.agentMode = agentMode;
    seedCaptchaParam('test-captcha-param');
    const restoreCaptcha = setCaptchaParamOverrideForTests('test-captcha-param');
    flushModelsCache();
    return () => {
        restoreCaptcha();
        config.agentMode = oldAgentMode;
        restoreSession();
        setBaseURL('https://chat.z.ai');
        flushModelsCache();
    };
}

function postChat(bridgeURL, body) {
    return fetch(bridgeURL + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ model: 'glm-4.7', stream: false, messages: [{ role: 'user', content: 'hi' }], ...body }),
    });
}

async function withBridge(fn) {
    const upstream = await startCapture();
    const bridgeServer = http.createServer(createHandler());
    const bridgeURL = await listen(bridgeServer);
    try {
        await fn({ upstream, bridgeURL });
    } finally {
        await new Promise((r) => bridgeServer.close(r));
        await new Promise((r) => upstream.server.close(r));
    }
}

function lastCompletion(seen) {
    const reqs = seen.filter((s) => s.url.startsWith('/api/v2/chat/completions'));
    assert.ok(reqs.length > 0, 'no completion request reached upstream');
    return reqs[reqs.length - 1];
}

test('webSearch enables auto_web_search; web_search stays false (issue #42)', async (t) => {
    await withBridge(async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url, false);
        t.after(restore);

        const resp = await postChat(bridgeURL, { webSearch: true });
        assert.equal(resp.status, 200);
        await resp.text();

        const req = lastCompletion(upstream.seen);
        assert.equal(req.body.features.auto_web_search, true);
        assert.equal(req.body.features.web_search, false);
        assert.equal(req.body.mcp_servers, undefined);
    });
});

test('search is an accepted alias for webSearch', async (t) => {
    await withBridge(async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url, false);
        t.after(restore);
        const resp = await postChat(bridgeURL, { search: true });
        assert.equal(resp.status, 200);
        await resp.text();
        assert.equal(lastCompletion(upstream.seen).body.features.auto_web_search, true);
    });
});

test('advancedSearch adds mcp_servers and implies web search', async (t) => {
    await withBridge(async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url, false);
        t.after(restore);
        const resp = await postChat(bridgeURL, { advancedSearch: true });
        assert.equal(resp.status, 200);
        await resp.text();

        const req = lastCompletion(upstream.seen);
        assert.deepEqual(req.body.mcp_servers, ['advanced-search']);
        assert.equal(req.body.features.auto_web_search, true);
        assert.equal(req.body.features.web_search, false);
    });
});

test('agent mode force-disables both search toggles', async (t) => {
    await withBridge(async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url, true);
        t.after(restore);
        const resp = await postChat(bridgeURL, { webSearch: true, advancedSearch: true });
        assert.equal(resp.status, 200);
        await resp.text();

        const req = lastCompletion(upstream.seen);
        assert.equal(req.body.mcp_servers, undefined);
        assert.equal(req.body.features.auto_web_search, undefined);
        assert.equal(req.body.features.web_search, false);
    });
});

test('signed query params ride the URL; Origin/Referer are sent', async (t) => {
    await withBridge(async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url, false);
        t.after(restore);
        await (await postChat(bridgeURL, {})).text();

        const req = lastCompletion(upstream.seen);
        const q = new URL(req.url, 'http://x').searchParams;
        for (const key of [
            'timestamp', 'requestId', 'user_id', 'version', 'platform', 'token',
            'user_agent', 'language', 'screen_resolution', 'viewport_size',
            'timezone', 'timezone_offset', 'signature_timestamp',
        ]) {
            assert.ok(q.get(key) !== null, `signed query param ${key} missing`);
        }
        assert.ok(req.headers['x-signature']);
        assert.ok(req.headers.origin);
        assert.ok(req.headers.referer);
    });
});

test('/v1/messages accepts the same search toggles', async (t) => {
    await withBridge(async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url, false);
        t.after(restore);

        const resp = await fetch(bridgeURL + '/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': config.auth.token },
            body: JSON.stringify({
                model: 'glm-4.7',
                max_tokens: 16,
                stream: false,
                advancedSearch: true,
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        assert.equal(resp.status, 200);
        await resp.text();

        const req = lastCompletion(upstream.seen);
        assert.deepEqual(req.body.mcp_servers, ['advanced-search']);
        assert.equal(req.body.features.auto_web_search, true);
    });
});

test('every upstream message carries an id (mainland MISSING_MESSAGE_ID)', async (t) => {
    await withBridge(async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url, false);
        t.after(restore);

        const resp = await postChat(bridgeURL, {
            messages: [
                { role: 'system', content: 'be brief' },
                { role: 'user', content: 'hi', id: 'client-supplied-id' },
            ],
        });
        assert.equal(resp.status, 200);
        await resp.text();

        const req = lastCompletion(upstream.seen);
        assert.equal(req.body.messages.length, 2);
        for (const m of req.body.messages) {
            assert.equal(typeof m.id, 'string', `message without id: ${JSON.stringify(m)}`);
            assert.ok(m.id !== '', 'message id must not be empty');
        }
        assert.equal(req.body.messages[1].id, 'client-supplied-id', 'client ids must not be overwritten');
        assert.notEqual(req.body.messages[0].id, req.body.messages[1].id, 'ids must be unique per message');
        // The mainland deployment reads the current message id from the top level.
        assert.equal(req.body.id, 'client-supplied-id', 'top-level id must be the last user message id');
    });
});
