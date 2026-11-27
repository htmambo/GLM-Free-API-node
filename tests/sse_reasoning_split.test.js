// Port of internal/zbridge/sse_reasoning_split_repro_test.go — issue #45:
// the reasoning block must be complete before any content is forwarded, and
// once </details> closes the reasoning tail is released in full (no
// hold-back while it can no longer grow).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sseEvent, runSSEParser } from './sse_helpers.js';
import { config } from '../src/config.js';

// appendEvents streams `add` one code point at a time, the way Z.AI streams
// edit_content (content = substring(0, edit_index) + edit_content).
function appendEvents(existing, add) {
    let body = '';
    let cur = existing;
    for (const ch of add) {
        body += sseEvent(JSON.stringify({ data: { edit_content: ch, edit_index: cur.length } }));
        cur += ch;
    }
    return { body, text: cur };
}

async function replay(t, raw) {
    const events = await runSSEParser(t, raw);
    const reasoning = events.filter((r) => r.reasoning !== '').map((r) => r.reasoning).join('');
    const content = events.filter((r) => r.reasoning === '' && r.chunk !== '').map((r) => r.chunk).join('');
    // Index of the first content delta relative to the last reasoning delta.
    let lastReasoning = -1;
    let firstContent = -1;
    events.forEach((r, i) => {
        if (r.reasoning !== '') lastReasoning = i;
        if (r.reasoning === '' && r.chunk !== '' && firstContent === -1) firstContent = i;
    });
    return { reasoning, content, lastReasoning, firstContent, events };
}

test('TestReasoningCompleteBeforeContent', async (t) => {
    const saved = config.streamHoldback;
    config.streamHoldback = 24;
    t.after(() => { config.streamHoldback = saved; });

    const reasoningText = 'First: OS release\nSecond: `cat /etc/os-release`\nThird: done';
    const answer = 'The OS is Linux.';
    const reasoning = appendEvents('', `<details type="reasoning">\n> ${reasoningText.replaceAll('\n', '\n> ')}\n</details>`);
    const content = appendEvents(reasoning.text, answer);

    const body = reasoning.body + content.body + sseEvent('{"data":{"phase":"done"}}') + sseEvent('[DONE]');
    const got = await replay(t, body);

    assert.ok(got.reasoning.includes('Third: done'), `reasoning tail missing: ${JSON.stringify(got.reasoning)}`);
    assert.ok(got.content.includes('The OS is Linux.'), `content missing: ${JSON.stringify(got.content)}`);
    assert.ok(got.lastReasoning < got.firstContent,
        `reasoning (#${got.lastReasoning}) must complete before content (#${got.firstContent})`);
});

test('TestReasoningReleasedWhenBlockCloses', async (t) => {
    const saved = config.streamHoldback;
    config.streamHoldback = 64; // deliberately larger than the reasoning text
    t.after(() => { config.streamHoldback = saved; });

    // Only the reasoning block: once </details> arrives, everything must be
    // released even though the stream is not over yet.
    const reasoningText = 'step one\nstep two\nstep three';
    const { body } = appendEvents('', `<details type="reasoning">\n> ${reasoningText.replaceAll('\n', '\n> ')}\n</details>`);

    // Feed the closing tag, then a non-terminal event (no [DONE] yet).
    const events = [];
    for await (const r of (await import('../src/zai.js')).streamSSEResponse(
        body + sseEvent('{"data":{"delta_content":""}}'))) {
        if (r.error) assert.fail(r.error.message);
        events.push(r);
    }
    const released = events.filter((r) => r.reasoning !== '').map((r) => r.reasoning).join('');
    assert.ok(released.includes('step three'),
        `closed reasoning block must be released in full, got ${JSON.stringify(released)}`);
});
