// Port of internal/zbridge/sse_reasoning_dup_repro_test.go — reproduction +
// regression tests for the post-d2ee325 regression: clients receive
// reasoning_content as repeated growing prefixes (">First: OS release.
// `First: OS release. `cat /etc/os-release` ...") even though the upstream
// Z.AI stream (visible in debug logs) is correct.
//
// Mechanism: Z.AI streams the <details> reasoning body one character
// at a time (edit_content appends). Each reasoning line is markdown-
// quoted ("> ..."). While a new line's quote marker is only partially
// arrived (raw tail = "\n>"), stripDetailsTags' "> " prefix strip does
// not match the bare ">" and trim keeps it, so the stripped reasoning
// snapshot transiently ends in a bare ">". One character later the "> "
// completes and the ">" is stripped away — the snapshot sequence is
// non-monotonic. The SSEEmitter then diverged: its tracked view kept the
// stale ">" tail, every later snapshot shared only the pre-">" prefix
// with it, and everything after that point was re-emitted on EVERY
// flush — the exact growing-prefix duplication clients render.
//
// Go note: utf16Len(s) is simply s.length in JS (JS string length IS the
// UTF-16 code-unit count), and per-rune iteration is `for (const ch of s)`
// (code points).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { holdBackPartialQuoteMarker } from '../src/zai.js';
import { sseEvent, runSSEParser, replayClientView, withHoldback } from './sse_helpers.js';

// editAppendEventsFrom builds one SSE event per code point of `add`,
// appending each at the running UTF-16 end-of-content offset — exactly the
// way the Z.AI prod-fe reconstructs it: content = content.substring(0,
// edit_index) + edit_content. It returns [events, newContent].
function editAppendEventsFrom(existing, add) {
    let body = '';
    let cur = existing;
    for (const ch of add) { // iterates code points, like Go's rune loop
        const payload = JSON.stringify({
            data: { edit_content: ch, edit_index: cur.length },
        });
        body += sseEvent(payload);
        cur += ch;
    }
    return [body, cur];
}

// editAppendStream appends to an empty stream, with the stream terminators.
function editAppendStream(full) {
    return editAppendEventsFrom('', full)[0] +
        sseEvent('{"data":{"phase":"done"}}') +
        'data: [DONE]\n\n';
}

// collectReasoning concatenates every reasoning delta the parser emits.
function collectReasoning(results) {
    let sb = '';
    for (const r of results) sb += r.reasoning;
    return sb;
}

// Streams a <details> reasoning block whose lines carry "> " quote markers
// one character at a time. The client must receive the reasoning exactly once.
test('SSE reasoning quoted lines: no duplication', async (t) => {
    const line1 = 'First: OS release. `cat /etc/os-release` — but the instructions say use read tool for text files.';
    const line2 = "That's for workspace files generally. But for system info gathering, bash is the natural approach.";
    const inner = '> ' + line1 + '\n> ' + line2;
    const full = '<details>' + inner + '</details>The answer.';

    for (const hb of [0, 24]) {
        await withHoldback(hb, async () => {
            const results = await runSSEParser(t, editAppendStream(full));

            const reasoning = collectReasoning(results);
            const want = line1 + '\n' + line2;

            assert.equal(reasoning, want,
                `holdback=${hb}: client reasoning mismatch`);
            const n = reasoning.split('First: OS release.').length - 1;
            assert.ok(n <= 1,
                `holdback=${hb}: reasoning duplicated ${n} times (growing-prefix symptom)`);

            // Content channel must carry only the answer.
            const { clientText } = replayClientView(results);
            assert.equal(clientText, 'The answer.', `holdback=${hb}`);
        });
    }
});

// Isolates the trigger: a partially-streamed "> " marker must never reach
// the client, and the tail rewrite it causes must not duplicate anything
// after it.
test('SSE reasoning quote marker partial arrival', async (t) => {
    await withHoldback(0, async () => {
        const full = '<details>> abc\n> def</details>ok';
        const results = await runSSEParser(t, editAppendStream(full));
        const reasoning = collectReasoning(results);
        assert.equal(reasoning, 'abc\ndef');
        assert.ok(!reasoning.includes('>'),
            `stray quote marker leaked into reasoning: ${JSON.stringify(reasoning)}`);
    });
});

// Asserts the append-only client view never diverges from the expected
// reasoning: every partial concatenation of reasoning deltas must stay a
// prefix of the final text (a re-emitted growing prefix violates this
// immediately).
test('SSE reasoning growth deltas are incremental', async (t) => {
    await withHoldback(0, async () => {
        const line1 = 'First: OS release. `cat /etc/os-release`.';
        const want = line1 + '\nsecond line here';
        const full = '<details>> ' + line1 + '\n> second line here</details>ans';
        const results = await runSSEParser(t, editAppendStream(full));

        let view = '';
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.reasoning === '') continue;
            view += r.reasoning;
            assert.ok(want.startsWith(view),
                `delta #${i} made the client view diverge from the expected reasoning:\n view = ${JSON.stringify(view)}`);
        }
        assert.equal(view, want, 'final client reasoning');
    });
});

// Verifies that a trailing edit_content backtrack inside the reasoning (the
// model revising the tail of its thinking) is absorbed by the hold-back
// window, so the client converges exactly — no stale fragment, no
// duplication.
test('SSE reasoning tail backtrack absorbed', async (t) => {
    await withHoldback(24, async () => {
        // Reasoning grows past the hold-back window, then the model
        // backtracks inside the window and retypes the tail, then the
        // block closes and the answer follows.
        const quoted = '> ' + 'thinking text '.repeat(12);
        let [body, cur] = editAppendEventsFrom('', '<details>' + quoted + 'wrong tail');
        // Backtrack: replace "wrong tail" with "right end".
        const prefix = '<details>' + quoted;
        body += sseEvent(JSON.stringify({
            data: { edit_content: 'right end', edit_index: prefix.length },
        }));
        cur = prefix + 'right end';
        body += editAppendEventsFrom(cur, '</details>ans')[0];
        body += sseEvent('{"data":{"phase":"done"}}');
        body += 'data: [DONE]\n\n';

        const results = await runSSEParser(t, body);
        const reasoning = collectReasoning(results);
        const want = 'thinking text '.repeat(12) + 'right end';
        assert.equal(reasoning, want);
        assert.ok(!reasoning.includes('wrong tail'),
            `stale backtracked tail leaked into reasoning: ${JSON.stringify(reasoning)}`);
        const { clientText } = replayClientView(results);
        assert.equal(clientText, 'ans');
    });
});

// Covers the holdBackPartialQuoteMarker helper directly.
test('holdBackPartialQuoteMarker', () => {
    const cases = [
        ['', ''],
        ['abc', 'abc'],
        ['>', ''],                 // bare marker at text start: held
        ['abc\n>', 'abc\n'],       // bare marker on its own line: held
        ['abc\n> x', 'abc\n> x'],  // marker already completed by text: kept
        ['abc\n>x', 'abc\n>x'],    // not a quote marker pattern mid-stream: kept
        ['a > b', 'a > b'],        // mid-line ">" is genuine text: kept
        ['a > b\n>', 'a > b\n'],   // trailing bare marker still held
        ['abc>', 'abc>'],          // not at line start: genuine text, kept
        ['<details>', '<details>'], // not at line start: kept
    ];
    for (const [s, want] of cases) {
        assert.equal(holdBackPartialQuoteMarker(s), want,
            `holdBackPartialQuoteMarker(${JSON.stringify(s)})`);
    }
});
