// Port of internal/zbridge/sse_garble_test.go — reproduction + regression
// tests for issue #23 (输出乱码的问题): garbled / unreadable characters
// interspersed in streamed output.
//
// Root causes proven here (all verified against the official Z.AI web
// frontend, prod-fe bundle):
//
//  1. edit_index is a UTF-16 code-unit offset — the frontend applies
//     `content.substring(0, edit_index) + edit_content` (JavaScript string
//     indexing).
//  2. The `content` SSE field is a FULL replacement (frontend:
//     `lt.content = rr`); the old parser appended it, duplicating text.
//  3. The old parser diffed accumulated text by BYTE LENGTH and sliced
//     `content[sentLen:]`, landing inside multi-byte runes — invalid UTF-8
//     that JSON renderers display as U+FFFD replacement garble. Partial
//     "<det" tag fragments also leaked.
//
// The tests feed synthetic Z.AI SSE streams (shaped exactly like the
// documented upstream protocol) through the REAL streamSSEResponse parser,
// then replay the emitted results through the exact logic of
// chatCompletionsHandler / anthropicStreamResponse, and assert what an
// OpenAI-compatible client actually receives.
//
// Go -> JS mapping:
//   - streamSSEResponse is an async generator here; runSSEParser drains it
//     and fails on a yielded error result (Go: streamSSEResponse's returned
//     error after the channel closes).
//   - "valid UTF-8" becomes "no lone surrogates": JS strings are decoded
//     UTF-16, so the equivalent garble symptom is a sliced surrogate pair.
//   - utf16IndexToByteIndex byte offsets become utf16IndexToStringIndex
//     string indexes; the Go expected values are translated accordingly
//     (BMP rune = 1 unit, emoji = 2 units).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    SSEEmitter,
    utf16IndexToStringIndex,
    commonPrefixLen,
    holdBackTail,
    holdBackPartialDetailsTag,
    splitDetails,
} from '../src/zai.js';
import {
    sseEvent,
    runSSEParser,
    replayClientView,
    assertValidUTF8,
    withHoldback,
    loneSurrogateRe,
} from './sse_helpers.js';

// ── Baseline: pure delta_content append must stay clean ─────────────────────

test('SSE baseline: pure delta append', async (t) => {
    const body = sseEvent('{"data":{"delta_content":"你好，"}}') +
        sseEvent('{"data":{"delta_content":"世界 🙂"}}') +
        sseEvent('{"data":{"phase":"done"}}') +
        'data: [DONE]\n\n';

    for (const hb of [0, 24]) {
        await withHoldback(hb, async () => {
            const results = await runSSEParser(t, body);
            const { clientText, deltas } = replayClientView(results);
            assertValidUTF8(t, deltas);
            assert.equal(clientText, '你好，世界 🙂', `holdback=${hb}`);
        });
    }
});

// ── Issue #23 core repro: edit_content revision garbled the output ──────────
//
// Upstream streams "Hello 你好", then revises via edit_content from UTF-16
// index 6 to "世界！". With hold-back disabled (worst case: the rewrite
// touches text already forwarded to the client) the client must still
// receive only valid text — the old code sliced mid-rune here and emitted
// raw continuation bytes.

test('SSE edit_content revision never emits garble', async (t) => {
    const body = sseEvent('{"data":{"delta_content":"Hello 你好"}}') +
        sseEvent('{"data":{"edit_content":"世界！","edit_index":6}}') +
        sseEvent('{"data":{"phase":"done"}}') +
        'data: [DONE]\n\n';

    await withHoldback(0, async () => {
        const results = await runSSEParser(t, body);
        const { clientText, deltas } = replayClientView(results);
        assertValidUTF8(t, deltas);
        // The stale "你好" cannot be taken back from an append-only
        // client, but the corrected tail must follow it intact.
        assert.ok(clientText.endsWith('世界！'),
            `client text = ${JSON.stringify(clientText)}, must end with the corrected tail`);
    });
});

// With the default hold-back window the tail revision happens inside the
// pending region, so the client must converge EXACTLY on the upstream's
// final text — no stale fragment, no garble.
test('SSE edit_content revision absorbed by holdback', async (t) => {
    const body = sseEvent('{"data":{"delta_content":"Hello 你好"}}') +
        sseEvent('{"data":{"edit_content":"世界！","edit_index":6}}') +
        sseEvent('{"data":{"phase":"done"}}') +
        'data: [DONE]\n\n';

    await withHoldback(24, async () => {
        const results = await runSSEParser(t, body);
        const { clientText, deltas } = replayClientView(results);
        assertValidUTF8(t, deltas);
        assert.equal(clientText, 'Hello 世界！');
    });
});

// ── Deep edit far beyond the hold-back window must stay readable ────────────

test('SSE deep edit stays valid', async (t) => {
    // 30 code points of Chinese (90 bytes), then the model backtracks to
    // rune 2 and retypes a LONGER passage (ASCII + Chinese mix, as real
    // output contains markdown/spaces). The old byte-length diff sliced the
    // new content at the old byte offset — inside a multi-byte rune.
    const longPrefix = '长'.repeat(30);
    const body = sseEvent(`{"data":{"delta_content":"${longPrefix}"}}`) +
        sseEvent(`{"data":{"edit_content":"短文abc${longPrefix}","edit_index":2}}`) +
        sseEvent('{"data":{"phase":"done"}}') +
        'data: [DONE]\n\n';

    await withHoldback(0, async () => {
        const results = await runSSEParser(t, body);
        const { deltas } = replayClientView(results);
        assertValidUTF8(t, deltas);
    });
});

// ── <details> reasoning tag split across SSE events ─────────────────────────
//
// The upstream streams the "<details" opener one fragment at a time. The
// old parser emitted the partial "<det" fragment as content, then sliced
// mid-rune when the tag completed and content shrank back — the exact
// "穿插着一些无法查看的乱码" pattern from the issue report.

test('SSE <details> tag split across events', async (t) => {
    const body = sseEvent('{"data":{"delta_content":"答案"}}') +
        sseEvent('{"data":{"delta_content":"<det"}}') +
        sseEvent('{"data":{"delta_content":"ails>思考过程</details>"}}') +
        sseEvent('{"data":{"delta_content":"正文内容"}}') +
        sseEvent('{"data":{"phase":"done"}}') +
        'data: [DONE]\n\n';

    for (const hb of [0, 24]) {
        await withHoldback(hb, async () => {
            const results = await runSSEParser(t, body);
            const { clientText, deltas } = replayClientView(results);

            assertValidUTF8(t, deltas);
            assert.ok(!clientText.includes('<det') && !clientText.includes('<details'),
                `holdback=${hb}: <details> tag fragment leaked into client content: ${JSON.stringify(clientText)}`);
            assert.equal(clientText, '答案正文内容', `holdback=${hb}`);

            // Reasoning must still arrive intact on the reasoning channel.
            let reasoning = '';
            for (const r of results) reasoning += r.reasoning;
            assert.equal(reasoning, '思考过程', `holdback=${hb}`);
        });
    }
});

// ── edit_index is UTF-16, not runes (owner's hypothesis, confirmed) ─────────
//
// The official frontend does content.substring(0, edit_index) — UTF-16
// code units. "A🙂" is 2 code points but 3 UTF-16 units; an edit right
// after the emoji arrives with edit_index=3. A rune-based conversion
// splices one character too late and silently corrupts the text.

test('SSE edit_index is UTF-16 units', async (t) => {
    const body = sseEvent('{"data":{"delta_content":"A🙂B"}}') +
        // UTF-16 index 3 = after "A" (1 unit) + "🙂" (2 units)
        sseEvent('{"data":{"edit_content":"C","edit_index":3}}') +
        sseEvent('{"data":{"phase":"done"}}') +
        'data: [DONE]\n\n';

    // Hold-back absorbs the tail rewrite, so the client must converge
    // exactly. A rune-based conversion of edit_index=3 would splice AFTER
    // the "B" (3 code points), appending instead of replacing — the client
    // would have seen "A🙂BC".
    await withHoldback(24, async () => {
        const results = await runSSEParser(t, body);
        const { clientText, deltas } = replayClientView(results);
        assertValidUTF8(t, deltas);
        assert.equal(clientText, 'A🙂C',
            'edit_index must be interpreted as UTF-16 units');
    });
});

// Pure-BMP text: UTF-16 units == code points, must keep working.
test('SSE edit_index BMP text', async (t) => {
    const body = sseEvent('{"data":{"delta_content":"你好世界"}}') +
        sseEvent('{"data":{"edit_content":"地球","edit_index":2}}') +
        sseEvent('{"data":{"phase":"done"}}') +
        'data: [DONE]\n\n';

    // Hold-back absorbs the tail rewrite: the client must converge exactly.
    await withHoldback(24, async () => {
        const results = await runSSEParser(t, body);
        const { clientText, deltas } = replayClientView(results);
        assertValidUTF8(t, deltas);
        assert.equal(clientText, '你好地球');
    });
});

// ── `content` events are full replacements, not appends ─────────────────────
//
// Official frontend: `lt.content = rr` ("全量更新"). The old parser
// appended `content` events, duplicating the whole message whenever the
// upstream sent a snapshot.

test('SSE content field is full replacement', async (t) => {
    const body = sseEvent('{"data":{"delta_content":"partial text"}}') +
        sseEvent('{"data":{"content":"完整的最终文本"}}') +
        sseEvent('{"data":{"phase":"done"}}') +
        'data: [DONE]\n\n';

    // Hold-back keeps "partial text" pending, so the replacement happens
    // before anything reaches the client: it must see ONLY the snapshot.
    // (The old parser APPENDED the snapshot, duplicating everything.)
    await withHoldback(24, async () => {
        const results = await runSSEParser(t, body);
        const { clientText, deltas } = replayClientView(results);
        assertValidUTF8(t, deltas);
        assert.ok(!clientText.includes('partial text'),
            `content snapshot must REPLACE, client text = ${JSON.stringify(clientText)}`);
        assert.ok(clientText.endsWith('完整的最终文本'),
            `client text = ${JSON.stringify(clientText)}, must end with the snapshot`);
    });
});

// ── Long stream with interleaved edits: parser contract holds ───────────────
//
// A realistic-length stream (well past the hold-back window) with mixed
// Chinese/ASCII/emoji and periodic tail edits. Every chunk reaching the
// client must be valid, fullText snapshots must equal the running
// concatenation of chunks, and the final text must match upstream.

test('SSE long stream with tail edits: contract', async (t) => {
    let body = '';
    // 40 events of mixed text, then a tail edit inside the hold-back zone.
    for (let i = 0; i < 40; i++) {
        body += sseEvent(`{"data":{"delta_content":"第${i}段。"}}`);
    }
    // Tail backtrack: replace the last two events' text (within the 24-rune
    // hold-back zone). Segments 0-9 are 4 code points, 10-37 are 5 each:
    // 10×4 + 28×5 = 180 UTF-16 units before segments 38-39.
    body += sseEvent('{"data":{"edit_content":"最终段。","edit_index":180}}');
    body += sseEvent('{"data":{"delta_content":"收尾 🙂"}}');
    body += sseEvent('{"data":{"phase":"done"}}');
    body += 'data: [DONE]\n\n';

    await withHoldback(24, async () => {
        const results = await runSSEParser(t, body);
        const { clientText, deltas } = replayClientView(results);

        assertValidUTF8(t, deltas);

        // Parser contract: every emitted chunk must be a suffix of its
        // fullText snapshot (never a mid-string slice), and the final
        // snapshot must equal the upstream's final content.
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.reasoning !== '' || r.chunk === '') continue;
            assert.ok(r.fullText.endsWith(r.chunk),
                `result #${i}: chunk ${JSON.stringify(r.chunk)} is not a suffix of snapshot ${JSON.stringify(r.fullText)}`);
        }
        let last = '';
        for (const r of results) {
            if (r.fullText !== '') last = r.fullText;
        }

        let want = '';
        for (let i = 0; i < 38; i++) want += `第${i}段。`;
        want += '最终段。收尾 🙂';
        assert.equal(last, want, 'final snapshot');
        assert.equal(clientText, want, 'client text');
    });
});

// ── Unit tests for the helper functions ─────────────────────────────────────

test('utf16IndexToStringIndex', (t) => {
    // Expected values are JS STRING indexes (Go's byte offsets translated:
    // BMP rune = 1 unit, emoji = 2 units).
    const cases = [
        ['', 5, 0],           // empty string
        ['abc', 0, 0],        // zero
        ['abc', -3, 0],       // negative
        ['abc', 2, 2],        // ASCII
        ['abc', 99, 3],       // beyond end -> clamp
        ['你好', 1, 1],        // BMP Chinese: 1 unit = 1 code point
        ['你好', 2, 2],        // end
        ['A🙂B', 0, 0],       // before emoji
        ['A🙂B', 1, 1],       // after 'A'
        ['A🙂B', 2, 1],       // inside the surrogate pair -> clamp to start
        ['A🙂B', 3, 3],       // after the emoji
        ['A🙂B', 4, 4],       // after 'B'
        ['A🙂B', 100, 4],     // beyond end
        ['你好🙂世界', 4, 4], // 2+2 units then emoji
    ];
    for (const [s, idx, want] of cases) {
        const got = utf16IndexToStringIndex(s, idx);
        assert.equal(got, want, `utf16IndexToStringIndex(${JSON.stringify(s)}, ${idx})`);
        // The result must always be a code point boundary (never the low
        // half of a surrogate pair).
        if (got < s.length) {
            const c = s.charCodeAt(got);
            assert.ok(!(c >= 0xdc00 && c <= 0xdfff),
                `utf16IndexToStringIndex(${JSON.stringify(s)}, ${idx}) = ${got} lands mid-surrogate-pair`);
        }
    }
});

test('commonPrefixLen code-point safe', () => {
    const cases = [
        ['', '', 0],
        ['abc', 'abd', 2],
        ['你好世界', '你好地球', 2],
        ['A🙂B', 'A🙂C', 3],
        ['abc', 'abc', 3],
        ['abc', 'xabc', 0],
    ];
    for (const [a, b, want] of cases) {
        assert.equal(commonPrefixLen(a, b), want,
            `commonPrefixLen(${JSON.stringify(a)}, ${JSON.stringify(b)})`);
    }
});

test('SSEEmitter.delta', (t) => {
    // Normal growth.
    const e = new SSEEmitter();
    assert.equal(e.delta('abc'), 'abc', 'growth from empty');
    assert.equal(e.delta('abcdef'), 'def', 'growth');
    assert.equal(e.delta('abcdef'), '', 'no-op');

    // Multibyte growth stays code-point aligned.
    const e2 = new SSEEmitter();
    assert.equal(e2.delta('你好'), '你好', 'multibyte growth');
    assert.equal(e2.delta('你好世界'), '世界', 'multibyte growth delta');

    // Deep truncation: target is a prefix of the client view — nothing is
    // sent and the view is NOT rewound, so the following growth does not
    // re-emit text the client already has.
    const e3 = new SSEEmitter();
    e3.delta('你好世界天地');
    assert.equal(e3.delta('你好世界'), '', 'shrink must emit nothing');
    assert.equal(e3.delta('你好世界天地人'), '人', 'growth after shrink');

    // Rewrite inside the view: re-sync from the common prefix, valid text.
    const e4 = new SSEEmitter();
    e4.delta('Hello 你好');
    const got = e4.delta('Hello 世界！');
    assert.equal(got, '世界！', 'rewrite re-sync');
    assert.ok(!loneSurrogateRe.test(got), 'rewrite re-sync produced a lone surrogate');

    // Full rewrite.
    const e5 = new SSEEmitter();
    e5.delta('abc');
    assert.equal(e5.delta('xyz'), 'xyz', 'full rewrite');
});

test('holdBackTail', (t) => {
    const cases = [
        ['', 5, ''],
        ['abc', 0, 'abc'],
        ['abc', 2, 'a'],
        ['abc', 99, ''],
        ['你好世界', 2, '你好'],
        ['A🙂B', 1, 'A🙂'],
        ['A🙂B', 2, 'A'],
    ];
    for (const [s, n, want] of cases) {
        const got = holdBackTail(s, n);
        assert.equal(got, want, `holdBackTail(${JSON.stringify(s)}, ${n})`);
        assert.ok(!loneSurrogateRe.test(got),
            `holdBackTail(${JSON.stringify(s)}, ${n}) produced a lone surrogate`);
    }
});

test('holdBackPartialDetailsTag', () => {
    const cases = [
        ['abc', 'abc'],
        ['abc<', 'abc'],
        ['abc<d', 'abc'],
        ['abc<det', 'abc'],
        ['abc<details', 'abc'],              // complete opener literal held
        ['abc</det', 'abc'],
        ['abc</details>', 'abc</details>'],  // complete close tag stays (literal text)
        ['abc<details>', 'abc<details>'],    // splitDetails owns complete openers; not this layer
        ['abc<div>', 'abc<div>'],            // unrelated tag stays
        ['abc<details> x', 'abc<details> x'], // opener already followed by more text stays
    ];
    for (const [s, want] of cases) {
        assert.equal(holdBackPartialDetailsTag(s), want,
            `holdBackPartialDetailsTag(${JSON.stringify(s)})`);
    }
});

test('splitDetails', () => {
    const cases = [
        ['plain text', '', 'plain text'],
        ['<details>think</details>answer', 'think', 'answer'],
        ['before<details>think</details>after', 'think', 'beforeafter'],
        // A partial tag FRAGMENT ("<det") passes through splitDetails —
        // it is held back at the emission layer (holdBackPartialDetailsTag)
        // while streaming and only released as literal text by the final
        // flush if the stream really ends there.
        ['answer<det', '', 'answer<det'],
        // Complete opener literal without '>' yet: held pending entirely.
        ['answer<details', '', 'answer'],
        ['answer<details sty', '', 'answer'],
        // opener complete, reasoning still streaming
        ['a<details>thinking so far', 'thinking so far', 'a'],
        // multiple blocks
        ['<details>t1</details>x<details>t2</details>y', 't1t2', 'xy'],
        // attributes on the opener
        ['<details type="thinking">t</details>ans', 't', 'ans'],
    ];
    for (const [raw, wantReason, wantContent] of cases) {
        const [r, content] = splitDetails(raw);
        assert.equal(r, wantReason, `splitDetails(${JSON.stringify(raw)}) reasoning`);
        assert.equal(content, wantContent, `splitDetails(${JSON.stringify(raw)}) content`);
    }
});
