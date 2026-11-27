// Port of internal/zbridge/agent_ultra.go — ULTRA MODE: ToolParserLLM
// intelligent malformed-tool repair layer.
//
// Strict opt-in: EVERY entry point first checks config.ultraEnabled()
// (--agent-mode + --agent-mode-level=ultra). When the gate is off the
// helpers return their input untouched and never touch ToolParserLLM, so
// default and plain agent-mode behaviour stay byte-for-byte identical.
//
// Pipeline:
//   1. Buffer the full upstream text (UltraBuffer) instead of forwarding.
//   2. Validate with the canonical parser (findAgentSpans + agentLooseParse).
//      Valid canonical → passthrough.
//   3. Otherwise extract ONLY the malformed tool-call span(s) — never the
//      whole response — normalize structural noise, variablize long values,
//      and send fragment + canonical spec to ToolParserLLM.
//   4. Re-validate the model output with the same validator; splice on
//      success, else forward the original fragment with a warning.

import { config } from './config.js';
import {
    findAgentSpans,
    agentLooseParse,
    parseAgentToolCalls,
    normalizeAgentFences,
    AgentStreamInterceptor,
} from './agent.js';
import { getToolParserLLMRepairer } from './toolparserLLM.js';

// ── gating ─────────────────────────────────────────────────────────────────

export function ultraRepairEnabled() {
    return config.ultraEnabled();
}

export function ultraGateDebug() {
    return `agentMode=${String(config.agentMode)} level=${config.agentModeLevel}`;
}

// ── canonical validator ────────────────────────────────────────────────────

export const UltraPlain = 0;
export const UltraValid = 1;
export const UltraMalformed = 2;

export function hasValidCanonicalBlock(text) {
    return parseAgentToolCalls(normalizeAgentFences(text)).length > 0;
}

export function classifyUltra(text) {
    if (hasValidCanonicalBlock(text)) {
        // A response can carry BOTH a valid block and a malformed sibling
        // (multi-call responses); those still need repair for the malformed
        // span — valid blocks are left untouched by the splicer.
        if (extractMalformedSpans(text).length > 0) return UltraMalformed;
        return UltraValid;
    }
    if (extractMalformedSpans(text).length > 0) return UltraMalformed;
    return UltraPlain;
}

// ── malformed-span extraction ──────────────────────────────────────────────

// Each pattern names a malformed-tool shape observed in the wild or in
// ToolParserLLM training (GENERALIZE families + issue #44 derailments).
// Canonical <<<TOOL_CALL>>> blocks are excluded explicitly below.
const ultraIntentPatterns = [
    // Renamed markers / envelopes.
    /TOOL_CALL_BLOCK/i,
    /<\s*\/?\s*tool_call\s*[^>]*>[\s\S]*?<\s*\/\s*tool_call\s*>/i,
    /<\s*tool_args\s*>[\s\S]*?<\s*\/\s*tool_args\s*>/i,
    /<\s*invoke\b[^>]*>[\s\S]*?<\s*\/\s*invoke\s*>/i,
    /DSML/i,
    // GENERALIZE wrapper families (train): xml_upper, sexpr, at_call,
    // shell_export, hash_flag, double_brace, json_toolkey, ini_section,
    // md_tool — plus held-out pipe_kv / csv_row / angle_json.
    /<TOOL><NAME>[\s\S]*?<\/ARGS><\/TOOL>/i,
    /\(tool\s+\w+[\s\S]*?\)/,
    /@\w+\([^)]*=\s*("[^"]*"|\{[^\n]{0,1000})/,
    /^\s*TOOL=\w+.*/m,
    /^\s*#TOOL\s+\w+.*/m,
    /\{\{\w+\s*:[\s\S]*?\}\}/,
    /\{"tool"\s*:[\s\S]*?\}/,
    /^\s*\[[\w-]+\]\s*$/m,
    /```tool[\s\S]*?```/i,
    /<json>\s*\{[\s\S]*?\}\s*<\/json>/,
    /^\s*\w+\s*::.*?=.*/m,
    /^\s*tool,args:.*/m,
    // Bare JSON-ish payloads naming a tool outside canonical markers.
    // Deliberately narrow (tool-ish key + a brace) so prose with no tool key
    // is NOT flagged.
    /\{[^{}]{0,1000}"(tool|tool_name|function|function_name)"\s*:[^{}]{0,1000}\}/,
    // Pseudo-calls: get_weather(city="Tokyo") / bash(command="...").
    /\b[a-zA-Z_][a-zA-Z0-9_]*\s*\(\s*[a-zA-Z_][a-zA-Z0-9_]*\s*=\s*("[^"]*"|'[^']*'|\{[^\n]{0,1000})/,
];

// ultraProtectedSpans returns the ranges of valid canonical blocks that must
// never be treated as malformed (bypass-ToolParserLLM guarantee).
function ultraProtectedSpans(text) {
    const out = [];
    for (const sp of findAgentSpans(text)) {
        const parsed = agentLooseParse(text.slice(sp.bodyStart, sp.bodyEnd));
        if (parsed.ok) out.push([sp.start, sp.end]);
    }
    return out;
}

function overlapsProtected(start, end, prot) {
    return prot.some(([s, e]) => start < e && end > s);
}

const ultraFenceLeadRe = /^```(?:json)?\s*/i;
const ultraFenceTailRe = /\s*```$/i;

// NormalizeUltraFragment removes obvious structural noise BEFORE
// ToolParserLLM; the semantic payload (tool name + arguments) is preserved
// verbatim — only the skeleton is fixed.
export function normalizeUltraFragment(s) {
    let t = s.trim();
    t = t.replace(ultraFenceLeadRe, '').trim();
    t = t.replace(ultraFenceTailRe, '').trim();
    // Fullwidth fold (mirror varpass.ascii_fold for ；→; etc.).
    t = t.replace(/[！-～　]/g, (ch) => (ch === '　' ? ' ' : String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)));
    t = t.replace(/^[ \t\n\r;,]+|[ \t\n\r;,]+$/g, '');
    return t.trim();
}

// extractMalformedSpans isolates malformed tool-call regions: sorted,
// non-overlapping, excluding surrounding prose and valid canonical blocks.
// The regex match itself IS the span — no line expansion.
export function extractMalformedSpans(text) {
    const prot = ultraProtectedSpans(text);
    const cands = [];
    for (const re of ultraIntentPatterns) {
        const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
        for (const m of text.matchAll(g)) {
            const s = m.index;
            const e = s + m[0].length;
            if (overlapsProtected(s, e, prot)) continue;
            cands.push({ s, e });
        }
    }
    if (cands.length === 0) return [];
    cands.sort((a, b) => a.s - b.s);
    const merged = [];
    for (const c of cands) {
        const last = merged[merged.length - 1];
        if (!last || c.s > last.e) merged.push({ s: c.s, e: c.e });
        else if (c.e > last.e) last.e = c.e;
    }

    const out = [];
    for (const m of merged) {
        if (overlapsProtected(m.s, m.e, prot)) continue;
        const raw = text.slice(m.s, m.e);
        const norm = normalizeUltraFragment(raw);
        if (norm.trim() === '') continue;
        // Drop candidates with no tool intent (prose protection).
        if (!ultraHasIntent(norm)) continue;
        const { skeleton, varMap } = ultraVariablize(norm);
        out.push({ start: m.s, end: m.e, fragment: skeleton, raw, varMap });
    }
    return out;
}

const ultraIntentProbe = /(tool|invoke|dsml|TOOL_CALL|<tool|@\w+\(|\(tool\s|\{\{|\[[\w-]+\]|```tool|<json>|::|tool,args:|"[a-z_]*name"\s*:|bash|read|write|edit|grep|get_weather|AskUser)/i;

function ultraHasIntent(s) {
    return ultraIntentProbe.test(s);
}

// ── varpass mirror (LONG sentinels) ────────────────────────────────────────

const ultraLongThreshold = 150;
const ultraSent = (i) => `VAR${i}`;

const ultraFenceRe = /```[a-zA-Z]*\n([\s\S]*?)```/gd;
const ultraLongQRe = /"((?:[^"\\]|\\.){200,})"/gd;

function ultraLongEnough(body) {
    return body.length >= ultraLongThreshold || (body.length >= 50 && body.includes('\n'));
}

// ultraVariablize replaces long spans with collision-proof PUA sentinels.
export function ultraVariablize(text) {
    const spans = [];
    for (const re of [ultraFenceRe, ultraLongQRe]) {
        for (const m of text.matchAll(re)) {
            const body = m[1] ?? '';
            if (ultraLongEnough(body)) {
                spans.push({ s: m.indices[1][0], e: m.indices[1][1] });
            }
        }
    }
    if (spans.length === 0) return { skeleton: text, varMap: new Map() };
    spans.sort((a, b) => a.s - b.s);

    let out = '';
    const varMap = new Map();
    let pos = 0;
    let last = -1;
    for (const sp of spans) {
        if (sp.s < last) continue;
        last = sp.e;
        out += text.slice(pos, sp.s);
        const sent = ultraSent(varMap.size);
        varMap.set(sent, text.slice(sp.s, sp.e));
        out += sent;
        pos = sp.e;
    }
    out += text.slice(pos);
    return { skeleton: out, varMap };
}

function ultraRehydrate(s, varMap) {
    let out = s;
    for (const [sent, val] of varMap) out = out.split(sent).join(val);
    return out;
}

// ── repair events + logging ────────────────────────────────────────────────

export function logUltraEvent(ev) {
    const max = 500;
    const tr = (s) => {
        const one = String(s ?? '').replace(/\n/g, '\\n');
        return one.length > max ? one.slice(0, max) + '…' : one;
    };
    console.error(`[UltraRepair] decision=${ev.decision} original=${JSON.stringify(tr(ev.originalFragment))} extracted=${JSON.stringify(tr(ev.extractedFragment))} model=${JSON.stringify(tr(ev.modelOutput))}`);
}

// ── core repair ────────────────────────────────────────────────────────────

// repairUltraBuffer is the full pipeline on buffered text. It is idempotent:
// valid canonical / plain input returns byte-identical. Malformed spans are
// each repaired independently; model output is re-validated before splicing.
export async function repairUltraBuffer(fullText, toolsJSON, repairer = null) {
    if (!ultraRepairEnabled()) return { text: fullText, events: [] };

    const cls = classifyUltra(fullText);
    if (cls !== UltraMalformed) {
        return {
            text: fullText,
            events: [{
                originalFragment: '',
                extractedFragment: '',
                modelOutput: '',
                decision: cls === UltraValid ? 'passthrough-valid' : 'plain',
            }],
        };
    }
    const spans = extractMalformedSpans(fullText);
    if (spans.length === 0) return { text: fullText, events: [] };

    repairer = repairer ?? getToolParserLLMRepairer();

    let out = fullText;
    const events = [];
    // Splice back-to-front so earlier offsets stay valid.
    for (let i = spans.length - 1; i >= 0; i--) {
        const sp = spans[i];
        if (repairer === null) {
            const ev = {
                originalFragment: sp.raw,
                extractedFragment: sp.fragment,
                modelOutput: '',
                decision: 'no-repairer',
            };
            logUltraEvent(ev);
            events.push(ev);
            continue;
        }

        let modelOut;
        try {
            modelOut = await repairer.repairFragment(sp.fragment, toolsJSON, 60_000);
        } catch (err) {
            const ev = {
                originalFragment: sp.raw,
                extractedFragment: sp.fragment,
                modelOutput: 'ERROR: ' + err.message,
                decision: 'fallback-passthrough',
            };
            console.error(`[UltraRepair] WARNING: ToolParserLLM repair failed (${err.message}); forwarding original malformed fragment (intent preserved)`);
            logUltraEvent(ev);
            events.push(ev);
            continue;
        }

        const rehyd = ultraRehydrate(String(modelOut ?? '').trim(), sp.varMap);
        // Re-validate with the SAME validator.
        if (parseAgentToolCalls(rehyd).length === 0) {
            const ev = {
                originalFragment: sp.raw,
                extractedFragment: sp.fragment,
                modelOutput: modelOut,
                decision: 'fallback-invalid',
            };
            console.error('[UltraRepair] WARNING: ToolParserLLM output failed re-validation; forwarding original malformed fragment (intent preserved)');
            logUltraEvent(ev);
            events.push(ev);
            continue;
        }

        // Splice the FIRST repaired canonical block in place of the
        // malformed fragment (non-destructive to surrounding prose).
        const block = firstCanonicalBlock(rehyd) || rehyd;
        out = out.slice(0, sp.start) + block + out.slice(sp.end);
        const ev = {
            originalFragment: sp.raw,
            extractedFragment: sp.fragment,
            modelOutput: modelOut,
            decision: 'repaired',
        };
        logUltraEvent(ev);
        events.push(ev);
    }
    events.reverse(); // back to document order
    return { text: out, events };
}

function firstCanonicalBlock(text) {
    for (const sp of findAgentSpans(text)) {
        const parsed = agentLooseParse(text.slice(sp.bodyStart, sp.bodyEnd));
        if (parsed.ok) return text.slice(sp.start, sp.end);
    }
    return '';
}

// ultraRepairFullText is the non-streaming convenience wrapper.
export async function ultraRepairFullText(fullContent, toolsRaw) {
    if (!ultraRepairEnabled()) return fullContent;
    const toolsJSON = toolsRaw == null ? ''
        : (typeof toolsRaw === 'string' ? toolsRaw : JSON.stringify(toolsRaw));
    const { text } = await repairUltraBuffer(fullContent, toolsJSON, null);
    return text;
}

// ── streaming buffer ───────────────────────────────────────────────────────

// UltraBuffer accumulates upstream chunks instead of forwarding them. At
// finish() it runs validator + repair once, then replays the (possibly
// repaired) text through a fresh stock interceptor so chunk ordering,
// call-index sequencing and the final terminator behave exactly like the
// non-ultra path from that point on.
export class UltraBuffer {
    constructor(toolsRaw) {
        this.chunks = [];
        this.toolsRaw = toolsRaw ?? null;
    }

    // feed appends one upstream delta (nothing is forwarded yet).
    feed(chunk) {
        if (!chunk) return;
        this.chunks.push(chunk);
    }

    // resetTo replaces the buffered content (upstream edit_content rewind).
    resetTo(text) {
        this.chunks = [text];
    }

    fullText() {
        return this.chunks.join('');
    }

    async finish() {
        let text = this.fullText();
        const toolsJSON = this.toolsRaw == null ? ''
            : (typeof this.toolsRaw === 'string' ? this.toolsRaw : JSON.stringify(this.toolsRaw));
        const { text: repaired } = await repairUltraBuffer(text, toolsJSON, null);
        if (repaired !== text) text = repaired;

        // Replay in one pass: a single feed + finish preserves the
        // interceptor's invariants (markers never leak, fences swallowed,
        // indices sequential).
        const inceptor = new AgentStreamInterceptor();
        const parsed = inceptor.feed(text);
        const fin = inceptor.finish();
        return {
            content: parsed.content + fin.content,
            toolCalls: [...parsed.toolCalls, ...fin.toolCalls],
        };
    }
}

// resetUltraForTests allows tests to clear gate-adjacent state (the gate is
// config-driven; this helper exists for symmetry with the Go test hooks).
export function resetUltraForTests() { /* no module-level state */ }
