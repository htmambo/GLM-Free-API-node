// Port of internal/zbridge/sse_requestid_test.go — issue #36: SSE debug lines
// carry the client-visible request id so concurrent streams stay attributable.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { streamSSEResponse } from '../src/zai.js';
import { setVerbose } from '../src/logger.js';
import { config } from '../src/config.js';

function captureStderr(fn) {
    const oldWrite = process.stderr.write;
    const lines = [];
    process.stderr.write = (chunk, ...rest) => {
        lines.push(String(chunk));
        return true;
    };
    return Promise.resolve()
        .then(fn)
        .finally(() => { process.stderr.write = oldWrite; })
        .then(() => lines);
}

const body = 'data: {"data":{"delta_content":"hi"}}\n\ndata: {"data":{"phase":"done"}}\n\ndata: [DONE]\n\n';

test('TestSSEDebugLinesCarryRequestId', async (t) => {
    const savedVerbose = config.logging.level;
    setVerbose(true);
    config.logging.level = 'debug';
    t.after(() => {
        setVerbose(false);
        config.logging.level = savedVerbose;
    });

    const lines = await captureStderr(async () => {
        for await (const _ of streamSSEResponse(body, 'req-abc123')) { /* drain */ }
    });

    const sseLines = lines.filter((l) => l.includes('Z.AI SSE line'));
    assert.ok(sseLines.length > 0, 'no SSE debug lines were logged');
    for (const l of sseLines) {
        assert.ok(l.includes('[req-abc123]'), `SSE debug line lacks the request id: ${l}`);
    }
});

test('TestSSEDebugLinesLegacyPrefix', async (t) => {
    const savedVerbose = config.logging.level;
    setVerbose(true);
    config.logging.level = 'debug';
    t.after(() => {
        setVerbose(false);
        config.logging.level = savedVerbose;
    });

    const lines = await captureStderr(async () => {
        for await (const _ of streamSSEResponse(body)) { /* drain */ }
    });

    const sseLines = lines.filter((l) => l.includes('Z.AI SSE line'));
    assert.ok(sseLines.length > 0);
    for (const l of sseLines) {
        assert.ok(l.includes('[DEBUG]'), `legacy prefix missing: ${l}`);
        assert.ok(!l.includes('[]'), `empty request id must not emit empty brackets: ${l}`);
    }
});
