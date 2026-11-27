// Port of internal/zbridge/session_pool.go — throwaway chat sessions +
// async session pool (see the Go file header for the full rationale:
// context rot, account accumulation, sync/async modes, graceful shutdown).
//
// Go -> JS mapping:
//   - goroutine + wg            -> tracked promises in _pendingOps
//   - ready chan string         -> readyQueue array + FIFO waiters queue
//   - stopCh / atomic.Bool / sync.Once -> stopped boolean + _stopNotify list;
//     shutdown() is idempotent
//   - context.Context           -> AbortSignal (callers pass one or nothing)
//   - errors.Is(err, Err...)    -> identity compare (err === ErrPoolTimeout)
//   - log.Printf                -> logInfo (warnings: logError); the
//     config.Logging.Level == "debug" gated prints -> logDebug. Note the
//     logger is silent unless verbose is enabled (see logger.js), unlike
//     Go's unconditional log.Printf.
//   - Go Acquire/Release/gcSessions spawn fire-and-forget goroutines; here
//     the equivalent async work is fire-and-forget too (errors are caught
//     and logged inside, never propagated).
//
// SessionBackend interface (Go): CreateChatSession(ctx) / DeleteChatSession(ctx, ids...)
// JS equivalent: { createChatSession(signal), deleteChatSession(signal, ...ids) }.
// Tests inject a stub; production uses newZAIChatBackend().
//
// Dependency on zai.js (later phase): deleteZAIChat needs initializeSession
// for the re-auth path. It is loaded via a LAZY dynamic import so this module
// loads fine before zai.js exists — do not move it to a top-level import.

import {
    BASE_URL,
    defaultPoolSize,
    defaultPoolWaitSec,
    defaultSessionReuse,
    config,
    zaiUserAgent,
} from './config.js';
import { session } from './state.js';
import { checkWAF } from './waf.js';
import { randomUUID } from './util.js';
import { logInfo, logError, logDebug } from './logger.js';
import { zaiFetch } from './httpClient.js';

export const ErrPoolClosing = new Error('session pool is shutting down');
export const ErrPoolTimeout = new Error('timed out waiting for a pooled session');

// Go time.Duration constants, in milliseconds.
export const poolOpTimeout = 30 * 1000;
export const poolCreateBackoffStart = 1 * 1000;
export const poolCreateBackoffMax = 15 * 1000;
export const poolDrainWait = 20 * 1000;

// Equivalent of ctx.Err(): the signal's reason if it is an Error, else an
// AbortError (mirrors what fetch rejects with).
function abortError(signal) {
    if (signal && signal.reason instanceof Error) return signal.reason;
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return err;
}

// ============================================================================
// Z.AI CHAT DELETE (Go: DeleteZAIChat)
// ============================================================================

// Deletes one chat from the Z.AI account so its history does not accumulate:
//   DELETE {BASE_URL}/api/v1/chats/{chatID}   (authorization: Bearer <token>)
//     200 "true"                                            -> deleted
//     404 / {"detail":"We could not find what you're ..."}  -> already gone
//     401                                                   -> re-init + retry once
// Deletion is idempotent: an "already gone" reply counts as success.
export async function deleteZAIChat(chatID, signal) {
    if (!chatID) return;

    // While the IP is blocked, DELETE hits the block page too: pointless
    // upstream traffic that keeps the block alive. The chat ID is a
    // client-generated UUID that never materialized, so skipping is harmless.
    const { err: wafErr } = checkWAF();
    if (wafErr !== null) {
        throw new Error(`chat delete skipped: ${wafErr}`);
    }

    for (let attempt = 0; attempt < 2; attempt++) {
        const token = session.token;
        const initialized = session.initialized;
        const feVersion = session.feVersion;

        if (!token || !initialized) {
            // Own context: the triggering request may already be gone.
            try {
                const { initializeSession } = await import('./zai.js');
                await initializeSession();
            } catch (err) {
                throw new Error(`session init for chat delete: ${err.message}`);
            }
            continue; // re-read the fresh token
        }

        const urlStr = `${BASE_URL}/api/v1/chats/${chatID}`;
        logDebug(`Z.AI chat delete: DELETE ${urlStr}`);

        let resp;
        try {
            resp = await zaiFetch(urlStr, {
                method: 'DELETE',
                headers: {
                    'authorization': `Bearer ${token}`,
                    'User-Agent': zaiUserAgent,
                    'content-type': 'application/json',
                    'x-fe-Version': feVersion,
                },
                signal,
            });
        } catch (err) {
            const cause = err?.cause?.code || err?.cause?.message || '';
            throw new Error(`Z.AI chat delete connection error: ${err.message}${cause ? ` (${cause})` : ''}`);
        }
        const text = (await resp.text()).trim();
        logDebug(`Z.AI chat delete response: ${resp.status} ${text}`);

        if (resp.status === 401) {
            // Token expired mid-flight: force re-init and retry once.
            session.initialized = false;
            continue;
        }
        if (resp.status === 404 || text.includes('could not find')) {
            return; // already gone — nothing left to collect
        }
        if (resp.status >= 200 && resp.status < 300) {
            return; // "true" (or any 2xx) — deleted
        }
        throw new Error(`Z.AI chat delete failed: ${resp.status}: ${text}`);
    }
    throw new Error('chat delete: max retries exceeded');
}

// ============================================================================
// PRODUCTION BACKEND (Go: zaiSessionBackend / NewZAIChatBackend)
// ============================================================================

// Sessions are client-generated chat IDs, deleted via DELETE
// /api/v1/chats/{id}. Creation never touches the network: a Z.AI chat only
// materializes server-side when a completion first references its ID.
export function newZAIChatBackend() {
    return {
        async createChatSession(signal) {
            if (signal?.aborted) throw abortError(signal);
            return randomUUID();
        },
        // Z.AI has no bulk endpoint: delete one by one, best-effort. Every ID
        // is attempted; the first error is rethrown after the rest were tried.
        async deleteChatSession(signal, ...sessionIDs) {
            let firstErr = null;
            for (const id of sessionIDs) {
                if (!id) continue;
                try {
                    await deleteZAIChat(id, signal);
                } catch (err) {
                    if (firstErr === null) firstErr = err;
                }
            }
            if (firstErr !== null) throw firstErr;
        },
    };
}

// ============================================================================
// SESSION POOL (Go: SessionPool)
// ============================================================================

// Holds the standing batch of ready stateless chat sessions. Every
// completion draws a pre-made session; the moment its response has been
// fully processed the consumed session is deleted upstream and a replacement
// refills the batch, so the account never accumulates garbage.
export class SessionPool {
    // backend: { createChatSession(signal), deleteChatSession(signal, ...ids) }
    // size < 1 is clamped to the default batch. Call start() to begin warmup.
    constructor(backend, size) {
        if (size < 1) size = defaultPoolSize;
        this.backend = backend;
        this._size = size;

        this.readyQueue = []; // stocked, unused clean sessions (FIFO)
        this.waiters = [];    // pending acquire() callers (FIFO)

        this.stopped = false;
        this._stopNotify = []; // resolve callbacks fired once on shutdown
        this._pendingOps = new Set(); // outstanding create/delete promises (Go wg)

        // Reuse accounting: one chat serves up to maxUses requests before it
        // is deleted and replaced (defaultSessionReuse unless overridden).
        this.uses = new Map(); // session ID -> completed request count
        this.maxUses = config.sessionReuseCount >= 1
            ? config.sessionReuseCount
            : defaultSessionReuse;
    }

    // Go: SetMaxUses(n). n < 1 restores the live config lookup.
    setMaxUses(n) {
        this.maxUses = n;
    }

    // Go: getMaxUses(). Pool override > live config > built-in default.
    getMaxUses() {
        if (this.maxUses >= 1) return this.maxUses;
        if (config.sessionReuseCount >= 1) return config.sessionReuseCount;
        return defaultSessionReuse;
    }

    // Go: Uses(id) — observation only.
    usesOf(id) {
        return this.uses.get(id) ?? 0;
    }

    // Go: Size()
    size() {
        return this._size;
    }

    // Go: Ready() — how many sessions are currently stocked.
    ready() {
        return this.readyQueue.length;
    }

    // Go: Start() — launches the warmup tasks that pre-make the initial batch.
    start() {
        logInfo(`[Pool] warming up ${this._size} stateless session(s)...`);
        for (let i = 0; i < this._size; i++) {
            this._track(this.fillSlot('warmup'));
        }
    }

    // Track a background operation (Go: wg.Add + go func). Errors are
    // swallowed here; the operations themselves log their own failures.
    _track(promise) {
        const p = Promise.resolve(promise).catch(() => {});
        this._pendingOps.add(p);
        const done = () => this._pendingOps.delete(p);
        p.then(done, done);
        return p;
    }

    // Go: Acquire(ctx, wait). Hands out one ready session, waiting until one
    // is available, the signal aborts, or waitMs elapses (waitMs <= 0 waits
    // indefinitely). The caller MUST eventually call release() with the
    // returned ID — even on error paths.
    acquire(signal, waitMs = 0) {
        if (this.readyQueue.length > 0) {
            const id = this.readyQueue.shift();
            logDebug(`[Pool] handed out session ${id} (${this.readyQueue.length}/${this._size} ready)`);
            return Promise.resolve(id);
        }
        if (this.stopped) return Promise.reject(ErrPoolClosing);
        if (signal?.aborted) return Promise.reject(abortError(signal));

        return new Promise((resolve, reject) => {
            const waiter = { settled: false, resolve, reject, timer: null, onAbort: null };
            waiter.settle = (fn, value) => {
                if (waiter.settled) return;
                waiter.settled = true;
                if (waiter.timer) clearTimeout(waiter.timer);
                if (waiter.onAbort) signal?.removeEventListener('abort', waiter.onAbort);
                const i = this.waiters.indexOf(waiter);
                if (i !== -1) this.waiters.splice(i, 1);
                fn(value);
            };
            if (waitMs > 0) {
                waiter.timer = setTimeout(() => waiter.settle(reject, ErrPoolTimeout), waitMs);
            }
            if (signal) {
                waiter.onAbort = () => waiter.settle(reject, abortError(signal));
                signal.addEventListener('abort', waiter.onAbort, { once: true });
            }
            this.waiters.push(waiter);
        });
    }

    // Go: Release(sessionID). Retires a consumed session: the used session is
    // deleted upstream, then a replacement refills the batch. Both steps run
    // in the background; during shutdown it retires only, no refill.
    release(sessionID) {
        if (!sessionID) return;
        this._track((async () => {
            const max = Math.max(1, this.getMaxUses());
            const used = (this.uses.get(sessionID) ?? 0) + 1;
            this.uses.set(sessionID, used);

            if (used < max) {
                // Reuse: hand the same chat to the next request. No DELETE,
                // no create — this is what makes traffic look human.
                if (this.stopped) {
                    this.uses.delete(sessionID);
                    await this.deleteOne(sessionID, 'shutdown');
                    return;
                }
                this._restock(sessionID, used, max);
                return;
            }

            // Reuse budget exhausted: delete + rotate.
            this.uses.delete(sessionID);
            await this.deleteOne(sessionID, 'used');
            if (this.stopped) return; // shutting down: retire only
            await this.fillSlot('refill');
        })());
    }

    // _restock returns a reused session to the batch (or to the oldest
    // waiter) without going through the create path.
    _restock(id, used, max) {
        while (this.waiters.length > 0) {
            const w = this.waiters[0];
            if (w.settled) {
                this.waiters.shift();
                continue;
            }
            logInfo(`[Pool:reuse] session ${id} reused ${used}/${max} (${this.readyQueue.length}/${this._size} ready)`);
            w.settle(w.resolve, id);
            return;
        }
        this.readyQueue.push(id);
        logInfo(`[Pool:reuse] session ${id} reused ${used}/${max} (${this.readyQueue.length}/${this._size} ready)`);
    }

    // Go: Shutdown(). Gracefully clears the pool (the CTRL+C path): refills
    // stop, every still-pooled session is deleted upstream, and we briefly
    // wait for in-flight retire/refill operations to finish. Idempotent.
    async shutdown() {
        if (this.stopped) return; // Go: stopOnce
        this.stopped = true;

        // Unblock pending acquire() waiters (Go: close(stopCh)).
        for (const w of this.waiters.splice(0)) w.settle(w.reject, ErrPoolClosing);
        // Wake fillSlot backoff sleepers.
        for (const r of this._stopNotify.splice(0)) r();

        // Collect whatever is still stocked and delete it. Z.AI deletion is
        // one call per chat, so the backend walks the leftovers sequentially.
        const leftover = this.readyQueue.splice(0);
        for (const id of leftover) this.uses.delete(id);
        if (leftover.length > 0) {
            logInfo(`[Pool] clearing all remaining sessions (${leftover.length})...`);
            try {
                await this.backend.deleteChatSession(AbortSignal.timeout(poolOpTimeout), ...leftover);
                logInfo(`[Pool] cleared ${leftover.length} pooled session(s): deleted [${leftover.join(' ')}]`);
            } catch (err) {
                logError(`[Pool] warning: failed to clear ${leftover.length} session(s): ${err.message}`);
            }
        } else {
            logInfo('[Pool] clearing all sessions... none remaining');
        }

        // Wait (bounded) for outstanding creates/deletes to wind down. The
        // losing timer is cleared so it cannot keep the event loop alive.
        let drained = false;
        let drainTimer;
        const drainTimeout = new Promise((r) => {
            drainTimer = setTimeout(r, poolDrainWait);
        });
        const drainAll = Promise.all([...this._pendingOps]).then(() => {
            drained = true;
            clearTimeout(drainTimer);
        });
        await Promise.race([drainAll, drainTimeout]);
        if (drained) {
            logInfo('[Pool] all sessions accounted for');
        } else {
            logError(`[Pool] warning: some background session operations did not finish within ${poolDrainWait}ms`);
        }
    }

    _waitStop() {
        if (this.stopped) return Promise.resolve();
        return new Promise((resolve) => this._stopNotify.push(resolve));
    }

    // Go: fillSlot(reason). Creates one session (retrying through transient
    // failures) and stocks it, unless shutdown won the race.
    async fillSlot(reason) {
        let backoff = poolCreateBackoffStart;
        let loggedOnce = false;
        for (;;) {
            if (this.stopped) return;
            let id;
            try {
                id = await this.backend.createChatSession(AbortSignal.timeout(poolOpTimeout));
            } catch (err) {
                if (this.stopped) return;
                // Log the first failure loudly; repeats stay quiet so a
                // misconfigured backend doesn't spam the log.
                if (!loggedOnce) {
                    logError(`[Pool:${reason}] session creation failed (${err.message}); retrying...`);
                    loggedOnce = true;
                } else {
                    logDebug(`[Pool:${reason}] session creation failed again (${err.message}); retrying in ${backoff}ms`);
                }
                let backoffTimer;
                await Promise.race([
                    new Promise((r) => {
                        backoffTimer = setTimeout(r, backoff);
                    }),
                    this._waitStop(),
                ]);
                clearTimeout(backoffTimer);
                if (this.stopped) return;
                backoff = Math.min(backoff * 2, poolCreateBackoffMax);
                continue;
            }
            this.stock(id, reason);
            return;
        }
    }

    // Go: stock(id, reason). Puts a freshly created session into the batch
    // (or hands it to the oldest waiting acquirer), or deletes it if shutdown
    // raced in first (never stockpile sessions nobody will consume).
    stock(id, reason) {
        if (this.stopped) {
            this._track(this.deleteOne(id, 'shutdown-race'));
            return;
        }
        while (this.waiters.length > 0) {
            const w = this.waiters[0];
            if (w.settled) {
                this.waiters.shift();
                continue;
            }
            logInfo(`[Pool:${reason}] session ready: ${id} (${this.readyQueue.length}/${this._size}, uses ${this.usesOf(id)}/${this.getMaxUses()})`);
            w.settle(w.resolve, id);
            return;
        }
        this.readyQueue.push(id);
        logInfo(`[Pool:${reason}] session ready: ${id} (${this.readyQueue.length}/${this._size}, uses ${this.usesOf(id)}/${this.getMaxUses()})`);
    }

    // Go: deleteOne(id, reason). Deletes a single session upstream, best-effort.
    async deleteOne(id, reason) {
        try {
            await this.backend.deleteChatSession(AbortSignal.timeout(poolOpTimeout), id);
            logDebug(`[Pool:${reason}] deleted chat session: ${id}`);
        } catch (err) {
            logError(`[Pool:${reason}] warning: failed to delete session ${id}: ${err.message}`);
        }
    }
}

// ============================================================================
// BRIDGE GLUE (Go: session_pool.go bottom half)
// ============================================================================

// sessionPool holds the standing batch of ready throwaway chat sessions.
// null when running in sync mode (SYNC_MODE=true); the legacy per-request
// flow still garbage-collects used sessions. poolWaitMs bounds how long a
// request waits for a pooled session before creating one directly (0 waits
// forever; SESSION_ACQUIRE_TIMEOUT seconds).
let sessionPool = null;
let poolWaitMs = defaultPoolWaitSec * 1000;

// Go: AttachSessionPool(p, wait). Swaps the async session pool (and its
// acquire wait window) and returns a function that restores the previous
// attachment. Passing null detaches the pool (sync legacy flow).
export function attachSessionPool(p, waitMs) {
    const oldPool = sessionPool;
    const oldWait = poolWaitMs;
    sessionPool = p;
    poolWaitMs = waitMs;
    // Both directions reset the sticky session so sync/async modes never
    // leak state into each other.
    resetSyncSticky();
    return () => {
        sessionPool = oldPool;
        poolWaitMs = oldWait;
        resetSyncSticky();
    };
}

// Go: AcquireStatelessSession(ctx) (chatID, pooled, err).
// Async mode takes a pre-made session from the standing batch; if a burst
// exhausts the batch the request waits up to poolWaitMs and then creates a
// session directly instead of stalling. Sync mode mints a fresh session per
// request. Returns { chatID, pooled }; pooled sessions are retired through
// pool.release(), on-demand ones through gcSessions(). Throws on shutdown /
// aborted signal.
export async function acquireStatelessSession(signal) {
    if (sessionPool === null) {
        // Sync mode: one sticky chat reused up to syncMaxUses() requests,
        // then deleted and rotated (issue #41 traffic-shape rationale).
        if (syncID === '') {
            syncID = randomUUID();
            syncUses = 0;
            logInfo(`[Sync] sticky session: ${syncID} (new)`);
        } else {
            logInfo(`[Sync] sticky session: ${syncID} (reuse ${syncUses}/${syncMaxUses()})`);
        }
        return { chatID: syncID, pooled: false };
    }
    try {
        const id = await sessionPool.acquire(signal, poolWaitMs);
        logInfo(`[Pool] stateless session: ${id} (${sessionPool.ready()}/${sessionPool.size()} ready, uses ${sessionPool.usesOf(id)}/${sessionPool.getMaxUses()})`);
        return { chatID: id, pooled: true };
    } catch (acqErr) {
        if (acqErr === ErrPoolTimeout) {
            const chatID = randomUUID();
            logInfo(`[Pool] busy — stateless session created on demand: ${chatID}`);
            return { chatID, pooled: false };
        }
        if (acqErr === ErrPoolClosing) {
            throw new Error('server is shutting down');
        }
        throw acqErr; // the request's client went away
    }
}

// Go: ReleaseStatelessSession(chatID, pooled). Must be called only after the
// response has been fully written and processed (or definitively failed):
// the chat is deleted on Z.AI, and in async mode the pool immediately stocks
// a replacement.
export function releaseStatelessSession(chatID, pooled) {
    if (!chatID) return;
    if (pooled && sessionPool !== null) {
        sessionPool.release(chatID);
        return;
    }
    if (sessionPool !== null) {
        // On-demand overflow session (the pool was exhausted).
        gcSessions('stateless', chatID);
        return;
    }
    // Sync mode: sticky reuse / rotate.
    if (chatID !== syncID) {
        // A concurrent rotation already replaced the sticky ID.
        gcSessions('sync-stale', chatID);
        return;
    }
    syncUses++;
    const max = syncMaxUses();
    if (syncUses < max) {
        logInfo(`[Sync] session ${chatID} reused ${syncUses}/${max}`);
        return;
    }
    // Clear first so the next acquire creates a fresh chat immediately.
    syncID = '';
    syncUses = 0;
    logInfo(`[Sync] session ${chatID} reached max uses ${max}, rotating`);
    gcSessions('sync-reuse-max', chatID);
}

// Go: gcSessions(reason, sessionIDs...). Asynchronously deletes used-up chat
// sessions on Z.AI so their history doesn't accumulate on the account.
// Fire-and-forget; deletion is best-effort — failures are logged.
export function gcSessions(reason, ...sessionIDs) {
    const ids = sessionIDs.filter((id) => id);
    if (ids.length === 0) return;
    (async () => {
        const backend = newZAIChatBackend();
        try {
            await backend.deleteChatSession(AbortSignal.timeout(poolOpTimeout), ...ids);
            logInfo(`[GC:${reason}] deleted chat session(s): [${ids.join(' ')}]`);
        } catch (err) {
            logError(`[GC:${reason}] failed to delete chat session(s) [${ids.join(' ')}]: ${err.message}`);
        }
    })();
}

// Go: sessionPoolStatus() — reports the session-lifecycle mode for /status.
export function sessionPoolStatus() {
    if (sessionPool === null) {
        const st = {
            mode: 'sync',
            throwaway: false,
            reuse: true,
            maxUses: syncMaxUses(),
            gc_enabled: true,
        };
        if (syncID !== '') st.currentUses = syncUses;
        return st;
    }
    return {
        mode: 'async',
        throwaway: false,
        reuse: true,
        maxUses: sessionPool.getMaxUses(),
        gc_enabled: true,
        size: sessionPool.size(),
        ready: sessionPool.ready(),
    };
}

// ── Sync-mode sticky session (Go: syncID / syncUses / syncMu) ─────────────

let syncID = '';
let syncUses = 0;

function syncMaxUses() {
    return config.sessionReuseCount >= 1 ? config.sessionReuseCount : defaultSessionReuse;
}

// Go: ResetSyncSticky(). Clears the sticky ID/uses without touching upstream.
export function resetSyncSticky() {
    syncID = '';
    syncUses = 0;
}

// Go: ShutdownSyncSession(). Deletes the sticky chat so nothing is left on
// the account at exit.
export async function shutdownSyncSession() {
    if (syncID === '') return;
    const id = syncID;
    syncID = '';
    syncUses = 0;
    try {
        await newZAIChatBackend().deleteChatSession(AbortSignal.timeout(poolOpTimeout), id);
        logInfo(`[Sync] deleted sticky session: ${id}`);
    } catch (err) {
        logError(`[Sync] warning: failed to delete sticky session ${id}: ${err.message}`);
    }
}
