// Port of cmd/token-collector/feilin.go — FeiLin / Aliyun-SAF device-token
// primitives.
//
// The device token the bridge consumes is NOT minted in the browser any more:
// the browser is used exactly once, briefly, to obtain a *trusted* device
// session plus the genuine collector payload template; every token is then
// produced in-process by assembling the payload and AES-sealing it.
//
//   token = base64( tF # Q # w # tC # p )
//     tF = region prefix        ("SG_WEB")
//     Q  = device sessionId     ("<appKey>-h-<serverTs-1>-<32 hex>")
//     w  = base64( AES-128-CBC(sessionKey, IV, PKCS7("#".join(payload))) )
//     tC = GatherCost (ms)
//     p  = MD5( tF # Q # w # tC # "daye,raolewoba!" )

import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';

// ---------- protocol constants ----------

// The ONE IV used everywhere: the UTF-8 bytes of "0123456789ABCDEF"
// (NOT hex-decoded).
export const AES_IV = Buffer.from('0123456789ABCDEF', 'utf8');
// Decrypts the DeviceConfig blob returned by the device service.
export const RES_KEY = '87f879f135f27da7';
// Seals the token (field p).
export const MD5_SECRET = 'daye,raolewoba!';
// tF field for the ap-southeast endpoints.
export const REGION_PREFIX = 'SG_WEB';
// Z.AI captcha scene.
//
// The web client picks the scene by hostname (verified in the prod bundle):
// chat.z.ai -> "didk33e0", any other host (e.g. zchat.z.ai) -> "xswyjefn".
// The collector therefore derives it from ZAI_BASE_URL so that a mainland
// deployment harvests device tokens for the scene it actually uses.
export const SCENE_ID = (() => {
    const override = (process.env.ALIYUN_CAPTCHA_SCENE_ID || '').trim();
    if (override !== '') return override;
    const base = (process.env.ZAI_BASE_URL || 'https://chat.z.ai').trim().replace(/\/+$/, '');
    let host = '';
    try {
        host = new URL(base).hostname;
    } catch {
        host = '';
    }
    return host === 'chat.z.ai' ? 'didk33e0' : 'xswyjefn';
})();

// ---------- AES-128-CBC (PKCS7) ----------

function keyBytes(key) {
    const b = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
    return b.subarray(0, 16);
}

export function aesCBCEncrypt(key, plaintext) {
    const k = keyBytes(key);
    const pt = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8');
    const padLen = 16 - (pt.length % 16);
    const padded = Buffer.concat([pt, Buffer.alloc(padLen, padLen)]);
    const cipher = createCipheriv('aes-128-cbc', k, AES_IV);
    cipher.setAutoPadding(false);
    return Buffer.concat([cipher.update(padded), cipher.final()]);
}

export function aesCBCDecrypt(key, ciphertext) {
    const k = keyBytes(key);
    const ct = Buffer.isBuffer(ciphertext) ? ciphertext : Buffer.from(ciphertext);
    if (ct.length === 0 || ct.length % 16 !== 0) {
        throw new Error('ciphertext is not a whole number of AES blocks');
    }
    const decipher = createDecipheriv('aes-128-cbc', k, AES_IV);
    decipher.setAutoPadding(false);
    const out = Buffer.concat([decipher.update(ct), decipher.final()]);
    const padLen = out[out.length - 1];
    if (padLen < 1 || padLen > 16 || padLen > out.length) throw new Error('bad PKCS7 padding');
    for (const b of out.subarray(out.length - padLen)) {
        if (b !== padLen) throw new Error('bad PKCS7 padding');
    }
    return out.subarray(0, out.length - padLen);
}

export function encryptB64(key, plaintext) {
    return aesCBCEncrypt(key, plaintext).toString('base64');
}

export function decryptB64(key, b64) {
    return aesCBCDecrypt(key, Buffer.from(b64, 'base64')).toString('utf8');
}

// ---------- the device session ----------

// decryptDeviceConfig parses the DeviceConfig blob:
//   f[0] base64(sessionKey)  f[1] "1"  f[2] sessionId
//   f[3] feilin version      f[7] serverTs  f[8] ip
export function decryptDeviceConfig(blob) {
    const plain = decryptB64(RES_KEY, blob);
    const f = plain.split('#');
    if (f.length < 9) throw new Error(`DeviceConfig has ${f.length} fields, expected >= 9`);

    let sessionKey;
    try {
        sessionKey = Buffer.from(f[0], 'base64').toString('utf8');
    } catch (err) {
        throw new Error(`DeviceConfig sessionKey: ${err.message}`);
    }
    const serverTs = Number.parseInt(f[7], 10);
    return {
        sessionKey,
        sessionId: f[2],
        serverTs: Number.isFinite(serverTs) ? serverTs : 0,
        // Live gap; the SDK derives it the same way.
        initTime: (Number.isFinite(serverTs) ? serverTs : 0) - 6606,
        ip: f[8],
        region: REGION_PREFIX,
        gatherCost: '0',
    };
}

export function timeNowMillis() {
    return Date.now();
}

// ---------- the payload template ----------

// Field indices of the per-session / per-token values inside the payload. The
// map is stable across the captured SDK builds (140, 111, 155 fields).
export const IDX_IP = 42;
export const IDX_LOG = 43;
export const IDX_INIT_TIME = 72;
export const IDX_NOW = 74;
export const IDX_SERVER_TS = 87;
export const LOG_ENTRY_93 = '93';
export const LOG_ENTRY_94 = '94';
export const IDX_EMPTY_93 = 93;
export const IDX_EMPTY_94 = 94;
export const MAX_LOG_JITTER = 15;

export function newPayloadTemplate(fields) {
    if (!Array.isArray(fields) || fields.length < 90) {
        throw new Error(`payload template has ${fields?.length ?? 0} fields, expected >= 90`);
    }
    return { fields: [...fields] };
}

// build refreshes the per-session and per-token values for one token.
export function buildPayload(tpl, session, nowMs, jitterMs) {
    const f = [...tpl.fields];
    if (f.length <= IDX_SERVER_TS) throw new Error(`payload template too short (${f.length} fields)`);

    // per-session
    f[IDX_IP] = session.ip;
    f[IDX_SERVER_TS] = String(session.serverTs);
    f[IDX_INIT_TIME] = String(session.initTime);

    // per-token
    f[IDX_NOW] = String(nowMs);

    // probe log: the trailing 93/94 entries are defined by (now - initTime)
    const entries = String(f[IDX_LOG]).split('|');
    if (entries.length < 2) throw new Error('payload field 43 has no log entries');
    const last = entries[entries.length - 1];
    const prev = entries[entries.length - 2];
    if (!prev.startsWith(LOG_ENTRY_93 + '-') || !last.startsWith(LOG_ENTRY_94 + '-')) {
        throw new Error(`payload field 43 must end with log entries 93/94, got ${JSON.stringify(prev)}/${JSON.stringify(last)}`);
    }
    if (jitterMs <= 0) {
        // keep the template's observed delta (entry94 cost - entry93 cost)
        const d94 = Number.parseInt(last.split('-')[1], 10);
        const d93 = Number.parseInt(prev.split('-')[1], 10);
        if (!Number.isFinite(d94) || !Number.isFinite(d93)) {
            throw new Error(`payload field 43: bad 93/94 entries: ${JSON.stringify(prev)}/${JSON.stringify(last)}`);
        }
        jitterMs = d94 - d93;
    }
    if (jitterMs < 1 || jitterMs > MAX_LOG_JITTER) jitterMs = 9;

    const cost = nowMs - session.initTime;
    if (cost < 0) throw new Error(`mint time ${nowMs} is before initTime ${session.initTime}`);
    entries[entries.length - 2] = LOG_ENTRY_93 + '-' + cost;
    entries[entries.length - 1] = LOG_ENTRY_94 + '-' + (cost + jitterMs);
    f[IDX_LOG] = entries.join('|');

    // the payload's own 93/94 slots stay empty (the log entries live in 43)
    if (f.length > IDX_EMPTY_94) {
        f[IDX_EMPTY_93] = '';
        f[IDX_EMPTY_94] = '';
    }
    return f;
}

// ---------- token assembly ----------

export function assembleToken(session, fields) {
    const w = encryptB64(session.sessionKey, fields.join('#'));
    const tC = session.gatherCost;
    const seal = createHash('md5')
        .update([session.region, session.sessionId, w, tC, MD5_SECRET].join('#'), 'utf8')
        .digest('hex');
    return Buffer.from([session.region, session.sessionId, w, tC, seal].join('#'), 'utf8').toString('base64');
}

// mintTokens produces n distinct tokens bound to one device session. They
// differ only in field 74 and the trailing probe-log entries — exactly what
// the SDK does for a second token on the same session.
export function mintTokens(session, tpl, n, jitterMs = 0) {
    if (n <= 0) throw new Error('token count must be > 0');
    const out = [];
    // The probe log is monotonic: the first token must not predate the
    // collector's last fixed probe cost.
    let start = timeNowMillis();
    const fixed = maxFixedLogCost(tpl.fields);
    if (session.initTime > 0) {
        const minStart = session.initTime + fixed;
        if (start < minStart) start = minStart;
    }
    for (let i = 0; i < n; i++) {
        const now = start + i;
        out.push(assembleToken(session, buildPayload(tpl, session, now, jitterMs)));
    }
    return out;
}

// maxFixedLogCost returns the largest probe-log cost among the template's
// fixed entries (everything before the trailing 93/94 pair).
export function maxFixedLogCost(fields) {
    if (fields.length <= IDX_LOG) return 0;
    const entries = String(fields[IDX_LOG]).split('|');
    if (entries.length < 2) return 0;
    let max = 0;
    for (const e of entries.slice(0, -2)) {
        const c = Number.parseInt(e.split('-')[1], 10);
        if (Number.isFinite(c) && c > max) max = c;
    }
    return max;
}

// verifyToken decodes a device token and checks the MD5 seal.
export function verifyToken(token, sessionKey) {
    let raw;
    try {
        raw = Buffer.from(token, 'base64').toString('utf8');
    } catch (err) {
        throw new Error(`token is not base64: ${err.message}`);
    }
    const parts = raw.split('#');
    if (parts.length !== 5) throw new Error(`token has ${parts.length} fields, expected 5`);
    const [tF, Q, w, tC, p] = parts;
    const seal = createHash('md5').update([tF, Q, w, tC, MD5_SECRET].join('#'), 'utf8').digest('hex');
    if (seal !== p) throw new Error('md5 seal mismatch');
    return decryptB64(sessionKey, w).split('#');
}
