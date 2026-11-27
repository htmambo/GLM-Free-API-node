// Port of internal/zbridge/zai.go — Z.AI wire protocol: guest auth / session
// init, chat completion calls (streaming), and SSE parsing.
//
// generateZaSignature is NOT here: it lives in util.js (per the Phase 0
// split, matching where the Go signature helper's dependencies live).
//
// Go -> JS mapping:
//   - sendToZAI returns a buffered chan ZAIResult + error; here it is an
//     `async function*` yielding result objects (see THE YIELD PROTOCOL
//     below). Go's two error surfaces — the synchronous return error from
//     sendToZAI (session init failure) and ZAIResult.Err mid-stream — are
//     consumed IDENTICALLY by both handlers (handlers.go:214/221,
//     anthropic.go:579/731): log + format an error response. So both are
//     unified into a yielded `{ error }` result; the generator never throws
//     for upstream/protocol failures (a consumer that forgets to check
//     `error` simply sees the stream end, same as a closed Go channel).
//   - ZAIResult{Chunk, FullText, Reasoning, Err} -> { chunk, fullText,
//     reasoning, error } (camelCase; error is an Error or null).
//   - bufio.Scanner (10 MB buffer) over resp.Body -> an async line iterator
//     over the web ReadableStream, decoded with a streaming TextDecoder so a
//     multi-byte rune split across network chunks is never mangled. The 10 MB
//     max-line guard is not re-implemented (a pathological upstream would
//     just buffer; noted as a deviation).
//   - Go strings are byte strings; all index conversions below therefore map
//     Go byte offsets to JS string (UTF-16 code unit) indexes. Every cut is
//     code-point safe: iteration uses codePointAt / [...str] semantics, NEVER
//     raw UTF-16 code-unit truncation (issue #23 garble).
//   - session.mu is omitted (single-threaded event loop); the "one
//     initialization at a time" spin-lock in Go initializeSession becomes a
//     shared in-flight promise (a concurrent caller awaits the same promise
//     and — unlike Go, which returns nil to late waiters — also sees a
//     failure if initialization failed; both handlers treat that error the
//     same, so behavior is preserved).

import { BASE_URL, zaiUserAgent, zaiRegion, config } from './config.js';
import { session, feVersionRe } from './state.js';
import { generateZaSignature, base64Decode, randomUUID } from './util.js';
import {
    checkWAF,
    isWAFBlockResponse,
    recordWAFBlock,
    recordWAFSuccess,
    truncateErrorBody,
    wafRetryHint,
    ERR_WAF_BLOCK,
} from './waf.js';
import { logInfo, logError, logDebug } from './logger.js';
import { zaiFetch } from './httpClient.js';
import { getCaptchaVerifyParam } from './captcha.js';
import { resolveFeaturesForModel } from './features.js';
import { modelSupportsReasoningEffort, isValidReasoningEffort } from './models.js';

// ============================================================================
// JWT DECODE
// ============================================================================

// Go: decodeJWT(token) (id, name). Returns { id, name }.
export function decodeJWT(token) {
    const parts = String(token).split('.');
    if (parts.length < 2) return { id: '', name: '' };
    let data;
    try {
        data = JSON.parse(base64Decode(parts[1]).toString('utf8'));
    } catch {
        return { id: '', name: '' };
    }
    const id = typeof data.id === 'string' ? data.id : '';
    const email = typeof data.email === 'string' ? data.email : '';
    let name = 'Guest';
    if (email !== '') name = email.split('@')[0];
    return { id, name };
}

// ============================================================================
// Z.AI SESSION INITIALIZATION
// ============================================================================

// Go: scrapeConfig() — best-effort feVersion scrape from the landing page.
export async function scrapeConfig() {
    let body;
    try {
        const resp = await zaiFetch(BASE_URL, {
            method: 'GET',
            signal: AbortSignal.timeout(10_000),
        });
        body = await resp.text();
    } catch (err) {
        logInfo(`[Config] Scrape error: ${err.message}, using default feVersion`);
        return;
    }
    const match = body.match(feVersionRe);
    if (match) {
        session.feVersion = match[0];
        logInfo(`[Config] fe_version: ${match[0]}`);
    }
}

// Shared in-flight initialization (Go: session.Initializing spin-wait).
let initInFlight = null;

// Go: initializeSession() error. Concurrent callers share the in-flight
// attempt instead of spin-waiting on session.initializing.
export function initializeSession() {
    if (initInFlight) return initInFlight;
    session.initializing = true;
    initInFlight = (async () => {
        try {
            await doInitializeSession();
        } finally {
            session.initializing = false;
        }
    })().finally(() => {
        initInFlight = null;
    });
    return initInFlight;
}

async function doInitializeSession() {
    if (config.zaiToken !== '') {
        logInfo('[Session] Using hardcoded ZAI_TOKEN, skipping guest init.');
        session.token = config.zaiToken;
        const { id, name } = decodeJWT(session.token);
        session.userID = id;
        if (name !== '') session.userName = name;
        if (session.userID === '') session.userName = 'User';
        let uidPreview = session.userID;
        if (uidPreview.length > 8) uidPreview = uidPreview.slice(0, 8);
        logInfo(`[Session] Token user: ${uidPreview}... (${session.userName})`);
        session.initialized = true;
        return;
    }

    logInfo('[Session] Initializing Z.AI session...');

    await scrapeConfig();

    const headers = {
        'Origin': BASE_URL,
        'Referer': BASE_URL + '/',
        'User-Agent': zaiUserAgent,
        'Content-Type': 'application/json',
    };

    // Initial guest POST (fire-and-forget, like Go).
    zaiFetch(BASE_URL + '/api/v1/auths/guest', {
        method: 'POST',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(15_000),
    }).then((r) => r.text()).catch(() => {});

    // GET /api/v1/auths/
    let resp;
    try {
        resp = await zaiFetch(BASE_URL + '/api/v1/auths/', {
            method: 'GET',
            headers,
            signal: AbortSignal.timeout(15_000),
        });
    } catch (err) {
        logInfo(`[Session] Initialization error: ${err.message}`);
        session.initialized = false;
        throw err;
    }

    if (resp.status !== 200) {
        await resp.text(); // drain
        const err = new Error(`Auth failed: ${resp.status}`);
        logInfo(`[Session] Initialization error: ${err.message}`);
        session.initialized = false;
        throw err;
    }

    let authData = {};
    try {
        authData = await resp.json();
    } catch { /* Go: json.Unmarshal error ignored — token stays "" */ }
    session.token = typeof authData.token === 'string' ? authData.token : '';

    if (session.token === '') {
        try {
            const guestResp = await zaiFetch(BASE_URL + '/api/v1/auths/guest', {
                method: 'POST',
                headers,
                body: '{}',
                signal: AbortSignal.timeout(15_000),
            });
            const gd = await guestResp.json().catch(() => ({}));
            session.token = typeof gd.token === 'string' ? gd.token : '';
        } catch { /* Go: error ignored — token stays "" */ }
    }

    if (session.token !== '') {
        const { id, name } = decodeJWT(session.token);
        session.userID = id;
        if (name !== '') session.userName = name;
        let uidPreview = session.userID;
        if (uidPreview.length > 8) uidPreview = uidPreview.slice(0, 8);
        logInfo(`[Session] Connected. UserID: ${uidPreview}... (${session.userName})`);
        session.initialized = true;
        return;
    }

    session.initialized = false;
    throw new Error('No token received from Z.AI');
}

// ============================================================================
// Z.AI COMMUNICATION
// ============================================================================

// THE YIELD PROTOCOL (Go: <-chan ZAIResult):
//   sendToZAI(prompt, opts) is an async generator. Every yielded value is
//       { chunk: string,      // rune-safe delta to append to the client
//         fullText: string,   // authoritative upstream snapshot ('' on
//                             // reasoning-only results)
//         reasoning: string,  // reasoning-channel delta ('' when none)
//         error: Error|null }
//   Exactly one of chunk / reasoning / error is non-empty per yield. A
//   yielded `error` is terminal: the generator returns right after it
//   (mirrors Go: sendToZAIStream's error is sent as the final ZAIResult and
//   the channel is closed). Consumers should stop on the first error result.
//
// opts (Go SendOptions; null/undefined = unset pointer):
//   { model, webSearch, thinking, imageGen, previewMode, chatID, messages,
//     clientMessagesRaw, reasoningEffort, files }
export async function* sendToZAI(prompt, opts = {}) {
    const model = opts.model || 'glm-5';

    // Resolve features dynamically from per-model state
    // (server defaults + stored user overrides)
    const featuresMap = await resolveFeaturesForModel(model);

    // Apply per-request overrides (highest precedence). auto_web_search is
    // the ONLY switch that works upstream; web_search is pinned false below
    // (issue #42).
    //
    // Agent mode force-disables both search toggles: mixing the agent-shim
    // tool contract with Z.AI's internal tool loop makes the model emit
    // internal markers (retrieve/open_url) as if they were caller tools.
    let webSearch = opts.webSearch;
    let advancedSearch = opts.advancedSearch === true;
    if (config.agentMode && (webSearch === true || advancedSearch)) {
        logInfo('[web_search] agent mode active — disabling web search for this request');
        webSearch = false;
        advancedSearch = false;
    }
    if (webSearch != null) {
        if (webSearch) {
            featuresMap.auto_web_search = true;
        } else {
            delete featuresMap.auto_web_search;
        }
    }
    delete featuresMap.web_search;
    if (opts.thinking != null) featuresMap.enable_thinking = opts.thinking;
    if (opts.imageGen != null) featuresMap.image_generation = opts.imageGen;
    if (opts.previewMode != null) featuresMap.preview_mode = opts.previewMode;

    // ── reasoning_effort handling ──
    // Defensive: always strip any stale reasoning_effort first so unsupported
    // models never receive a placeholder value (would cause malfunction).
    delete featuresMap.reasoning_effort;

    if (opts.reasoningEffort) {
        if (await modelSupportsReasoningEffort(model)) {
            if (isValidReasoningEffort(opts.reasoningEffort)) {
                // Forward reasoning_effort INSIDE the features payload
                featuresMap.reasoning_effort = opts.reasoningEffort;
                // When reasoning_effort is active, enable_thinking MUST be
                // true and any user modification on enable_thinking is
                // ignored.
                featuresMap.enable_thinking = true;
                logInfo(
                    `[reasoning_effort] model=${model} effort=${opts.reasoningEffort} enabled (enable_thinking forced true)`);
            } else {
                logError(
                    `[reasoning_effort] invalid value '${opts.reasoningEffort}' for model=${model} (accepted: high, max); ignored`);
            }
        } else {
            logInfo(
                `[reasoning_effort] model=${model} does not support reasoning_effort; parameter ignored`);
        }
    }

    // Remove 'think' entirely; ALWAYS force image_generation to false
    delete featuresMap.think;
    featuresMap.image_generation = false;

    const chatID = opts.chatID || session.chatID;
    const messages = opts.messages ?? session.messages;

    if (!session.initialized) {
        try {
            await initializeSession();
        } catch (err) {
            // Go: sendToZAI returns this as its synchronous error; the
            // handlers consume both error surfaces identically, so it is
            // yielded as a terminal error result instead (see header).
            yield { chunk: '', fullText: '', reasoning: '', error: err };
            return;
        }
    }

    const resolvedOpts = {
        model,
        chatID,
        featuresMap,
        messages,
        clientMessagesRaw: opts.clientMessagesRaw,
        files: opts.files,
        requestId: opts.requestId ?? '',
        advancedSearch,
    };

    yield* sendToZAIStream(prompt, resolvedOpts);
}

// ensureMessageIDs stamps a UUID on every message that lacks one. The
// mainland deployment (zchat.z.ai) rejects completions with
// MISSING_MESSAGE_ID unless each message carries `id`; the official web
// client generates one per message, stateless API clients do not. The
// international site ignores the extra field.
function ensureMessageIDs(messages) {
    if (!Array.isArray(messages)) return messages;
    return messages.map((m) => {
        if (!m || typeof m !== 'object') return m;
        if (typeof m.id === 'string' && m.id !== '') return m;
        return { ...m, id: randomUUID() };
    });
}

// Go: sendToZAIStream. `opts.clientMessagesRaw` is a raw JSON string (Go
// json.RawMessage) or null/empty; `opts.files` is an array of uploaded file
// entries (see vision.js) or empty.
async function* sendToZAIStream(prompt, opts) {
    for (let attempt = 0; attempt < 2; attempt++) {
        // Fail fast while the IP is blocked: one captcha costs a harvested
        // device token and ~10-15 s of signing work.
        const { err: wafErr, retryIn } = checkWAF();
        if (wafErr !== null) {
            yield { chunk: '', fullText: '', reasoning: '', error: new Error(wafErr) };
            return;
        }

        const token = session.token;
        const userID = session.userID;
        const feVersion = session.feVersion;

        // The signed query params must actually ride the URL (issue #41).
        const { signature, urlParams } = generateZaSignature(prompt, token, userID);
        const urlStr = BASE_URL + '/api/v2/chat/completions?' + urlParams;

        let messagesField;
        if (opts.clientMessagesRaw) {
            // Go embeds the raw client JSON verbatim; here it is parsed and
            // re-serialized — semantically identical on the wire.
            messagesField = JSON.parse(opts.clientMessagesRaw);
        } else {
            // Go appends Message{Role:"user", Content:json.RawMessage(
            // promptJSON)} — the JSON-quoted prompt. A plain JS string
            // content serializes to exactly that.
            messagesField = [...opts.messages, { role: 'user', content: prompt }];
        }
        messagesField = ensureMessageIDs(messagesField);

        let captchaParam;
        try {
            captchaParam = await getCaptchaVerifyParam();
        } catch (err) {
            yield { chunk: '', fullText: '', reasoning: '', error: err };
            return;
        }

        // Build features payload from dynamically resolved per-model features.
        // reasoning_effort is only present in opts.featuresMap if the model
        // supports it AND a valid value was provided — no placeholder is added
        // for unsupported models (would cause malfunction).
        const featuresPayload = { ...opts.featuresMap };
        // Remove 'think' entirely — only enable_thinking reaches the request
        delete featuresPayload.think;
        featuresPayload.flags = [];
        // image_generation is ALWAYS false; web_search never enables search
        // upstream (auto_web_search is the only working switch, issue #42).
        featuresPayload.image_generation = false;
        featuresPayload.web_search = false;

        // The mainland deployment requires the CURRENT user message's id at
        // the top level (`id`), not only inside each message: the web client
        // sends `id: <current message id>`. Reuse the id stamped on the last
        // user message so the two agree.
        const lastUserIdx = messagesField.findLastIndex((m) => m && m.role === 'user');
        const currentMessageID = lastUserIdx >= 0 && typeof messagesField[lastUserIdx].id === 'string'
            ? messagesField[lastUserIdx].id
            : randomUUID();

        const requestBody = {
            model: opts.model,
            chat_id: opts.chatID,
            messages: messagesField,
            signature_prompt: prompt,
            stream: true,
            id: currentMessageID,
            captcha_verify_param: captchaParam,
            features: featuresPayload,
        };
        // Attach uploaded files (images) only when present — text-only
        // requests keep the exact body shape they always had.
        if (opts.files && opts.files.length > 0) {
            requestBody.files = opts.files;
        }
        // Advanced Search is an MCP server, not a feature flag: it sits at
        // the top level next to captcha_verify_param (issue #42).
        if (opts.advancedSearch) {
            requestBody.mcp_servers = ['advanced-search'];
        }

        const bodyStr = JSON.stringify(requestBody);

        if (config.logging.level === 'debug') {
            logDebug(`Z.AI url ${urlStr}`);
            logDebug(`Z.AI request body: ${bodyStr}`);
            logDebug('Z.AI request headers ' + JSON.stringify({
                authorization: 'Bearer ' + token,
                'content-type': 'application/json',
                'x-fe-Version': feVersion,
                'x-region': zaiRegion,
                'x-signature': signature,
                'Origin': BASE_URL,
                'Referer': BASE_URL + '/',
            }, null, 2));
        }

        const timeout = config.timeouts.default * 2;
        let resp;
        try {
            resp = await zaiFetch(urlStr, {
                method: 'POST',
                headers: {
                    'authorization': 'Bearer ' + token,
                    'User-Agent': zaiUserAgent,
                    'content-type': 'application/json',
                    'x-fe-Version': feVersion,
                    'x-region': zaiRegion,
                    'x-signature': signature,
                    'Origin': BASE_URL,
                    'Referer': BASE_URL + '/',
                },
                body: bodyStr,
                signal: AbortSignal.timeout(timeout),
            });
        } catch (err) {
            // Node's fetch collapses every network failure into "fetch
            // failed"; the actionable detail (ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT,
            // certificate errors) lives on err.cause. Surface it.
            const cause = err?.cause?.code || err?.cause?.message || '';
            yield {
                chunk: '', fullText: '', reasoning: '',
                error: new Error(`Z.AI connection error: ${err.message}${cause ? ` (${cause})` : ''}`),
            };
            return;
        }

        if (config.logging.level === 'debug') {
            logDebug(`Z.AI response status: ${resp.status}`);
            const hdrs = {};
            resp.headers.forEach((v, k) => { hdrs[k] = v; });
            logDebug('Z.AI response headers: ' + JSON.stringify(hdrs, null, 2));
        }

        if (resp.status === 401) {
            await resp.text(); // drain before reuse
            // A hardcoded ZAI_TOKEN cannot be refreshed: re-initializing
            // re-applies the same rejected token, burns the second attempt,
            // and ends in a useless "Max retries exceeded".
            if (config.zaiToken !== '') {
                yield {
                    chunk: '', fullText: '', reasoning: '',
                    error: new Error(
                        `Z.AI 401 Unauthorized: ZAI_TOKEN was rejected by ${BASE_URL}. ` +
                        `The token must belong to that site (set ZAI_BASE_URL=https://zchat.z.ai ` +
                        'for the mainland site) and must not be expired.'),
                };
                return;
            }
            session.initialized = false;
            try {
                await initializeSession();
            } catch (err) {
                yield { chunk: '', fullText: '', reasoning: '', error: err };
                return;
            }
            continue;
        }

        if (resp.status < 200 || resp.status >= 300) {
            const errBody = await resp.text();
            if (config.logging.level === 'debug') {
                logDebug(`Z.AI error body: ${errBody}`);
            }
            if (isWAFBlockResponse(resp.status, errBody)) {
                recordWAFBlock();
                const remaining = Math.round(wafRetryHint() / 1000);
                yield {
                    chunk: '', fullText: '', reasoning: '',
                    error: new Error(`${ERR_WAF_BLOCK} (retry in ~${remaining}s)`),
                };
                return;
            }
            recordWAFSuccess();
            // Never hand a full HTML page to the client (issue #41).
            yield {
                chunk: '', fullText: '', reasoning: '',
                error: new Error(`Z.AI error ${resp.status}: ${truncateErrorBody(errBody)}`),
            };
            return;
        }

        recordWAFSuccess();
        yield* streamSSEResponse(resp.body, opts.requestId);
        return;
    }
    yield {
        chunk: '', fullText: '', reasoning: '',
        error: new Error('Max retries exceeded (upstream still returned 401 after re-authentication)'),
    };
}

// extractZAIError inspects a parsed Z.AI SSE payload for an embedded error
// (Z.AI sometimes returns HTTP 200 with the error inside the JSON body).
// Returns the human-readable detail string, or '' if no error is present.
export function extractZAIError(j) {
    const detail = (errObj) => {
        let d = typeof errObj.detail === 'string' ? errObj.detail : '';
        if (d === '' && typeof errObj.message === 'string') d = errObj.message;
        if (d === '') return '';
        const code = errObj.code;
        if (code !== undefined && code !== null) return `${d} (code: ${code})`;
        return d;
    };
    const data = j?.data;
    if (data && typeof data === 'object') {
        // data.error
        if (data.error && typeof data.error === 'object') {
            const d = detail(data.error);
            if (d !== '') return d;
        }
        // data.data.error (nested variant observed in production)
        const nested = data.data;
        if (nested && typeof nested === 'object' &&
            nested.error && typeof nested.error === 'object') {
            const d = detail(nested.error);
            if (d !== '') return d;
        }
    }
    // Top-level error (non-Z.AI shape, just in case).
    // NOTE: unlike the data.error path, Go's top-level branch never appends
    // the code — kept faithful.
    if (j && typeof j === 'object' && j.error && typeof j.error === 'object') {
        let d = typeof j.error.detail === 'string' ? j.error.detail : '';
        if (d === '' && typeof j.error.message === 'string') d = j.error.message;
        if (d !== '') return d;
    }
    return '';
}

// statusFromError maps a Z.AI/bridge error string to an HTTP status code.
export function statusFromError(errMsg) {
    if (errMsg.includes("temporarily blocked this server's IP")) return 503;
    if (errMsg.includes('401')) return 401;
    if (errMsg.includes('403')) return 403;
    if (errMsg.includes('429')) return 429;
    if (errMsg.includes('400')) return 400;
    return 500;
}

// ============================================================================
// RUNE-SAFE STRING HELPERS (issue #23)
//
// Go slices strings by BYTE offset; the JS equivalents slice by UTF-16 code
// unit index. Both are valid as long as every cut lands on a code point
// boundary, which the helpers below guarantee. One caveat: Go's
// DecodeRuneInString treats invalid bytes as RuneError/size-1; JS strings
// (already decoded) cannot contain invalid UTF-8, so that path has no
// counterpart here.
// ============================================================================

// utf16IndexToStringIndex converts a UTF-16 code-unit offset — the indexing
// semantics of JavaScript strings, used by the official Z.AI web frontend
// (`content.substring(0, edit_index)`, see the prod-fe bundle) — into a JS
// string index within s. It clamps at the end of s and never returns an
// index inside a surrogate pair: an offset landing between the two units of
// a pair is clamped to the start of that code point.
// (Go: utf16IndexToByteIndex — byte offset; here a string index, which plays
// the identical role for JS slicing.)
export function utf16IndexToStringIndex(s, utf16Idx) {
    if (utf16Idx <= 0) return 0;
    let i = 0;
    let units = 0;
    while (i < s.length) {
        if (units === utf16Idx) return i;
        const cp = s.codePointAt(i);
        const ru = cp > 0xffff ? 2 : 1;
        if (units + ru > utf16Idx) return i; // inside a surrogate pair — clamp
        units += ru;
        i += ru;
    }
    return s.length;
}

// commonPrefixLen returns the string-index length of the longest common
// prefix of a and b. The result is always on a code point boundary, so
// slicing either string at that offset cannot produce a lone surrogate.
// (Go: commonPrefixLen — byte length; here a UTF-16 index length.)
export function commonPrefixLen(a, b) {
    let i = 0;
    while (i < a.length && i < b.length) {
        const ca = a.codePointAt(i);
        const cb = b.codePointAt(i);
        if (ca !== cb) break;
        i += ca > 0xffff ? 2 : 1;
    }
    return i;
}

// holdBackTail trims up to n code points from the end of s (code-point safe).
export function holdBackTail(s, n) {
    if (n <= 0 || s === '') return s;
    const cps = [...s];
    if (cps.length <= n) return '';
    return cps.slice(0, cps.length - n).join('');
}

// holdBackPartialDetailsTag trims a trailing fragment that could still be
// the beginning of a <details> tag whose completion has not arrived yet,
// so a tag streamed character by character never leaks to the client.
// A COMPLETE "</details>" literal is kept (legitimate text); a complete
// "<details" is held (waiting for its ">" to decide whether it is a tag).
export function holdBackPartialDetailsTag(s) {
    const i = s.lastIndexOf('<');
    if (i < 0) return s;
    const suffix = s.slice(i);
    if (suffix.length <= '<details'.length && '<details'.startsWith(suffix)) {
        return s.slice(0, i);
    }
    if (suffix.length < '</details>'.length && '</details>'.startsWith(suffix)) {
        return s.slice(0, i);
    }
    return s;
}

// holdBackPartialQuoteMarker trims a trailing ">" that forms the entire
// last line of s. Lines inside a <details> reasoning body are markdown-
// quoted ("> ..."), and while the body streams in one character at a
// time a new line's quote marker is transiently present as a bare ">"
// — which stripDetailsTags cannot strip yet (the "> " prefix needs the
// space) but strips one character later when the "> " completes.
// Forwarding that transient ">" makes the stripped-reasoning snapshot
// sequence non-monotonic, diverging the reasoning emitter: every later
// snapshot re-emits everything after the stale ">" — the growing-prefix
// reasoning_content duplication seen by clients. Holding the marker
// back keeps the sequence monotonic; the final flush releases it if
// the text really ends there.
export function holdBackPartialQuoteMarker(s) {
    if (!s.endsWith('>')) return s;
    const body = s.slice(0, -1);
    if (body === '' || body.endsWith('\n')) return body;
    return s;
}

// SSEEmitter forwards snapshots of a growing (and occasionally rewritten)
// text to an append-only consumer as code-point-safe deltas. It tracks
// exactly what the consumer has received so far and never emits a slice
// that starts inside a surrogate pair, so the consumer can never receive
// broken text (which a JSON renderer would show as U+FFFD replacement
// garble — the symptom reported in issue #23).
export class SSEEmitter {
    constructor() {
        this.clientView = ''; // exactly what the consumer has received so far
    }

    // delta returns the text to append to the consumer so it converges on
    // target as closely as possible, and updates the tracked view:
    //   - target extends the view   -> the new suffix (normal growth)
    //   - target is a prefix of the view (a deep edit truncated the text)
    //     -> '' — nothing can be taken back; the view is kept as-is so the
    //     following growth is not re-sent from a rewound base
    //   - target rewrote part of the view -> everything after the longest
    //     common prefix; the stale fragment in between stays on the consumer
    //     (unavoidable for append-only SSE, but it remains valid text).
    //     The tracked state then re-syncs to target so later growth emits
    //     only the genuinely new suffix; keeping the stale fragment in the
    //     tracked view would make every later snapshot diverge at the same
    //     point and re-emit everything after it on every call (cascading
    //     growing-prefix duplication).
    delta(target) {
        if (target === this.clientView) return '';
        if (target.startsWith(this.clientView)) {
            const d = target.slice(this.clientView.length);
            this.clientView = target;
            return d;
        }
        const cp = commonPrefixLen(this.clientView, target);
        if (cp === target.length) {
            return ''; // consumer already has everything target contains
        }
        const d = target.slice(cp);
        this.clientView = target;
        return d;
    }
}

// splitDetails extracts every complete <details ...>...</details> block
// from raw: the block bodies (concatenated) become reasoning, everything
// else becomes content. A trailing opener whose '>' has not arrived yet is
// held pending (neither reasoning nor content) until more data arrives.
// The third return value (`open`) reports whether the tail is inside an
// unclosed <details> block (complete or partial opener): reasoning that has
// closed is released in full, reasoning still streaming is held back
// (issue #45).
export function splitDetails(raw) {
    let rb = '';
    let cb = '';
    let open = false;
    let rest = raw;
    for (;;) {
        const idx = rest.indexOf('<details');
        if (idx < 0) {
            cb += rest;
            break;
        }
        cb += rest.slice(0, idx);
        const tagEnd = rest.indexOf('>', idx);
        if (tagEnd < 0) {
            open = true; // incomplete opener at the tail — hold pending
            break;
        }
        const afterTag = rest.slice(tagEnd + 1);
        const closeIdx = afterTag.indexOf('</details>');
        if (closeIdx < 0) {
            rb += afterTag; // reasoning still streaming
            open = true;
            break;
        }
        rb += afterTag.slice(0, closeIdx);
        rest = afterTag.slice(closeIdx + '</details>'.length);
    }
    return [rb, cb, open];
}

// ============================================================================
// SSE PARSING (Go: streamSSEResponse)
// ============================================================================

// async generator over a Z.AI response body, yielding the result protocol
// described on sendToZAI. `body` may be a web ReadableStream (production:
// zaiFetch's resp.body), an async iterable of Buffers, or — for tests — a
// plain string / Buffer.
export async function* streamSSEResponse(body, requestId = '') {
    // Attribute debug lines to the request when several are in flight
    // (issue #36). Empty IDs keep the bare [DEBUG] prefix.
    const logPrefix = requestId !== '' ? `[DEBUG] [${requestId}]` : '[DEBUG]';

    // ── Accumulated state across SSE lines ──
    let fullText = '';                    // raw upstream content, verbatim
    const contentEmitter = new SSEEmitter();   // tracks what the client received
    const reasoningEmitter = new SSEEmitter(); // same for the reasoning channel

    // stripDetailsTags removes <details ...> and </details> wrappers
    // and leading "> " markdown-quote prefixes from each line.
    const stripDetailsTags = (s) => {
        const idx = s.indexOf('<details');
        if (idx >= 0) {
            const end = s.indexOf('>', idx);
            if (end >= 0) s = s.slice(0, idx) + s.slice(end + 1);
        }
        s = s.replaceAll('</details>', '');
        const lines = s.split('\n').map((l) => (l.startsWith('> ') ? l.slice(2) : l));
        return lines.join('\n').trim();
    };

    // emitContent forwards the part of `target` the client has not seen
    // yet. All slicing is code-point safe, so clients can never receive
    // broken UTF-16 (which their JSON renderer would show as U+FFFD
    // replacement garble — the symptom reported in issue #23). fullText
    // carries the authoritative upstream snapshot for non-stream consumers
    // and for deep-edit re-sync detection in the handlers.
    function* emitContent(target) {
        const d = contentEmitter.delta(target);
        if (d !== '') yield { chunk: d, fullText: target, reasoning: '', error: null };
    }

    function* flush(final) {
        const raw = fullText;

        // Split <details ...> ... </details> into reasoning vs content
        const [reasoningRaw, content, reasoningOpen] = splitDetails(raw);
        let reasoning = reasoningRaw;
        if (reasoning !== '') reasoning = stripDetailsTags(reasoning);

        // Emit reasoning delta (prefix-aware, code-point safe). Reasoning
        // rides the same edit-based stream as content, so while the stream
        // is live it gets the same protection: hold back a small tail so
        // trailing edit_content backtracks are absorbed invisibly, hold
        // back a partial </details> close tag streamed character by
        // character (splitDetails folds it into the reasoning body until
        // it completes, so forwarding it would leak the fragment and
        // then rewind the snapshot), and hold back a partially-streamed
        // "> " quote marker that a later character would strip again
        // (non-monotonic snapshots diverge the emitter and duplicate
        // everything after them). The final flush releases everything.
        // A closed reasoning block is complete: release it in full so the
        // answer never overtakes the reasoning tail on append-only clients
        // (issue #45).
        if (!final && reasoningOpen) {
            reasoning = holdBackTail(reasoning, config.streamHoldback);
            reasoning = holdBackPartialDetailsTag(reasoning);
            reasoning = holdBackPartialQuoteMarker(reasoning);
        }
        const rDelta = reasoningEmitter.delta(reasoning);
        if (rDelta !== '') yield { chunk: '', fullText: '', reasoning: rDelta, error: null };

        // While the stream is live, keep a small tail pending so ordinary
        // trailing edit_content backtracks are absorbed invisibly, and
        // never forward a fragment that could still grow into a <details>
        // tag. The final flush releases everything.
        let target = content;
        if (!final) {
            target = holdBackTail(target, config.streamHoldback);
            target = holdBackPartialDetailsTag(target);
        }
        yield* emitContent(target);
    }

    let finished = false;   // saw [DONE] / phase=done (flush(true) already ran)
    let inlineError = null; // Z.AI inline error (no final flush, like Go)

    // handleLine processes one SSE line; it sets finished/inlineError to
    // signal the main loop to stop.
    function* handleLine(line) {
        const trimmed = line.trim();

        if (config.logging.level === 'debug' && trimmed !== '') {
            logDebug(`${logPrefix} Z.AI SSE line: ${trimmed}`);
        }

        if (!trimmed.startsWith('data: ')) return;
        const dataStr = trimmed.slice(6);
        if (dataStr === '[DONE]') {
            yield* flush(true);
            finished = true;
            return;
        }

        let j;
        try {
            j = JSON.parse(dataStr);
        } catch {
            if (config.logging.level === 'debug') {
                logDebug(`${logPrefix} Z.AI failed to parse SSE: ${dataStr}`);
            }
            return;
        }

        // ── Detect inline errors (HTTP 200 with error in body) ──
        const errDetail = extractZAIError(j);
        if (errDetail !== '') {
            if (config.logging.level === 'debug') {
                logDebug(`${logPrefix} Z.AI inline SSE error: ${errDetail}`);
            }
            inlineError = new Error(`Z.AI error: ${errDetail}`);
            return;
        }

        const data = j && typeof j === 'object' ? j.data : undefined;
        if (!data || typeof data !== 'object') {
            yield* flush(false);
            return;
        }

        if (data.phase === 'done') {
            yield* flush(true);
            finished = true;
            return;
        }

        // ── Content accumulation ──
        // Semantics mirror the official Z.AI web frontend (prod-fe bundle):
        //   edit_content:  content = content.substring(0, edit_index) +
        //                  edit_content where edit_index is a UTF-16 code-
        //                  unit offset (JavaScript string indexing); a
        //                  missing edit_index defaults to 0 (full replacement)
        //   content:       full replacement of the accumulated text
        //   delta_content: plain append
        if (typeof data.edit_content === 'string' && data.edit_content !== '') {
            const editIndex = typeof data.edit_index === 'number' ? Math.trunc(data.edit_index) : 0;
            const idx = utf16IndexToStringIndex(fullText, editIndex);
            fullText = fullText.slice(0, idx) + data.edit_content;
        } else if (typeof data.content === 'string' && data.content !== '') {
            fullText = data.content;
        } else if (typeof data.delta_content === 'string' && data.delta_content !== '') {
            fullText += data.delta_content;
        }

        yield* flush(false);
    }

    // Iterate lines: streaming TextDecoder so a multi-byte rune split across
    // network chunks is reassembled before line splitting. (Go's 10 MB
    // max-line scanner guard is not re-implemented.)
    let readError = null;
    try {
        const iterable =
            typeof body === 'string' ? [Buffer.from(body, 'utf8')]
            : (Buffer.isBuffer(body) ? [body] : body);
        const decoder = new TextDecoder('utf-8');
        let buf = '';
        for await (const chunk of iterable) {
            buf += decoder.decode(chunk, { stream: true });
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                yield* handleLine(line);
                if (finished || inlineError) break;
            }
            if (finished || inlineError) break;
        }
        if (!finished && !inlineError) {
            buf += decoder.decode();
            if (buf !== '') yield* handleLine(buf);
        }
    } catch (err) {
        readError = err; // Go: scanner.Err()
    }

    if (inlineError) {
        yield { chunk: '', fullText: '', reasoning: '', error: inlineError };
        return;
    }
    // Go: reaching here means the stream ended without a terminator (or the
    // scanner failed) — flush(true) runs either way, then the read error (if
    // any) is returned.
    if (!finished) yield* flush(true);
    if (readError) {
        yield { chunk: '', fullText: '', reasoning: '', error: readError };
    }
}
