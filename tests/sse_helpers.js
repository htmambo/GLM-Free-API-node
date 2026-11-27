// Shared helpers for the SSE parser tests — the JS equivalents of the
// helpers in Go's sse_garble_test.go / sse_reasoning_dup_repro_test.go.
// (Not a *.test.js file on purpose: it must not be picked up by node --test,
// and test files must NOT import each other — importing a test file would
// re-run its tests inside the importer's process.)

import assert from 'node:assert/strict';

import { streamSSEResponse } from '../src/zai.js';
import { config } from '../src/config.js';

// sseEvent wraps one upstream payload as an SSE `data:` line.
export function sseEvent(payload) {
    return 'data: ' + payload + '\n\n';
}

// runSSEParser runs the real streamSSEResponse over a synthetic body and
// collects every result the generator yields. A yielded error fails the
// test, mirroring the Go helper's t.Fatalf on the returned error.
export async function runSSEParser(t, body) {
    const results = [];
    for await (const r of streamSSEResponse(body)) {
        if (r.error) assert.fail(`streamSSEResponse returned error: ${r.error.message}`);
        results.push(r);
    }
    return results;
}

// replayClientView replicates VERBATIM the accumulation logic of
// chatCompletionsHandler / anthropicStreamResponse after the issue #23
// fix: the parser owns diffing, the handler forwards result.chunk and
// tracks the result.fullText snapshot.
export function replayClientView(results) {
    const deltas = [];
    for (const result of results) {
        if (result.reasoning !== '') continue; // reasoning travels on its own channel
        if (result.chunk === '') continue;
        deltas.push(result.chunk);
    }
    return { clientText: deltas.join(''), deltas };
}

// Lone surrogates are the JS equivalent of invalid UTF-8 (a sliced
// surrogate pair renders as U+FFFD replacement garble downstream).
export const loneSurrogateRe =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

export function assertValidUTF8(t, deltas) {
    for (let i = 0; i < deltas.length; i++) {
        assert.ok(!loneSurrogateRe.test(deltas[i]),
            `client delta #${i} contains a LONE SURROGATE (renders as replacement-char garble): ${JSON.stringify(deltas[i])}`);
    }
}

// withHoldback runs fn with a temporary streamHoldback value.
export async function withHoldback(n, fn) {
    const old = config.streamHoldback;
    config.streamHoldback = n;
    try {
        return await fn();
    } finally {
        config.streamHoldback = old;
    }
}
