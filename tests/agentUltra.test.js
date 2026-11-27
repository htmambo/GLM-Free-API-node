// Port of internal/zbridge/agent_ultra_test.go + toolparser_llm_test.go —
// the ToolParserLLM repair layer (strict double gate, fragment-only repair,
// re-validation, dormant-by-default).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../src/config.js';
import {
    ultraRepairEnabled,
    classifyUltra,
    UltraPlain,
    UltraValid,
    UltraMalformed,
    hasValidCanonicalBlock,
    extractMalformedSpans,
    normalizeUltraFragment,
    repairUltraBuffer,
    ultraRepairFullText,
    UltraBuffer,
} from '../src/agentUltra.js';
import {
    toolParserLLMCanonicalSpec,
    toolParserLLMRepairPrompt,
    detectGPU,
    setToolParserLLMRepairerForTests,
} from '../src/toolparserLLM.js';

const CANONICAL = '<<<TOOL_CALL>>>\n{"name":"bash","arguments":{"command":"ls"}}\n<<<END_TOOL_CALL>>>';

async function withUltra(fn, { agentMode = true, level = 'ultra' } = {}) {
    const savedMode = config.agentMode;
    const savedLevel = config.agentModeLevel;
    config.agentMode = agentMode;
    config.agentModeLevel = level;
    try {
        return await fn();
    } finally {
        config.agentMode = savedMode;
        config.agentModeLevel = savedLevel;
    }
}

test('gate matrix: only agent mode + level ultra activates', async () => {
    assert.equal(await withUltra(() => ultraRepairEnabled(), { agentMode: false, level: 'ultra' }), false);
    assert.equal(await withUltra(() => ultraRepairEnabled(), { agentMode: true, level: '' }), false);
    assert.equal(await withUltra(() => ultraRepairEnabled(), { agentMode: true, level: 'ULTRA' }), true);
    assert.equal(await withUltra(() => ultraRepairEnabled(), { agentMode: true, level: ' ultra ' }), true);
});

test('valid canonical input is passthrough (no model call)', async () => {
    await withUltra(async () => {
        let called = false;
        const repairer = { async repairFragment() { called = true; return CANONICAL; } };
        const { text, events } = await repairUltraBuffer(`Here you go:\n${CANONICAL}`, '[]', repairer);
        assert.equal(text, `Here you go:\n${CANONICAL}`);
        assert.equal(called, false, 'valid canonical must bypass ToolParserLLM');
        assert.equal(events[0].decision, 'passthrough-valid');
        assert.equal(classifyUltra(CANONICAL), UltraValid);
        assert.equal(hasValidCanonicalBlock(CANONICAL), true);
    });
});

test('plain text is passthrough', async () => {
    await withUltra(async () => {
        const { text, events } = await repairUltraBuffer('Just a normal answer.', '[]', null);
        assert.equal(text, 'Just a normal answer.');
        assert.equal(events[0].decision, 'plain');
        assert.equal(classifyUltra('Just a normal answer.'), UltraPlain);
    });
});

test('extracts only the malformed fragment, never the whole response', async () => {
    const text = 'Sure, I will run it.\n<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>\nDone?';
    const spans = await extractMalformedSpans(text);
    assert.equal(spans.length, 1);
    assert.ok(spans[0].raw.startsWith('<tool_call>'));
    assert.ok(!spans[0].raw.includes('Sure, I will run it.'));
    assert.equal(classifyUltra(text), UltraMalformed);
});

test('prose without tool intent is not flagged', async () => {
    assert.equal((await extractMalformedSpans('The JSON {"command":"ls"} is just an example.')).length, 0);
});

test('repairs a malformed span and splices it in place', async () => {
    await withUltra(async () => {
        const text = 'Running now:\nTOOL_CALL_BLOCK bash command=ls\nAll set.';
        const { text: out, events } = await repairUltraBuffer(text, '[{"name":"bash"}]', {
            async repairFragment(fragment, toolsJSON) {
                assert.ok(!fragment.includes('Running now:'), 'only the fragment may be sent');
                assert.equal(toolsJSON, '[{"name":"bash"}]');
                return CANONICAL;
            },
        });
        assert.ok(out.includes(CANONICAL));
        assert.ok(out.startsWith('Running now:'), 'surrounding prose must survive');
        assert.ok(out.endsWith('All set.'));
        assert.equal(events[0].decision, 'repaired');
    });
});

test('invalid model output falls back to the original fragment', async () => {
    await withUltra(async () => {
        const text = 'TOOL_CALL_BLOCK bash command=ls';
        const { text: out, events } = await repairUltraBuffer(text, '[]', {
            async repairFragment() { return 'no canonical block here'; },
        });
        assert.equal(out, text);
        assert.equal(events[0].decision, 'fallback-invalid');
    });
});

test('no repairer keeps the intent untouched', async () => {
    await withUltra(async () => {
        const restore = setToolParserLLMRepairerForTests(null);
        try {
            const text = 'TOOL_CALL_BLOCK bash command=ls';
            const { text: out, events } = await repairUltraBuffer(text, '[]', null);
            assert.equal(out, text);
            assert.equal(events[0].decision, 'no-repairer');
        } finally {
            restore();
        }
    });
});

test('repair is dormant when the gate is off', async () => {
    await withUltra(async () => {
        const text = 'TOOL_CALL_BLOCK bash command=ls';
        const { text: out, events } = await repairUltraBuffer(text, '[]', {
            async repairFragment() { throw new Error('must not be called'); },
        });
        assert.equal(out, text);
        assert.deepEqual(events, []);
        assert.equal(await ultraRepairFullText(text, '[]'), text);
    }, { agentMode: true, level: '' });
});

test('UltraBuffer defers emission until finish', async () => {
    await withUltra(async () => {
        const buf = new UltraBuffer('[]');
        buf.feed('Hello ');
        buf.feed(CANONICAL);
        assert.equal(buf.fullText(), 'Hello ' + CANONICAL);

        const { content, toolCalls } = await buf.finish();
        assert.ok(content.includes('Hello'));
        assert.equal(toolCalls.length, 1);
        assert.equal(toolCalls[0].function.name, 'bash');
    });
});

test('NormalizeUltraFragment strips noise, keeps the payload', () => {
    assert.equal(
        normalizeUltraFragment('```json\n{"tool":"bash","arguments":{"command":"ls"}};\n```'),
        '{"tool":"bash","arguments":{"command":"ls"}}');
});

test('canonical spec pins the three markers and the two keys', () => {
    const spec = toolParserLLMCanonicalSpec();
    assert.ok(spec.includes('<<<TOOL_CALL>>>'));
    assert.ok(spec.includes('<<<END_TOOL_CALL>>>'));
    assert.ok(spec.includes('"name"'));
    assert.ok(spec.includes('"arguments"'));
});

test('repair prompt contains exactly one <malformed> section', () => {
    const prompt = toolParserLLMRepairPrompt('TOOL_CALL_BLOCK bash', '[{"name":"bash"}]');
    assert.equal((prompt.match(/<malformed>/g) ?? []).length, 1);
    assert.ok(prompt.includes('keep arguments VERBATIM'));
    assert.ok(prompt.includes('never invent or drop arguments'));
});

test('DetectGPU returns evidence', () => {
    const g = detectGPU();
    assert.equal(typeof g.ok, 'boolean');
    assert.ok(typeof g.evidence === 'string' && g.evidence !== '');
});
