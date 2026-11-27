// Port of internal/zbridge/waf_test.go — WAF detection, breaker transitions,
// the handler gate, and error-body truncation.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    isWAFBlockResponse,
    recordWAFBlock,
    recordWAFSuccess,
    checkWAF,
    wafStatus,
    rejectIfWAFBlocked,
    truncateErrorBody,
    setWafProbeTransportForTests,
    setWafProberSliceForTests,
    setWafCooldownForTests,
    resetWAFForTests,
    formatDuration,
} from '../src/waf.js';

function blockPageBody() {
    return '<html><body><h1>Sorry, your request has been blocked as it may cause ' +
        'potential threats to the server\'s security.</h1><p>errors.aliyun.com</p></body></html>';
}

function resetAll() {
    resetWAFForTests();
    setWafProberSliceForTests(1000);
    setWafProbeTransportForTests(async () => ({ status: 405, body: blockPageBody() }));
}

test('TestIsWAFBlockResponse', () => {
    assert.equal(isWAFBlockResponse(405, blockPageBody()), true);
    assert.equal(isWAFBlockResponse(403, blockPageBody()), true);
    assert.equal(isWAFBlockResponse(405, '<html>您的访问被阻断</html>'), true);
    assert.equal(isWAFBlockResponse(405, '<html>errors.aliyun.com</html>'), true);
    assert.equal(isWAFBlockResponse(405, '{"detail":"method not allowed"}'), false);
    assert.equal(isWAFBlockResponse(403, '{"detail":"Not authenticated"}'), false);
    assert.equal(isWAFBlockResponse(200, blockPageBody()), false);
    assert.equal(isWAFBlockResponse(405, ''), false);
    assert.equal(isWAFBlockResponse(500, '{"detail":"boom"}'), false);
});

test('TestBreakerOpensAndFailsFast', () => {
    resetAll();
    const before = checkWAF();
    assert.equal(before.err, null);

    recordWAFBlock();
    const during = checkWAF();
    assert.ok(during.err !== null);
    assert.match(during.err, /temporarily blocked this server's IP/);
    assert.ok(during.retryIn > 0);

    const st = wafStatus();
    assert.equal(st.blocked, true);
    assert.equal(st.state, 1);
    assert.equal(st.consecutiveBlocks, 1);
    assert.ok(typeof st.retryIn === 'string');

    resetWAFForTests();
    assert.equal(checkWAF().err, null);
});

test('TestBreakerClosesOnSuccess', () => {
    resetAll();
    recordWAFBlock();
    assert.equal(wafStatus().blocked, true);
    recordWAFSuccess();
    assert.equal(wafStatus().blocked, false);
    assert.equal(checkWAF().err, null);
});

test('TestRejectIfWAFBlockedAnswers503', () => {
    resetAll();
    recordWAFBlock();

    const captured = {};
    const res = {
        setHeader(k, v) { captured[k] = v; },
        writeHead(status, headers) { captured.status = status; captured.headers = headers; },
        end(body) { captured.body = body; },
        writableEnded: false,
        headersSent: false,
    };
    const handled = rejectIfWAFBlocked(res);
    assert.equal(handled, true);
    assert.equal(captured.status, 503);
    assert.ok(Number(captured['Retry-After']) >= 0);
    const parsed = JSON.parse(captured.body);
    assert.equal(parsed.error.type, 'overloaded_error');
    assert.equal(parsed.error.code, 'waf_block');
    assert.match(parsed.error.message, /temporarily blocked/);
    assert.ok(typeof parsed.error.retryIn === 'string');
});

test('TestRejectIfWAFBlockedPassesWhenClosed', () => {
    resetAll();
    const res = { setHeader() { assert.fail('must not answer'); }, writeHead() {}, end() {} };
    assert.equal(rejectIfWAFBlocked(res), false);
});

test('TestTruncateErrorBody', () => {
    const short = '{"detail":"nope"}';
    assert.equal(truncateErrorBody(short), short);

    const long = 'x'.repeat(600);
    const got = truncateErrorBody(`  ${long}  `);
    assert.equal(got.length, 512 + '...(truncated)'.length);
    assert.ok(got.endsWith('...(truncated)'));
});

test('TestWAFStatusReporting', () => {
    resetAll();
    assert.deepEqual(wafStatus(), { blocked: false, state: 0 });
    recordWAFBlock();
    recordWAFBlock(); // consecutive observation while open
    const st = wafStatus();
    assert.equal(st.blocked, true);
    assert.equal(st.consecutiveBlocks, 2);
});

test('TestBreakerProbeFailureTreatedAsBlocked', async () => {
    resetAll();
    setWafProberSliceForTests(5);
    setWafProbeTransportForTests(async () => { throw new Error('connection refused'); });

    recordWAFBlock();
    setWafCooldownForTests(10);
    // The probe fails -> the breaker stays open (conservative).
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(wafStatus().blocked, true);
    resetWAFForTests();
});

test('TestBreakerProberClosesWhenClear', async () => {
    resetAll();
    setWafProberSliceForTests(5);
    // Probe says the block lifted: a JSON 403, not an HTML block page.
    setWafProbeTransportForTests(async () => ({ status: 403, body: '{"detail":"Not authenticated"}' }));

    recordWAFBlock();
    setWafCooldownForTests(10);
    const deadline = Date.now() + 1000;
    while (wafStatus().blocked && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
    }
    assert.equal(wafStatus().blocked, false, 'breaker should close once the probe clears');
});

test('formatDuration matches Go whole-second rendering', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(90_000), '1m30s');
    assert.equal(formatDuration(3_600_000), '1h0m0s');
});

test('HTTP: open breaker answers 503 + Retry-After before any upstream work', async () => {
    resetAll();
    recordWAFBlock();

    const http = await import('node:http');
    const { createHandler } = await import('../src/server.js');
    const { config } = await import('../src/config.js');
    const server = http.createServer(createHandler());
    const url = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
    try {
        const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.auth.token };

        // Malformed requests are still 400: validation precedes the gate.
        const bad = await fetch(url + '/v1/chat/completions', { method: 'POST', headers, body: '{' });
        assert.equal(bad.status, 400);

        const blocked = await fetch(url + '/v1/chat/completions', {
            method: 'POST',
            headers,
            body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(blocked.status, 503);
        assert.ok(blocked.headers.get('retry-after') !== null);
        const body = await blocked.json();
        assert.equal(body.error.code, 'waf_block');
        assert.equal(body.error.type, 'overloaded_error');

        // Anthropic endpoint uses the same gate.
        const anth = await fetch(url + '/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': config.auth.token },
            body: JSON.stringify({ model: 'glm-4.7', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }),
        });
        assert.equal(anth.status, 503);
    } finally {
        resetWAFForTests();
        await new Promise((r) => server.close(r));
    }
});
