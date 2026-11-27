// Port of internal/zbridge/util.go — HTTP client section (Go lines ~85-350):
// the Z.AI HTTP client, cookie jar, proxy handling and warmupCookies.
//
// Go original uses uTLS with a Chrome-120 ClientHello because Aliyun ESA WAF
// JA3-fingerprints Go's TLS stack. Node has no built-in TLS fingerprint
// spoofing, so there are two backends:
//
//   1. DEFAULT (global fetch / undici): real browser-grade TLS stack
//      (BoringSSL via Node), HTTP/2, keep-alive — no uTLS needed because the
//      fingerprint is already non-Go.
//      PROXY: undici is NOT importable as a module in Node 24 (verified:
//      `import('undici')` -> ERR_MODULE_NOT_FOUND), so no ProxyAgent.
//      Instead start node with NODE_USE_ENV_PROXY=1 to make the global
//      fetch honor HTTP_PROXY/HTTPS_PROXY (verified working on Node
//      24.19.0). Without that flag, env proxies are silently ignored.
//
//   2. CURL_IMPERSONATE: if the CURL_IMPERSONATE env var points at a
//      curl-impersonate executable (e.g. curl_chrome120), requests are made
//      through that binary via child_process — invoking it is equivalent to
//      curl with a real Chrome TLS fingerprint. Streaming responses are
//      exposed as the child's stdout stream. This backend honors proxy env
//      vars natively (same lookup order as Go dialUTLS).
//
// Go's per-client timeouts and connection-pool tuning (MaxIdleConns etc.)
// have no direct fetch equivalent and are omitted; callers should pass an
// AbortSignal via `signal` for timeouts.

import { spawn } from 'node:child_process';
import { BASE_URL, zaiUserAgent } from './config.js';
import { logInfo, logDebug } from './logger.js';
import { pace } from './ratelimit.js';

// ============================================================================
// COOKIE JAR — minimal implementation (Go: cookieJar, mutex omitted)
// ============================================================================

// Go's cookieJar ignores the URL argument entirely: SetCookies stores every
// cookie handed to it and Cookies() returns all of them. Ported faithfully
// (matching is on name+domain+path for replacement only).
export class CookieJar {
    constructor() {
        this.cookies = []; // [{ name, value, domain, path }]
    }

    // cookies: [{ name, value, domain?, path? }]
    setCookies(url, cookies) {
        for (const c of cookies) {
            const domain = c.domain || '';
            const path = c.path || '';
            this.cookies = this.cookies.filter(
                (e) => !(e.name === c.name && e.domain === domain && e.path === path),
            );
            this.cookies.push({ name: c.name, value: c.value, domain, path });
        }
    }

    getCookies(url) {
        return this.cookies.map((e) => ({ ...e }));
    }

    // "name=value; name2=value2" for the Cookie request header ('' if empty).
    getCookieHeader(url) {
        return this.cookies.map((e) => `${e.name}=${e.value}`).join('; ');
    }
}

// Parse one Set-Cookie header value into a jar entry (attributes other than
// Domain/Path are irrelevant to the Go jar and dropped).
export function parseSetCookie(header) {
    const parts = header.split(';');
    const eq = parts[0].indexOf('=');
    if (eq === -1) return null;
    const entry = {
        name: parts[0].slice(0, eq).trim(),
        value: parts[0].slice(eq + 1).trim(),
        domain: '',
        path: '',
    };
    for (let i = 1; i < parts.length; i++) {
        const attr = parts[i].trim();
        const aeq = attr.indexOf('=');
        const key = (aeq === -1 ? attr : attr.slice(0, aeq)).trim().toLowerCase();
        const val = aeq === -1 ? '' : attr.slice(aeq + 1).trim();
        if (key === 'domain') entry.domain = val;
        else if (key === 'path') entry.path = val;
    }
    return entry;
}

function storeResponseCookies(cookieJar, url, setCookies) {
    if (!cookieJar) return;
    const entries = [];
    for (const h of setCookies) {
        const e = parseSetCookie(h);
        if (e) entries.push(e);
    }
    if (entries.length) cookieJar.setCookies(url, entries);
}

// Shared jar, mirroring Go's zaiJar attached to zaiHTTPClient.
export const zaiJar = new CookieJar();

// ============================================================================
// PROXY RESOLUTION — same env lookup order as Go dialUTLS
// ============================================================================

function proxyFromEnv() {
    const env = process.env;
    return (
        env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY ||
        env.https_proxy || env.http_proxy || env.all_proxy || ''
    );
}

// ============================================================================
// UNIFIED RESPONSE WRAPPER
// ============================================================================

// Shape: { status, headers: Headers, body: ReadableStream|null, text(), json() }
function wrapResponse(status, headers, body, consume) {
    return {
        status,
        headers,
        body,
        async text() {
            return consume().then((buf) => buf.toString('utf8'));
        },
        async json() {
            return consume().then((buf) => JSON.parse(buf.toString('utf8')));
        },
    };
}

// ============================================================================
// DEFAULT BACKEND — global fetch (undici), single request, no redirects
// ============================================================================

async function nodeFetch(url, { method, headers, body, signal }) {
    const resp = await fetch(url, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal,
    });
    return wrapResponse(
        resp.status,
        resp.headers,
        resp.body,
        async () => {
            if (resp.body === null) return Buffer.alloc(0);
            if (resp.bodyUsed) throw new TypeError('Body has already been consumed');
            return Buffer.from(await resp.arrayBuffer());
        },
    );
}

// ============================================================================
// CURL-IMPERSONATE BACKEND — child_process, chrome TLS fingerprint
// ============================================================================

// Single request via the curl-impersonate binary; no redirects (handled by
// the shared loop in zaiFetch), no jar handling (headers arrive pre-baked).
function curlFetch(url, { method, headers, body, signal }) {
    const bin = process.env.CURL_IMPERSONATE;
    const args = ['-sS', '-N', '-i', '-X', method];

    const proxy = proxyFromEnv();
    if (proxy) args.push('-x', proxy);

    for (const [k, v] of Object.entries(headers)) {
        args.push('-H', `${k}: ${v}`);
    }
    if (body !== null && body !== undefined) {
        args.push('--data-binary', '@-');
    }
    args.push(url);

    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    if (signal) {
        if (signal.aborted) child.kill('SIGKILL');
        else signal.addEventListener('abort', () => child.kill('SIGKILL'), { once: true });
    }

    let stderrBuf = Buffer.alloc(0);
    child.stderr.on('data', (d) => {
        stderrBuf = Buffer.concat([stderrBuf, d]);
    });

    if (body !== null && body !== undefined) {
        child.stdin.write(typeof body === 'string' ? Buffer.from(body, 'utf8') : body);
    }
    child.stdin.end();

    const iter = child.stdout[Symbol.asyncIterator]();

    const readHeaderBlock = async () => {
        // Accumulate until the end of the final (non-1xx) header block.
        let buf = Buffer.alloc(0);
        for (;;) {
            const { value, done } = await iter.next();
            if (done) throw new Error('curl-impersonate closed stdout before headers');
            buf = Buffer.concat([buf, value]);
            const idx = buf.indexOf('\r\n\r\n');
            if (idx === -1) continue;
            const head = buf.subarray(0, idx).toString('latin1');
            const rest = buf.subarray(idx + 4);
            const lines = head.split('\r\n');
            const status = parseInt(lines[0].split(' ')[1], 10);
            if (status >= 100 && status < 200) {
                // Interim response (e.g. 100 Continue): keep parsing.
                buf = rest;
                continue;
            }
            const hdrs = new Headers();
            for (let i = 1; i < lines.length; i++) {
                const c = lines[i].indexOf(':');
                if (c > 0) hdrs.append(lines[i].slice(0, c).trim(), lines[i].slice(c + 1).trim());
            }
            return { status, headers: hdrs, rest };
        }
    };

    return (async () => {
        const { status, headers: respHeaders, rest } = await readHeaderBlock();

        let pending = rest;
        let finished = false;
        const stream = new ReadableStream({
            async pull(controller) {
                if (pending && pending.length) {
                    controller.enqueue(pending);
                    pending = null;
                    return;
                }
                if (finished) {
                    controller.close();
                    return;
                }
                const { value, done } = await iter.next();
                if (done) {
                    finished = true;
                    controller.close();
                } else {
                    controller.enqueue(value);
                }
            },
            cancel() {
                finished = true;
                child.kill('SIGKILL');
            },
        });

        const consume = async () => {
            const chunks = [];
            for await (const chunk of stream) chunks.push(chunk);
            return Buffer.concat(chunks);
        };
        return wrapResponse(status, respHeaders, stream, consume);
    })().catch((err) => {
        const stderr = stderrBuf.toString('utf8').trim();
        if (stderr) err.message += ` (curl-impersonate stderr: ${stderr})`;
        throw err;
    });
}

// ============================================================================
// zaiFetch — unified interface (default backend preferred)
// ============================================================================

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 10; // Go http.Client default

// async function zaiFetch(url, { method, headers, body, cookieJar, signal })
//   -> { status, headers, body: ReadableStream|null, text(), json() }
//
// `body` is a string/Buffer or null. `cookieJar` is a CookieJar (defaults to
// the shared zaiJar, matching Go's zaiHTTPClient which always has a jar).
// Redirects are followed manually (both backends) so the cookie jar sees
// every hop and Go's redirect method-rewrite rules apply.
export async function zaiFetch(url, {
    method = 'GET',
    headers = {},
    body = null,
    cookieJar = zaiJar,
    signal = undefined,
} = {}) {
    const backend = process.env.CURL_IMPERSONATE ? curlFetch : nodeFetch;

    let currentUrl = url;
    let currentMethod = method;
    let currentBody = body;
    const baseHeaders = { ...headers };

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        const reqHeaders = { ...baseHeaders };
        if (cookieJar) {
            const cookieHeader = cookieJar.getCookieHeader(currentUrl);
            if (cookieHeader) reqHeaders['Cookie'] = cookieHeader;
        }
        // Go strips sensitive headers on cross-origin redirects.
        if (hop > 0 && new URL(currentUrl).host !== new URL(url).host) {
            delete reqHeaders['Authorization'];
            delete reqHeaders['authorization'];
        }

        // Shared pacing gate (Go: pacedTransport wrapping both the Z.AI and
        // the Aliyun captcha transports). Claiming a slot per hop matches
        // net/http, which calls RoundTrip once per redirect.
        await pace(signal);

        const resp = await backend(currentUrl, {
            method: currentMethod,
            headers: reqHeaders,
            body: currentBody,
            signal,
        });

        storeResponseCookies(cookieJar, currentUrl, resp.headers.getSetCookie());

        if (!REDIRECT_STATUSES.has(resp.status)) {
            return resp;
        }
        if (hop === MAX_REDIRECTS) {
            throw new Error(`stopped after ${MAX_REDIRECTS} redirects`);
        }

        const location = resp.headers.get('location');
        if (!location) {
            return resp;
        }
        // Discard the redirect body before following (io.Copy(io.Discard)).
        resp.body?.cancel().catch(() => {});
        currentUrl = new URL(location, currentUrl).href;
        // Go net/http: 301/302/303 turn non-GET/HEAD into GET with no body;
        // 307/308 preserve method and body.
        if (resp.status === 303 ||
            ((resp.status === 301 || resp.status === 302) &&
                currentMethod !== 'GET' && currentMethod !== 'HEAD')) {
            currentMethod = 'GET';
            currentBody = null;
            delete baseHeaders['Content-Type'];
            delete baseHeaders['content-type'];
        }
    }
}

// ============================================================================
// WARM-UP — acquire acw_tc anti-bot cookies before API calls
// (Go: warmupCookies in util.go)
// ============================================================================

export async function warmupCookies() {
    const resp = await zaiFetch(BASE_URL, {
        method: 'GET',
        headers: {
            'User-Agent': zaiUserAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'sec-ch-ua': '"Not=A?Brand";v="99", "Brave";v="151", "Chromium";v="151"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
        },
    });
    // io.Copy(io.Discard, resp.Body)
    await resp.text();

    // Go logs each cookie at debug level via log.Printf.
    for (const c of zaiJar.getCookies(BASE_URL)) {
        let v = c.value;
        if (v.length > 20) v = v.slice(0, 20);
        logDebug(`[Warmup] Cookie: ${c.name}=${v}...`);
    }
    logInfo('[Warmup] done');
}
