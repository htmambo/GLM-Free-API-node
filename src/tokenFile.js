// Runtime reload of the Z.AI session token from a file written by an external
// refresher (cmd/zai-token-refresher).
//
// A bare bearer token cannot be renewed upstream (see README "ZAI_TOKEN 过期了
// 怎么办"), so renewal happens inside a browser that still holds the site's
// login cookies; that browser writes the token it reads from localStorage and
// this module makes the bridge pick it up without a restart.
//
// ZAI_TOKEN_FILE is read at startup (run()) and again whenever a chat request
// is rejected with 401. A missing, empty, malformed or expired file never
// replaces a still-valid token.

import { readFileSync, statSync } from 'node:fs';
import { config } from './config.js';
import { logInfo } from './logger.js';

// Cached file identity. Atomic writes (tmp + rename) always change mtimeMs,
// so a matching pair means "unchanged" unless the caller forces a read.
let lastMtimeMs = -1;
let lastSize = -1;
// Last warning reason, so a permanently broken file is reported once instead
// of on every request.
let warnedFor = '';

function warnOnce(reason, msg) {
    if (warnedFor === reason) return;
    warnedFor = reason;
    // console.error, not logError: a broken token file is an operator problem
    // that must be visible without --verbose.
    console.error(msg);
}

// tokenUsable reports whether the string is a JWT whose exp has not passed.
// A missing exp is accepted (the upstream is then the judge); an unparseable
// payload is rejected.
function tokenUsable(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (typeof payload.exp !== 'number') return true;
        return payload.exp * 1000 > Date.now();
    } catch {
        return false;
    }
}

// reloadTokenFromFile re-reads ZAI_TOKEN_FILE and, when it yields a usable
// token that differs from the active one, swaps it into config.zaiToken.
// Returns true only when the token actually changed.
export function reloadTokenFromFile({ force = false } = {}) {
    const path = config.zaiTokenFile;
    if (path === '') return false;

    let st;
    try {
        st = statSync(path);
    } catch (err) {
        warnOnce('missing', `[TokenFile] cannot stat ${path}: ${err.message}`);
        return false;
    }
    if (!force && st.mtimeMs === lastMtimeMs && st.size === lastSize) return false;
    lastMtimeMs = st.mtimeMs;
    lastSize = st.size;

    let raw;
    try {
        raw = readFileSync(path, 'utf8');
    } catch (err) {
        console.error(`[TokenFile] cannot read ${path}: ${err.message}`);
        return false;
    }

    const token = raw.trim();
    if (token === '') {
        warnOnce('empty', `[TokenFile] ${path} is empty — keeping the current token`);
        return false;
    }
    if (!tokenUsable(token)) {
        warnOnce('invalid',
            `[TokenFile] ${path} does not contain a usable JWT (malformed or expired) — ` +
            'keeping the current token');
        return false;
    }
    if (token === config.zaiToken) {
        warnedFor = '';
        return false;
    }

    config.zaiToken = token;
    warnedFor = '';
    logInfo(`[TokenFile] loaded Z.AI token from ${path}`);
    return true;
}
