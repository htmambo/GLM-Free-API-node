// Port of internal/zbridge/util.go — utility functions.
//
// Excluded here (they live elsewhere, matching the Go split):
//   - logging (logError/logInfo)      -> logger.js
//   - uTLS dial / HTTP clients / cookie jar / warmupCookies -> httpClient.js
//   - Go buffer pools (bufPool, zlibWriterPool) are GC-pressure
//     optimizations with no JS counterpart; omitted.
//
// Also included (per project convention, keeping util.go's role as the
// shared-helpers file):
//   - generateSignature / buildQueryString from captcha.go (Aliyun signing)
//   - generateZaSignature from zai.go (Z.AI request signing)
//
// Crypto uses node:crypto. All HMAC/hash outputs are Buffers unless noted.
//
// NOTE on the circular import: this module imports `session` from state.js
// while state.js imports randomUUID from here. Safe because every export
// here is a hoisted function declaration and `session` is only read at
// call time inside generateZaSignature.

import { createHmac, randomBytes } from 'node:crypto';
import { session } from './state.js';
import { clientVersion, zaiUserAgent, BASE_URL } from './config.js';

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

export function minInt(a, b) {
    return a < b ? a : b;
}

export function randomUUID() {
    const b = randomBytes(16);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = b.toString('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function generateID() {
    return randomBytes(16).toString('hex');
}

// UUID v4 — same output as Go generateUUID (kept distinct from randomUUID
// to match the Go codebase, which has both).
export function generateUUID() {
    return randomUUID();
}

// ---------- Timestamp helpers ----------

export function getTimestampUTC() {
    // Go layout "2006-01-02T15:04:05Z"
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function currentTimeMillis() {
    return Date.now();
}

// ---------- Token estimation ----------

export function estimateTokens(text) {
    if (!text) return 0;
    // Go: (len(text) + 3) / 4 where len is BYTE length.
    return Math.floor((Buffer.byteLength(text, 'utf8') + 3) / 4);
}

// ---------- Message helpers ----------

// Go: getMessageContent(json.RawMessage). In JS the raw JSON has already
// been parsed, so `content` is string | array | other | null.
export function getMessageContent(content) {
    if (content === null || content === undefined) return '';
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        const texts = [];
        for (const item of content) {
            if (typeof item === 'string') {
                texts.push(item);
            } else if (item && typeof item === 'object') {
                if (item.type === 'text' && typeof item.text === 'string') {
                    texts.push(item.text);
                }
            }
        }
        return texts.join('\n');
    }
    return JSON.stringify(content);
}

export function messagesToPrompt(messages) {
    let sb = '';
    for (const msg of messages) {
        sb += getMessageContent(msg.content);
        sb += '\n\n';
    }
    return sb.trim();
}

// Go boolPtr (*bool for optional flags). JS has no pointers; callers use
// null/undefined for "unset". Kept as identity for call-site parity.
export function boolPtr(b) {
    return !!b;
}

// ============================================================================
// URL ENCODING — Go url.QueryEscape-style byte-level percent encoding
// ============================================================================

const hexUpper = '0123456789ABCDEF';
const hexLower = '0123456789abcdef';

// Safe-character table for the custom URL encoder (Go: baseSafeTable,
// initialised in init()).
const baseSafeTable = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    const c = i;
    if ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) ||
        c === 0x2d || c === 0x5f || c === 0x2e || c === 0x7e) { // 0-9 A-Z a-z - _ . ~
        baseSafeTable[c] = 1;
    }
}

// Go: urlEncode(s, safe string). Operates on UTF-8 BYTES like Go strings.
export function urlEncode(s, safe = '') {
    const safeTable = Uint8Array.from(baseSafeTable);
    for (let i = 0; i < safe.length; i++) {
        safeTable[safe.charCodeAt(i)] = 1;
    }
    const bytes = Buffer.from(s, 'utf8');
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        if (safeTable[c]) {
            out += String.fromCharCode(c);
        } else {
            out += '%' + hexUpper[c >> 4] + hexUpper[c & 0x0f];
        }
    }
    return out;
}

// Go url.Values.Encode semantics: query-component escaping where space
// becomes '+' (everything else identical to urlEncode above).
export function queryEscape(s) {
    const bytes = Buffer.from(s, 'utf8');
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
        const c = bytes[i];
        if (c === 0x20) {
            out += '+';
        } else if (baseSafeTable[c]) {
            out += String.fromCharCode(c);
        } else {
            out += '%' + hexUpper[c >> 4] + hexUpper[c & 0x0f];
        }
    }
    return out;
}

export function fromHex(c) {
    // Go takes a byte; here a char code or single-char string.
    if (typeof c === 'string') c = c.charCodeAt(0);
    if (c >= 0x30 && c <= 0x39) return c - 0x30;        // 0-9
    if (c >= 0x41 && c <= 0x46) return c - 0x41 + 10;   // A-F
    if (c >= 0x61 && c <= 0x66) return c - 0x61 + 10;   // a-f
    return 0;
}

// ============================================================================
// CRYPTO HELPERS
// ============================================================================

export function base64Encode(data) {
    return Buffer.from(data).toString('base64');
}

export function hmacSHA1(key, msg) {
    return createHmac('sha1', key).update(msg).digest();
}

export function hmacSHA256(key, msg) {
    return createHmac('sha256', key).update(msg).digest();
}

// Go base64Decode: tries raw-url, raw-std, url, std, std+"==", url+"==".
// Node's base64 decoder is lenient about padding, so normalise the URL
// alphabet and add padding ourselves, then decode.
export function base64Decode(s) {
    if (typeof s !== 'string') throw new Error('base64 decode failed');
    const std = s.replace(/-/g, '+').replace(/_/g, '/');
    const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) {
        throw new Error('base64 decode failed');
    }
    return Buffer.from(padded, 'base64');
}

// ============================================================================
// JSON MARSHALING
// ============================================================================

// Go jsonMarshal disables HTML escaping and trims the trailing newline.
// JSON.stringify never escapes HTML and has no trailing newline, so it is
// the exact equivalent. Returns a string (Go returned []byte).
export function jsonMarshal(v) {
    return JSON.stringify(v);
}

// ============================================================================
// ALIYUN SIGNATURE (captcha.go: generateSignature / buildQueryString)
// ============================================================================

export function generateSignature(params, secKey) {
    const keys = Object.keys(params).sort();
    const canonical = keys.map((k) => `${urlEncode(k)}=${urlEncode(params[k])}`).join('&');
    const stringToSign = 'POST&' + urlEncode('/') + '&' + urlEncode(canonical);
    const signingKey = secKey + '&';
    return base64Encode(hmacSHA1(Buffer.from(signingKey), Buffer.from(stringToSign)));
}

export function buildQueryString(params) {
    const keys = Object.keys(params).sort();
    return keys.map((k) => `${urlEncode(k)}=${urlEncode(params[k])}`).join('&');
}

// ============================================================================
// Z.AI SIGNATURE GENERATION (zai.go: generateZaSignature)
// ============================================================================

// Reads session.saltKey at call time, exactly like the Go original reads
// session.SaltKey. Returns { signature, timestamp, urlParams }.
export function generateZaSignature(prompt, token, userID) {
    const tsMs = Date.now();
    const timestamp = String(tsMs);
    const requestId = randomUUID();
    const bucket = Math.floor(tsMs / 300000);

    const wKey = hmacSHA256(Buffer.from(session.saltKey), Buffer.from(String(bucket))).toString('hex');

    const payloadDict = [
        ['requestId', requestId],
        ['timestamp', timestamp],
        ['user_id', userID],
    ].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const sortedPayload = payloadDict.map(([k, v]) => `${k},${v}`).join(',');

    const promptB64 = base64Encode(Buffer.from(prompt.trim(), 'utf8'));
    const dataToSign = sortedPayload + '|' + promptB64 + '|' + timestamp;

    const signature = hmacSHA256(Buffer.from(wKey), Buffer.from(dataToSign)).toString('hex');

    // Go url.Values.Encode(): keys sorted, values query-escaped (space -> '+').
    //
    // The web client also ships a full browser-fingerprint set alongside
    // these. The upstream compares the request against it and answers a
    // bare "500 Internal Server Error" when the shape does not match, so
    // the fingerprint fields are reproduced here (see fingerprintParams).
    const params = {
        timestamp,
        requestId,
        user_id: userID,
        signature_timestamp: timestamp,
        ...fingerprintParams(token),
    };
    const urlParams = Object.keys(params)
        .sort()
        .map((k) => `${queryEscape(k)}=${queryEscape(params[k])}`)
        .join('&');

    return { signature, timestamp, urlParams };
}

// fingerprintParams reproduces the browser-fingerprint query parameters the
// z.ai web client sends on /api/v2/chat/completions.
//
// The upstream validates the request against this set; a request that is
// missing them is answered with a bare "500 Internal Server Error" instead
// of a descriptive error, so the shape has to match the deployed client.
//
// Field list taken from the prod web bundle (prod-fe-1.2.x): the client
// builds them from navigator / window / screen / location, so the values
// here are the equivalent static ones for the bridge's own fingerprint.
export function fingerprintParams(token) {
    const now = new Date();
    // The fingerprint describes the site the request goes to, so every
    // host-ish value is derived from BASE_URL rather than hardcoded.
    let origin = 'https://chat.z.ai';
    let host = 'chat.z.ai';
    try {
        origin = new URL(BASE_URL).origin;
        host = new URL(BASE_URL).hostname;
    } catch {
        /* keep the defaults */
    }
    return {
        version: clientVersion,
        platform: 'web',
        token,
        // Must match the User-Agent header: the upstream compares the two
        // and a mismatch (Chrome/120 in the query vs Chrome/133 in the
        // header) reads as a spoofed client.
        user_agent: zaiUserAgent,
        language: 'en-US',
        languages: 'en-US',
        timezone: 'Asia/Shanghai',
        cookie_enabled: 'true',
        screen_width: '1440',
        screen_height: '900',
        screen_resolution: '1440x900',
        viewport_height: '900',
        viewport_width: '1440',
        viewport_size: '1440x900',
        color_depth: '24',
        pixel_ratio: '1',
        current_url: origin + '/chat',
        pathname: '/chat',
        search: '',
        hash: '',
        host,
        hostname: host,
        protocol: 'https:',
        referrer: '',
        title: 'New Chat | Z.ai - Advanced AI Chatbot & Agent powered by GLM',
        timezone_offset: '-480',
        local_time: now.toISOString(),
        utc_time: now.toUTCString(),
        is_mobile: 'false',
        is_touch: 'false',
        max_touch_points: '0',
        browser_name: 'Chrome',
        os_name: 'Mac OS',
    };
}
