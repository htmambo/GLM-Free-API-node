// Port of internal/zbridge/db.go — the hot-swappable token database.
//
// The active SQLite handle lives behind a small holder so POST /sqlite can
// swap it without a restart: the candidate file is validated on a private
// connection first, swapped in with a single pointer exchange, and the old
// handle is closed once its in-flight queries drain. Requests arriving during
// a swap see either the old or the new database — never an error.
//
// Go -> JS mapping:
//   - sync.RWMutex + inflight map + sync.Cond -> single-threaded event loop.
//     node:sqlite queries are synchronous, so a handle cannot be observed
//     mid-query; release() still tracks the count and the old handle is
//     closed when it reaches zero.
//   - swapGate chan struct{} (buffered 1) -> a boolean; a concurrent swap is
//     rejected with the same retryable error.
//   - sql.Open + Ping -> new DatabaseSync + a trivial SELECT.
//   - os.Stat / mode 0400 -> fs.statSync / accessSync(R_OK).

import { existsSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

export const ERR_DB_UNAVAILABLE = 'no active sqlite database';

const defaultTokenCountTTL = 5000;

function parseCountTTL() {
    const raw = process.env.TOKEN_COUNT_TTL_MS;
    if (raw === undefined || raw === '') return defaultTokenCountTTL;
    if (!/^[+-]?\d+$/.test(raw)) return defaultTokenCountTTL;
    const n = Number(raw);
    return Number.isSafeInteger(n) && n > 0 ? n : defaultTokenCountTTL;
}

let tokenCountCacheTTL = parseCountTTL();

export function setTokenCountTTLForTests(ms) {
    tokenCountCacheTTL = ms;
}

const state = {
    active: null, // { db, path } | null
    inflight: new Map(), // DatabaseSync -> count
    swapping: false,
    count: -1, // -1 = unknown/unavailable
    countAt: 0,
    countPath: '',
    swaps: 0,
};

// ---------------------------------------------------------------------------
// OPEN / VALIDATE / ATTACH
// ---------------------------------------------------------------------------

function openTokenDB(path) {
    const db = new DatabaseSync(path);
    // Force a real connection now so a corrupt file fails here, not on the
    // first query.
    db.prepare('SELECT 1').get();
    return db;
}

// validateTokenDB runs the rejection ladder on a private short-lived
// connection; it never touches the active database.
export function validateTokenDB(path) {
    if (!path) throw new Error('db_path is empty');
    let st;
    try {
        st = statSync(path);
    } catch (err) {
        throw new Error(`database file not accessible: ${err.message}`);
    }
    if (st.isDirectory()) throw new Error(`db_path is a directory, not a file: ${path}`);
    try {
        accessSync(path, fsConstants.R_OK);
    } catch {
        throw new Error(`database file is not readable: ${path}`);
    }

    let db;
    try {
        db = openTokenDB(path);
    } catch (err) {
        throw new Error(`not a valid SQLite database: ${err.message}`);
    }
    try {
        const table = db.prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='tokens';",
        ).get();
        if (table === undefined) throw new Error("schema mismatch: table 'tokens' not found");
        const col = db.prepare(
            "SELECT COUNT(*) AS n FROM pragma_table_info('tokens') WHERE name = 'token';",
        ).get();
        if (!col || Number(col.n) === 0) {
            throw new Error("schema mismatch: table 'tokens' has no 'token' column");
        }
    } catch (err) {
        const msg = err.message;
        if (msg.startsWith('schema mismatch')) throw err;
        throw new Error(`schema check failed: ${msg}`);
    } finally {
        try { db.close(); } catch { /* already closed */ }
    }
}

function invalidateTokenCount() {
    state.count = -1;
    state.countAt = 0;
    state.countPath = '';
}

// attachDB installs db without validation (startup / tests). The previous
// handle is drained in the background.
function attachDB(db, path) {
    const old = state.active;
    state.active = { db, path };
    invalidateTokenCount();
    if (old && old.db !== db) {
        drainAndClose(old.db).catch(() => { /* best effort */ });
    }
}

async function drainAndClose(db) {
    // Wait for the last in-flight query to finish. Queries are synchronous
    // here, so this only matters if a caller held a handle across an await.
    for (;;) {
        const n = state.inflight.get(db) ?? 0;
        if (n <= 0) break;
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    state.inflight.delete(db);
    try { db.close(); } catch { /* already closed */ }
}

// acquireDB captures the active handle and registers an in-flight query.
export function acquireDB() {
    const h = state.active;
    if (!h || !h.db) throw new Error(ERR_DB_UNAVAILABLE);
    state.inflight.set(h.db, (state.inflight.get(h.db) ?? 0) + 1);
    let released = false;
    const release = () => {
        if (released) return;
        released = true;
        const n = (state.inflight.get(h.db) ?? 1) - 1;
        if (n <= 0) state.inflight.delete(h.db);
        else state.inflight.set(h.db, n);
    };
    return { handle: h, release };
}

// withTokenDB is the bridge's only read entry point: acquire, run fn without
// holding a lock, release.
export function withTokenDB(fn) {
    const { handle, release } = acquireDB();
    try {
        return fn(handle);
    } finally {
        release();
    }
}

// ---------------------------------------------------------------------------
// TOKEN COUNT (TTL cached, -1 = unavailable)
// ---------------------------------------------------------------------------

export function tokenCount() {
    const h = state.active;
    const fresh = h && h.db && state.countAt !== 0 &&
        Date.now() - state.countAt < tokenCountCacheTTL &&
        state.countPath === h.path && state.count >= 0;
    if (fresh) return state.count;
    if (!h || !h.db) return -1;

    let n;
    try {
        const { handle, release } = acquireDB();
        try {
            const row = handle.db.prepare('SELECT COUNT(*) AS n FROM tokens;').get();
            n = Number(row.n);
        } finally {
            release();
        }
    } catch {
        return -1;
    }
    state.count = n;
    state.countAt = Date.now();
    state.countPath = h.path;
    return n;
}

// ---------------------------------------------------------------------------
// STARTUP / SHUTDOWN / SWAP
// ---------------------------------------------------------------------------

export function initDB(path) {
    if (!existsSync(path)) {
        throw new Error(`Captcha db not found: ${path} (run the token collector first)`);
    }
    const db = openTokenDB(path);
    attachDB(db, path);
}

export async function closeDB() {
    const old = state.active;
    state.active = null;
    invalidateTokenCount();
    if (old && old.db) await drainAndClose(old.db);
}

// swapDB validates and installs newPath. A rejected swap never changes the
// active database.
export async function swapDB(newPath) {
    validateTokenDB(newPath);

    let newDB;
    try {
        newDB = openTokenDB(newPath);
    } catch (err) {
        throw new Error(`failed to open new database: ${err.message}`);
    }

    if (state.swapping) {
        try { newDB.close(); } catch { /* ignore */ }
        throw new Error('a database swap is already in progress — retry shortly');
    }
    state.swapping = true;
    try {
        const old = state.active;
        state.active = { db: newDB, path: newPath };
        state.swaps++;
        invalidateTokenCount();
        const previous = old ? old.path : '';
        console.error(`[DB Swap] active database is now ${newPath} (previous: ${previous})`);
        if (old && old.db) await drainAndClose(old.db);
    } finally {
        state.swapping = false;
    }
}

// Test hooks mirroring testhooks.go.
export function activeDBPath() {
    return state.active ? state.active.path : '';
}

export function attachDatabaseForTests(db, path) {
    attachDB(db, path);
}

export function detachDatabaseForTests() {
    return closeDB();
}
