// Port of internal/zbridge/anthropic.go — Anthropic /v1/messages protocol
// support: request translation, SSE event conversion, and error envelopes.
// Auth: Anthropic clients send the API key via the x-api-key header (handled
// in checkAuth, middleware.js); the anthropic-version header is allowed via
// CORS.
//
// Go -> JS mapping: see handlers.js header. anthropicToOpenAIRequest returns
// the converted request as a JSON string (Go returned json.Marshal bytes);
// callers re-parse the fields they need, exactly like the Go original.

import { config } from './config.js';
import { generateID, messagesToPrompt, estimateTokens } from './util.js';
import { logError, logInfo } from './logger.js';
import { writeJSON } from './middleware.js';
import { rejectIfWAFBlocked } from './waf.js';
import { sendToZAI, statusFromError } from './zai.js';
import { acquireStatelessSession, releaseStatelessSession } from './sessionPool.js';
import { modelSupportsVision, resolveModelID } from './models.js';
import { processVisionMessages } from './vision.js';
import {
    agentTransformMessages,
    newAgentInterceptor,
    rearmAgentInterceptor,
    agentExtractToolCalls,
    agentStripToolCalls,
} from './agent.js';
import { UltraBuffer, ultraRepairEnabled, ultraRepairFullText } from './agentUltra.js';

// formatAnthropicError builds an Anthropic-style error envelope.
export function formatAnthropicError(errType, message) {
    return {
        type: 'error',
        error: { type: errType, message },
    };
}

// extractAnthropicContent coerces an Anthropic content field (string or
// array of content blocks) into a plain string.
export function extractAnthropicContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const parts = [];
        for (const item of content) {
            if (item && typeof item === 'object' && item.type === 'text' &&
                typeof item.text === 'string') {
                parts.push(item.text);
            }
        }
        return parts.join('\n');
    }
    return JSON.stringify(content);
}

// anthropicContentToOpenAI converts an Anthropic content field to an OpenAI
// content value. When the content carries no image blocks it collapses to a
// plain string (preserving the long-standing text behavior exactly). When one
// or more image blocks are present it returns an array of OpenAI content parts
// (text + image_url) so the shared vision pipeline can pick the images up.
export function anthropicContentToOpenAI(content) {
    if (!Array.isArray(content)) {
        return extractAnthropicContent(content); // string / scalar path
    }

    const hasImage = content.some(
        (item) => item && typeof item === 'object' && item.type === 'image');
    if (!hasImage) {
        return extractAnthropicContent(content);
    }

    const parts = [];
    for (const item of content) {
        if (!item || typeof item !== 'object') continue;
        switch (item.type) {
            case 'text':
                if (typeof item.text === 'string') {
                    parts.push({ type: 'text', text: item.text });
                }
                break;
            case 'image': {
                const part = anthropicImageToOpenAI(item);
                if (part !== null) parts.push(part);
                break;
            }
        }
    }
    if (parts.length === 0) {
        return extractAnthropicContent(content);
    }
    return parts;
}

// anthropicImageToOpenAI converts a single Anthropic image block into an
// OpenAI image_url part, or null if the block is malformed/unsupported.
// base64 sources become data: URLs; url sources pass through.
export function anthropicImageToOpenAI(block) {
    const src = block?.source;
    if (!src || typeof src !== 'object') return null;
    let imgURL;
    switch (src.type) {
        case 'base64': {
            const data = typeof src.data === 'string' ? src.data : '';
            if (data === '') return null;
            const mediaType = typeof src.media_type === 'string' && src.media_type !== ''
                ? src.media_type : 'image/png';
            imgURL = 'data:' + mediaType + ';base64,' + data;
            break;
        }
        case 'url': {
            const u = typeof src.url === 'string' ? src.url : '';
            if (u === '') return null;
            imgURL = u;
            break;
        }
        default:
            return null;
    }
    return { type: 'image_url', image_url: { url: imgURL } };
}

// anthropicToOpenAIRequest converts an Anthropic /v1/messages request body
// (JSON string) to an OpenAI /v1/chat/completions request body (JSON string)
// for the existing sendToZAI pipeline. Throws on invalid JSON.
export function anthropicToOpenAIRequest(bodyStr) {
    const req = JSON.parse(bodyStr); // Go: json.Unmarshal error -> 400

    const out = {};
    if ('model' in req) out.model = req.model;
    if ('stream' in req) out.stream = req.stream;
    if ('max_tokens' in req) out.max_tokens = req.max_tokens;
    if ('temperature' in req) out.temperature = req.temperature;
    if ('top_p' in req) out.top_p = req.top_p;
    if ('stop_sequences' in req) out.stop = req.stop_sequences;

    const messages = [];

    // System field -> system message
    if ('system' in req) {
        const sysStr = extractAnthropicContent(req.system);
        if (sysStr !== '') {
            messages.push({ role: 'system', content: sysStr });
        }
    }

    // Convert messages
    if (Array.isArray(req.messages)) {
        for (const m of req.messages) {
            if (!m || typeof m !== 'object') continue;
            const role = typeof m.role === 'string' ? m.role : '';
            const content = m.content;

            // Handle tool_result content blocks in user messages
            if (Array.isArray(content)) {
                let hasToolResult = false;
                for (const item of content) {
                    if (item && typeof item === 'object' && item.type === 'tool_result') {
                        hasToolResult = true;
                        const toolUseID = typeof item.tool_use_id === 'string' ? item.tool_use_id : '';
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolUseID,
                            content: extractAnthropicContent(item.content),
                        });
                    }
                }
                if (hasToolResult) continue;
            }

            // Handle assistant tool_use blocks -> OpenAI tool_calls
            if (role === 'assistant' && Array.isArray(content)) {
                const textParts = [];
                const toolCalls = [];
                for (const item of content) {
                    if (!item || typeof item !== 'object') continue;
                    switch (item.type) {
                        case 'text':
                            if (typeof item.text === 'string') textParts.push(item.text);
                            break;
                        case 'tool_use': {
                            const id = typeof item.id === 'string' ? item.id : '';
                            const name = typeof item.name === 'string' ? item.name : '';
                            const args = item.input ?? {};
                            toolCalls.push({
                                id,
                                type: 'function',
                                function: { name, arguments: JSON.stringify(args) },
                            });
                            break;
                        }
                    }
                }
                const msg = { role: 'assistant', content: textParts.join('\n') };
                if (toolCalls.length > 0) msg.tool_calls = toolCalls;
                messages.push(msg);
                continue;
            }

            messages.push({ role, content: anthropicContentToOpenAI(content) });
        }
    }
    out.messages = messages;

    // Convert tools: input_schema -> parameters, wrap in function
    if (Array.isArray(req.tools) && req.tools.length > 0) {
        const openaiTools = [];
        for (const t of req.tools) {
            if (!t || typeof t !== 'object') continue;
            const fn = {
                name: typeof t.name === 'string' ? t.name : '',
                description: typeof t.description === 'string' ? t.description : '',
            };
            if ('input_schema' in t) fn.parameters = t.input_schema;
            openaiTools.push({ type: 'function', function: fn });
        }
        out.tools = openaiTools;
    }

    // Search toggles (issue #42). webSearch takes precedence over its
    // `search` alias; advancedSearch implies web search on the OpenAI path.
    if ('webSearch' in req) out.webSearch = req.webSearch;
    else if ('search' in req) out.webSearch = req.search;
    if ('advancedSearch' in req) out.advancedSearch = req.advancedSearch;

    // Convert thinking config
    if (req.thinking && typeof req.thinking === 'object') {
        out.thinking = req.thinking;
        if (req.thinking.type === 'enabled') {
            out.reasoning = true;
        }
    }

    return JSON.stringify(out);
}

// thinkingEnabled returns true if the Anthropic thinking config is enabled.
export function thinkingEnabled(thinkingCfg) {
    if (thinkingCfg === null || thinkingCfg === undefined) return false;
    if (typeof thinkingCfg !== 'object') return false;
    return thinkingCfg.type === 'enabled';
}

// anthropicMessagesHandler exposes the Anthropic Messages API at /v1/messages.
export async function anthropicMessagesHandler(req, res, ctx) {
    if (req.method !== 'POST') {
        writeJSON(res, 405, formatAnthropicError('invalid_request_error', 'Method not allowed'));
        return;
    }

    const bodyStr = ctx.body.toString('utf8');

    let openaiBody;
    try {
        openaiBody = anthropicToOpenAIRequest(bodyStr);
    } catch (err) {
        writeJSON(res, 400, formatAnthropicError('invalid_request_error', 'Invalid JSON: ' + err.message));
        return;
    }

    let body;
    try {
        body = JSON.parse(openaiBody);
    } catch (err) {
        writeJSON(res, 400, formatAnthropicError('invalid_request_error', 'Conversion error: ' + err.message));
        return;
    }

    // The Anthropic-side stream flag / thinking config (defaults differ from
    // OpenAI: non-stream is the default here).
    let anthReq = {};
    try {
        anthReq = JSON.parse(bodyStr);
    } catch { /* body already parsed above; unreachable */ }

    // Same model resolution as the OpenAI route: an unknown id would come
    // back from the upstream as a bare "500 Internal Server Error".
    let model = body.model || '';
    {
        const { model: resolved, resolved: exact, requested } = await resolveModelID(model);
        if (!exact) {
            logInfo(
                `[Model] requested=${JSON.stringify(requested)} is not served by the upstream; ` +
                `using ${resolved} instead`);
        }
        model = resolved;
    }

    let messages = Array.isArray(body.messages) ? body.messages : null;
    if (messages === null || messages.length === 0) {
        writeJSON(res, 400, formatAnthropicError(
            'invalid_request_error', 'messages is required and must be an array'));
        return;
    }

    // Issue #41: fail fast while the Aliyun WAF blocks this server's egress
    // IP — before a pooled session, before vision upload, before captcha.
    if (rejectIfWAFBlocked(res)) return;

    // ── Vision: extract image_url parts (converted from Anthropic image ──
    // blocks), upload them to Z.AI, and strip them from the messages.
    // rewritten equals the input when no images are present.
    let cleanedMessages;
    let files;
    try {
        ({ rewritten: cleanedMessages, files } =
            await processVisionMessages(body.messages, ctx.signal));
    } catch (vErr) {
        writeJSON(res, 400, formatAnthropicError('invalid_request_error', vErr.message));
        return;
    }
    if (files && files.length > 0) {
        if (!(await modelSupportsVision(model))) {
            console.error(
                `[Vision] ${files.length} image(s) attached but model ${JSON.stringify(model)} ` +
                'does not advertise vision support; forwarding anyway');
        }
        try {
            messages = JSON.parse(cleanedMessages);
        } catch { /* keep the pre-vision parse */ }
    }

    const stream = anthReq.stream === true;
    // Stateless request: run it on a THROWAWAY chat session (see
    // chatCompletionsHandler / sessionPool.js). The chat is deleted on Z.AI
    // once the response is fully processed (finally below).
    let chatID, pooled;
    try {
        ({ chatID, pooled } = await acquireStatelessSession(ctx.signal));
    } catch (err) {
        if (ctx.signal?.aborted || err?.name === 'AbortError') {
            return; // client gone; nothing to answer
        }
        writeJSON(res, 503, formatAnthropicError('api_error', err.message));
        return;
    }

    try {
        const requestId = 'msg_' + generateID();

        let transformedMessages = cleanedMessages;
        if (config.agentMode) {
            try {
                const tm = agentTransformMessages(cleanedMessages, body.tools ?? null);
                transformedMessages = tm;
                try {
                    messages = JSON.parse(tm);
                } catch { /* keep previous messages */ }
            } catch (err) {
                logError('agent transform failed: ' + err.message);
            }
        }

        const prompt = messagesToPrompt(messages);

        const opts = {
            model,
            chatID,
            clientMessagesRaw: transformedMessages,
            reasoningEffort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : '',
            files: files ?? undefined,
            requestId,
            toolsRaw: body.tools ?? null,
            webSearch: typeof body.webSearch === 'boolean' ? body.webSearch : undefined,
            advancedSearch: body.advancedSearch === true,
        };
        // Advanced Search rides on top of web search (issue #42).
        if (opts.advancedSearch && opts.webSearch === undefined) {
            opts.webSearch = true;
        }

        if (typeof body.reasoning === 'boolean') {
            opts.thinking = body.reasoning;
        } else if (body.thinking !== undefined && body.thinking !== null) {
            opts.thinking = thinkingEnabled(body.thinking);
        }

        if (stream) {
            await anthropicStreamResponse(res, prompt, opts, model, requestId);
        } else {
            await anthropicNonStreamResponse(res, prompt, opts, model, requestId);
        }
    } finally {
        releaseStatelessSession(chatID, pooled);
    }
}

// anthropicStreamResponse converts a sendToZAI result stream to Anthropic
// SSE events.
async function anthropicStreamResponse(res, prompt, opts, model, requestId) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    // Go: writeMu omitted (single-threaded event loop).
    const writeEvent = (eventType, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const inputTokens = estimateTokens(prompt);

    // message_start
    writeEvent('message_start', {
        type: 'message_start',
        message: {
            id: requestId,
            type: 'message',
            role: 'assistant',
            content: [],
            model,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: inputTokens, output_tokens: 0 },
        },
    });

    writeEvent('ping', { type: 'ping' });

    // Keep-alive pings (Go: 5s ticker goroutine + keepAliveStop + wg.Wait()).
    const keepAlive = setInterval(() => {
        writeEvent('ping', { type: 'ping' });
    }, 5000);
    const stopKeepAlive = () => clearInterval(keepAlive);
    res.on('close', stopKeepAlive);

    let blockIndex = -1;
    let currentBlockType = '';
    let outputTokens = 0;

    const startBlock = (bType, extra) => {
        blockIndex++;
        currentBlockType = bType;
        const cb = { type: bType, ...extra };
        writeEvent('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: cb,
        });
    };

    const stopBlock = () => {
        if (currentBlockType !== '') {
            writeEvent('content_block_stop', {
                type: 'content_block_stop',
                index: blockIndex,
            });
            currentBlockType = '';
        }
    };

    let toolCallEmitted = false;

    // emitToolCallEvent converts one parsed tool-call (sub)delta into
    // Anthropic content-block events: a delta carrying an id starts a new
    // tool_use block, an id-less delta only appends partial arguments JSON.
    // Both shims stream a header first, then argument fragments (a header may
    // already carry the first fragment when one upstream chunk covered both).
    const emitToolCallEvent = (tc) => {
        const fn = tc.function && typeof tc.function === 'object' ? tc.function : {};
        const argsStr = typeof fn.arguments === 'string' ? fn.arguments : '';
        if (typeof tc.id === 'string' && tc.id !== '') {
            // Header delta — start new tool_use block
            stopBlock();
            const name = typeof fn.name === 'string' ? fn.name : '';
            const tooluID = 'toolu_' + (tc.id.startsWith('call_') ? tc.id.slice(5) : tc.id);
            startBlock('tool_use', { id: tooluID, name, input: {} });
            toolCallEmitted = true;
            if (argsStr !== '') {
                writeEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: argsStr },
                });
            }
        } else {
            // Arguments delta — emit partial JSON
            if (argsStr !== '') {
                writeEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'input_json_delta', partial_json: argsStr },
                });
            }
        }
    };

    let interceptor = null;
    let ultraBuf = null;
    if (config.agentMode) {
        if (ultraRepairEnabled()) ultraBuf = new UltraBuffer(opts.toolsRaw);
        else interceptor = newAgentInterceptor();
    }
    let fullContent = '';

    const failStream = (err) => {
        // Go: stopBlock + close(keepAliveStop) + wg.Wait + error + message_stop.
        stopBlock();
        stopKeepAlive();
        res.off('close', stopKeepAlive);
        writeEvent('error', formatAnthropicError('api_error', err.message));
        writeEvent('message_stop', { type: 'message_stop' });
        if (!res.writableEnded) res.end();
    };

    try {
        for await (const result of sendToZAI(prompt, opts)) {
            if (result.error) {
                failStream(result.error);
                return;
            }

            // Reasoning -> thinking content block
            if (result.reasoning !== '') {
                if (currentBlockType !== 'thinking') {
                    stopBlock();
                    startBlock('thinking', { thinking: '' });
                }
                writeEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'thinking_delta', thinking: result.reasoning },
                });
                outputTokens += estimateTokens(result.reasoning);
                continue;
            }

            // Content delta
            if (result.fullText !== '' && !result.fullText.startsWith(fullContent)) {
                // A deep edit_content rewrite rewound text that was already
                // forwarded: reset the stale agent interceptor (issue #23).
                if (interceptor !== null) {
                    interceptor = rearmAgentInterceptor(interceptor);
                }
                if (ultraBuf !== null) ultraBuf.resetTo(result.fullText);
            }
            if (result.fullText !== '') {
                fullContent = result.fullText;
            } else {
                fullContent += result.chunk;
            }

            // The parser emits the exact rune-safe delta to forward.
            const delta = result.chunk;
            if (delta === '') continue;

            if (ultraBuf !== null) {
                ultraBuf.feed(delta);
                continue;
            }

            if (interceptor !== null) {
                const { content: contentDelta, toolCalls } = interceptor.feed(delta);
                if (contentDelta !== '') {
                    if (currentBlockType !== 'text') {
                        stopBlock();
                        startBlock('text', { text: '' });
                    }
                    writeEvent('content_block_delta', {
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: { type: 'text_delta', text: contentDelta },
                    });
                    outputTokens += estimateTokens(contentDelta);
                }
                for (const tc of toolCalls) {
                    emitToolCallEvent(tc);
                }
            } else {
                if (currentBlockType !== 'text') {
                    stopBlock();
                    startBlock('text', { text: '' });
                }
                writeEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: delta },
                });
                outputTokens += estimateTokens(delta);
            }
        }
    } catch (err) {
        failStream(err);
        return;
    } finally {
        stopKeepAlive();
        res.off('close', stopKeepAlive);
    }

    // Ultra mode: validate + repair the buffered text, then replay it through
    // a fresh stock interceptor.
    if (ultraBuf !== null) {
        const { content: repaired, toolCalls } = await ultraBuf.finish();
        if (repaired !== '') {
            if (currentBlockType !== 'text') {
                stopBlock();
                startBlock('text', { text: '' });
            }
            writeEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: repaired },
            });
            outputTokens += estimateTokens(repaired);
        }
        for (const tc of toolCalls) {
            emitToolCallEvent(tc);
        }
    }

    // Drain the interceptor tail: trailing text plus any tool call whose
    // block only completed at end of stream (modern shim hold-back window).
    if (interceptor !== null) {
        const { content: rem, toolCalls: tailCalls } = interceptor.finish();
        if (rem !== '' && !toolCallEmitted) {
            if (currentBlockType !== 'text') {
                stopBlock();
                startBlock('text', { text: '' });
            }
            writeEvent('content_block_delta', {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'text_delta', text: rem },
            });
            outputTokens += estimateTokens(rem);
        }
        for (const tc of tailCalls) {
            emitToolCallEvent(tc);
        }
        // No end-of-stream re-parse: finish() drained every complete block.
    }

    stopBlock();

    const stopReason = toolCallEmitted ? 'tool_use' : 'end_turn';

    writeEvent('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: outputTokens },
    });

    writeEvent('message_stop', { type: 'message_stop' });
    if (!res.writableEnded) res.end();
}

// anthropicNonStreamResponse produces a single Anthropic message object.
async function anthropicNonStreamResponse(res, prompt, opts, model, requestId) {
    let fullContent = '';
    let fullReasoning = '';
    for await (const result of sendToZAI(prompt, opts)) {
        if (result.error) {
            writeJSON(res, statusFromError(result.error.message),
                formatAnthropicError('api_error', result.error.message));
            return;
        }
        if (result.reasoning !== '') {
            fullReasoning += result.reasoning;
            continue;
        }
        if (result.fullText !== '') {
            fullContent = result.fullText;
        } else {
            fullContent += result.chunk;
        }
    }

    const content = [];
    let stopReason = 'end_turn';

    if (fullReasoning !== '') {
        content.push({ type: 'thinking', thinking: fullReasoning });
    }

    if (config.agentMode) {
        const toolCalls = agentExtractToolCalls(fullContent);
        if (toolCalls.length > 0) {
            const stripped = agentStripToolCalls(fullContent);
            if (stripped !== '') {
                content.push({ type: 'text', text: stripped });
            }
            for (const tc of toolCalls) {
                const fn = tc.function && typeof tc.function === 'object' ? tc.function : {};
                const name = typeof fn.name === 'string' ? fn.name : '';
                const argsStr = typeof fn.arguments === 'string' ? fn.arguments : '';
                const id = typeof tc.id === 'string' ? tc.id : '';
                const tooluID = 'toolu_' + (id.startsWith('call_') ? id.slice(5) : id);
                let args = null;
                try {
                    args = JSON.parse(argsStr);
                } catch { /* Go: json.Unmarshal error ignored -> args stays nil */ }
                if (args === null) args = {};
                content.push({ type: 'tool_use', id: tooluID, name, input: args });
            }
            stopReason = 'tool_use';
        } else {
            content.push({ type: 'text', text: fullContent });
        }
    } else {
        content.push({ type: 'text', text: fullContent });
    }

    writeJSON(res, 200, {
        id: requestId,
        type: 'message',
        role: 'assistant',
        content,
        model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: {
            input_tokens: estimateTokens(prompt),
            output_tokens: estimateTokens(fullContent),
        },
    });
}
