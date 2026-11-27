// agent.js
//
// ============================================================================
// AGENT MODE (MODERN) — XML-Sectioned Prompt Shim for Z.AI Compatibility
// ============================================================================
//
// Port of internal/zbridge/agent.go — the modern agentMode compatibility shim
// from DeepseekFreeAPI (internal/dsproxy/agent.go), adapted for the
// GLM-Free-API / Z.AI bridge.
//
// Enable with --agent-mode / AGENT_MODE=true (modern variant is the default;
// the old [ROLE: ...] rewrite shim stays available via
// --agent-mode-variant=legacy or AGENT_MODE_VARIANT=legacy).
//
// Why the modern shim replaces the legacy one:
//
//   - Legacy flattened the conversation into "[ROLE: x]" prefixed user
//     messages plus a [TOOL CONTRACT] blob. Models suffer context rot on
//     that flat format: marker ambiguity, no recency anchor, full verbatim
//     replay of long tool histories.
//
//   - Modern structures the prompt with explicit XML-like section tags
//     (<system>, <tools>, <history_summary>, <recent>, <current_task>,
//     <output_rules>), summarizes older tool exchanges, anchors the latest
//     user message as the current task, and repeats the output contract at
//     the very end (recency bias).
//
//   - Modern parsing is tolerant where legacy was strict:
//       * markers matched with 2..4 angle brackets per side (models
//         miscount brackets in the wild),
//       * ```json fences adjacent to markers are stripped,
//       * payload shapes beyond {"name","arguments"} are accepted
//         (flat {"tool": ..., params...} and alternate key spellings),
//       * the streaming interceptor holds back a trailing window so a
//         marker split across upstream chunks can never leak as content.
//
// No native tool calling is used: the model emits the tool-call protocol
// below, which is converted back to OpenAI tool_calls on the way out (parsed
// from the finished text, or incrementally while streaming).
//
// PORT NOTE: Go slices strings by BYTE offset; this port slices JS strings by
// UTF-16 code-unit index. All marker/fence text is ASCII, so indices agree;
// the byte-level rune guards (utf8.RuneStart / runeSafeCut) map to surrogate
// checks (never emit a lone surrogate half — the JS form of issue #23
// garble). Go's json.RawMessage fields map to already-parsed JS values;
// re-encoding uses JSON.stringify (compact), which — unlike Go's
// json.Marshal — does not HTML-escape <, >, & and preserves insertion order
// instead of sorting map keys (cosmetic wire difference only).

import { randomBytes } from 'node:crypto';

import { config } from './config.js';
import { logError } from './logger.js';
import { extractImageParts, attachImageParts } from './vision.js';
import {
    transformMessagesForAgent,
    newAgentStreamInterceptor,
    extractAgentToolCalls as legacyExtractAgentToolCalls,
    stripAgentToolCallBlocks as legacyStripAgentToolCallBlocks,
} from './agentLegacy.js';

export const agentToolStart = '<<<TOOL_CALL>>>';
export const agentToolEnd = '<<<END_TOOL_CALL>>>';

// ── marker tolerance ─────────────────────────────────────────────────────────
// Models occasionally miscount the angle brackets framing the markers —
// observed in the wild with deepseek-v4-pro emitting "<<TOOL_CALL>>>" (two
// leading '<') while producing a well-formed "<<<END_TOOL_CALL>>>". An
// exact-literal matcher silently misses such blocks and the whole tool call
// leaks to the client as plain content. Both markers are therefore matched
// with a bracket run of 2..4 on each side; emission above stays canonical.
export const agentStartWord = 'TOOL_CALL';
export const agentEndWord = 'END_TOOL_CALL';
export const agentMinBrackets = 2;
export const agentMaxBrackets = 4;

// agentWorstMarkerLen is the longest accepted spelling ("<<<<TOOL_CALL>>>>").
export const agentWorstMarkerLen = 2 * agentMaxBrackets + agentStartWord.length;

// bracketRunBack counts the run of b chars ending immediately before s[i].
export function bracketRunBack(s, i, b) {
    let n = 0;
    while (i - n - 1 >= 0 && s[i - n - 1] === b) n++;
    return n;
}

// bracketRunForward counts the run of b chars starting at s[0].
export function bracketRunForward(s, b) {
    let n = 0;
    while (n < s.length && s[n] === b) n++;
    return n;
}

// Sentinel results for findAgentMarker.
export const markerNone = -1; // no framed occurrence of word in s
export const markerIncomplete = -2; // a candidate needs more bytes before it can match

// findAgentMarker locates the first occurrence of word framed by 2..4 '<'
// immediately before and 2..4 '>' immediately after. It returns [index of the
// first bracket, full marker length], or markerNone / markerIncomplete.
// Occurrences not so framed (the TOOL_CALL inside an END marker, prose, code)
// are skipped.
//
// Streaming correctness: a trailing '>' run that reaches the end of s has no
// terminating byte yet, so the run may still grow — with final=false that is
// reported as markerIncomplete instead of matching short (which would leak
// the missing brackets as content) or rejecting outright. With final=true
// (finished text) an end-of-string run is taken as is.
export function findAgentMarker(s, word, final) {
    for (let from = 0; ;) {
        const j = s.indexOf(word, from);
        if (j < 0) return [markerNone, 0];
        const w = j;
        const lead = bracketRunBack(s, w, '<');
        if (lead < agentMinBrackets || lead > agentMaxBrackets) {
            from = w + word.length;
            continue;
        }
        const after = s.slice(w + word.length);
        const trail = bracketRunForward(after, '>');
        if (trail > agentMaxBrackets) {
            // Definitively over-long; more bytes cannot shrink the run.
        } else if (trail === after.length && !final) {
            // The '>' run touches the end of the available data and may
            // still grow past min/max — wait for a terminating byte.
            return [markerIncomplete, 0];
        } else if (trail >= agentMinBrackets) {
            return [w - lead, lead + word.length + trail];
        }
        from = w + word.length;
    }
}

// findAgentSpans walks every complete tolerant tool-call block in text,
// returning [{start, bodyStart, bodyEnd, end}]: [start,end) covers both
// markers, [bodyStart,bodyEnd) the JSON between them.
// An unterminated opening marker is ignored, matching the old literal scan.
export function findAgentSpans(text) {
    const spans = [];
    for (let pos = 0; ;) {
        const [s, slen] = findAgentMarker(text.slice(pos), agentStartWord, true);
        if (s < 0) return spans;
        const bodyStart = pos + s + slen;
        const [e, elen] = findAgentMarker(text.slice(bodyStart), agentEndWord, true);
        if (e < 0) return spans;
        spans.push({
            start: pos + s,
            bodyStart,
            bodyEnd: bodyStart + e,
            end: bodyStart + e + elen,
        });
        pos = bodyStart + e + elen;
    }
}

// ── prompt architecture ──────────────────────────────────────────────────────
// The prompt is structured with explicit XML-like section tags so the model
// can clearly distinguish instructions, tools, conversation history, and the
// current task. This eliminates context rot: the model no longer has to parse
// a flat blob of role-tagged text.

// agentCallSchema is the exact JSON payload shape required inside a
// tool-call block. It is stated verbatim in the prompt (and repeated in the
// final reminder): a bare "{JSON}" placeholder let models invent flat
// payloads like {"tool": "bash", "command": ...} that the runtime cannot
// map back to OpenAI tool_calls reliably.
export const agentCallSchema = '{"name":"<tool_name>","arguments":{<parameter JSON>}}';

export const agentSystemPrefix = '<system>\n' +
    'You are an agent with access to the tools listed in <tools>. Your output is parsed by a literal scanner \u2014 not a human, not an AI: it recognizes ONLY the exact byte strings below. A tool call in any paraphrased, renamed, restyled or fenced form is NOT executed; the user just sees raw text.\n' +
    '\n' +
    'TOOL CALL \u2014 exactly this shape, nothing before or after, no code fences:\n' +
    '<<<TOOL_CALL>>>\n' +
    agentCallSchema + '\n' +
    '<<<END_TOOL_CALL>>>\n' +
    'Both markers are literal constants: copy them character for character, never rename or reimagine them. The JSON has exactly two keys \u2014 "name" (a tool from <tools>) and "arguments" (that tool\'s parameter object); no "tool" key, no flat payloads. Discarded forms include <tool_call> tags, TOOL_CALL_BLOCK, any renamed marker, and any block wrapped in a code fence \u2014 with those the tool never runs.\n' +
    '\n' +
    'FINAL ANSWER \u2014 plain text, no markers, only when no tool is needed.\n' +
    '\n' +
    'RULES:\n' +
    '- Never narrate an action in words; the block IS the action. Stop right after <<<END_TOOL_CALL>>> and wait for the <tool_result>.\n' +
    '- Never invent results. Never call a tool not listed in <tools>.\n' +
    '- NO REPEATS: never re-issue a call listed in <already_called>; change the call instead. If the last tool result already answers this step, advance to the next step or give the final answer.\n' +
    '- Task fully done \u2192 answer in plain text, no block.\n' +
    '</system>';

// agentFinalReminder is appended at the very end of the prompt. Models weight
// the end of the prompt most heavily (recency bias), so the output contract
// is repeated here as the last thing the model sees.
export const agentFinalReminder = `<output_rules>
Respond with exactly ONE of:
1. A tool call \u2014 the shape below copied character for character, markers never renamed, no code fences, no other text:
<<<TOOL_CALL>>>
{"name":"<tool_name>","arguments":{...}}
<<<END_TOOL_CALL>>>
The scanner matches only these exact strings; any other form is dropped as plain text and the tool never runs.
2. Plain text, only when no tool applies.
Never re-issue a call listed in <already_called>.
</output_rules>`;

// ── prompt building ──────────────────────────────────────────────────────────
// Incoming OpenAI messages/tools are plain parsed JS objects here (Go
// unmarshals into agentMessage / openAITool structs; the JSON field tags map
// to the same snake_case keys: tool_calls, tool_call_id, function, ...).

// contentToText flattens OpenAI message content (string or typed parts) to text.
export function contentToText(raw) {
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) {
        const texts = [];
        for (const p of raw) {
            if (p && typeof p === 'object' && typeof p.text === 'string' && p.text !== '') {
                texts.push(p.text);
            }
        }
        return texts.join('\n');
    }
    return JSON.stringify(raw);
}

// jsonIndent pretty-prints a JSON value with two-space indent (Go
// json.Indent). Accepts a parsed value or raw JSON text; unparseable input
// is returned trimmed.
export function jsonIndent(raw) {
    try {
        const v = typeof raw === 'string' ? JSON.parse(raw.trim()) : raw;
        return JSON.stringify(v, null, 2);
    } catch {
        return typeof raw === 'string' ? raw.trim() : String(raw);
    }
}

function toolFnName(t) {
    if (t && t.function && typeof t.function.name === 'string' && t.function.name !== '') {
        return t.function.name;
    }
    return t && typeof t.name === 'string' ? t.name : '';
}

function toolFnDescription(t) {
    if (t && t.function && typeof t.function.description === 'string' && t.function.description !== '') {
        return t.function.description;
    }
    return t && typeof t.description === 'string' ? t.description : '';
}

function toolFnParameters(t) {
    if (t && t.function && t.function.parameters !== null && t.function.parameters !== undefined) {
        return t.function.parameters;
    }
    return t ? t.parameters : undefined;
}

// renderAgentTools renders the OpenAI tools array as the [TOOL CONTRACT] block.
export function renderAgentTools(tools) {
    if (!tools || tools.length === 0) return '(no tools provided)';
    let b = '';
    for (let i = 0; i < tools.length; i++) {
        const tool = tools[i];
        const name = toolFnName(tool);
        if (name === '') continue;
        b += `### Tool ${i + 1}: ${name}`;
        const desc = toolFnDescription(tool);
        if (desc !== '') b += '\nDescription: ' + desc;
        const params = toolFnParameters(tool);
        if (params !== null && params !== undefined) {
            b += '\nParameters JSON Schema:\n' + jsonIndent(params);
        }
        b += '\n';
    }
    return b.endsWith('\n') ? b.slice(0, -1) : b;
}

// renderToolCallBlock renders a single assistant tool-call block in the wire
// protocol format (used both in prompt history and response parsing).
// The payload object is built name-first, matching Go's struct marshal order.
export function renderToolCallBlock(call) {
    const name = call && call.function && typeof call.function.name === 'string'
        ? call.function.name : '';
    const argsText = agentParseArguments(call && call.function ? call.function.arguments : undefined);
    const payload = `{"name":${JSON.stringify(name)},"arguments":${argsText}}`;
    return `${agentToolStart}\n${payload}\n${agentToolEnd}`;
}

// renderAssistantTurn renders an assistant message with optional text and tool
// calls inside an XML-like tag.
export function renderAssistantTurn(m) {
    const text = contentToText(m.content);
    const blocks = [];
    if (text !== '') blocks.push(text);
    for (const call of m.tool_calls ?? []) {
        const block = renderToolCallBlock(call);
        if (block !== '') blocks.push(block);
    }
    return `<assistant>\n${blocks.join('\n')}\n</assistant>`;
}

// renderUserTurn renders a user message inside an XML-like tag.
export function renderUserTurn(m) {
    const text = contentToText(m.content);
    if (text === '') return '';
    return `<user>\n${text}\n</user>`;
}

// renderSystemTurn renders a system message inside an XML-like tag.
export function renderSystemTurn(m) {
    const text = contentToText(m.content);
    if (text === '') return '';
    return `<system_message>\n${text}\n</system_message>`;
}

// renderToolResult renders a tool result inside an XML-like tag with the
// call_id attribute for unambiguous matching.
export function renderToolResult(m) {
    const text = contentToText(m.content);
    const attr = m.tool_call_id ? ` call_id="${m.tool_call_id}"` : '';
    return `<tool_result${attr}>\n${text}\n</tool_result>`;
}

// renderAgentMessage renders one OpenAI message using XML-like section tags.
// This replaces the old [ROLE: ...] format with clearly delimited sections
// that the model can parse unambiguously.
export function renderAgentMessage(m) {
    let role = (typeof m.role === 'string' ? m.role : '').trim();
    if (role === '') role = 'user';
    switch (role) {
        case 'system': return renderSystemTurn(m);
        case 'user': return renderUserTurn(m);
        case 'assistant': return renderAssistantTurn(m);
        case 'tool': return renderToolResult(m);
        default: {
            // Unknown role: render as user with role annotation.
            const text = contentToText(m.content);
            return `<user role=${role}>\n${text}\n</user>`;
        }
    }
}

// ── history summarization ────────────────────────────────────────────────────
//
// For long conversations (many tool exchanges), the full replay causes context
// rot: the model loses focus on the current task. We summarize older turns
// into a compact context block while keeping the most recent turns verbatim.

// maxRecentToolExchanges is the number of recent tool-exchange pairs to keep
// in full detail. Older ones get summarized.
export const maxRecentToolExchanges = 6;

// summarizeOldHistory extracts tool-exchange summaries from older messages and
// returns a compact <history_summary> block. Returns '' if there's nothing to
// summarize. `exchanges` is [{toolName, summary}].
export function summarizeOldHistory(exchanges) {
    if (!exchanges || exchanges.length === 0) return '';
    let b = '<history_summary>\nPreviously completed tool calls:\n';
    for (let i = 0; i < exchanges.length; i++) {
        b += `${i + 1}. ${exchanges[i].toolName} → ${exchanges[i].summary}\n`;
    }
    return b + '</history_summary>';
}

// extractToolExchanges scans messages and returns
// { old: [{toolName, summary}], recent: [message...] } — old exchanges beyond
// the recent window, plus the messages to render verbatim.
export function extractToolExchanges(messages) {
    // First pass: identify tool-exchange boundaries.
    // A tool exchange = assistant with tool_calls followed by 1+ tool results.
    const exchanges = []; // {start, end} indices into messages
    let i = 0;
    while (i < messages.length) {
        if (messages[i].role === 'assistant' && (messages[i].tool_calls ?? []).length > 0) {
            const ex = { start: i };
            i++;
            // skip tool results
            while (i < messages.length && messages[i].role === 'tool') i++;
            ex.end = i;
            exchanges.push(ex);
        } else {
            i++;
        }
    }

    // If there aren't enough exchanges to summarize, keep everything.
    if (exchanges.length <= maxRecentToolExchanges) {
        return { old: [], recent: messages };
    }

    // Summarize exchanges before the recent window.
    const splitIdx = exchanges[exchanges.length - maxRecentToolExchanges].start;
    const old = [];
    for (const ex of exchanges.slice(0, exchanges.length - maxRecentToolExchanges)) {
        // Collect tool names and truncated results from this exchange.
        const assistant = messages[ex.start];
        const names = (assistant.tool_calls ?? []).map((tc) => tc?.function?.name ?? '');
        const toolName = names.join(', ');
        // Grab first tool result as summary.
        let summary = 'ok';
        if (ex.end > ex.start + 1) {
            let result = contentToText(messages[ex.start + 1].content);
            if (result.length > 80) result = result.slice(0, 77) + '...';
            summary = result;
        }
        old.push({ toolName, summary });
    }
    return { old, recent: messages.slice(splitIdx) };
}

// buildAgentPrompt constructs the prompt sent to Z.AI. The prompt is
// structured with explicit XML-like section tags so the model can clearly
// distinguish instructions, tools, history, and the current task.
//
// Structure:
//
//   <system>             — compact output contract (incl. anti-loop rules)
//   <tools>              — available tool definitions
//   <history_summary>    — summarized older turns (if conversation is long)
//   <recent>             — recent turns in full detail with grouped tool exchanges
//   <already_called>     — deduplicated list of calls already made (anti-loop)
//   <current_task>       — the latest user message (recency anchor)
//   <output_rules>       — final reminder at the very end (heaviest weight)
// agentExampleCall returns one concrete filled-in call using the request's
// first declared tool. Derailments clustered on the FIRST call of a session,
// when <recent> holds no replay to imitate; this gives exact bytes to copy.
export function agentExampleCall(tools) {
    for (const tool of tools ?? []) {
        const name = toolFnName(tool);
        if (name === '') continue;
        return 'Example of a correct tool call (this exact shape, with the arguments filled in):\n' +
            '<<<TOOL_CALL>>>\n' +
            JSON.stringify({ name, arguments: {} }) + '\n' +
            '<<<END_TOOL_CALL>>>';
    }
    return '';
}

export function buildAgentPrompt(messages, tools) {
    let b = '';

    // 1. System instructions (compact).
    b += agentSystemPrefix;
    b += '\n\n';

    // 2. Tool contract.
    b += '<tools>\n';
    b += renderAgentTools(tools);
    b += '\n</tools>\n\n';

    // 2b. One concrete example call (issue #44).
    const example = agentExampleCall(tools);
    if (example !== '') {
        b += example;
        b += '\n\n';
    }

    // 3. Split messages into old (summarizable) and recent.
    const { old: oldExchanges, recent: recentMessages } = extractToolExchanges(messages);

    const summary = summarizeOldHistory(oldExchanges);
    if (summary !== '') {
        b += summary;
        b += '\n\n';
    }

    // 4. Render recent conversation turns with grouped tool exchanges.
    if (recentMessages.length > 0) {
        b += '<recent>\n';
        b += renderRecentConversation(recentMessages);
        b += '</recent>\n\n';
    }

    // 5. Anti-loop state: the deduplicated list of calls already made. Placed
    //    late in the prompt (recency) so the model checks it against the
    //    current task before emitting anything.
    const already = agentAlreadyCalledList(messages);
    if (already !== '') {
        b += already;
        b += '\n\n';
    }

    // 6. Extract the LAST user message as the explicit current task.
    //    This is the most important change: the model knows exactly which
    //    message to respond to.
    let lastUserIdx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === 'user') {
            lastUserIdx = i;
            break;
        }
    }
    if (lastUserIdx >= 0) {
        const text = contentToText(messages[lastUserIdx].content);
        if (text !== '') {
            b += '<current_task>\n';
            b += text;
            b += '\n</current_task>\n\n';
        }
    }

    // 7. Final output contract reminder (recency anchor).
    b += agentFinalReminder;

    return b;
}

// renderRecentConversation renders recent messages with tool exchanges grouped.
// Tool calls and their results are wrapped in <tool_exchange> tags so the
// model can clearly see the call→result pairing.
export function renderRecentConversation(messages) {
    let b = '';
    let i = 0;
    while (i < messages.length) {
        const m = messages[i];

        // Skip the last user message — it goes in <current_task>.
        let isLastUser = false;
        if (m.role === 'user') {
            isLastUser = true;
            for (let j = i + 1; j < messages.length; j++) {
                if (messages[j].role === 'user') {
                    isLastUser = false;
                    break;
                }
            }
        }

        if (isLastUser) {
            i++;
            continue;
        }

        // Group assistant tool-calls with following tool results.
        if (m.role === 'assistant' && (m.tool_calls ?? []).length > 0) {
            b += '<tool_exchange>\n';
            // Render assistant's tool calls.
            b += renderAssistantTurn(m);
            b += '\n';
            i++;
            // Render tool results.
            while (i < messages.length && messages[i].role === 'tool') {
                b += renderToolResult(messages[i]);
                b += '\n';
                i++;
            }
            b += '</tool_exchange>\n';
            continue;
        }

        // Regular message.
        const rendered = renderAgentMessage(m);
        if (rendered !== '') {
            b += rendered;
            b += '\n';
        }
        i++;
    }
    return b;
}

// agentAlreadyCalledList renders the <already_called> section: a deduplicated,
// order-preserving list of every tool call the model already issued in this
// conversation. Anti-loop anchor (issue #31): long agent sessions drift into
// re-issuing identical calls (or endless thinking) because the flat replay
// never tells the model what is already done; an explicit, compact list plus
// the no-repeat rules above gives it a hard, current state to check against.
// Returns '' when no calls have been made yet (section omitted).
export function agentAlreadyCalledList(messages) {
    const lines = [];
    const seen = new Set();
    for (const m of messages) {
        if (m.role !== 'assistant') continue;
        for (const call of m.tool_calls ?? []) {
            const name = call?.function?.name ?? '';
            const argsText = agentParseArguments(call?.function?.arguments);
            const key = name + '\n' + argsText;
            if (seen.has(key)) continue;
            seen.add(key);
            lines.push(`- ${name} ${argsText}`);
        }
    }
    if (lines.length === 0) return '';
    let b = '<already_called>\n';
    b += 'Calls already made in this conversation (do NOT re-issue any of them):\n';
    for (const line of lines) {
        b += line;
        b += '\n';
    }
    b += '</already_called>';
    return b;
}

// wrapAgentPromptAsMessages wraps the built agent prompt as a Z.AI messages
// array containing a single user message. Z.AI's /api/v2/chat/completions
// only accepts role="user", and the modern shim folds the entire
// conversation into one prompt, so one user message carries it all.
// Returns the JSON-encoded messages string.
export function wrapAgentPromptAsMessages(prompt) {
    return JSON.stringify([{ role: 'user', content: prompt }]);
}

// ── response parsing ─────────────────────────────────────────────────────────

// Go: `(?i)^```(?:json)?\s*` and `(?i)\s*```$`
const agentFenceLead = /^```(?:json)?\s*/i;
const agentFenceTail = /\s*```$/i;

// ── fence tolerance ──────────────────────────────────────────────────────────
// Models often wrap tool-call blocks in ```json … ``` fences even when told
// not to. These helpers strip fence lines sitting DIRECTLY against the
// markers (never ordinary code blocks elsewhere in the answer).

// Tolerant bracket runs around both markers, e.g. "<<TOOL_CALL>>>" or
// "<<<END_TOOL_CALL>>>" as well as the canonical spellings.
export const agentMarkerPat = '(?:<{2,4})TOOL_CALL(?:>{2,4})';
export const agentEndMarkerPat = '(?:<{2,4})END_TOOL_CALL(?:>{2,4})';

// fence line immediately before a tool-call opening marker
const agentFenceBeforeCallRe = new RegExp(
    '(?:^|\\r?\\n)[ \\t]*```(?:json)?[ \\t]*\\r?\\n(' + agentMarkerPat + ')', 'g');
// fence line right after a tool-call closing marker (keeps the newline that follows)
const agentFenceAfterEndRe = new RegExp(
    '(' + agentEndMarkerPat + ')[ \\t]*\\r?\\n[ \\t]*```(?:json)?[ \\t]*((?:\\r?\\n)?)', 'g');
// bare fence line hanging at the very end of a streamed content piece
// (Go: `(?:\A|\r?\n)[ \t]*```(?:json)?[ \t]*(?:\r?\n)?\z`)
const agentTrailFenceRe = /(?:^|\r?\n)[ \t]*```(?:json)?[ \t]*(?:\r?\n)?$/;

const agentFenceJSON = '```json';

// agentStreamKeep is the minimum number of trailing chars the streaming
// interceptor keeps un-flushed while no marker has matched: enough to cover
// a fence line plus a partially received marker at its worst tolerated
// spelling, so neither can ever leak as content.
export const agentStreamKeep = agentWorstMarkerLen + '```json\n'.length + 5;

// normalizeAgentFences removes fence lines adjacent to tool-call markers from
// finished text (non-streaming path).
export function normalizeAgentFences(text) {
    for (;;) {
        let t = text.replace(agentFenceAfterEndRe, '$1$2');
        t = t.replace(agentFenceBeforeCallRe, '$1');
        if (t === text) return t;
        text = t;
    }
}

// trimTrailingAgentFence drops one fence line hanging at the end of s
// (the fence the model placed immediately before <<<TOOL_CALL>>>).
export function trimTrailingAgentFence(s) {
    return s.replace(agentTrailFenceRe, '');
}

// agentPossibleFencePrefix reports whether s is empty or could still grow
// into a bare ``` / ```json fence line — i.e. it's too early to treat the
// bytes after a tool-call block as ordinary content.
export function agentPossibleFencePrefix(s) {
    if (s === '') return true; // can't judge yet; wait for more chunks
    for (let k = 1; k <= s.length && k <= agentFenceJSON.length + 1; k++) {
        if ('```json\n'.startsWith(s.slice(0, k)) || '```\n'.startsWith(s.slice(0, k))) {
            return true;
        }
    }
    return false;
}

// skipLeadingAgentFence returns the length of a bare fence line at the start
// of s (the ``` the model places immediately after <<<END_TOOL_CALL>>>), or 0
// if s does not begin with one.
export function skipLeadingAgentFence(s) {
    let i = 0;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    if (!s.slice(i).startsWith('```')) return 0;
    let j = i + 3;
    if (s.slice(j).startsWith('json')) j += 4;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
    if (j < s.length && s[j] !== '\n' && s[j] !== '\r') {
        return 0; // not a bare fence line (e.g. an ordinary ```bash block)
    }
    if (j < s.length) { // consume one line terminator
        if (s[j] === '\r') j++;
        if (j < s.length && s[j] === '\n') j++;
    }
    return j;
}

// ── payload tolerance ────────────────────────────────────────────────────────
// The contract asks the model for {"name": "<tool>", "arguments": {...}}, but
// models observed in the wild invent their own payload shapes when the schema
// is under-specified — most commonly the FLAT form {"tool": "bash",
// "command": "...", "timeout": 10} where the tool name sits under "tool" and
// the parameters are the remaining top-level keys. A strict {name, arguments}
// unmarshal accepts such objects with name == "", so the whole block leaks to
// the client as plain content with finish_reason "stop" and the tool is never
// executed. We therefore accept every shape that unambiguously names a tool
// and its parameters.

// agentNameKeys are accepted spellings of the "which tool" key, in priority
// order. Explicit tool-* keys outrank "name": in a flat payload a "name"
// entry is more likely a tool PARAMETER named "name" than the tool itself,
// while a "tool" entry is never a canonical-shape artifact.
export const agentNameKeys = ['tool', 'tool_name', 'function', 'function_name', 'name'];

// agentArgKeys are accepted spellings of the explicit "parameters" key.
export const agentArgKeys = ['arguments', 'parameters', 'args', 'params', 'input'];

// agentExtractCall resolves (name, arguments) from one decoded tool-call
// payload object, accepting the canonical shape, alternate key spellings,
// and flat payloads where the parameters are the remaining top-level keys.
// Returns { name, args, ok } where args is the raw (parsed) JS value.
export function agentExtractCall(obj) {
    // Locate the tool name under any accepted key spelling.
    let name = '';
    let nameKey = '';
    for (const k of agentNameKeys) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        const v = obj[k];
        if (typeof v === 'string' && v.trim() !== '') {
            name = v.trim();
            nameKey = k;
            break;
        }
    }
    if (nameKey === '') return { name: '', args: undefined, ok: false };

    // An explicit arguments object wins over the flat fallback.
    for (const k of agentArgKeys) {
        if (Object.prototype.hasOwnProperty.call(obj, k) && !isJSONNull(obj[k])) {
            return { name, args: obj[k], ok: true };
        }
    }

    // Flat payload: every remaining top-level key is a parameter.
    const rest = {};
    for (const k of Object.keys(obj)) {
        if (k !== nameKey) rest[k] = obj[k];
    }
    return { name, args: rest, ok: true };
}

// isJSONNull reports whether the parsed value is null/absent (Go: raw is
// whitespace, JSON null, or empty).
export function isJSONNull(v) {
    return v === null || v === undefined;
}

// agentLooseParse parses one tool-call body, tolerating markdown fences and
// the payload shape deviations listed at agentNameKeys / agentArgKeys.
export function agentLooseParse(body) {
    let raw = body.trim();
    raw = raw.replace(agentFenceLead, '');
    raw = raw.replace(agentFenceTail, '');
    let obj;
    try {
        obj = JSON.parse(raw);
    } catch {
        return { name: '', args: undefined, ok: false };
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj) || Object.keys(obj).length === 0) {
        return { name: '', args: undefined, ok: false };
    }
    return agentExtractCall(obj);
}

// agentParseArguments normalizes model-provided arguments to compact JSON
// text (objects pass through, JSON-encoded strings are parsed, unparsable
// strings stay quoted).
export function agentParseArguments(raw) {
    if (raw === null || raw === undefined) return '{}';
    if (typeof raw === 'string') {
        try {
            return JSON.stringify(JSON.parse(raw.trim()));
        } catch {
            return JSON.stringify(raw);
        }
    }
    try {
        return JSON.stringify(raw);
    } catch {
        return '{}';
    }
}

// agentStreamArguments mirrors the stream path: non-string values are
// compacted, string values are used verbatim.
export function agentStreamArguments(raw) {
    if (raw === null || raw === undefined) return '{}';
    if (typeof raw === 'string') return raw;
    try {
        return JSON.stringify(raw);
    } catch {
        return '{}';
    }
}

// agentRandomHex returns n random bytes as lowercase hex (call-id suffixes).
export function agentRandomHex(n) {
    return randomBytes(n).toString('hex');
}

// parseAgentToolCalls extracts every complete tool-call block from finished
// text and returns OpenAI-format tool_calls objects.
export function parseAgentToolCalls(text) {
    text = normalizeAgentFences(text);
    const calls = [];
    for (const span of findAgentSpans(text)) {
        const { name, args, ok } = agentLooseParse(text.slice(span.bodyStart, span.bodyEnd));
        if (!ok || name === '') continue;
        calls.push({
            id: 'call_' + agentRandomHex(12),
            type: 'function',
            function: {
                name,
                arguments: agentParseArguments(args),
            },
        });
    }
    return calls;
}

// stripAgentToolCalls removes all tool-call blocks from finished text.
export function stripAgentToolCalls(text) {
    text = normalizeAgentFences(text);
    let kept = '';
    let prev = 0;
    for (const span of findAgentSpans(text)) {
        kept += text.slice(prev, span.start);
        prev = span.end;
    }
    kept += text.slice(prev);
    return kept.trim();
}

// ── streaming interceptor ────────────────────────────────────────────────────

export function isASCIISpace(b) {
    return b === ' ' || b === '\t' || b === '\n' || b === '\r' || b === '\v' || b === '\f';
}

// jsonStringValueAt reads a `"key": "value"` string value starting the scan
// at pos (just past the quoted key). ok is false when the value is not a
// string or its closing quote has not arrived yet.
export function jsonStringValueAt(s, pos) {
    while (pos < s.length && isASCIISpace(s[pos])) pos++;
    if (pos >= s.length || s[pos] !== ':') return ['', false];
    pos++;
    while (pos < s.length && isASCIISpace(s[pos])) pos++;
    if (pos >= s.length || s[pos] !== '"') return ['', false];
    pos++;
    const start = pos;
    while (pos < s.length) {
        if (s[pos] === '\\') {
            pos += 2;
            continue;
        }
        if (s[pos] === '"') return [s.slice(start, pos), true];
        pos++;
    }
    return ['', false];
}

// agentStreamExtractName resolves the tool name from partial block body text,
// accepting the same key spellings as agentExtractCall (priority order). The
// search stops before any arguments key so a nested "name" parameter inside
// the arguments object can never be mistaken for the tool name. ok is false
// while no accepted key carries a complete string value yet.
export function agentStreamExtractName(body) {
    let searchEnd = body.length;
    for (const k of agentArgKeys) {
        const i = body.indexOf(`"${k}"`);
        if (i >= 0 && i < searchEnd) searchEnd = i;
    }
    const region = body.slice(0, searchEnd);
    for (const k of agentNameKeys) {
        const keyIdx = region.indexOf(`"${k}"`);
        if (keyIdx < 0) continue;
        const [v, ok] = jsonStringValueAt(region, keyIdx + k.length + 2);
        if (ok) return [v, true];
    }
    return ['', false];
}

// Outcomes of agentStreamFindArgs.
export const argsPending = 0; // no complete arguments value start visible yet
export const argsObject = 1; // value starts with '{' — bracePos is its offset
export const argsNonObject = 2; // value exists but is not an object — cannot stream

// agentStreamFindArgs locates the arguments value in partial block body text
// using the accepted key spellings (agentArgKeys, priority order).
// Returns [bracePos, state].
export function agentStreamFindArgs(body) {
    for (const k of agentArgKeys) {
        const keyIdx = body.indexOf(`"${k}"`);
        if (keyIdx < 0) continue;
        let pos = keyIdx + k.length + 2;
        while (pos < body.length && isASCIISpace(body[pos])) pos++;
        if (pos >= body.length) return [0, argsPending]; // key arrived, colon pending
        if (body[pos] !== ':') return [0, argsNonObject]; // malformed — buffered parse will judge
        pos++;
        while (pos < body.length && isASCIISpace(body[pos])) pos++;
        if (pos >= body.length) return [0, argsPending]; // value start pending
        if (body[pos] !== '{') return [0, argsNonObject]; // string/number arguments — buffer mode
        return [pos, argsObject];
    }
    return [0, argsPending];
}

// States of agentEndMarkerPrefix.
export const agentPrefixNo = 0; // s can never grow into a tolerated marker
export const agentPrefixMaybe = 1; // s is a strict prefix of some tolerated marker
export const agentPrefixComplete = 2; // s starts with a complete tolerated marker

// agentEndMarkerPrefix classifies s (which starts with '<') against the
// tolerated END_TOOL_CALL marker spellings (agentMinBrackets..agentMaxBrackets
// on each side). A "maybe" verdict means the bytes so far are consistent with
// a marker that is still arriving across upstream chunks — the caller must
// hold them back rather than stream them as argument content.
// Returns [state, markerLen].
export function agentEndMarkerPrefix(s) {
    const L = bracketRunForward(s, '<');
    if (L > agentMaxBrackets) return [agentPrefixNo, 0];
    const rest = s.slice(L);
    const word = agentEndWord;
    let k = 0;
    while (k < rest.length && k < word.length && rest[k] === word[k]) k++;
    if (k === 0) {
        if (rest.length === 0) return [agentPrefixMaybe, 0]; // bare '<' run, word may still start
        return [agentPrefixNo, 0]; // '<' followed by a non-'E' byte: ordinary
    }
    if (L < agentMinBrackets) return [agentPrefixNo, 0]; // lead run finalized below tolerance
    if (k < word.length) {
        if (k === rest.length) return [agentPrefixMaybe, 0]; // word still arriving
        return [agentPrefixNo, 0]; // word mismatched mid-way
    }
    const after = rest.slice(word.length);
    const trail = bracketRunForward(after, '>');
    if (trail > agentMaxBrackets) return [agentPrefixNo, 0];
    if (trail < agentMinBrackets && trail === after.length) {
        return [agentPrefixMaybe, 0]; // '>' run may still grow to tolerance
    }
    if (trail < agentMinBrackets) return [agentPrefixNo, 0]; // non-'>' byte right after the word
    return [agentPrefixComplete, L + word.length + trail];
}

// isLowSurrogate / isHighSurrogate classify UTF-16 code units. JS strings
// arriving from the SSE decoder are always complete text, but test chunkers
// (and the hold-back cut below) may split a surrogate pair — the JS
// equivalent of Go slicing a string mid-rune (issue #23).
function isLowSurrogate(cu) {
    return cu >= 0xdc00 && cu <= 0xdfff;
}

function isHighSurrogate(cu) {
    return cu >= 0xd800 && cu <= 0xdbff;
}

// runeSafeCut returns the largest prefix length of s that ends on a code
// point boundary, holding back a trailing high surrogate (half of an astral
// character whose second half has not arrived yet). Argument fragments must
// be valid text on their own: an upstream chunk boundary can split a
// surrogate pair, and forwarding the halves separately would surface as
// U+FFFD garble on the client (issue #23).
// (Go: runeSafeCut holds back up to utf8.UTFMax-1 trailing bytes of an
// incomplete multi-byte sequence.)
export function runeSafeCut(s) {
    let n = s.length;
    if (n > 0 && isHighSurrogate(s.charCodeAt(n - 1))) n--;
    return n;
}

// AgentStreamInterceptor incrementally separates ordinary text from tool-call
// blocks. It retains a short suffix so a marker split across upstream chunks
// is never leaked to the client.
//
// Tool calls STREAM like the OpenAI / Anthropic APIs: as soon as the block's
// {"name": ..., "arguments": { has arrived the interceptor emits the header
// delta (index + id + type + function.name), then forwards the arguments
// object char-by-char as id-less fragments while the model is still writing
// it — the client sees live tool-call SSE instead of a long silence followed
// by one buffered blob. Payload shapes that cannot be streamed safely
// (non-object arguments, flat payloads, a name that never resolves) fall
// back to the old behaviour: the whole block is buffered between the markers
// and emitted as one complete call.
export class AgentStreamInterceptor {
    constructor() {
        this.buffer = '';
        this.offset = 0;
        this.callIndex = 0;
        this.pendingSep = false; // a tool-call block just closed: watch for a stray fence

        // ── incremental tool-call streaming state ──
        this.inCall = false; // between the opening and closing markers
        this.tcBlockStart = 0; // offset of the opening marker (for leak-as-content)
        this.tcName = ''; // resolved tool name, once complete
        this.tcNameFound = false;
        this.tcArgsFound = false; // the arguments value's opening '{' was located
        this.tcArgsPos = 0; // absolute offset of that '{' in buffer
        this.tcArgsStreamed = 0; // chars of the arguments object already emitted
        this.tcBraceDepth = 0; // brace depth while scanning arguments
        this.tcInString = false; // inside a JSON string while scanning arguments
        this.tcEscapeNext = false; // next char is escaped while scanning arguments
        this.tcArgsDone = false; // the arguments object's closing '}' was emitted
        this.tcFallback = false; // un-streamable shape: buffer the block, parse at the end
    }

    // feed processes one upstream chunk and returns
    // { content, toolCalls } (Go: Feed(chunk) AgentParsedChunk).
    feed(chunk) {
        this.buffer += chunk;
        return this.drain(false);
    }

    // finish drains the interceptor at end of upstream stream, treating the
    // buffered tail as complete data: a marker whose trailing '>' run touches
    // the very end can now match, and whatever remains unparsed is ordinary
    // content. Tool calls discovered here must still be forwarded to the
    // client. (Go: Finish().)
    finish() {
        const parsed = this.drain(true);
        this.offset = this.buffer.length;
        return parsed;
    }

    // finishCall closes the current tool-call block: scanning resumes after it
    // and the pendingSep pass swallows a stray fence the model may append.
    finishCall() {
        this.inCall = false;
        this.pendingSep = true;
        this.tcName = '';
        this.tcNameFound = false;
        this.tcArgsFound = false;
        this.tcArgsPos = 0;
        this.tcArgsStreamed = 0;
        this.tcBraceDepth = 0;
        this.tcInString = false;
        this.tcEscapeNext = false;
        this.tcArgsDone = false;
        this.tcFallback = false;
    }

    drain(final) {
        const content = [];
        const toolCalls = [];

        for (;;) {
            // Immediately after a tool-call block, swallow blank space and
            // stray ```json / ``` fence lines the model appends despite
            // instructions (possibly split across chunks). Ordinary content
            // elsewhere — including its leading spaces and real code blocks —
            // is untouched.
            if (this.pendingSep) {
                for (;;) {
                    while (this.offset < this.buffer.length && isASCIISpace(this.buffer[this.offset])) {
                        this.offset++;
                    }
                    const n = skipLeadingAgentFence(this.buffer.slice(this.offset));
                    if (n === 0) break;
                    this.offset += n;
                }
                if (agentPossibleFencePrefix(this.buffer.slice(this.offset)) && !final) {
                    break; // could still become a fence; wait for more chunks
                }
                this.pendingSep = false;
            }

            if (this.inCall) {
                if (!this.drainToolCall(final, content, toolCalls)) {
                    break; // block still streaming: wait for more chunks
                }
                continue;
            }

            const rest = this.buffer.slice(this.offset);
            const [start, markerLen] = findAgentMarker(rest, agentStartWord, final);
            if (start < 0) {
                if (final) {
                    // End of data: everything left is ordinary content.
                    if (rest !== '') {
                        content.push(rest);
                        this.offset = this.buffer.length;
                    }
                    break;
                }
                // Hold back a window big enough for a fence line + partial
                // marker so neither can leak as content while split across
                // chunks. A marker reported incomplete keeps its bytes inside
                // this window, so nothing here can be part of a future match.
                // The cut is backed up to a code point boundary so an astral
                // character is never split across emissions (a lone surrogate
                // would render as replacement-char garble on the client —
                // issue #23).
                const keep = agentStreamKeep;
                if (rest.length > keep) {
                    let cut = rest.length - keep;
                    while (cut > 0 && isLowSurrogate(rest.charCodeAt(cut))) cut--;
                    if (cut > 0) {
                        content.push(rest.slice(0, cut));
                        this.offset += cut;
                    }
                }
                break;
            }
            if (start > 0) {
                const piece = trimTrailingAgentFence(rest.slice(0, start));
                if (piece !== '') content.push(piece);
                this.offset += start;
            }
            // Enter the tool-call block: the opening marker is consumed now
            // and the body streams incrementally until the closing marker.
            this.inCall = true;
            this.tcBlockStart = this.offset;
            this.offset += markerLen;
        }
        return { content: content.join(''), toolCalls };
    }

    // emitArgsFragment forwards argsText[:emitEnd] as the next streamed
    // delta: it merges into the header emitted earlier in the same pass
    // (exactly what OpenAI does when one chunk covers the name and the first
    // argument bytes), or rides its own id-less fragment delta when the
    // header went out earlier.
    emitArgsFragment(argsText, emitEnd, headerIdx, toolCalls) {
        if (emitEnd <= this.tcArgsStreamed) return; // nothing new to forward
        const frag = argsText.slice(this.tcArgsStreamed, emitEnd);
        this.tcArgsStreamed = emitEnd;
        if (headerIdx >= 0) {
            toolCalls[headerIdx].function.arguments = frag;
            return;
        }
        toolCalls.push({
            index: this.callIndex,
            function: { arguments: frag },
        });
    }

    // drainToolCall processes the body of one open tool-call block. It
    // returns false when more upstream chars are needed, true once the block
    // is fully consumed (drain continues scanning for what follows).
    //
    // Streaming contract (mirrors the OpenAI chunk sequence):
    //   - the header delta carries index, id, type and function.name —
    //     emitted as soon as the name AND an object-valued arguments key have
    //     arrived;
    //   - each subsequent delta carries index and a function.arguments
    //     fragment;
    //   - when header and the first fragment surface in the same pass they
    //     ride one delta (exactly what OpenAI emits when a chunk covers
    //     both).
    drainToolCall(final, content, toolCalls) {
        let headerIdx = -1; // toolCalls slot of the header emitted in this pass

        for (;;) {
            const body = this.buffer.slice(this.offset);

            // ── Fallback mode: buffer everything, parse the complete block ──
            if (this.tcFallback) {
                const [idx, markerLen] = findAgentMarker(body, agentEndWord, final);
                if (idx < 0) {
                    if (!final) return false;
                    // Stream ended mid-block: drop the tail (existing policy).
                    this.offset = this.buffer.length;
                    this.finishCall();
                    return true;
                }
                const end = this.offset + idx;
                const raw = this.buffer.slice(this.offset, end).trim();
                const { name, args, ok } = agentLooseParse(raw);
                if (ok && name !== '') {
                    toolCalls.push({
                        index: this.callIndex,
                        id: 'call_' + agentRandomHex(12),
                        type: 'function',
                        function: {
                            name,
                            arguments: agentStreamArguments(args),
                        },
                    });
                    this.callIndex++;
                } else {
                    // invalid model block: leave it as visible text
                    content.push(this.buffer.slice(this.tcBlockStart, end + markerLen));
                }
                this.offset = end + markerLen;
                this.finishCall();
                return true;
            }

            // ── Phase 1: resolve the tool name ──
            if (!this.tcNameFound) {
                const [name, ok] = agentStreamExtractName(body);
                if (ok) {
                    this.tcName = name;
                    this.tcNameFound = true;
                } else {
                    // No complete name yet: if the block already closed (or
                    // the stream ended) it never will — parse the whole body
                    // instead.
                    const [idx] = findAgentMarker(body, agentEndWord, final);
                    if (idx >= 0 || final) {
                        this.tcFallback = true;
                        continue;
                    }
                    return false;
                }
            }

            // ── Phase 2: locate the arguments object, then emit the header ──
            if (!this.tcArgsFound) {
                const [pos, state] = agentStreamFindArgs(body);
                if (state === argsObject) {
                    this.tcArgsFound = true;
                    this.tcArgsPos = this.offset + pos;
                    toolCalls.push({
                        index: this.callIndex,
                        id: 'call_' + agentRandomHex(12),
                        type: 'function',
                        function: {
                            name: this.tcName,
                            arguments: '',
                        },
                    });
                    headerIdx = toolCalls.length - 1;
                } else if (state === argsNonObject) {
                    this.tcFallback = true; // e.g. arguments as a JSON-encoded string
                    continue;
                } else { // argsPending
                    const [idx] = findAgentMarker(body, agentEndWord, final);
                    if (idx >= 0 || final) {
                        this.tcFallback = true; // flat payload or name-only block
                        continue;
                    }
                    return false;
                }
            }

            // ── Phase 3: stream the arguments object char-by-char ──
            if (!this.tcArgsDone) {
                const argsText = this.buffer.slice(this.tcArgsPos);
                let i = this.tcArgsStreamed;
                let truncatedAt = -1;
                let truncatedLen = 0;
                scan:
                while (i < argsText.length) {
                    const c = argsText[i];
                    if (this.tcEscapeNext) {
                        this.tcEscapeNext = false;
                        i++;
                        continue;
                    }
                    if (c === '\\') {
                        this.tcEscapeNext = true;
                        i++;
                        continue;
                    }
                    if (c === '"') {
                        this.tcInString = !this.tcInString;
                        i++;
                        continue;
                    }
                    if (!this.tcInString) {
                        if (c === '<') {
                            // Outside a string this can only be the closing
                            // marker arriving before the braces balanced (the
                            // model bailed mid-JSON). Markers INSIDE a string
                            // value are content and deliberately never match
                            // here; a partial marker split across upstream
                            // chunks is held back, never streamed as argument
                            // bytes.
                            const [state, mLen] = agentEndMarkerPrefix(argsText.slice(i));
                            if (state === agentPrefixComplete) {
                                truncatedAt = i;
                                truncatedLen = mLen;
                                break scan;
                            } else if (state === agentPrefixMaybe && !final) {
                                this.emitArgsFragment(argsText, i, headerIdx, toolCalls);
                                return false; // marker still arriving: wait for it
                            } else {
                                i++; // ordinary char inside malformed JSON
                                continue;
                            }
                        } else if (c === '{') {
                            this.tcBraceDepth++;
                        } else if (c === '}') {
                            this.tcBraceDepth--;
                            if (this.tcBraceDepth === 0) {
                                i++;
                                this.tcArgsDone = true;
                                break scan;
                            }
                        }
                    }
                    i++;
                }

                let emitEnd = i;
                if (!this.tcArgsDone && truncatedAt < 0) {
                    // Also at final: an incomplete trailing surrogate can
                    // never complete — forwarding it would surface as U+FFFD
                    // garble.
                    emitEnd = runeSafeCut(argsText.slice(0, i));
                    // Held-back chars are only the tail of one incomplete
                    // code point (never a quote/backslash/brace), so
                    // re-scanning them next pass cannot corrupt the
                    // string/escape/depth state.
                }
                this.emitArgsFragment(argsText, emitEnd, headerIdx, toolCalls);

                if (this.tcArgsDone) {
                    this.offset = this.tcArgsPos + this.tcArgsStreamed;
                } else if (truncatedAt >= 0) {
                    // Malformed call (unbalanced JSON): the header already
                    // went out, so close the call at the marker instead of
                    // leaking the marker bytes into the arguments string.
                    this.offset = this.tcArgsPos + truncatedAt + truncatedLen;
                    this.callIndex++;
                    this.finishCall();
                    return true;
                } else {
                    return false; // arguments still streaming
                }
            }

            // ── Phase 4: arguments complete — consume the closing marker ──
            const rest = this.buffer.slice(this.offset);
            const [idx, markerLen] = findAgentMarker(rest, agentEndWord, final);
            if (idx < 0) {
                if (final) {
                    // Truncated block: the streamed call stands; drop the tail.
                    this.offset = this.buffer.length;
                    this.callIndex++;
                    this.finishCall();
                    return true;
                }
                return false;
            }
            this.offset += idx + markerLen;
            this.callIndex++;
            this.finishCall();
            return true;
        }
    }
}

// ============================================================================
// SHIM DISPATCH GLUE — lets the request handlers stay variant-agnostic
// ============================================================================
//
// The two agent-mode implementations (modern in this file, legacy in
// agentLegacy.js) expose slightly different APIs. These thin
// adapters/dispatchers present one uniform surface so
// chatCompletionsHandler / anthropicMessagesHandler pick the active shim
// purely from config.

// transformMessagesForAgentModern folds the whole conversation + tool contract
// into one XML-sectioned prompt and wraps it as a single Z.AI user message.
// `rawMessages` / `toolsRaw` accept raw JSON strings or already-parsed arrays.
// Returns the JSON-encoded messages string.
export function transformMessagesForAgentModern(rawMessages, toolsRaw) {
    const msgs = typeof rawMessages === 'string' ? JSON.parse(rawMessages) : rawMessages;
    if (!Array.isArray(msgs)) {
        throw new Error('agent transform (modern): parse messages: not a messages array');
    }
    let tools = [];
    if (toolsRaw !== null && toolsRaw !== undefined) {
        try {
            const t = typeof toolsRaw === 'string' ? JSON.parse(toolsRaw) : toolsRaw;
            if (Array.isArray(t)) tools = t;
        } catch { /* Go: _ = json.Unmarshal — ignored */ }
    }
    const prompt = buildAgentPrompt(msgs, tools);
    return wrapAgentPromptAsMessages(prompt);
}

// agentTransformMessages rewrites the incoming OpenAI messages array for the
// active agent shim, returning the JSON-encoded messages string to send
// upstream.
//
// Both shims flatten message content to plain text, which drops the
// image_url parts that processVisionMessages rewrote to uploaded Z.AI file
// ids. Without those references the model never receives the pixels and
// answers "I don't see any image" even though the files array is attached —
// so the image parts are re-attached to the final user message afterwards.
export function agentTransformMessages(rawMessages, toolsRaw) {
    let out;
    if (config.agentModern()) {
        out = transformMessagesForAgentModern(rawMessages, toolsRaw);
    } else {
        let tools = [];
        if (toolsRaw !== null && toolsRaw !== undefined) {
            try {
                tools = typeof toolsRaw === 'string' ? JSON.parse(toolsRaw) : toolsRaw;
            } catch { /* Go: _ = json.Unmarshal — ignored */ }
        }
        out = transformMessagesForAgent(rawMessages, tools);
    }
    const imageParts = extractImageParts(rawMessages);
    if (imageParts && imageParts.length > 0) {
        try {
            return attachImageParts(out, imageParts);
        } catch (aerr) {
            // On attach failure fall through to the text-only transform: the
            // request still completes (without vision) instead of erroring.
            logError('agent vision attach failed: ' + aerr.message);
        }
    }
    return out;
}

// agentExtractToolCalls parses tool-call blocks out of finished assistant text
// using the active shim's parser.
export function agentExtractToolCalls(text) {
    if (config.agentModern()) {
        return parseAgentToolCalls(text);
    }
    return legacyExtractAgentToolCalls(text);
}

// agentStripToolCalls removes tool-call blocks from finished assistant text
// using the active shim's stripper.
export function agentStripToolCalls(text) {
    if (config.agentModern()) {
        return stripAgentToolCalls(text);
    }
    return legacyStripAgentToolCallBlocks(text);
}

// modernAgentInterceptor adapts AgentStreamInterceptor (complete-call
// emission, tolerant markers, hold-back window) to the uniform interceptor
// surface: feed/finish -> { content, toolCalls }.
export class ModernAgentInterceptor {
    constructor() {
        this.in = new AgentStreamInterceptor();
    }

    feed(chunk) {
        return this.in.feed(chunk);
    }

    finish() {
        return this.in.finish();
    }
}

// legacyAgentInterceptor adapts the legacy agentStreamInterceptor
// (incremental argument streaming) to the uniform interceptor surface. Its
// finish returns only trailing content; end-of-stream tool calls are caught
// by the caller's extractAgentToolCalls safety net.
export class LegacyAgentInterceptor {
    constructor() {
        this.in = newAgentStreamInterceptor();
    }

    feed(chunk) {
        const { contentDelta, toolCalls } = this.in.feed(chunk);
        return { content: contentDelta, toolCalls };
    }

    finish() {
        return { content: this.in.flushFinal(), toolCalls: [] };
    }
}

// newAgentInterceptor constructs the streaming interceptor for the active shim.
export function newAgentInterceptor() {
    if (config.agentModern()) {
        return new ModernAgentInterceptor();
    }
    return new LegacyAgentInterceptor();
}

// rearmAgentInterceptor replaces a stale interceptor (an upstream
// edit_content rewrite rewound text it had already consumed — issue #23)
// while preserving the client-visible call-index sequence: a call streamed
// before the rewind keeps its index, and the re-emitted block takes the
// next one instead of colliding inside SDK accumulation.
export function rearmAgentInterceptor(old) {
    const fresh = newAgentInterceptor();
    if (old instanceof ModernAgentInterceptor && fresh instanceof ModernAgentInterceptor) {
        fresh.in.callIndex = old.in.callIndex;
    } else if (old instanceof LegacyAgentInterceptor && fresh instanceof LegacyAgentInterceptor) {
        fresh.in.callIndex = old.in.callIndex;
    }
    return fresh;
}
