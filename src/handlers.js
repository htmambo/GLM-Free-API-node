// Port of internal/zbridge/handlers.go (+ testhooks.go) — every HTTP route
// handler except /v1/messages (anthropic.js) and the route table itself
// (server.js).
//
// Go -> JS mapping:
//   - http.ResponseWriter / *http.Request -> node:http res / req; every
//     handler has the unified shape handler(req, res, ctx) with
//     ctx = { url: URL, body: Buffer, signal: AbortSignal } (see server.js).
//   - r.Context() -> ctx.signal (aborted when the client goes away).
//   - <-chan ZAIResult -> `for await (const result of sendToZAI(...))`; the
//     synchronous sendToZAI error and ZAIResult.Err are BOTH yielded as a
//     terminal { error } result (see zai.js header) and consumed identically.
//   - http.Flusher -> res.write() flushes per chunk on node:http; the
//     headers are pushed early via res.flushHeaders() and Nagle is disabled
//     with res.socket.setNoDelay(true). Go's writeMu is omitted
//     (single-threaded event loop).
//   - 5s keep-alive goroutine -> setInterval + clearInterval at end of
//     response; the timer is also cleared if the client disconnects.
//   - context.Canceled/DeadlineExceeded from AcquireStatelessSession ->
//     AbortError / an already-aborted ctx.signal: the client is gone and
//     nothing is answered (silent return, like Go).

import { config } from './config.js';
import { session, setModelsCache } from './state.js';
import { generateID, messagesToPrompt, estimateTokens } from './util.js';
import { logError } from './logger.js';
import { writeJSON, writeError, writeNotFound, toJSON } from './middleware.js';
import { rejectIfWAFBlocked, wafStatus } from './waf.js';
import { tokenCount, swapDB } from './db.js';
import { sendToZAI, statusFromError } from './zai.js';
import { formatOpenAIResponse, formatOpenAIError } from './format.js';
import {
    acquireStatelessSession,
    releaseStatelessSession,
    sessionPoolStatus,
} from './sessionPool.js';
import { buildModelsListResponse, buildModelsSimpleResponse, modelSupportsVision } from './models.js';
import { getFeaturesResponse, applyFeatureOverrides } from './features.js';
import { processVisionMessages } from './vision.js';
import {
    agentTransformMessages,
    newAgentInterceptor,
    rearmAgentInterceptor,
    agentExtractToolCalls,
    agentStripToolCalls,
} from './agent.js';
import { UltraBuffer, ultraRepairEnabled, ultraRepairFullText } from './agentUltra.js';

// ============================================================================
// SIMPLE HANDLERS
// ============================================================================

// Go: dashboardHandler — "/" redirects to /health; anything else that fell
// through to the catch-all is a 404.
export function dashboardHandler(req, res, ctx) {
    if (ctx.url.pathname !== '/') {
        writeNotFound(res);
        return;
    }
    // Go: http.Redirect(w, r, "/health", http.StatusFound)
    res.writeHead(302, { Location: '/health', 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<a href="/health">Found</a>.\n');
}

// Go: statusHandler.
export function statusHandler(req, res, ctx) {
    let userIDPreview = null;
    if (session.userID !== '') {
        let uid = session.userID;
        if (uid.length > 8) uid = uid.slice(0, 8);
        userIDPreview = uid + '...';
    }
    writeJSON(res, 200, {
        connected: session.initialized,
        userName: session.userName,
        userId: userIDPreview,
        feVersion: session.feVersion,
        features: session.features,
        mode: 'direct',
        sessionPool: sessionPoolStatus(),
        waf: wafStatus(),
    });
}

// Go: statsHandler.
export function statsHandler(req, res, ctx) {
    writeJSON(res, 200, {
        mode: 'direct',
        totalClients: session.initialized ? 1 : 0,
        stats: { totalRequests: 0 },
    });
}

// Go: healthHandler. tokenCount is the live row count of the active token DB
// (TTL cached); -1 means unavailable.
export function healthHandler(req, res, ctx) {
    const healthy = session.initialized;
    const count = tokenCount();
    writeJSON(res, healthy ? 200 : 503, { healthy, mode: 'direct', tokenCount: count });
}

// Go: sqliteSwapHandler — POST /sqlite {"db_path": "..."} hot-swaps the
// token database without a restart.
export async function sqliteSwapHandler(req, res, ctx) {
    if (req.method !== 'POST') {
        writeJSON(res, 405, {
            success: false,
            error: 'method not allowed — use POST /sqlite with {"db_path": "..."}',
        });
        return;
    }

    let body;
    try {
        body = JSON.parse(ctx.body.toString('utf8'));
    } catch (err) {
        writeJSON(res, 400, { success: false, error: `invalid JSON body: ${err.message}` });
        return;
    }
    if (typeof body.db_path !== 'string' || body.db_path === '') {
        writeJSON(res, 400, { success: false, error: "missing required field 'db_path'" });
        return;
    }

    const startedAt = Date.now();
    try {
        await swapDB(body.db_path);
    } catch (err) {
        writeJSON(res, 400, { success: false, error: err.message, db_path: body.db_path });
        return;
    }
    writeJSON(res, 200, {
        success: true,
        message: 'database swapped',
        db_path: body.db_path,
        swapped_in: `${Date.now() - startedAt}ms`,
        token_count: tokenCount(),
    });
}

// Go: clientsHandler.
export function clientsHandler(req, res, ctx) {
    const clients = session.initialized ? [{ id: 'session', status: 'idle' }] : [];
    writeJSON(res, 200, { clients });
}

// Go: injectHandler.
export function injectHandler(req, res, ctx) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"message":"Direct mode"}');
}

// Go: stopHandler.
export function stopHandler(req, res, ctx) {
    writeJSON(res, 200, { success: true, message: 'Stop acknowledged' });
}

// ============================================================================
// MODELS
// ============================================================================

// Go: modelsHandler (payload logic lives in models.js).
export async function modelsHandler(req, res, ctx) {
    writeJSON(res, 200, await buildModelsListResponse());
}

// Go: modelsHandler2.
export async function modelsHandler2(req, res, ctx) {
    writeJSON(res, 200, await buildModelsSimpleResponse());
}

// ============================================================================
// FEATURES
// ============================================================================

// Go: featuresHandler — GET returns resolved features, POST updates the
// per-model feature state (business logic lives in features.js).
export async function featuresHandler(req, res, ctx) {
    if (req.method === 'GET') {
        const model = ctx.url.searchParams.get('model') ?? '';
        const { status, payload } = await getFeaturesResponse(model);
        writeJSON(res, status, payload);
        return;
    }

    if (req.method !== 'POST') {
        writeError(res, 'Method not allowed', 405);
        return;
    }

    let body;
    try {
        body = JSON.parse(ctx.body.toString('utf8'));
    } catch {
        writeJSON(res, 400, { error: 'Invalid JSON' });
        return;
    }

    // Check Include-All-Features header (strings.EqualFold against "true").
    const includeAll = (req.headers['include-all-features'] ?? '').toLowerCase() === 'true';

    const { status, payload } = await applyFeatureOverrides(body, includeAll);
    writeJSON(res, status, payload);
}

// ============================================================================
// CHAT COMPLETIONS
// ============================================================================

// isClientGone mirrors the Go check for context.Canceled/DeadlineExceeded
// coming out of AcquireStatelessSession: the request died while waiting.
function isClientGone(err, signal) {
    return signal?.aborted || err?.name === 'AbortError';
}

// Go: chatCompletionsHandler.
export async function chatCompletionsHandler(req, res, ctx) {
    if (req.method !== 'POST') {
        writeError(res, 'Method not allowed', 405);
        return;
    }

    let body;
    try {
        body = JSON.parse(ctx.body.toString('utf8'));
    } catch {
        writeJSON(res, 400, formatOpenAIError('Invalid JSON', 'invalid_request_error', null));
        return;
    }

    let model = body.model || 'glm-5';

    let messages = Array.isArray(body.messages) ? body.messages : null;
    if (messages === null || messages.length === 0) {
        writeJSON(res, 400, formatOpenAIError(
            'messages is required and must be an array', 'invalid_request_error', null));
        return;
    }

    // Issue #41: fail fast while the Aliyun WAF blocks this server's egress
    // IP — before a pooled session is drawn, before vision upload, and before
    // a captcha burns a harvested device token.
    if (rejectIfWAFBlocked(res)) return;

    // ── Vision: extract image_url parts, upload them to Z.AI, strip them ──
    // from the messages. rewritten carries the uploaded file ids in place of
    // the original URLs and equals the input when no images are present.
    let cleanedMessages;
    let files;
    try {
        ({ rewritten: cleanedMessages, files } =
            await processVisionMessages(body.messages, ctx.signal));
    } catch (vErr) {
        writeJSON(res, 400, formatOpenAIError(vErr.message, 'invalid_request_error', null));
        return;
    }
    if (files && files.length > 0) {
        if (!(await modelSupportsVision(model))) {
            console.error(
                `[Vision] ${files.length} image(s) attached but model ${JSON.stringify(model)} ` +
                'does not advertise vision support; forwarding anyway');
        }
        // Re-parse the cleaned (file-id-referencing) messages for prompt building.
        try {
            messages = JSON.parse(cleanedMessages);
        } catch { /* keep the pre-vision parse */ }
    }

    const stream = typeof body.stream === 'boolean' ? body.stream : true;

    // Stateless request: run it on a THROWAWAY chat session (ported from the
    // DeepseekFreeAPI reference). Async mode takes a pre-made session from
    // the standing pool batch; sync mode mints one on the spot. Either way
    // the chat is deleted on Z.AI once the response is fully processed
    // (finally below), so no server-side history survives the request.
    let chatID, pooled;
    try {
        ({ chatID, pooled } = await acquireStatelessSession(ctx.signal));
    } catch (err) {
        if (isClientGone(err, ctx.signal)) return; // client gone; nothing to answer
        writeJSON(res, 503, formatOpenAIError(err.message, 'server_error', 'shutting_down'));
        return;
    }

    try {
        const requestId = generateID();

        // ── Agent mode: transform tools & roles for Z.AI compatibility ──
        // Modern shim (default): one XML-sectioned prompt in a single user
        // message. Legacy shim: [ROLE: ...] rewritten user messages + tool
        // contract message. Operates on the cleaned (image-stripped) messages.
        let transformedMessages = cleanedMessages;
        if (config.agentMode) {
            try {
                const tm = agentTransformMessages(cleanedMessages, body.tools ?? null);
                transformedMessages = tm;
                // Re-parse so local `messages` reflects the rewritten content
                try {
                    messages = JSON.parse(tm);
                } catch { /* keep previous messages */ }
            } catch (err) {
                logError('agent transform failed: ' + err.message);
            }
        }

        const prompt = messagesToPrompt(messages);

        // Features are resolved per-model inside sendToZAI.
        // Per-request overrides are only set if explicitly provided in the body.
        const opts = {
            model,
            chatID,
            clientMessagesRaw: transformedMessages,
            reasoningEffort: typeof body.reasoning_effort === 'string' ? body.reasoning_effort : '',
            files: files ?? undefined,
            requestId,
            toolsRaw: body.tools ?? null,
        };

        // Parse thinking configuration:
        //   reasoning: true/false  ->  enable_thinking
        //   "thinking": {"type":"enabled"|"disabled"}  ->  enable_thinking
        if (typeof body.reasoning === 'boolean') {
            opts.thinking = body.reasoning;
        } else if (body.thinking !== undefined && body.thinking !== null) {
            const t = body.thinking;
            if (typeof t === 'object' && typeof t.type === 'string') {
                opts.thinking = t.type === 'enabled';
            }
        }

        if (typeof body.webSearch === 'boolean') {
            opts.webSearch = body.webSearch;
        } else if (typeof body.search === 'boolean') {
            opts.webSearch = body.search;
        }
        if (typeof body.advancedSearch === 'boolean') {
            opts.advancedSearch = body.advancedSearch;
            // Advanced Search rides on top of web search, matching the web UI
            // where it is exposed under the globe menu (issue #42).
            if (body.advancedSearch && opts.webSearch === undefined) {
                opts.webSearch = true;
            }
        }

        if (stream) {
            await chatCompletionsStream(res, ctx, prompt, opts, model, requestId, body);
        } else {
            await chatCompletionsNonStream(res, prompt, opts, model, requestId);
        }
    } finally {
        releaseStatelessSession(chatID, pooled);
    }
}

// Stream path of chatCompletionsHandler: OpenAI chat.completion.chunk SSE
// with a 5s keep-alive heartbeat.
async function chatCompletionsStream(res, ctx, prompt, opts, model, requestId, body) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.socket?.setNoDelay(true);
    res.flushHeaders();

    // Go: writeMu serialises writes between the main loop and the keep-alive
    // goroutine; the single-threaded event loop makes that unnecessary.
    const writeSSE = (data) => {
        if (res.writableEnded) return;
        res.write(`data: ${data}\n\n`);
    };

    // Opening chunk carries only the role (issue #45): an empty content delta
    // here would make append-only clients register a content start before the
    // reasoning tail has been released.
    writeSSE(toJSON({
        id: 'chatcmpl-' + requestId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    }));

    let fullContent = '';
    let fullReasoning = '';

    // Ultra mode buffers the full text and repairs malformed calls at the
    // end; the stock interceptor is only used outside the gate.
    let interceptor = null;
    let ultraBuf = null;
    if (config.agentMode) {
        if (ultraRepairEnabled()) ultraBuf = new UltraBuffer(opts.toolsRaw);
        else interceptor = newAgentInterceptor();
    }
    let toolCallEmitted = false;

    const emitToolCallDelta = (tc) => {
        const chunk = {
            id: 'chatcmpl-' + requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{
                index: 0,
                delta: { role: 'assistant', tool_calls: [tc] },
                finish_reason: null,
            }],
        };
        writeSSE(toJSON(chunk));
    };

    // Go: 5s keep-alive ticker goroutine, stopped via keepAliveStop + wg.Wait().
    // The heartbeat is inert (empty delta) so it never disturbs reasoning
    // accumulation on append-only clients (issue #45).
    const keepAlive = setInterval(() => {
        writeSSE(toJSON({
            id: 'chatcmpl-' + requestId,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: {}, finish_reason: null }],
        }));
    }, 5000);
    const stopKeepAlive = () => clearInterval(keepAlive);
    res.on('close', stopKeepAlive);

    let errored = false;
    try {
        for await (const result of sendToZAI(prompt, opts)) {
            if (result.error) {
                console.error(`[Stream] Error: ${result.error.message}`);
                writeSSE(toJSON(formatOpenAIError(
                    result.error.message, 'api_error', statusFromError(result.error.message))));
                writeSSE('[DONE]');
                errored = true;
                break;
            }

            if (result.reasoning !== '') {
                fullReasoning += result.reasoning;
                const rChunk = {
                    id: 'chatcmpl-' + requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{
                        index: 0,
                        delta: { reasoning_content: result.reasoning },
                        finish_reason: null,
                    }],
                };
                writeSSE(toJSON(rChunk));
                continue;
            }
            if (result.fullText !== '' && !result.fullText.startsWith(fullContent)) {
                // A deep edit_content rewrite rewound text that was already
                // forwarded: the agent interceptor's view of the stream is
                // stale, reset it (issue #23).
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
                    const c = formatOpenAIResponse({ content: contentDelta }, model, requestId, true);
                    writeSSE(toJSON(c));
                }
                for (const tc of toolCalls) {
                    emitToolCallDelta(tc);
                    toolCallEmitted = true;
                }
            } else {
                const c = formatOpenAIResponse({ content: delta }, model, requestId, true);
                writeSSE(toJSON(c));
            }
        }
    } finally {
        stopKeepAlive();
        res.off('close', stopKeepAlive);
    }

    if (!errored && !res.writableEnded) {
        if (ultraBuf !== null) {
            const { content: repaired, toolCalls } = await ultraBuf.finish();
            if (repaired !== '') {
                writeSSE(toJSON(formatOpenAIResponse({ content: repaired }, model, requestId, true)));
            }
            for (const tc of toolCalls) {
                emitToolCallDelta(tc);
                toolCallEmitted = true;
            }
            if (toolCallEmitted) {
                writeSSE(toJSON({
                    id: 'chatcmpl-' + requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                }));
            } else {
                writeSSE(toJSON(formatOpenAIResponse(
                    { content: '', finishReason: 'stop' }, model, requestId, true)));
            }
        } else if (interceptor !== null) {
            // Drain the interceptor tail: trailing text plus any tool call
            // whose block only completed at end of stream (the modern shim
            // holds back a window while streaming).
            const { content: rem, toolCalls: tailCalls } = interceptor.finish();
            if (rem !== '' && !toolCallEmitted) {
                const c = formatOpenAIResponse({ content: rem }, model, requestId, true);
                writeSSE(toJSON(c));
            }
            for (const tc of tailCalls) {
                emitToolCallDelta(tc);
                toolCallEmitted = true;
            }

            // No end-of-stream re-parse: finish() already drained every
            // complete block through the same parser (upstream removed the
            // old safety net together with the fallback parsers).

            if (toolCallEmitted) {
                writeSSE(toJSON({
                    id: 'chatcmpl-' + requestId,
                    object: 'chat.completion.chunk',
                    created: Math.floor(Date.now() / 1000),
                    model,
                    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
                }));
            } else {
                writeSSE(toJSON(formatOpenAIResponse(
                    { content: '', finishReason: 'stop' }, model, requestId, true)));
            }
        } else {
            writeSSE(toJSON(formatOpenAIResponse(
                { content: '', finishReason: 'stop' }, model, requestId, true)));
        }
        writeSSE('[DONE]');
    }

    if (!res.writableEnded) res.end();
}

// Non-stream path of chatCompletionsHandler: one chat.completion object.
async function chatCompletionsNonStream(res, prompt, opts, model, requestId) {
    let fullContent = '';
    let fullReasoning = '';
    for await (const result of sendToZAI(prompt, opts)) {
        if (result.error) {
            console.error(`[API] Error: ${result.error.message}`);
            writeJSON(res, statusFromError(result.error.message),
                formatOpenAIError(result.error.message, 'api_error', null));
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

    // Agent-mode: repair (ultra) then parse tool-call blocks.
    if (config.agentMode) {
        if (ultraRepairEnabled()) {
            fullContent = await ultraRepairFullText(fullContent, opts.toolsRaw);
        }
        const toolCalls = agentExtractToolCalls(fullContent);
        if (toolCalls.length > 0) {
            const stripped = agentStripToolCalls(fullContent);
            const message = {
                role: 'assistant',
                content: stripped,
                tool_calls: toolCalls,
            };
            if (fullReasoning !== '') message.reasoning_content = fullReasoning;
            writeJSON(res, 200, {
                id: 'chatcmpl-' + requestId,
                object: 'chat.completion',
                created: Math.floor(Date.now() / 1000),
                model,
                choices: [{
                    index: 0,
                    message,
                    finish_reason: 'tool_calls',
                }],
                usage: {
                    prompt_tokens: estimateTokens(prompt),
                    completion_tokens: estimateTokens(fullContent),
                    total_tokens: estimateTokens(prompt) + estimateTokens(fullContent),
                },
            });
            return;
        }
    }

    writeJSON(res, 200, formatOpenAIResponse(
        { content: fullContent, reasoning: fullReasoning }, model, requestId, false));
}

// ============================================================================
// TEST HOOKS (Go: testhooks.go)
// ============================================================================

// Go: GetConfig() — the live bridge configuration; callers may toggle fields
// (e.g. agentMode) and should restore what they changed.
export function getConfig() {
    return config;
}

// Go: OverrideSessionState(token, userID, initialized) — swaps the Z.AI
// session identity used by the bridge and returns a restore function.
// Integration tests use it to skip guest auth against a mock upstream.
export function overrideSessionState(token, userID, initialized) {
    const oldToken = session.token;
    const oldUser = session.userID;
    const oldInit = session.initialized;
    session.token = token;
    session.userID = userID;
    session.initialized = initialized;
    return () => {
        session.token = oldToken;
        session.userID = oldUser;
        session.initialized = oldInit;
    };
}

// Go: FlushModelsCache() — clears the cached model list so the next
// /v1/models (or capability lookup) re-fetches from the current BASE_URL.
export function flushModelsCache() {
    setModelsCache([], 0);
}
