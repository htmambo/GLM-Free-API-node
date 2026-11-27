// Port of internal/zbridge/captcha.go — Aliyun captcha machinery:
// device-token access, the captcha param generator, and the agent-mode
// captcha cache.
//
// Port notes:
//   - The hot-swappable token database lives in db.js; this file only reads
//     and deletes through withTokenDB (the captcha path's two call sites).
//   - Go goroutines/channels become async/await; the 90s timeout in
//     getCaptchaVerifyParam becomes a Promise.race against setTimeout.
//   - Go's bufPool/zlibWriterPool are GC-pressure optimizations with no JS
//     counterpart; omitted (same as util.js).
//   - generateSignature / buildQueryString live in util.js (per the Go
//     split decided in Phase 0) and are imported from there.
//   - Go's getNextToken returns (string, bool); here it returns the token
//     string or null. CaptchaCache.Get returns the value or null.

import { existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { accessKey, secretKey, sceneID, maxTokenRetries } from './config.js';
import { config } from './state.js';
import { withTokenDB, ERR_DB_UNAVAILABLE } from './db.js';
import { logError, logInfo } from './logger.js';
import {
    generateUUID,
    getTimestampUTC,
    currentTimeMillis,
    urlEncode,
    fromHex,
    base64Encode,
    jsonMarshal,
    generateSignature,
    buildQueryString,
} from './util.js';
import { zaiFetch } from './httpClient.js';

const hexLower = '0123456789abcdef';

// ============================================================================
// DATABASE — SQLite via node:sqlite
// ============================================================================

// Go: getNextToken() (string, bool) -> token string or null. Reads from the
// active handle's path, so a hot-swapped database is followed automatically.
export function getNextToken() {
    let token = null;
    try {
        withTokenDB((h) => {
            if (!existsSync(h.path)) {
                logError('Database file not found: ' + h.path);
                throw new Error('database file not found');
            }
            const row = h.db.prepare('SELECT token FROM tokens ORDER BY id LIMIT 1;').get();
            if (row === undefined) {
                logError("No device tokens available in table 'tokens'");
                return;
            }
            token = row.token;
        });
    } catch (err) {
        if (err.message === ERR_DB_UNAVAILABLE) {
            logError(err.message);
        } else if (err.message !== 'database file not found') {
            logError('Failed to query token: ' + err.message);
        }
        return null;
    }
    return token;
}

export function removeToken(token) {
    try {
        withTokenDB((h) => {
            h.db.prepare('DELETE FROM tokens WHERE token = ?;').run(token);
        });
    } catch (err) {
        logError('Failed to delete consumed token: ' + err.message);
    }
}

// ============================================================================
// HTTP POST — Go: httpPost via aliyunHTTPClient (30s timeout, no cookie jar)
// ============================================================================

async function httpPost(targetURL, body, extraHeaders = {}) {
    const headers = {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        ...extraHeaders,
    };
    const resp = await zaiFetch(targetURL, {
        method: 'POST',
        headers,
        body,
        cookieJar: null, // Go's aliyunHTTPClient has no jar attached
        signal: AbortSignal.timeout(30_000), // Go http.Client Timeout: 30s
    });
    return resp.text();
}

// ============================================================================
// CAPTCHA GENERATION — PART 1: InitCaptchaV3
// ============================================================================

// Go: initCaptcha() — returns the CertifyId (JSON field name verbatim).
export async function initCaptcha() {
    const params = {
        AccessKeyId: accessKey,
        Action: 'InitCaptchaV3',
        Format: 'JSON',
        Language: 'en',
        Mode: 'popup',
        SceneId: sceneID,
        SignatureMethod: 'HMAC-SHA1',
        SignatureNonce: generateUUID(),
        SignatureVersion: '1.0',
        Timestamp: getTimestampUTC(),
        UpLang: 'true',
        Version: '2023-03-05',
    };
    params.Signature = generateSignature(params, secretKey);

    const body = buildQueryString(params);
    const resp = await httpPost(
        'https://no8xfe.captcha-open-southeast.aliyuncs.com/', body);

    let result;
    try {
        result = JSON.parse(resp);
    } catch (err) {
        throw new Error(`parse InitCaptchaV3 response: ${err.message}`);
    }
    return result.CertifyId ?? '';
}

// ============================================================================
// CAPTCHA GENERATION — PART 2: Generate arg (RC4-like stream cipher)
// ============================================================================

// Go: var argPermTable = [64]int{...} — `r := argPermTable` copies the array
// per call, so each cipher run starts from this pristine table.
const argPermTable = Object.freeze([
    32, 50, 10, 51, 6, 44, 37, 16, 46, 11, 62, 19, 43, 25, 23, 30,
    60, 33, 53, 34, 7, 26, 12, 48, 5, 2, 20, 4, 61, 13, 47, 49,
    18, 29, 27, 22, 1, 17, 39, 56, 41, 38, 55, 31, 15, 58, 52, 40,
    8, 57, 45, 35, 59, 36, 42, 54, 63, 3, 24, 28, 14, 9, 0, 21,
]);

const argConstant = '4xrihv8zb8tf1mfj';

// Shared KSA+PRGA core of generateArg (key argConstant) and encrypt (key
// encryptKey) — the Go source duplicates this loop pair verbatim in both
// functions; factored here to keep the byte-level semantics in one place.
// data: Uint8Array/Buffer of input bytes. Returns a Uint8Array of output
// bytes (each already masked to & 255, as in Go).
function argStreamCipher(data, key) {
    const r = Array.from(argPermTable);
    const n = key;
    const rlen = 64;

    // KSA
    let i = 0;
    let j = 0;
    while (i < rlen) {
        j = (((i + j + r[i] + r[j]) >> 1) + n.charCodeAt(i % n.length)) & (rlen - 1);
        if (i !== j) {
            const tmp = r[i];
            r[i] = r[j];
            r[j] = tmp;
        }
        i++;
    }

    // PRGA
    const t = new Uint8Array(data.length);
    let e = 0;
    let a = 0;
    for (let idx = 0; idx < data.length; idx++) {
        a = ((e ^ a) + (r[e] ^ r[a])) & (rlen - 1);
        if (e !== a) {
            const tmp = r[e];
            r[e] = r[a];
            r[a] = tmp;
        }
        let m = data[idx];
        m = m + e + r[e] - a - r[a];
        m = m ^ (r[e] + r[a]);
        m = m ^ r[(r[e] + r[a]) & (rlen - 1)];
        m = m & 255;
        t[idx] = m;
        e = (e + 1) & (rlen - 1);
    }
    return t;
}

export function generateArg(certifyID) {
    const encoded = urlEncode(certifyID, '');

    // URL-decode (identity for already-decoded strings, kept for faithfulness)
    const o = [];
    for (let i = 0; i < encoded.length;) {
        if (encoded[i] === '%' && i + 2 < encoded.length) {
            o.push((fromHex(encoded[i + 1]) << 4) | fromHex(encoded[i + 2]));
            i += 3;
        } else {
            o.push(encoded.charCodeAt(i));
            i++;
        }
    }

    return base64Encode(argStreamCipher(Uint8Array.from(o), argConstant));
}

// ============================================================================
// CAPTCHA GENERATION — PART 4: ali_hash (custom hash with 16-byte state)
// ============================================================================

// Go indexes the input/salt strings byte-wise; convert to UTF-8 bytes first.
export function aliHash(inputStr, saltStr) {
    const o = Buffer.from(inputStr, 'utf8');
    const r = Buffer.from(saltStr, 'utf8');
    const aLen = o.length;
    const m = r.length;

    const e = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        e[i] = (i << 4) + (i % 16);
    }
    const f = 16;

    let i = 0;
    let j = 0;
    while (i < f) {
        j = (((i + j + e[i] + e[j]) >> 1) + r[i % m]) & (f - 1);
        const tmp = e[i];
        e[i] = e[j];
        e[j] = tmp;
        i++;
    }

    let idx = 0;
    let p = 0;
    let q = 0;
    while (idx < aLen) {
        q = ((p ^ q) + (e[p] ^ e[q])) & (f - 1);
        const tmp = e[p];
        e[p] = e[q];
        e[q] = tmp;
        let C = o[idx];
        C = (C + p + q) ^ e[p] ^ e[q];
        C = C & 255;
        e[p] = C;
        p = (p + 1) & (f - 1);
        idx++;
    }

    for (let step = 0; step < 2 * f; step++) {
        const pos = step % f;
        if (pos !== 0) {
            e[pos] ^= e[pos - 1];
        } else {
            e[0] ^= e[f - 1];
        }
    }

    let result = '';
    for (const b of e) {
        result += hexLower[b >> 4] + hexLower[b & 0xf];
    }
    return result;
}

// ============================================================================
// CAPTCHA GENERATION — PART 7: encrypt (same RC4-like cipher, different key)
// ============================================================================

const encryptKey = '3e627e1b4c63f913';

// plaintext: Uint8Array/Buffer, or a string (encoded as UTF-8, matching the
// ASCII base64 input the Go caller passes). Returns base64.
export function encrypt(plaintext) {
    const o = typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext;
    return base64Encode(argStreamCipher(o, encryptKey));
}

// ============================================================================
// ZLIB COMPRESS — Go: zlibCompress with pooled writer (pools omitted).
// Go's zlib.DefaultCompression and Node's Z_DEFAULT_COMPRESSION both map to
// level 6; the byte streams may differ between implementations but both are
// valid zlib and decode identically.
// ============================================================================

export function zlibCompress(data) {
    return deflateSync(data);
}

// ============================================================================
// MOUSE TRACK — TrackList/Track payload (types.go:105-122).
// The Go original generates an empty track: every TrackList string field
// stays "" and only the timestamps are set. Key insertion order below
// matches Go's struct field order exactly (JSON.stringify preserves it):
//   TrackList: fi, ks, mc, mp, mu, startTime, tc, te, tmv
//   Track:     TrackList, TrackStartTime, VerifyTime, arg
// ============================================================================

export function buildTrackJSON(certifyID, ct = currentTimeMillis()) {
    const track = {
        TrackList: {
            fi: '',
            ks: '',
            mc: '',
            mp: '',
            mu: '',
            startTime: ct,
            tc: '',
            te: '',
            tmv: '',
        },
        TrackStartTime: ct,
        VerifyTime: ct + 300,
        arg: generateArg(certifyID),
    };
    return jsonMarshal(track);
}

// ============================================================================
// CAPTCHA GENERATION — PART 8: VerifyCaptchaV3
// ============================================================================

// Go: verifyCaptcha(certifyID, dataValue, deviceToken) (string, error).
// Returns the base64 FinalPayload, or '' when verification failed
// (Go logs the reason and returns "", nil).
export async function verifyCaptcha(certifyID, dataValue, deviceToken) {
    // CVP (types.go:82-87) — JSON keys verbatim: certifyId/data/deviceToken/sceneId
    const cvpJSON = jsonMarshal({
        certifyId: certifyID,
        data: dataValue,
        deviceToken,
        sceneId: sceneID,
    });

    const params = {
        AccessKeyId: accessKey,
        Action: 'VerifyCaptchaV3',
        Format: 'JSON',
        SignatureMethod: 'HMAC-SHA1',
        SignatureVersion: '1.0',
        Timestamp: getTimestampUTC(),
        Version: '2023-03-05',
        SceneId: sceneID,
        CertifyId: certifyID,
        CaptchaVerifyParam: cvpJSON,
        SignatureNonce: generateUUID(),
    };
    params.Signature = generateSignature(params, secretKey);

    const body = buildQueryString(params);
    const resp = await httpPost(
        'https://no8xfe-verify.captcha-open-southeast.aliyuncs.com/',
        body, { Referer: '' });

    // VerifyCaptchaResponse (types.go:89-96): Success, Result.VerifyResult,
    // Result.securityToken, Result.certifyId — missing fields unmarshal to
    // Go zero values, mirrored by the ?? fallbacks below.
    let respJSON;
    try {
        respJSON = JSON.parse(resp);
    } catch (err) {
        throw new Error(`parse VerifyCaptchaV3 response: ${err.message}`);
    }
    const success = respJSON.Success ?? false;
    const vResult = respJSON.Result ?? {};
    const verifyResult = vResult.VerifyResult ?? false;

    if (success && verifyResult) {
        const st = vResult.securityToken ?? '';
        const ci = vResult.certifyId ?? '';
        if (st !== '' && ci !== '') {
            // FinalPayload (types.go:98-103)
            const fpJSON = jsonMarshal({
                certifyId: ci,
                isSign: true,
                sceneId: sceneID,
                securityToken: st,
            });
            return base64Encode(fpJSON);
        }
        logError('VerifyCaptchaV3 succeeded but securityToken/certifyId empty for deviceToken=' + deviceToken);
    } else if (success) {
        logError('deviceToken failed verification (VerifyResult=false): ' + deviceToken);
    } else {
        logError('VerifyCaptchaV3 request unsuccessful for deviceToken=' + deviceToken + ' response=' + resp);
    }
    return '';
}

// ============================================================================
// COMPUTE FINAL PAYLOAD — tries tokens until success or exhausted
// ============================================================================

export async function computeFinalPayload() {
    for (let attempt = 0; attempt < maxTokenRetries; attempt++) {
        const deviceToken = getNextToken();
        if (deviceToken === null) {
            logError(`No device tokens remaining (attempt ${attempt + 1}/${maxTokenRetries})`);
            return '';
        }
        logInfo(`Attempt ${attempt + 1}/${maxTokenRetries} using deviceToken=${deviceToken}`);

        try {
            const payload = await tryCompute(deviceToken);
            if (payload !== '') {
                return payload;
            }
            logError('deviceToken=' + deviceToken + ' produced empty payload, retrying');
        } catch (err) {
            logError(`Attempt ${attempt + 1} failed for deviceToken=${deviceToken}: ${err.message}`);
        }
    }
    logError(`All ${maxTokenRetries} token retries exhausted`);
    return '';
}

export async function tryCompute(deviceToken) {
    let certifyID;
    try {
        certifyID = await initCaptcha();
    } catch (err) {
        removeToken(deviceToken);
        throw new Error(`initCaptcha: ${err.message}`);
    }

    const ct = currentTimeMillis();
    const json = buildTrackJSON(certifyID, ct);

    const h = aliHash(json, '0000');
    const combined = h + json;
    const compressed = zlibCompress(Buffer.from(combined, 'utf8'));
    const fb64 = base64Encode(compressed);
    const finalVal = encrypt(fb64);

    // Always remove token after use — prevents conflicts
    removeToken(deviceToken);

    let payload;
    try {
        payload = await verifyCaptcha(certifyID, finalVal, deviceToken);
    } catch (err) {
        throw new Error(`verifyCaptcha: ${err.message}`);
    }
    return payload;
}

// ============================================================================
// CAPTCHA CACHE — Background async generation for speed
// Go: CaptchaCache with sync.Mutex (omitted — single-threaded event loop).
// generatedAt is a ms epoch number (Go: time.Time).
// ============================================================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// captchaCredentialsMissing reports whether the Aliyun signing credentials
// are absent. Only the chat path needs them; health/status/model listing do
// not, so a missing pair must not take the whole bridge down.
export function captchaCredentialsMissing() {
    return accessKey === '' || secretKey === '';
}

export class CaptchaCache {
    constructor() {
        this.params = []; // [{ value, generatedAt }]
        this.maxParams = 2;
        this.generating = 0;
        this.active = false;
        this.lastActive = Date.now();
    }

    markActive() {
        this.lastActive = Date.now();
        this.active = true;
    }

    // Go: Get() (string, bool) -> value string or null. Sweeps entries older
    // than the 75s TTL first.
    get() {
        this.markActive();
        const now = Date.now();
        this.params = this.params.filter((p) => now - p.generatedAt < 75_000);
        if (this.params.length > 0) {
            return this.params.shift().value;
        }
        return null;
    }

    // Go: Run() — 2s initial delay, then a 500ms ticker. Pass an
    // AbortSignal to stop the loop (Go runs it forever).
    async run(signal) {
        // Wait a moment before starting to allow session to init
        await sleep(2000);

        while (!signal?.aborted) {
            // Without credentials there is nothing to generate — skip the
            // tick entirely instead of retrying (and logging) every 500ms.
            if (captchaCredentialsMissing()) {
                await sleep(500);
                continue;
            }

            // If no activity in the last 3 minutes, pause generation to
            // save tokens
            if (Date.now() - this.lastActive > 3 * 60_000) {
                this.active = false;
            } else {
                this.active = true;

                // Sweep expired
                const now = Date.now();
                this.params = this.params.filter((p) => now - p.generatedAt < 75_000);

                const needed = this.maxParams - this.params.length - this.generating;
                if (needed > 0) {
                    this.generating += needed;
                    // Launch generation in parallel (Go: go c.generate())
                    for (let k = 0; k < needed; k++) {
                        this.generate().catch((err) => {
                            logError(`[Captcha Cache] generate error: ${err.message}`);
                        });
                    }
                }
            }
            await sleep(500);
        }
    }

    async generate() {
        const startedAt = Date.now();
        try {
            const payload = await computeFinalPayload();
            if (payload !== '') {
                this.params.push({ value: payload, generatedAt: Date.now() });
                const secs = (Date.now() - startedAt) / 1000;
                logInfo(`[Captcha Cache] ✓ generated param in ${secs.toFixed(1)}s (cache size: ${this.params.length})`);
            } else {
                logError('[Captcha Cache] ✗ failed to generate param');
            }
        } finally {
            this.generating--;
        }
    }
}

export const captchaCache = new CaptchaCache();

// Test hook (Go: testhooks.go SeedCaptchaParam) — pushes a ready-made
// captcha_verify_param into the cache so tests can bypass the Aliyun
// captcha machinery.
export function seedCaptchaParam(value) {
    captchaCache.params.push({ value, generatedAt: Date.now() });
}

// ============================================================================
// CAPTCHA VERIFICATION PARAM — IN-MEMORY (no FIFO / named pipe)
// ============================================================================

// Test seam (testhooks.go: OverrideCaptchaParam). When set, the generator is
// bypassed entirely — no Aliyun call, no cache — so integration tests can run
// the non-agent path against a mock upstream.
let captchaParamOverride = '';

export function setCaptchaParamOverrideForTests(value) {
    const prev = captchaParamOverride;
    captchaParamOverride = value;
    return () => { captchaParamOverride = prev; };
}

export async function getCaptchaVerifyParam() {
    if (captchaParamOverride !== '') return captchaParamOverride;

    if (config.agentMode) {
        const val = captchaCache.get();
        if (val !== null) {
            logInfo('[Captcha Cache] hit - using cached param');
            return val;
        }
        logInfo('[Captcha Cache] miss - generating synchronously');
    }

    // The captcha param is signed with the Aliyun AccessKey pair, so without
    // them the chat path cannot work. Fail here — at the request boundary —
    // with an actionable message instead of an opaque signature error from
    // the upstream API. A cached param above never reaches this point: it was
    // already signed when it was generated.
    if (captchaCredentialsMissing()) {
        throw new Error(
            'Aliyun captcha credentials are not configured: set ' +
            'ALIYUN_CAPTCHA_ACCESS_KEY_ID and ALIYUN_CAPTCHA_ACCESS_KEY_SECRET ' +
            '(see .env.example).');
    }

    const startedAt = Date.now();
    console.error('[Captcha] → computing CaptchaVerifyParam (in-memory IPC)');

    // Go runs computeFinalPayload in a goroutine and selects on a 90s
    // timer; on timeout the goroutine keeps running. Promise.race mirrors
    // that (the compute promise is not cancelled).
    const compute = (async () => {
        const payload = await computeFinalPayload();
        if (payload === '') {
            throw new Error('captcha generation returned empty payload');
        }
        return payload;
    })();
    // Swallow a late rejection if the timeout wins the race.
    compute.catch(() => {});

    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('captcha generation timeout after 90s')), 90_000);
    });

    try {
        const val = await Promise.race([compute, timeout]);
        const elapsed = (Date.now() - startedAt) / 1000;
        console.error(`[Captcha] ✓ got ${Buffer.byteLength(val)}b in ${elapsed.toFixed(1)}s`);
        return val;
    } catch (err) {
        const elapsed = (Date.now() - startedAt) / 1000;
        if (err.message === 'captcha generation timeout after 90s') {
            console.error(`[Captcha] ✗ timeout after ${elapsed.toFixed(1)}s`);
        } else {
            console.error(`[Captcha] ✗ error: ${err.message}`);
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}
