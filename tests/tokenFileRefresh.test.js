// End-to-end test for the 401 path in src/zai.js: a token rotated by the
// refresher (ZAI_TOKEN_FILE) must be picked up and used on the retry, without
// re-applying the rejected token.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { config, setBaseURL } from '../src/config.js';
import { session } from '../src/state.js';
import { setCaptchaParamOverrideForTests } from '../src/captcha.js';
import { createHandler } from '../src/server.js';
import { overrideSessionState, flushModelsCache } from '../src/handlers.js';

const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

function jwt(id) {
    return `${enc({ alg: 'HS256', typ: 'JWT' })}.` +
        `${enc({ id, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${server.address().port}`;
}

// Rejects the first completion with 401, then answers normally; records the
// Authorization header of every completion request.
async function startUpstream({ rejectAll = false } = {}) {
    const seen = [];
    let completions = 0;
    const server = http.createServer((req, res) => {
        let buf = '';
        req.on('data', (c) => { buf += c; });
        req.on('end', () => {
            if (req.url.startsWith('/api/v2/chat/completions')) {
                seen.push({ auth: req.headers.authorization, url: req.url });
                completions++;
                if (rejectAll || completions === 1) {
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end('{"error":"unauthorized"}');
                    return;
                }
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
            // Homepage scrape and anything else: empty 404 is harmless.
            res.writeHead(404).end('');
        });
    });
    const url = await listen(server);
    return { seen, server, url };
}

test('401 with a rotated token file: retries once with the new token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zai-token-401-'));
    const tokenPath = join(dir, 'token');
    const fresh = jwt('fresh-user');
    writeFileSync(tokenPath, fresh + '\n', { mode: 0o600 });

    const upstream = await startUpstream();
    const bridge = http.createServer(createHandler());
    const bridgeURL = await listen(bridge);

    const old = {
        token: config.zaiToken,
        file: config.zaiTokenFile,
        agentMode: config.agentMode,
    };
    config.zaiToken = 'rejected-token';
    config.zaiTokenFile = tokenPath;
    config.agentMode = false;
    setBaseURL(upstream.url);
    const restoreSession = overrideSessionState('rejected-token', 'test-user', true);
    const restoreCaptcha = setCaptchaParamOverrideForTests('test-captcha-param');
    flushModelsCache();

    try {
        const resp = await fetch(bridgeURL + '/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + config.auth.token,
            },
            body: JSON.stringify({
                model: 'glm-4.7',
                stream: false,
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        const body = await resp.text();

        assert.equal(resp.status, 200, body);
        assert.equal(upstream.seen.length, 2, 'expected one retry after the 401');
        assert.ok(upstream.seen[0].auth);
        assert.equal(upstream.seen[1].auth, 'Bearer ' + fresh);
        assert.equal(config.zaiToken, fresh);
        assert.equal(session.token, fresh);
    } finally {
        restoreCaptcha();
        restoreSession();
        config.zaiToken = old.token;
        config.zaiTokenFile = old.file;
        config.agentMode = old.agentMode;
        setBaseURL('https://chat.z.ai');
        flushModelsCache();
        await new Promise((r) => bridge.close(r));
        await new Promise((r) => upstream.server.close(r));
        rmSync(dir, { recursive: true, force: true });
    }
});

test('401 with an unchanged token file: no retry, error surfaced', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zai-token-401-same-'));
    const tokenPath = join(dir, 'token');
    const same = jwt('same-user');
    writeFileSync(tokenPath, same + '\n', { mode: 0o600 });

    const upstream = await startUpstream({ rejectAll: true });
    const bridge = http.createServer(createHandler());
    const bridgeURL = await listen(bridge);

    const old = {
        token: config.zaiToken,
        file: config.zaiTokenFile,
        agentMode: config.agentMode,
    };
    config.zaiToken = same;
    config.zaiTokenFile = tokenPath;
    config.agentMode = false;
    setBaseURL(upstream.url);
    const restoreSession = overrideSessionState(same, 'test-user', true);
    const restoreCaptcha = setCaptchaParamOverrideForTests('test-captcha-param');
    flushModelsCache();

    try {
        const resp = await fetch(bridgeURL + '/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: 'Bearer ' + config.auth.token,
            },
            body: JSON.stringify({
                model: 'glm-4.7',
                stream: true,
                messages: [{ role: 'user', content: 'hi' }],
            }),
        });
        const body = await resp.text();

        assert.equal(resp.status, 200, body);
        assert.equal(upstream.seen.length, 1, 'an unchanged token must not be retried');
        assert.match(body, /ZAI_TOKEN was rejected/);
    } finally {
        restoreCaptcha();
        restoreSession();
        config.zaiToken = old.token;
        config.zaiTokenFile = old.file;
        config.agentMode = old.agentMode;
        setBaseURL('https://chat.z.ai');
        flushModelsCache();
        await new Promise((r) => bridge.close(r));
        await new Promise((r) => upstream.server.close(r));
        rmSync(dir, { recursive: true, force: true });
    }
});
