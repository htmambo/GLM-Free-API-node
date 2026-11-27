// Port of internal/zbridge/sse_toolcall_test.go — end-to-end verification of
// STREAMED tool calls: a synthetic Z.AI upstream SSE stream containing a
// tool-call block is run through the REAL streamSSEResponse parser, replayed
// through the interceptor + delta-emission logic of chatCompletionsHandler,
// and the client-visible chunks are asserted against the OpenAI streaming
// contract:
//
//   - the tool-call header (index + id + type + function.name) is emitted
//     WHILE the model is still writing the block — before <<<END_TOOL_CALL>>>
//     ever arrives upstream;
//   - arguments arrive as incremental function.arguments fragments that an
//     OpenAI SDK reassembles by index into the exact JSON object;
//   - every emitted fragment is valid text (no issue #23 garble);
//   - no marker/JSON bytes leak as content.
//
// DEPENDENCY GATE: the agent-mode interceptor (newAgentInterceptor /
// AgentStreamInterceptor / parseAgentToolCalls) lives in src/agent.js, a
// LATER PHASE port. While that module does not exist, every test in this
// file skips itself via t.skip; once agent.js lands they activate unchanged.
// Expected JS API (camelCase, mirroring sessionPool.js naming):
//   newAgentInterceptor()            -> { feed(chunk) -> {content, toolCalls}, finish() -> {content, toolCalls} }
//   new AgentStreamInterceptor()     -> same shape (Feed/Finish in Go)
//   parseAgentToolCalls(text)        -> [{ id, type, function: { name, arguments } }, ...]
//
// Deviations from the Go test:
//   - splitRunes cuts by UTF-16 code units (Go cuts by bytes — "ASCII input
//     assumed"; the CJK sweep stream is therefore chunked at different, but
//     equally adversarial, boundaries).
//   - The randomized sweep uses a mulberry32 PRNG seeded 234567 instead of
//     Go's math/rand (different sequence, same shape of coverage).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import { sseEvent, runSSEParser, loneSurrogateRe } from './sse_helpers.js';

let agent = null;
try {
    agent = await import('../src/agent.js');
} catch { /* src/agent.js not yet ported (Phase 3) — tests self-skip */ }

const newAgentInterceptor = agent?.newAgentInterceptor;
const AgentStreamInterceptor = agent?.AgentStreamInterceptor;
const parseAgentToolCalls = agent?.parseAgentToolCalls ?? agent?.ParseAgentToolCalls;

function skipIfNoAgent(t) {
    if (agent) return false;
    t.skip('src/agent.js not yet ported (Phase 3) — activate when it lands');
    return true;
}

// withAgentVariant pins config.agentModeVariant for the duration of fn.
async function withAgentVariant(variant, fn) {
    const old = config.agentModeVariant;
    config.agentModeVariant = variant;
    try {
        return await fn();
    } finally {
        config.agentModeVariant = old;
    }
}

// splitRunes cuts s into pieces of n code units (Go cuts bytes; ASCII input
// assumed there — here unit-cuts give the equivalent coverage).
function splitRunes(s, n) {
    const out = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out;
}

// mulberry32 — small deterministic PRNG for the randomized sweep.
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a |= 0; a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// feed/finish adapters: accept either camelCase ({content, toolCalls}) or
// Go-style PascalCase ({Content, ToolCalls}) results from the interceptor.
function feedCall(in_, piece) {
    const r = in_.feed ? in_.feed(piece) : in_.Feed(piece);
    return {
        content: r.content ?? r.Content ?? '',
        toolCalls: r.toolCalls ?? r.ToolCalls ?? [],
    };
}
function finishCall(in_) {
    const r = in_.finish ? in_.finish() : in_.Finish();
    return {
        content: r.content ?? r.Content ?? '',
        toolCalls: r.toolCalls ?? r.ToolCalls ?? [],
    };
}

// sseToolCallStream drives the full pipeline: upstream Z.AI SSE bytes →
// real parser → real interceptor → handler-identical delta emission.
//
// Returns { toolDeltas, calls, deltasBeforeBlockClose, finalContent } — how
// many tool-call deltas were emitted while the upstream was still INSIDE
// the block is the crucial regression signal.
async function sseToolCallStream(t, upstreamText, chunkEvery) {
    // 1. Build the upstream SSE body, chunking the assistant text into
    //    delta_content events exactly like Z.AI does.
    let body = '';
    for (let i = 0; i < upstreamText.length; i += chunkEvery) {
        const piece = upstreamText.slice(i, i + chunkEvery);
        const payload = JSON.stringify({ delta_content: piece });
        body += `data: {"data":${payload}}\n\n`;
    }
    body += sseEvent('{"data":{"phase":"done"}}');
    body += 'data: [DONE]\n\n';

    // 2. Run the real upstream parser.
    const results = await runSSEParser(t, body);

    // 3. Replay the exact chatCompletionsHandler stream logic (agent-mode
    //    branch): fullContent accumulation + interceptor feed + tool-call
    //    delta emission.
    const interceptor = newAgentInterceptor();
    let fullContent = '';
    let finalContent = '';
    let sawEndMarker = false;
    const toolDeltas = [];
    let calls = 0;
    let deltasBeforeBlockClose = 0;
    for (const result of results) {
        if (result.reasoning !== '') continue;
        if (result.fullText !== '') {
            fullContent = result.fullText;
        } else {
            fullContent += result.chunk;
        }
        const delta = result.chunk;
        if (delta === '') continue;
        if (fullContent.includes('END_TOOL_CALL')) {
            sawEndMarker = true; // the handler has now SEEN the closing marker
        }
        const { content, toolCalls } = feedCall(interceptor, delta);
        if (content !== '') finalContent += content;
        for (const tc of toolCalls) {
            if (typeof tc.id === 'string' && tc.id !== '') calls++;
            if (!sawEndMarker) deltasBeforeBlockClose++;
            toolDeltas.push(tc);
        }
    }
    const tail = finishCall(interceptor);
    finalContent += tail.content;
    for (const tc of tail.toolCalls) {
        if (typeof tc.id === 'string' && tc.id !== '') calls++;
        toolDeltas.push(tc);
    }
    return { toolDeltas, calls, deltasBeforeBlockClose, finalContent };
}

// Proves the fix end to end: the client must see tool-call SSE deltas while
// the model is still writing the tool-call block — not one buffered blob
// after <<<END_TOOL_CALL>>>.
test('SSE tool calls stream while block is open', async (t) => {
    if (skipIfNoAgent(t)) return;
    await withAgentVariant('modern', async () => {
        // The exact scenario from the goal: a calculate tool with an
        // arguments object the model writes out incrementally.
        const upstream = '<<<TOOL_CALL>>>\n' +
            '{"name":"calculate","arguments":{"operation": "multiply", "a": 234, "b": 567}}' +
            '\n<<<END_TOOL_CALL>>>';

        const { toolDeltas, calls, deltasBeforeBlockClose, finalContent } =
            await sseToolCallStream(t, upstream, 13);
        assert.equal(calls, 1, 'logical tool calls');
        assert.ok(deltasBeforeBlockClose > 0,
            'no tool-call delta streamed before <<<END_TOOL_CALL>>> arrived — buffered behaviour regressed');

        // Header delta carries the OpenAI fields: index, id, type, name.
        let header = null;
        let headerIndex = 0;
        for (const tc of toolDeltas) {
            if (typeof tc.id === 'string' && tc.id !== '') {
                header = tc;
                if (typeof tc.index === 'number') headerIndex = tc.index;
            }
        }
        assert.ok(header, 'no header delta emitted');
        assert.ok(header.id.startsWith('call_'), `header id = ${header.id}, want call_*`);
        assert.equal(header.type, 'function');
        assert.equal(header.function?.name, 'calculate');

        // Fragments reassemble by index into the exact arguments JSON.
        const argsByIndex = new Map();
        for (const tc of toolDeltas) {
            const frag = tc.function?.arguments ?? '';
            assert.ok(!loneSurrogateRe.test(frag),
                `argument fragment is invalid (client garble): ${JSON.stringify(frag)}`);
            argsByIndex.set(tc.index, (argsByIndex.get(tc.index) ?? '') + frag);
        }
        assert.equal(argsByIndex.get(headerIndex),
            '{"operation": "multiply", "a": 234, "b": 567}', 'reassembled arguments');

        // No marker or JSON leaks as content.
        assert.ok(!finalContent.includes('TOOL_CALL') && !finalContent.includes('calculate'),
            `tool-call block leaked as content: ${JSON.stringify(finalContent)}`);
    });
});

// Worst-case upstream chunking (a few bytes per event) — the streamed
// arguments must still reassemble exactly.
test('SSE tool calls: byte-split fragments', async (t) => {
    if (skipIfNoAgent(t)) return;
    await withAgentVariant('modern', async () => {
        const upstream = '<<<TOOL_CALL>>>\n' +
            '{"name":"calculate","arguments":{"a": 234, "b": 567, "operation": "multiply"}}' +
            '\n<<<END_TOOL_CALL>>>';
        const { toolDeltas, calls, deltasBeforeBlockClose, finalContent } =
            await sseToolCallStream(t, upstream, 4);
        assert.equal(calls, 1, 'logical tool calls');
        assert.ok(deltasBeforeBlockClose > 0, 'no delta streamed before the block closed');
        let idx0 = '';
        for (const tc of toolDeltas) {
            if (tc.index === 0) idx0 += tc.function?.arguments ?? '';
        }
        assert.equal(idx0, '{"a": 234, "b": 567, "operation": "multiply"}',
            'reassembled arguments');
        assert.ok(!finalContent.includes('TOOL_CALL'),
            `marker leaked as content: ${JSON.stringify(finalContent)}`);
    });
});

// The same upstream text must parse to the equivalent complete call on the
// non-stream path (parseAgentToolCalls): streaming did not change the
// finished-text contract. (The finished-text parser compacts the JSON; the
// streamed arguments preserve the model's spacing verbatim, so compare the
// decoded objects.)
test('SSE tool call non-stream parity', (t) => {
    if (skipIfNoAgent(t)) return;
    const text = '<<<TOOL_CALL>>>\n{"name":"calculate","arguments":{"a": 234, "b": 567, "operation": "multiply"}}\n<<<END_TOOL_CALL>>>';
    const calls = parseAgentToolCalls(text);
    assert.equal(calls.length, 1, 'parseAgentToolCalls call count');
    assert.equal(calls[0].function?.name, 'calculate');
    const got = JSON.parse(calls[0].function.arguments);
    assert.deepEqual(got, { a: 234, b: 567, operation: 'multiply' });
});

// Sweeps EVERY chunk size and randomized split patterns through the
// interceptor and asserts the streaming invariants hold at every boundary:
//   1. exactly one header delta per block, with a stable id and name;
//   2. fragments reassemble, by index, into the exact arguments JSON;
//   3. every fragment is valid text (issue #23);
//   4. no marker/JSON bytes leak as content.
test('stream chunk sweep invariants', async (t) => {
    if (skipIfNoAgent(t)) return;
    await withAgentVariant('modern', async () => {
        const streams = [
            '<<<TOOL_CALL>>>\n{"name":"calculate","arguments":{"a": 234, "b": 567, "operation": "multiply"}}\n<<<END_TOOL_CALL>>>',
            'Reasoning first.\n<<<TOOL_CALL>>>\n{"name":"translate","arguments":{"text":"你好，世界","to":"en"}}\n<<<END_TOOL_CALL>>>\nafter',
            '<<TOOL_CALL>>>\n{"tool":"bash","parameters":{"command":"uname -m","timeout":10}}\n<<<END_TOOL_CALL>>>',
            '<<<TOOL_CALL>>>\n{"name":"echo","arguments":{}}\n<<<END_TOOL_CALL>>>',
        ];
        const wantArgs = [
            '{"a": 234, "b": 567, "operation": "multiply"}',
            '{"text":"你好，世界","to":"en"}',
            '{"command":"uname -m","timeout":10}',
            '{}',
        ];

        for (let si = 0; si < streams.length; si++) {
            const stream = streams[si];
            for (let size = 1; size <= stream.length; size++) {
                const chunks = splitRunes(stream, size);
                const in_ = new AgentStreamInterceptor();
                let content = '';
                const argsByIndex = new Map();
                let headers = 0;
                let name = '';
                let id = '';
                const collect = (tcs) => {
                    for (const tc of tcs) {
                        const frag = tc.function?.arguments ?? '';
                        assert.ok(!loneSurrogateRe.test(frag),
                            `stream ${si} size ${size}: invalid fragment ${JSON.stringify(frag)}`);
                        argsByIndex.set(tc.index, (argsByIndex.get(tc.index) ?? '') + frag);
                        if (typeof tc.id === 'string' && tc.id !== '') {
                            headers++;
                            id = tc.id;
                            name = tc.function?.name ?? '';
                        }
                    }
                };
                for (const piece of chunks) {
                    const parsed = feedCall(in_, piece);
                    content += parsed.content;
                    collect(parsed.toolCalls);
                }
                const f = finishCall(in_);
                content += f.content;
                collect(f.toolCalls);

                assert.equal(headers, 1, `stream ${si} size ${size}: header deltas`);
                assert.ok(name !== '' && id !== '',
                    `stream ${si} size ${size}: header lost name/id`);
                assert.equal(argsByIndex.get(0), wantArgs[si],
                    `stream ${si} size ${size}: reassembled arguments`);
                assert.ok(!content.includes('TOOL_CALL'),
                    `stream ${si} size ${size}: marker leaked: ${JSON.stringify(content)}`);
            }
        }

        // Randomized chunk boundaries (deterministic seed).
        const rnd = mulberry32(234567);
        for (let trial = 0; trial < 200; trial++) {
            const stream = streams[trial % streams.length];
            const want = wantArgs[trial % wantArgs.length];
            const in_ = new AgentStreamInterceptor();
            let args = '';
            let headers = 0;
            for (let pos = 0; pos < stream.length;) {
                let n = 1 + Math.floor(rnd() * 12);
                if (pos + n > stream.length) n = stream.length - pos;
                const parsed = feedCall(in_, stream.slice(pos, pos + n));
                for (const tc of parsed.toolCalls) {
                    const frag = tc.function?.arguments ?? '';
                    assert.ok(!loneSurrogateRe.test(frag),
                        `trial ${trial}: invalid fragment ${JSON.stringify(frag)}`);
                    args += frag;
                    if (typeof tc.id === 'string' && tc.id !== '') headers++;
                }
                pos += n;
            }
            const f = finishCall(in_);
            for (const tc of f.toolCalls) {
                args += tc.function?.arguments ?? '';
                if (typeof tc.id === 'string' && tc.id !== '') headers++;
            }
            assert.equal(headers, 1, `trial ${trial}: headers`);
            assert.equal(args, want, `trial ${trial}: reassembled`);
        }
    });
});
