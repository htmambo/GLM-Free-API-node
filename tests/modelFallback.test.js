// End-to-end tests for the model capacity / tier fallback.
//
// Z.AI can answer a request with "this model is busy" or "this model is not
// available for your user level" while another model in the same catalogue
// serves the account fine. The bridge retries with the next model instead of
// failing outright — and the request that finally succeeds is the one the
// client gets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { config, setBaseURL } from '../src/config.js';
import { seedCaptchaParam, setCaptchaParamOverrideForTests } from '../src/captcha.js';
import { createHandler } from '../src/server.js';
import { overrideSessionState, flushModelsCache } from '../src/handlers.js';
import { setModelsCache } from '../src/state.js';

const authHeaders = { Authorization: 'Bearer ' + config.auth.token };

const CATALOGUE = [
    { id: 'glm-5.4', name: 'GLM-5.4' },
    { id: 'x-preview-l', name: 'GLM-5.3-Flash' },
    { id: 'glm-5.3', name: 'GLM-5.3' },
    { id: 'glm-5.2', name: 'GLM-5.2' },
];

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

// An upstream that answers a completion with an inline SSE error for the
// models named in `failing`, and with content for the others.
async function startCapture(failing = {}) {
    const seen = [];
    const server = http.createServer((req, res) => {
        let buf = '';
        req.on('data', (c) => { buf += c; });
        req.on('end', () => {
            const body = buf ? JSON.parse(buf) : null;
            seen.push({ url: req.url, headers: req.headers, body });
            if (req.url.startsWith('/api/v2/chat/completions')) {
                const failure = failing[body?.model];
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                if (failure !== undefined) {
                    res.write(`data: ${JSON.stringify(failure)}\n\n`);
                    res.write('data: {"data":{"phase":"done"}}\n\n');
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }
                res.write('data: {"data":{"delta_content":"ok"}}\n\n');
                res.write('data: {"data":{"phase":"done"}}\n\n');
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            if (req.url === '/api/models') {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ data: CATALOGUE }));
                return;
            }
            res.writeHead(404).end('not found');
        });
    });
    const url = await listen(server);
    return { seen, server, url };
}

function pointAt(upstreamURL) {
    setBaseURL(upstreamURL);
    const restoreSession = overrideSessionState('test-token', 'test-user', true);
    seedCaptchaParam('test-captcha-param');
    const restoreCaptcha = setCaptchaParamOverrideForTests('test-captcha-param');
    flushModelsCache();
    setModelsCache(CATALOGUE);
    return () => {
        restoreCaptcha();
        restoreSession();
        setBaseURL('https://chat.z.ai');
        flushModelsCache();
    };
}

async function withBridge(failing, fn) {
    const upstream = await startCapture(failing);
    const bridgeServer = http.createServer(createHandler());
    const bridgeURL = await listen(bridgeServer);
    try {
        await fn({ upstream, bridgeURL });
    } finally {
        await new Promise((r) => bridgeServer.close(r));
        await new Promise((r) => upstream.server.close(r));
    }
}

function postChat(bridgeURL, body) {
    return fetch(bridgeURL + '/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ model: 'glm-5.4', stream: false, messages: [{ role: 'user', content: 'hi' }], ...body }),
    });
}

function completions(seen) {
    return seen.filter((s) => s.url.startsWith('/api/v2/chat/completions'));
}

const CAPACITY = {
    type: 'chat:completion',
    data: {
        data: {
            done: true,
            error: { code: 'MODEL_CONCURRENCY_LIMIT', detail: 'Model is currently at capacity.' },
        },
        error: { code: 'MODEL_CONCURRENCY_LIMIT', detail: 'Model is currently at capacity.' },
    },
};

const TIER_LOCKED = {
    type: 'chat:completion',
    data: {
        data: {
            done: true,
            error: { code: '403', detail: 'Model not available for current user level' },
        },
        error: { code: '403', detail: 'Model not available for current user level' },
    },
};

test('a model at capacity is retried with another model', async (t) => {
    await withBridge({ 'glm-5.4': CAPACITY }, async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url);
        t.after(restore);

        const resp = await postChat(bridgeURL, {});
        assert.equal(resp.status, 200);
        const payload = await resp.json();
        assert.equal(payload.choices[0].message.content, 'ok');

        const reqs = completions(upstream.seen);
        assert.ok(reqs.length >= 2, 'the request must be retried with another model');
        assert.equal(reqs[0].body.model, 'glm-5.4');
        // The Flash model is the one every account tier can reach, so it is
        // tried first.
        assert.equal(reqs[1].body.model, 'x-preview-l');
    });
});

test('every model in the catalogue is tried before giving up', async (t) => {
    const allFail = {
        'glm-5.4': CAPACITY,
        'x-preview-l': CAPACITY,
        'glm-5.3': CAPACITY,
        'glm-5.2': CAPACITY,
    };
    await withBridge(allFail, async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url);
        t.after(restore);

        const resp = await postChat(bridgeURL, {});
        assert.equal(resp.status, 503);
        const payload = await resp.json();
        assert.match(payload.error.message, /capacity|capacity/i);

        const reqs = completions(upstream.seen);
        // Every model must have been attempted — no model is left untried
        // just because an earlier one was tier-locked.
        const models = reqs.map((r) => r.body.model);
        assert.ok(models.includes('glm-5.4'));
        assert.ok(models.includes('x-preview-l'));
        assert.ok(models.includes('glm-5.3'));
        assert.ok(models.includes('glm-5.2'));
    });
});

test('a tier-locked model falls through to the next one', async (t) => {
    await withBridge({ 'glm-5.4': TIER_LOCKED }, async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url);
        t.after(restore);

        const resp = await postChat(bridgeURL, {});
        assert.equal(resp.status, 200);
        await resp.json();

        const reqs = completions(upstream.seen);
        assert.equal(reqs[0].body.model, 'glm-5.4');
        assert.notEqual(reqs[1].body.model, 'glm-5.4');
    });
});

test('a healthy model is used as-is', async (t) => {
    await withBridge({}, async ({ upstream, bridgeURL }) => {
        const restore = pointAt(upstream.url);
        t.after(restore);

        const resp = await postChat(bridgeURL, {});
        assert.equal(resp.status, 200);
        await resp.json();

        // No retry: the first model worked.
        assert.equal(completions(upstream.seen).length, 1);
    });
});
