// agent.test.js — port of internal/zbridge/agent_test.go
//
// Tests for the modern agent-mode shim (src/agent.js), ported from the
// DeepseekFreeAPI reference implementation and extended with GLM-Free-API
// dispatch/integration coverage. All tests are pure-logic; the Go file
// contains no HTTP-handler-driven cases (those belong to Phase 4).
//
// Deviations from the Go test:
//   - splitRunes cuts by UTF-16 code units (Go cuts bytes — "ASCII input
//     assumed"); multi-byte coverage comes from code-unit boundaries instead.
//   - utf8.ValidString(fragment) becomes the lone-surrogate check (JS
//     strings cannot hold invalid UTF-8; a split surrogate pair is the
//     equivalent garble).
//   - json.RawMessage fields (Content, Arguments) become plain JS values
//     (strings / parsed objects); JSON-encoding stays equivalent.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import {
    agentToolStart,
    agentToolEnd,
    agentStartWord,
    agentEndWord,
    agentWorstMarkerLen,
    markerIncomplete,
    bracketRunBack,
    findAgentMarker,
    parseAgentToolCalls,
    stripAgentToolCalls,
    normalizeAgentFences,
    trimTrailingAgentFence,
    skipLeadingAgentFence,
    agentEndMarkerPrefix,
    agentPrefixNo,
    agentPrefixMaybe,
    agentPrefixComplete,
    agentSystemPrefix,
    maxRecentToolExchanges,
    buildAgentPrompt,
    wrapAgentPromptAsMessages,
    agentTransformMessages,
    agentExtractToolCalls,
    agentStripToolCalls,
    AgentStreamInterceptor,
    ModernAgentInterceptor,
    LegacyAgentInterceptor,
} from '../src/agent.js';
import { newAgentStreamInterceptor } from '../src/agentLegacy.js';
import { loneSurrogateRe } from './sse_helpers.js';

// splitRunes cuts s into pieces of n code units (Go cuts bytes; ASCII input
// assumed there — unit cuts give the equivalent coverage here).
function splitRunes(s, n) {
    const out = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out;
}

// feedChunks replays chunks through the streaming interceptor. It counts
// LOGICAL tool calls (deltas carrying an id open a call; id-less deltas are
// argument fragments of the open call) and returns the arguments accumulated
// across all fragments — mirroring how an OpenAI SDK reassembles the stream.
function feedChunks(chunks, step) {
    const in_ = new AgentStreamInterceptor();
    let content = '';
    let toolCalls = 0;
    let args = '';
    const collect = (parsed) => {
        content += parsed.content;
        for (const call of parsed.toolCalls) {
            if (typeof call.id === 'string' && call.id !== '') toolCalls++;
            args += call.function?.arguments ?? '';
        }
    };
    for (let i = 0; i < chunks.length; i += step) {
        let piece = '';
        for (let j = i; j < i + step && j < chunks.length; j++) piece += chunks[j];
        collect(in_.feed(piece));
    }
    collect(in_.finish());
    return { content, toolCalls, args };
}

// withAgentVariant swaps the configured agent variant for the duration of fn
// and restores it afterwards (Go: t.Cleanup).
function withAgentVariant(variant, fn) {
    const prevMode = config.agentMode;
    const prevVariant = config.agentModeVariant;
    config.agentMode = true;
    config.agentModeVariant = variant;
    try {
        return fn();
    } finally {
        config.agentMode = prevMode;
        config.agentModeVariant = prevVariant;
    }
}

// callFn extracts the function map from a tool-call delta map.
function callFn(tc) {
    return tc.function ?? {};
}

// ── marker finder ────────────────────────────────────────────────────────────

test('TestFindAgentMarkerVariants', () => {
    const cases = [
        ['<<<TOOL_CALL>>>', 0, 15],     // canonical
        ['<<TOOL_CALL>>>', 0, 14],      // live failure: one '<' short
        ['<<<TOOL_CALL>>', 0, 14],      // one '>' short
        ['<<<<TOOL_CALL>>>>', 0, 17],   // worst tolerated spelling
        ['x <<<TOOL_CALL>>> y', 2, 15], // embedded
        ['<TOOL_CALL>', -1, 0],         // too few brackets
        ['<<<TOOL_CALL>', -1, 0],       // unterminated
        ['TOOL_CALL', -1, 0],           // bare word
        ['<<<<<<<TOOL_CALL>>>', -1, 0], // bracket run longer than tolerated
    ];
    for (const [input, wantAt, wantLn] of cases) {
        const [at, ln] = findAgentMarker(input, agentStartWord, true);
        assert.ok(at === wantAt && (wantAt < 0 || ln === wantLn),
            `findAgentMarker(${JSON.stringify(input)}) = (${at},${ln}), want (${wantAt},${wantLn})`);
    }
    // The TOOL_CALL inside an END marker must never be taken as a start.
    {
        const [at] = findAgentMarker(agentToolEnd, agentStartWord, true);
        assert.equal(at, -1, 'END marker matched as start');
    }
    assert.equal(bracketRunBack('a<<<b', 4, '<'), 3, 'bracketRunBack');
    assert.equal(agentWorstMarkerLen, '<<<<TOOL_CALL>>>>'.length, 'agentWorstMarkerLen');

    // Streaming mode: a trailing '>' run touching the end of the data must
    // wait instead of matching short — this keeps the third '>' of a
    // canonical marker from leaking when chunks split the marker.
    for (const [input, word] of [
        ['a <<<TOOL_CALL>>', agentStartWord],
        ['x <<<END_TOOL_CALL>>', agentEndWord],
    ]) {
        const [at] = findAgentMarker(input, word, false);
        assert.equal(at, markerIncomplete,
            `findAgentMarker(${JSON.stringify(input)}, final=false)`);
    }
    {
        const [at] = findAgentMarker('<<<TOOL_CALL>> x', agentStartWord, false);
        assert.equal(at, 0, 'terminated short run should match at 0');
    }
});

// ── finished-text parsing ────────────────────────────────────────────────────

// The exact RESPONSE payload reconstructed from the failing debug session
// (deepseek-v4-pro, "Find my public ip").
const malformedPayload = '<<TOOL_CALL>>>\n{"name":"bash","arguments":{"command":"curl -s https://api.ipify.org"}}\n<<<END_TOOL_CALL>>>';

test('TestParseAgentToolCallsTolerantMarkers', () => {
    const cases = [
        [malformedPayload, 'api.ipify.org'],
        ['Let me check.\n' + malformedPayload + '\n', 'api.ipify.org'],
        ['<<<<TOOL_CALL>>>>\n{"name":"bash","arguments":{}}\n<<<<END_TOOL_CALL>>>>', '{}'],
    ];
    for (const [text, wantArgs] of cases) {
        const calls = parseAgentToolCalls(text);
        assert.equal(calls.length, 1, `parseAgentToolCalls(${JSON.stringify(text.slice(0, 12))}...)`);
        assert.equal(calls[0].function.name, 'bash');
        assert.ok(calls[0].function.arguments.includes(wantArgs),
            `arguments = ${calls[0].function.arguments}, want substring ${wantArgs}`);
        const stripped = stripAgentToolCalls(text);
        assert.ok(!stripped.includes('TOOL_CALL'), `strip left markers: ${JSON.stringify(stripped)}`);
    }
});

test('TestNormalizeAgentFencesTolerantMarkers', () => {
    const input = '```json\n<<TOOL_CALL>>>\n{"name":"bash","arguments":{}}\n<<<END_TOOL_CALL>>>\n```\ndone';
    const want = '<<TOOL_CALL>>>\n{"name":"bash","arguments":{}}\n<<<END_TOOL_CALL>>>\ndone';
    assert.equal(normalizeAgentFences(input), want);
});

// ── payload tolerance ────────────────────────────────────────────────────────
//
// Second live failure mode: the markers were canonical, but the model invented
// a FLAT payload shape — {"tool": "bash", "command": ..., "timeout": 10}
// instead of {"name": ..., "arguments": {...}}.

// The exact RESPONSE text reconstructed from the failing debug session.
const flatPayload = '<<<TOOL_CALL>>>{"tool": "bash", "command": "curl -s ifconfig.me", "timeout": 10}<<<END_TOOL_CALL>>>';

test('TestParseAgentToolCallsFlatPayload', () => {
    const calls = parseAgentToolCalls(flatPayload);
    assert.equal(calls.length, 1, 'parseAgentToolCalls(flat payload)');
    assert.equal(calls[0].function.name, 'bash');
    const args = calls[0].function.arguments;
    assert.ok(args.includes('"command":"curl -s ifconfig.me"') && args.includes('"timeout":10'),
        `arguments = ${args}, want flat keys folded into an arguments object`);
    const stripped = stripAgentToolCalls(flatPayload);
    assert.ok(!stripped.includes('TOOL_CALL') && stripped.trim() === '',
        `strip left residue: ${JSON.stringify(stripped)}`);
});

test('TestParseAgentToolCallsPayloadVariants', () => {
    const cases = [
        // canonical shape keeps working
        ['{"name":"bash","arguments":{"command":"id"}}', 'bash', '"command":"id"'],
        // alternate explicit-arguments spellings
        ['{"name":"bash","parameters":{"command":"id"}}', 'bash', '"command":"id"'],
        ['{"tool":"bash","arguments":{"command":"id"}}', 'bash', '"command":"id"'],
        // alternate name keys with flat parameters
        ['{"tool_name":"read","path":"/etc/hosts"}', 'read', '"/etc/hosts"'],
        ['{"function":"bash","command":"uname"}', 'bash', '"uname"'],
        // flat payload keyed on "name"
        ['{"name":"bash","command":"pwd","timeout":5}', 'bash', '"command":"pwd"'],
        // a tool parameter literally named "name" must not shadow the tool key
        ['{"tool":"write","name":"a.txt","content":"x"}', 'write', '"content":"x"'],
        // no parameters at all
        ['{"tool":"bash"}', 'bash', '{}'],
    ];
    for (const [body, wantName, wantArgs] of cases) {
        const text = '<<<TOOL_CALL>>>' + body + '<<<END_TOOL_CALL>>>';
        const calls = parseAgentToolCalls(text);
        assert.equal(calls.length, 1, `body ${body}`);
        assert.equal(calls[0].function.name, wantName, `body ${body} name`);
        assert.ok(calls[0].function.arguments.includes(wantArgs),
            `body ${body} => arguments ${calls[0].function.arguments}, want substring ${wantArgs}`);
    }
    // No recognizable tool name at all: stays visible text (existing policy).
    assert.equal(parseAgentToolCalls('<<<TOOL_CALL>>>{"command":"ls"}<<<END_TOOL_CALL>>>').length, 0,
        'nameless payload produced calls');
});

// goalFragmentChunks are the upstream SSE fragment appends of the failing
// session, byte for byte (initial RESPONSE fragment content "<<", then every
// APPEND/"v" delta from the debug log).
const goalFragmentChunks = [
    '<<', '<', 'TO', 'OL', '_C', 'ALL', '>>>',
    '{"', 'tool', '":', ' "', 'bash', '",', ' "', 'command', '":',
    ' "', 'curl', ' -', 's', ' if', 'config', '.me', '",', ' "',
    'time', 'out', '":', ' ', '10', '}',
    '<<', '<', 'END', '_TO', 'OL', '_C', 'ALL', '>>>',
];

test('TestStreamInterceptorReplaysFlatPayloadDebugStream', () => {
    for (const step of [1, 3, 7]) {
        const { content, toolCalls: calls, args } = feedChunks(goalFragmentChunks, step);
        assert.equal(calls, 1, `step=${step} (content=${JSON.stringify(content)})`);
        assert.ok(args.includes('ifconfig.me') && args.includes('"timeout":10'),
            `step=${step}: arguments ${JSON.stringify(args)} missing flat payload parameters`);
        assert.ok(!content.includes('TOOL_CALL') && content.trim() === '',
            `step=${step}: markers or junk leaked as content: ${JSON.stringify(content)}`);
    }
});

// The prompt must pin the payload schema: the bare "{JSON}" placeholder is
// what let the model invent the flat shape in the first place.
test('TestAgentPromptPinsPayloadSchema', () => {
    const prompt = buildAgentPrompt(
        [{ role: 'user', content: 'Find my public ip' }],
        [{ type: 'function', function: { name: 'bash' } }],
    );
    for (const want of [
        '<<<TOOL_CALL>>>\n{"name":"<tool_name>","arguments":{<parameter JSON>}}\n<<<END_TOOL_CALL>>>',
        'exactly two keys',
        'literal scanner',
        '"name"',
        '"arguments"',
    ]) {
        assert.ok(prompt.includes(want), `agent prompt missing schema fragment ${JSON.stringify(want)}`);
    }
    assert.ok(!prompt.includes('{JSON}'),
        'agent prompt still carries the underspecified {JSON} placeholder');
});

// ── streaming interceptor ────────────────────────────────────────────────────

// Replays the RESPONSE fragment chunks exactly as they arrived in the failing
// session's upstream SSE log, byte for byte.
const debugFragmentChunks = [
    '<<', '<', 'TO', 'OL', '_C', 'ALL', '>>', '>\n',
    '{"', 'name', '":"', 'bash', '","',
    'arguments', '":{"', 'command', '":"', 'curl',
    ' -', 's', ' https', '://', 'api', '.ip', 'ify', '.org', '"', '}}\n',
    '<<', '<', 'END', '_TO', 'OL', '_C', 'ALL', '>>>',
];

test('TestStreamInterceptorReplaysMalformedDebugStream', () => {
    for (const step of [1, 3, 7]) { // one chunk / log-like bursts / coarse
        const { content, toolCalls: calls, args } = feedChunks(debugFragmentChunks, step);
        assert.equal(calls, 1, `step=${step} (content=${JSON.stringify(content)})`);
        assert.ok(args.includes('api.ipify.org'),
            `step=${step}: arguments ${JSON.stringify(args)} missing ipify command`);
        assert.ok(!content.includes('TOOL_CALL') && content.trim() === '',
            `step=${step}: markers or junk leaked as content: ${JSON.stringify(content)}`);
    }
});

test('TestStreamInterceptorShortTailVariant', () => {
    const stream = 'checking…\n```json\n<<<TOOL_CALL>>\n{"name":"bash","arguments":{"command":"uname"}}\n<<<END_TOOL_CALL>>>\n```\n';
    const { content, toolCalls: calls } = feedChunks(splitRunes(stream, 3), 1);
    assert.equal(calls, 1, 'tool calls');
    assert.ok(!content.includes('```') && !content.includes('TOOL_CALL'),
        `leaked: ${JSON.stringify(content)}`);
    assert.ok(content.includes('checking'), `prose damaged: ${JSON.stringify(content)}`);
});

// An unterminated opening marker must not hang the stream nor be parsed.
test('TestStreamInterceptorUnterminatedMarkerStaysContent', () => {
    const in_ = new AgentStreamInterceptor();
    const parsed = in_.feed('<TOOL_CALL> just talking about tools');
    const final = in_.finish();
    const out = parsed.content + final.content;
    assert.equal(parsed.toolCalls.length + final.toolCalls.length, 0,
        'single-bracket text produced tool calls');
    assert.equal(out, '<TOOL_CALL> just talking about tools', 'single-bracket text altered');
});

// Invalid JSON inside a recognized block stays visible text (existing policy).
test('TestStreamInvalidBlockLeaksAsContent', () => {
    const { content, toolCalls: calls } = feedChunks(splitRunes('<<TOOL_CALL>>>\nnot json\n<<<END_TOOL_CALL>>>', 4), 1);
    assert.equal(calls, 0, 'calls for invalid block');
    assert.ok(content.includes('not json'),
        `invalid block vanished instead of leaking: ${JSON.stringify(content)}`);
});

test('TestStreamTwoSequentialBlocks', () => {
    const stream = '<<TOOL_CALL>>>\n{"name":"a","arguments":{}}\n<<<END_TOOL_CALL>>>\n<<TOOL_CALL>>>\n{"name":"b","arguments":{}}\n<<<END_TOOL_CALL>>>';
    const in_ = new AgentStreamInterceptor();
    const names = [];
    const argsByIndex = new Map();
    const collect = (parsed) => {
        for (const call of parsed.toolCalls) {
            const idx = call.index;
            const fn = callFn(call);
            if (typeof call.id === 'string' && call.id !== '') {
                // header delta: names ride on headers only
                if (typeof fn.name === 'string' && fn.name !== '') names.push(fn.name);
            }
            argsByIndex.set(idx, (argsByIndex.get(idx) ?? '') + (fn.arguments ?? ''));
        }
    };
    for (let i = 0; i < stream.length; i += 5) {
        collect(in_.feed(stream.slice(i, i + 5)));
    }
    collect(in_.finish());
    const final = in_.finish();
    assert.ok(!final.content.includes('TOOL_CALL'),
        `trailing markers flushed: ${JSON.stringify(final.content)}`);
    assert.deepEqual(names, ['a', 'b']);
    assert.equal(argsByIndex.get(0), '{}', 'call 0 arguments');
    assert.equal(argsByIndex.get(1), '{}', 'call 1 arguments');
});

// ── incremental tool-call streaming (streamable tool calls) ──────────────────
//
// The interceptor must emit tool-call deltas WHILE the model is still writing
// the block — an id/name header as soon as {"name": ...,"arguments": { has
// arrived, then live argument fragments — not one buffered blob after
// <<<END_TOOL_CALL>>>. These deltas mirror the OpenAI chunk contract:
// header deltas carry index/id/type/name, fragment deltas carry index and a
// function.arguments piece, and an SDK reassembles arguments by index.

test('TestStreamHeaderEmittedBeforeBlockCloses', () => {
    const in_ = new AgentStreamInterceptor();
    // Opening marker + a name + an arguments object still in flight: the
    // client must already see the tool-call header SSE.
    let parsed = in_.feed('Sure.\n<<<TOOL_CALL>>>\n{"name":"calculate","arguments":{"operation":"mult');
    assert.ok(parsed.toolCalls.length > 0,
        'no tool-call header streamed before block close');
    const header = parsed.toolCalls[0];
    assert.ok(typeof header.id === 'string' && header.id.startsWith('call_'),
        `header id = ${header.id}, want call_*`);
    assert.equal(header.type, 'function');
    assert.equal(header.function.name, 'calculate');
    assert.equal(header.index, 0);
    // Prose before the marker streamed as content; the block body did not.
    assert.ok(parsed.content.includes('Sure.'), 'prose before marker not streamed');
    assert.ok(!parsed.content.includes('name') && !parsed.content.includes('TOOL_CALL'),
        `block body leaked as content: ${JSON.stringify(parsed.content)}`);
    // The fragment that already arrived rides the header delta (OpenAI does
    // the same when one chunk covers the name and the first argument bytes).
    const headerArgs = header.function.arguments;
    assert.equal(headerArgs, '{"operation":"mult', 'header arguments');

    // Rest of the arguments stream as id-less fragments referencing the
    // header's index, then the block closes.
    parsed = in_.feed('iply","a": 234, "b": 567}}\n<<<END_TOOL_CALL>>>');
    let args = headerArgs;
    for (const tc of parsed.toolCalls) {
        assert.ok(!(typeof tc.id === 'string' && tc.id !== ''),
            'unexpected second header mid-call');
        assert.equal(tc.index, 0, 'fragment index');
        args += tc.function?.arguments ?? '';
    }
    assert.equal(args, '{"operation":"multiply","a": 234, "b": 567}', 'reassembled arguments');
    assert.equal(parsed.content, '', 'content leaked');

    // Nothing left after the block.
    const fin = in_.finish();
    assert.ok(fin.content === '' && fin.toolCalls.length === 0, 'finish left residue');
});

test('TestStreamArgumentsByteByByte', () => {
    // Worst-case upstream: 1-char chunks, including the markers and JSON
    // split at every boundary. The reassembled arguments must be exact
    // and every fragment must ride a consistent index.
    const stream = '<<<TOOL_CALL>>>\n{"name":"search","arguments":{"query":"what is 234*567","limit":3}}\n<<<END_TOOL_CALL>>>';
    const in_ = new AgentStreamInterceptor();
    const argsByIndex = new Map();
    let headers = 0;
    let name = '';
    const accumulate = (tcs) => {
        for (const tc of tcs) {
            const idx = tc.index;
            const fn = callFn(tc);
            argsByIndex.set(idx, (argsByIndex.get(idx) ?? '') + (fn.arguments ?? ''));
            if (typeof tc.id === 'string' && tc.id !== '') {
                headers++;
                name = fn.name ?? '';
            }
        }
    };
    for (const piece of splitRunes(stream, 1)) accumulate(in_.feed(piece).toolCalls);
    accumulate(in_.finish().toolCalls);
    assert.ok(headers === 1 && name === 'search', `headers = ${headers} (${name})`);
    assert.equal(argsByIndex.get(0), '{"query":"what is 234*567","limit":3}');
});

test('TestStreamArgumentFragmentsAreValidUTF8', () => {
    // Argument string values carrying multi-unit code points, cut mid-pair
    // by the chunker (issue #23): no fragment may surface a lone surrogate.
    const stream = '<<<TOOL_CALL>>>\n{"name":"translate","arguments":{"text":"你好，世界 🙂 安心","to":"en"}}\n<<<END_TOOL_CALL>>>';
    const in_ = new AgentStreamInterceptor();
    let args = '';
    const collect = (tcs) => {
        for (const tc of tcs) {
            const frag = tc.function?.arguments ?? '';
            assert.ok(!loneSurrogateRe.test(frag),
                `argument fragment contains a lone surrogate (client garble): ${JSON.stringify(frag)}`);
            args += frag;
        }
    };
    for (const piece of splitRunes(stream, 3)) { // lands inside surrogate pairs
        collect(in_.feed(piece).toolCalls);
    }
    collect(in_.finish().toolCalls);
    assert.equal(args, '{"text":"你好，世界 🙂 安心","to":"en"}');
});

test('TestStreamMarkerTextInsideStringArgument', () => {
    // A string argument whose VALUE contains the closing-marker words: the
    // scanner tracks JSON strings, so the block still streams and closes at
    // the real marker instead of truncating at the quoted one.
    const stream = '<<<TOOL_CALL>>>\n{"name":"write","arguments":{"content":"template: <<<END_TOOL_CALL>>> done","path":"/tmp/x"}}\n<<<END_TOOL_CALL>>>';
    const { content, toolCalls: calls, args } = feedChunks(splitRunes(stream, 4), 1);
    assert.equal(calls, 1, `(content=${JSON.stringify(content)})`);
    assert.ok(args.includes('<<<END_TOOL_CALL>>> done'),
        `arguments truncated at quoted marker: ${JSON.stringify(args)}`);
    assert.ok(args.includes('/tmp/x'),
        `arguments missing keys after quoted marker: ${JSON.stringify(args)}`);
});

test('TestStreamStringArgumentsFallsBackToCompleteCall', () => {
    // arguments as a JSON-encoded STRING is not streamable: the interceptor
    // must buffer the block and emit one complete, unescaped call.
    const stream = '<<<TOOL_CALL>>>\n{"name":"bash","arguments":"{\\"command\\":\\"uname -a\\"}"}\n<<<END_TOOL_CALL>>>';
    const { content, toolCalls: calls, args } = feedChunks(splitRunes(stream, 5), 1);
    assert.equal(calls, 1, `(content=${JSON.stringify(content)})`);
    assert.equal(args, '{"command":"uname -a"}', 'unwrapped JSON object');
});

test('TestStreamFlatPayloadFallsBackToCompleteCall', () => {
    // Flat payload ({"tool": ..., <parameters>}): no arguments key is ever
    // found, so the buffered path folds the stray keys into one complete
    // call — same result as the finished-text parser.
    const stream = '<<<TOOL_CALL>>>\n{"tool":"bash","command":"uname -a","timeout":10}\n<<<END_TOOL_CALL>>>';
    const { content, toolCalls: calls, args } = feedChunks(splitRunes(stream, 3), 1);
    assert.equal(calls, 1, `(content=${JSON.stringify(content)})`);
    assert.ok(args.includes('"command":"uname -a"') && args.includes('"timeout":10'),
        `arguments = ${JSON.stringify(args)}, want flat keys folded in`);
});

test('TestStreamAlternateKeySpellingsStillStream', () => {
    // Tolerated spellings stream too: the name resolves from "tool" and the
    // arguments object from "parameters".
    const stream = '<<<TOOL_CALL>>>\n{"tool":"lookup","parameters":{"city":"Berlin"}}\n<<<END_TOOL_CALL>>>';
    const { content, toolCalls: calls, args } = feedChunks(splitRunes(stream, 3), 1);
    assert.equal(calls, 1, `(content=${JSON.stringify(content)})`);
    assert.equal(args, '{"city":"Berlin"}', 'streamed parameters object');
    assert.ok(!content.includes('TOOL_CALL') && content.trim() === '',
        `markers or junk leaked as content: ${JSON.stringify(content)}`);
});

test('TestStreamUnbalancedJSONClosesAtMarker', () => {
    // The model bails mid-JSON and closes the block anyway: the streamed
    // call must close at the marker (no marker bytes inside the arguments)
    // and no marker text may leak as content.
    const stream = '<<<TOOL_CALL>>>\n{"name":"bash","arguments":{"command":"echo"\n<<<END_TOOL_CALL>>>';
    const { content, toolCalls: calls, args } = feedChunks(splitRunes(stream, 4), 1);
    assert.equal(calls, 1, `(content=${JSON.stringify(content)})`);
    assert.ok(!args.includes('TOOL_CALL') && !args.includes('<'),
        `end-marker bytes leaked into streamed arguments: ${JSON.stringify(args)}`);
    assert.ok(!content.includes('TOOL_CALL'), `marker leaked as content: ${JSON.stringify(content)}`);
});

// ── fence helpers ────────────────────────────────────────────────────────────

test('TestTrimTrailingAgentFence', () => {
    const cases = [
        ["I'll check.\n```json", "I'll check."],
        ["I'll check.\n```", "I'll check."],
        ['plain', 'plain'],
        ['hello ```bash\nx=1', 'hello ```bash\nx=1'], // real code block untouched
    ];
    for (const [input, want] of cases) {
        assert.equal(trimTrailingAgentFence(input), want, `trim(${JSON.stringify(input)})`);
    }
});

test('TestSkipLeadingAgentFence', () => {
    assert.equal(skipLeadingAgentFence('```\nrest'), 4, 'bare fence');
    assert.equal(skipLeadingAgentFence('```json\ntext'), 8, 'json fence');
    assert.equal(skipLeadingAgentFence('```python\nx'), 0, 'lang fence must not match');
    assert.equal(skipLeadingAgentFence('text'), 0, 'text');
});

test('TestInterceptorSwallowsFencesAcrossChunks', () => {
    const stream = 'Let me check your architecture.\n\n```json\n<<<TOOL_CALL>>>\n{"name":"bash","arguments":{"command":"uname -m"}}\n<<<END_TOOL_CALL>>>\n```\ntrailing note';
    const in_ = new AgentStreamInterceptor();
    let content = '';
    let calls = 0;
    let args = '';
    const collect = (parsed) => {
        content += parsed.content;
        for (const call of parsed.toolCalls) {
            args += call.function?.arguments ?? '';
            if (typeof call.id === 'string' && call.id !== '') {
                calls++; // header delta; id-less deltas are argument fragments
            }
        }
    };
    for (let i = 0; i < stream.length; i += 3) { // nasty 3-char chunking
        collect(in_.feed(stream.slice(i, i + 3)));
    }
    collect(in_.finish());
    assert.equal(calls, 1, 'expected 1 tool call');
    assert.equal(args, '{"command":"uname -m"}', 'reassembled arguments');
    assert.ok(!content.includes('```') && !content.includes('json\n<<<'),
        `fence leaked into content: ${JSON.stringify(content)}`);
    assert.ok(content.includes('Let me check') && content.includes('trailing note'),
        `prose damaged: ${JSON.stringify(content)}`);
});

test('TestNonStreamParseStripWithFences', () => {
    const text = 'Sure!\n```json\n<<<TOOL_CALL>>>\n{"name":"bash","arguments":{"command":"arch"}}\n<<<END_TOOL_CALL>>>\n```\nRunning now.';
    const calls = parseAgentToolCalls(text);
    assert.ok(calls.length === 1 && calls[0].function.name === 'bash',
        `parse failed: ${JSON.stringify(calls)}`);
    const stripped = stripAgentToolCalls(text);
    assert.ok(!stripped.includes('```') && !stripped.includes('TOOL_CALL'),
        `strip left junk: ${JSON.stringify(stripped)}`);
});

// ── prompt structure (context rot) ───────────────────────────────────────────

// TestContextRotHypothesis tests whether the agent mode properly handles
// tool results when reasoning/thinking is enabled.
//
// The new prompt structure uses XML-like section tags (<tool_result>,
// <tool_exchange>, <current_task>) instead of [ROLE: ...] tags, which
// eliminates marker ambiguity and gives the model clear structure.
test('TestContextRotHypothesis', () => {
    const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Find me public ip' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'call_123',
                type: 'function',
                function: { name: 'bash', arguments: '{"command":"curl -s https://api.ipify.org"}' },
            }],
        },
        { role: 'tool', content: '110.226.238.87', tool_call_id: 'call_123' },
        { role: 'assistant', content: 'Your IP address is 110.226.238.87.' },
        { role: 'user', content: 'Fair enough now find my os arch and read my codebase explain me it in summary' },
    ];

    const tools = [{
        type: 'function',
        function: {
            name: 'bash',
            description: 'Execute a bash command',
            parameters: { type: 'object', properties: { command: { type: 'string' } } },
        },
    }];

    const prompt = buildAgentPrompt(messages, tools);

    assert.ok(prompt.includes('<tool_result'), 'Prompt should contain <tool_result> tag');
    assert.ok(prompt.includes('call_id="call_123"'), 'Prompt should contain call_id attribute');
    assert.ok(prompt.includes('<<<TOOL_CALL>>>'), 'Prompt should contain <<<TOOL_CALL>>> from assistant message');
    assert.ok(prompt.includes('<current_task>'), 'Prompt should have <current_task> section');
    assert.ok(prompt.includes('find my os arch'), 'Prompt should contain the final user message in <current_task>');
    assert.ok(prompt.includes('<tool_exchange>'), 'Prompt should group tool calls with results in <tool_exchange>');
    assert.ok(prompt.includes('110.226.238.87'), 'Prompt should contain the tool result content (IP address)');

    // Verify the new structure: no [ROLE: ...] tags
    for (const marker of ['[ROLE: system]', '[ROLE: user]', '[ROLE: assistant]']) {
        assert.ok(!prompt.includes(marker), `Prompt should not contain old ${marker} marker`);
    }
});

// TestToolResultVisibility checks that tool results are clearly visible
// in the generated prompt, not buried in a way the model might miss.
test('TestToolResultVisibility', () => {
    const messages = [
        { role: 'user', content: 'What is my IP?' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'call_abc',
                type: 'function',
                function: { name: 'bash', arguments: '{"command":"curl -s https://api.ipify.org"}' },
            }],
        },
        { role: 'tool', content: '192.168.1.100', tool_call_id: 'call_abc' },
    ];
    const tools = [{
        type: 'function',
        function: { name: 'bash', description: 'Execute a bash command' },
    }];

    const prompt = buildAgentPrompt(messages, tools);

    assert.ok(prompt.includes('<tool_result'), 'No <tool_result> tag found in prompt');
    assert.ok(prompt.includes('192.168.1.100'), 'Tool result content (IP) not visible in prompt');
    assert.ok(prompt.includes('<tool_exchange>'), 'Tool calls and results should be grouped in <tool_exchange>');
});

// TestMultipleToolResults verifies that multiple tool results are properly
// distinguished in the prompt with call_id attributes.
test('TestMultipleToolResults', () => {
    const messages = [
        { role: 'user', content: 'Get my IP and OS' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'bash', arguments: '{"command":"curl -s https://api.ipify.org"}' },
                },
                {
                    id: 'call_2',
                    type: 'function',
                    function: { name: 'bash', arguments: '{"command":"uname -a"}' },
                },
            ],
        },
        { role: 'tool', content: '10.0.0.1', tool_call_id: 'call_1' },
        { role: 'tool', content: 'Linux server 5.15.0 x86_64', tool_call_id: 'call_2' },
    ];
    const tools = [{
        type: 'function',
        function: { name: 'bash', description: 'Execute a bash command' },
    }];

    const prompt = buildAgentPrompt(messages, tools);

    assert.ok(prompt.includes('call_id="call_1"'), 'Missing call_id="call_1" in tool_result tag');
    assert.ok(prompt.includes('call_id="call_2"'), 'Missing call_id="call_2" in tool_result tag');
    assert.ok(prompt.includes('10.0.0.1'), 'Missing first tool result content');
    assert.ok(prompt.includes('Linux server 5.15.0 x86_64'), 'Missing second tool result content');
    assert.ok(prompt.includes('<tool_exchange>'), 'Tool calls should be grouped in <tool_exchange>');
});

// TestPromptStructureAnalysis analyzes the new prompt structure and verifies
// it addresses the context rot issues.
test('TestPromptStructureAnalysis', () => {
    const messages = [
        { role: 'system', content: 'You are a helpful assistant with access to bash.' },
        { role: 'user', content: 'Find my public IP' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'call_ip',
                type: 'function',
                function: { name: 'bash', arguments: '{"command":"curl -s https://api.ipify.org"}' },
            }],
        },
        { role: 'tool', content: '203.0.113.42', tool_call_id: 'call_ip' },
        { role: 'assistant', content: 'Your public IP is 203.0.113.42.' },
        { role: 'user', content: 'Now find my OS architecture' },
    ];
    const tools = [{
        type: 'function',
        function: { name: 'bash', description: 'Execute a bash command' },
    }];

    const prompt = buildAgentPrompt(messages, tools);

    for (const section of ['<system>', '<tools>', '<recent>', '<current_task>', '<output_rules>']) {
        assert.ok(prompt.includes(section), `Prompt missing section: ${section}`);
    }
    assert.ok(prompt.includes('<tool_exchange>'), 'Missing <tool_exchange> for grouped tool calls');
    assert.ok(prompt.includes('</tool_exchange>'), 'Missing closing </tool_exchange>');
    assert.ok(prompt.includes('<tool_result call_id="call_ip"'), 'Missing <tool_result> with call_id');

    for (const marker of [
        '[ROLE: system]',
        '[ROLE: user]',
        '[ROLE: assistant]',
        '[ROLE: tool_result]',
        '<<TOOL_RESULT>>',
        '[TOOL CONTRACT]',
    ]) {
        assert.ok(!prompt.includes(marker), `Prompt should NOT contain old format marker: ${marker}`);
    }
});

// TestMarkerAmbiguity verifies that the new prompt structure has zero
// marker ambiguity — old [ROLE: ...] tags are completely eliminated.
test('TestMarkerAmbiguity', () => {
    const oldRoleTags = [
        '[ROLE: system]',
        '[ROLE: user]',
        '[ROLE: assistant]',
        '[ROLE: tool_result]',
        '[ROLE: tool]',
    ];

    // Count in the modern system prefix
    for (const tag of oldRoleTags) {
        const count = agentSystemPrefix.split(tag).length - 1;
        assert.equal(count, 0, `System prefix still contains ${tag} (${count} times)`);
    }

    const messages = [
        { role: 'user', content: 'test' },
        {
            role: 'assistant',
            content: '',
            tool_calls: [{
                id: 'call_1',
                type: 'function',
                function: { name: 'bash', arguments: '{"command":"echo test"}' },
            }],
        },
        { role: 'tool', content: 'test output', tool_call_id: 'call_1' },
    ];
    const tools = [{
        type: 'function',
        function: { name: 'bash', description: 'Execute a bash command' },
    }];

    const prompt = buildAgentPrompt(messages, tools);

    for (const tag of oldRoleTags) {
        const count = prompt.split(tag).length - 1;
        assert.equal(count, 0, `Full prompt contains ${tag} (${count} times) — should be zero`);
    }

    for (const marker of [
        '<system>',
        '<tools>',
        '<recent>',
        '<current_task>',
        '<output_rules>',
        '<tool_exchange>',
        '<tool_result',
        '<assistant>',
    ]) {
        assert.ok(prompt.includes(marker), `Full prompt missing new marker: ${marker}`);
    }
    // Note: <user> tag only appears when there are multiple user messages
    // (the last user message goes into <current_task> instead)
});

// TestHistorySummarization verifies that conversations with more than
// maxRecentToolExchanges tool exchanges summarize the older ones into a
// <history_summary> block instead of replaying them verbatim.
test('TestHistorySummarization', () => {
    const messages = [{ role: 'user', content: 'start' }];
    // Build maxRecentToolExchanges + 3 tool exchanges.
    for (let i = 0; i < maxRecentToolExchanges + 3; i++) {
        const id = 'call_sum_' + String.fromCharCode(97 + i);
        messages.push(
            {
                role: 'assistant',
                content: '',
                tool_calls: [{
                    id,
                    type: 'function',
                    function: {
                        name: 'bash',
                        arguments: `{"command":"step ${String.fromCharCode(97 + i)}"}`,
                    },
                }],
            },
            {
                role: 'tool',
                content: `result of step ${String.fromCharCode(97 + i)}`,
                tool_call_id: id,
            },
        );
    }
    messages.push({ role: 'user', content: 'final question' });

    const prompt = buildAgentPrompt(messages, [{ type: 'function', function: { name: 'bash' } }]);

    assert.ok(prompt.includes('<history_summary>'), 'long conversation should produce a <history_summary> block');
    assert.ok(prompt.includes('Previously completed tool calls:'), 'history summary missing header');
    // The oldest exchange result is summarized...
    assert.ok(prompt.includes('result of step a'), 'oldest exchange should appear in the summary');
    // ...while the most recent window stays verbatim in <recent>.
    assert.ok(prompt.includes('<recent>'), 'recent window missing');
    assert.ok(prompt.includes('<current_task>\nfinal question'), 'final user message should anchor <current_task>');
});

// TestAlreadyCalledAntiLoop verifies the <already_called> anti-loop section
// (issue #31): every distinct call already made is listed once — duplicates
// are collapsed — and the section appears late in the prompt (after
// <recent>, before <current_task>) where recency weight is highest.
test('TestAlreadyCalledAntiLoop', () => {
    const mkCall = (id, name, args) => ({
        role: 'assistant',
        content: '',
        tool_calls: [{
            id,
            type: 'function',
            function: { name, arguments: args },
        }],
    });

    const messages = [
        { role: 'user', content: 'find my ip' },
        mkCall('call_1', 'bash', '{"command":"curl -s https://api.ipify.org"}'),
        { role: 'tool', content: '203.0.113.7', tool_call_id: 'call_1' },
        // Same call re-issued by the client (a prior loop) — must dedup.
        mkCall('call_2', 'bash', '{"command":"curl -s https://api.ipify.org"}'),
        { role: 'tool', content: '203.0.113.7', tool_call_id: 'call_2' },
        // A different call — must be kept.
        mkCall('call_3', 'bash', '{"command":"uname -a"}'),
        { role: 'tool', content: 'Linux arm64', tool_call_id: 'call_3' },
        { role: 'user', content: 'now get the os arch' },
    ];

    const prompt = buildAgentPrompt(messages, [{ type: 'function', function: { name: 'bash' } }]);

    // Locate the actual section (the tag is also *mentioned* in <system>
    // and <output_rules>, so anchor on the section header line).
    const hdr = prompt.indexOf('<already_called>\n');
    assert.ok(hdr >= 0, 'prompt missing <already_called> section');
    const end = prompt.slice(hdr).indexOf('</already_called>');
    assert.ok(end >= 0, '<already_called> section not closed');
    const section = prompt.slice(hdr, hdr + end + '</already_called>'.length);

    assert.ok(section.includes('Calls already made in this conversation'),
        '<already_called> missing its no-repeat header');
    const repeats = section.split('curl -s https://api.ipify.org').length - 1;
    assert.equal(repeats, 1, 'identical repeat call should be listed exactly once in <already_called>');
    assert.ok(section.includes('- bash {"command":"uname -a"}'), 'distinct call missing from <already_called>');

    // Section order: <recent> … <already_called> … <current_task>.
    const iRecent = prompt.indexOf('<recent>');
    const iTask = prompt.indexOf('<current_task>');
    assert.ok(iRecent >= 0 && iTask >= 0 && iRecent < hdr && hdr < iTask,
        `<already_called> should sit between <recent> and <current_task> (recent=${iRecent} already=${hdr} task=${iTask})`);
});

// TestAlreadyCalledEmptyWhenNoCalls verifies the <already_called> section is
// omitted entirely when the conversation contains no tool calls (the tag may
// still be *mentioned* by the rules, but the section header must be absent).
test('TestAlreadyCalledEmptyWhenNoCalls', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const prompt = buildAgentPrompt(messages, [{ type: 'function', function: { name: 'bash' } }]);
    assert.ok(!prompt.includes('<already_called>\nCalls already made'),
        '<already_called> section should be omitted when no calls were made');
});

// ── GLM-Free-API integration: variant dispatch ───────────────────────────────

test('TestAgentVariantSelection', () => {
    const prevMode = config.agentMode;
    const prevVariant = config.agentModeVariant;
    try {
        const cases = [
            [true, 'modern', true],
            [true, '', true], // empty defaults to modern
            [true, 'legacy', false],
            [true, 'LEGACY', false], // case-insensitive
            [false, 'modern', false],
            [false, 'legacy', false],
        ];
        for (const [mode, variant, wantModern] of cases) {
            config.agentMode = mode;
            config.agentModeVariant = variant;
            assert.equal(config.agentModern(), wantModern,
                `agentModern(mode=${mode} variant=${JSON.stringify(variant)})`);
            assert.equal(config.agentLegacy(), mode && !wantModern,
                `agentLegacy(mode=${mode} variant=${JSON.stringify(variant)})`);
        }
    } finally {
        config.agentMode = prevMode;
        config.agentModeVariant = prevVariant;
    }
});

test('TestWrapAgentPromptAsMessages', () => {
    const raw = wrapAgentPromptAsMessages('hello agent prompt');
    const msgs = JSON.parse(raw);
    assert.equal(msgs.length, 1, 'wrapped messages entries');
    assert.equal(msgs[0].role, 'user', 'wrapped role (Z.AI only accepts user)');
    assert.equal(msgs[0].content, 'hello agent prompt', 'wrapped content');
});

test('TestAgentTransformMessagesModern', () => {
    withAgentVariant('modern', () => {
        const messages = JSON.stringify([
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'Find my public ip' },
            { role: 'assistant', content: '', tool_calls: [{ id: 'call_9', type: 'function', function: { name: 'bash', arguments: '{"command":"curl ifconfig.me"}' } }] },
            { role: 'tool', tool_call_id: 'call_9', content: '203.0.113.7' },
            { role: 'user', content: 'Thanks, now get my hostname' },
        ]);
        const tools = JSON.stringify([{ type: 'function', function: { name: 'bash', description: 'Execute a bash command', parameters: { type: 'object', properties: { command: { type: 'string' } } } } }]);

        const raw = agentTransformMessages(messages, tools);
        const msgs = JSON.parse(raw);
        assert.equal(msgs.length, 1, 'modern transform should produce 1 folded prompt');
        assert.equal(msgs[0].role, 'user');
        const prompt = msgs[0].content;
        for (const want of [
            '<system>',
            '<tools>',
            '### Tool 1: bash',
            '<tool_exchange>',
            'call_id="call_9"',
            '203.0.113.7',
            '<current_task>\nThanks, now get my hostname',
            '<output_rules>',
        ]) {
            assert.ok(prompt.includes(want), `modern prompt missing ${JSON.stringify(want)}`);
        }
        // Legacy markers must not leak into the modern prompt.
        assert.ok(!prompt.includes('[ROLE:'), 'modern prompt contains legacy [ROLE:] markers');
    });
});

test('TestAgentTransformMessagesLegacyStillWorks', () => {
    withAgentVariant('legacy', () => {
        const messages = JSON.stringify([
            { role: 'system', content: 'You are helpful.' },
            { role: 'user', content: 'hi' },
        ]);
        const tools = JSON.stringify([{ type: 'function', function: { name: 'bash', description: 'Execute a bash command' } }]);

        const raw = agentTransformMessages(messages, tools);
        const msgs = JSON.parse(raw);
        // Legacy: system prefix message + rewritten system + user + tool contract.
        assert.equal(msgs.length, 4, 'legacy transform message count');
        for (const m of msgs) {
            assert.equal(m.role, 'user', `legacy transform left non-user role: ${m.role}`);
        }
        assert.ok(msgs[0].content.includes('[SYSTEM] AGENT MODE'),
            'legacy first message should carry the legacy system prefix');
        assert.ok(msgs[1].content.startsWith('[ROLE: system]'),
            `legacy system rewrite = ${JSON.stringify(msgs[1].content)}, want [ROLE: system] prefix`);
        assert.ok(msgs[3].content.includes('[TOOL CONTRACT]') && msgs[3].content.includes('### Tool 1: bash'),
            'legacy tool contract message missing');
    });
});

// TestAgentInterceptorAdapters verifies both interceptor adapters behave
// correctly through the shared agentInterceptor surface.
test('TestAgentInterceptorAdapters', () => {
    const stream = 'Sure thing.\n<<<TOOL_CALL>>>\n{"name":"bash","arguments":{"command":"id"}}\n<<<END_TOOL_CALL>>>';

    // run feeds the stream and counts logical tool calls: deltas carrying an
    // id open a new call (id-less argument fragments belong to the open
    // call), and accumulates the streamed arguments like an SDK does.
    const run = (in_) => {
        let content = '';
        let calls = 0;
        let argFrags = 0;
        let args = '';
        const collect = (c, tcs) => {
            content += c;
            for (const tc of tcs) {
                args += tc.function?.arguments ?? '';
                if (typeof tc.id === 'string' && tc.id !== '') {
                    calls++;
                } else {
                    argFrags++;
                }
            }
        };
        for (let i = 0; i < stream.length; i += 4) {
            const { content: c, toolCalls: tcs } = in_.feed(stream.slice(i, i + 4));
            collect(c, tcs);
        }
        const fin = in_.finish();
        collect(fin.content, fin.toolCalls);
        return { content, calls, argFrags, args };
    };

    // Modern adapter: one streamed call, arguments reassemble exactly, no
    // marker leakage.
    let r = run(new ModernAgentInterceptor());
    assert.equal(r.calls, 1, 'modern adapter calls');
    assert.equal(r.args, '{"command":"id"}', 'modern adapter streamed arguments');
    assert.ok(!r.content.includes('TOOL_CALL'), `modern adapter leaked markers: ${JSON.stringify(r.content)}`);
    assert.ok(r.content.includes('Sure thing.'), `modern adapter damaged prose: ${JSON.stringify(r.content)}`);

    // Legacy adapter: same input (canonical markers) also yields one call,
    // streamed incrementally (header delta + argument fragments).
    r = run(new LegacyAgentInterceptor());
    assert.equal(r.calls, 1, 'legacy adapter calls');
    assert.equal(r.args, '{"command":"id"}', 'legacy adapter streamed arguments');
    assert.ok(!r.content.includes('TOOL_CALL'), `legacy adapter leaked markers: ${JSON.stringify(r.content)}`);
});

// TestAgentExtractStripDispatch checks the extract/strip dispatch helpers
// route to the right implementation per variant.
test('TestAgentExtractStripDispatch', () => {
    // Flat payload: the MODERN tolerant parser resolves the tool name and
    // folds the stray keys into arguments.
    withAgentVariant('modern', () => {
        const calls = agentExtractToolCalls(flatPayload);
        assert.equal(calls.length, 1, 'modern extract: flat payload call count');
        assert.equal(calls[0].function.name, 'bash', 'modern extract: name');
        assert.equal(agentStripToolCalls(flatPayload).trim(), '', 'modern strip residue');
    });

    withAgentVariant('legacy', () => {
        // The legacy strict parser accepts the flat JSON but cannot resolve a
        // tool name from it (name stays "") — exactly the failure mode the
        // modern tolerant parser fixes.
        const legacyCalls = agentExtractToolCalls(flatPayload);
        for (const tc of legacyCalls) {
            const name = typeof tc.function?.name === 'string' ? tc.function.name : '';
            assert.equal(name, '', `legacy extract unexpectedly resolved name ${JSON.stringify(name)} from flat payload`);
        }
        // Canonical payload works on legacy too.
        const canonical = '<<<TOOL_CALL>>>\n{"name":"bash","arguments":{"command":"id"}}\n<<<END_TOOL_CALL>>>';
        assert.equal(agentExtractToolCalls(canonical).length, 1,
            'legacy extract: canonical payload call count');
        assert.equal(agentStripToolCalls(canonical).trim(), '', 'legacy strip residue');
    });
});

// TestAgentEndMarkerPrefixMatrix pins the partial-marker classifier used by
// the streaming arguments scanner: "maybe" verdicts hold bytes back (a
// marker split across upstream chunks), "complete" closes the call, "no"
// streams the byte as ordinary (malformed) JSON.
test('TestAgentEndMarkerPrefixMatrix', () => {
    const cases = [
        ['<<<END_TOOL_CALL>>>', agentPrefixComplete, 19], // canonical
        ['<<<<END_TOOL_CALL>>>>', agentPrefixComplete, 21],
        ['<<END_TOOL_CALL>>', agentPrefixComplete, 17],   // short tolerated
        ['<<<END_TOOL_CALL>>', agentPrefixComplete, 18],  // asymmetric 3/2 — tolerated
        ['<<<END_TOOL_CALL>', agentPrefixMaybe, 0],       // 1 '>' so far
        ['<<<END_TOOL_CAL', agentPrefixMaybe, 0],         // word still arriving
        ['<<<END_TOOL', agentPrefixMaybe, 0],
        ['<<<END_', agentPrefixMaybe, 0],
        ['<<<', agentPrefixMaybe, 0], // bare bracket run, word may still start
        ['<', agentPrefixMaybe, 0],
        ['<<<<<', agentPrefixNo, 0], // 5 brackets: never tolerated
        ['<<<<<END_TOOL_CALL>>>', agentPrefixNo, 0],
        ['<abc', agentPrefixNo, 0],
        ['<<x', agentPrefixNo, 0],
        ['<<<END_TOOL_CALL>x', agentPrefixNo, 0],
        ['<<<NOT_TOOL_CALL>>>', agentPrefixNo, 0],
        ['<<<END_TOOL_CALLL>>>', agentPrefixNo, 0],
    ];
    for (const [input, state, mLen] of cases) {
        const [st, ml] = agentEndMarkerPrefix(input);
        assert.ok(st === state && ml === mLen,
            `agentEndMarkerPrefix(${JSON.stringify(input)}) = (${st},${ml}), want (${state},${mLen})`);
    }
});

test('TestStreamTwoCallsWithProseBetween', () => {
    const stream = '<<<TOOL_CALL>>>\n{"name":"a","arguments":{"x":1}}\n<<<END_TOOL_CALL>>>\nfirst done\n<<<TOOL_CALL>>>\n{"name":"b","arguments":{"y":2}}\n<<<END_TOOL_CALL>>>\ntrailing';
    const in_ = new AgentStreamInterceptor();
    let content = '';
    const argsByIndex = new Map();
    let headers = 0;
    const names = [];
    const collect = (parsed) => {
        content += parsed.content;
        for (const tc of parsed.toolCalls) {
            const idx = tc.index;
            const fn = callFn(tc);
            argsByIndex.set(idx, (argsByIndex.get(idx) ?? '') + (fn.arguments ?? ''));
            if (typeof tc.id === 'string' && tc.id !== '') {
                headers++;
                names.push(fn.name);
            }
        }
    };
    for (const piece of splitRunes(stream, 6)) collect(in_.feed(piece));
    collect(in_.finish());

    assert.ok(headers === 2 && names.length === 2 && names[0] === 'a' && names[1] === 'b',
        `headers = ${headers} names = ${JSON.stringify(names)}, want 2 [a b]`);
    assert.ok(argsByIndex.get(0) === '{"x":1}' && argsByIndex.get(1) === '{"y":2}',
        `arguments by index = ${JSON.stringify([...argsByIndex])}`);
    assert.ok(content.includes('first done') && content.includes('trailing'),
        `prose between/after calls lost: ${JSON.stringify(content)}`);
    assert.ok(!content.includes('TOOL_CALL') && !content.includes('"x"'),
        `block bytes leaked as content: ${JSON.stringify(content)}`);
});
