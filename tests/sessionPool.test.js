// Tests for src/sessionPool.js — port of tests/session_pool_test.go
// (blackbox tests for the throwaway-session lifecycle), driving the module
// through its exported API with a scriptable stub backend.
//
// Covered:
//   - pool warmup / acquire / release / refill discipline
//   - acquire timeout + shutdown semantics (leftover cleanup, no refill)
//   - create-retry backoff path
//   - deleteZAIChat against a mock chat.z.ai (DELETE /api/v1/chats/{id}:
//     "true" on success, {"detail":"We could not find ..."} when already
//     gone — which must count as a successful idempotent delete)
//   - the sync-mode glue (acquire/releaseStatelessSession with no pool
//     attached) end to end through the GC
//
// NOT ported (dependency not yet ported): the Go file's final test
// TestHTTPChatCompletionsUsesPooledSessionThenDeletes drives the real HTTP
// handler (zbridge.NewHandler), which belongs to a later phase.
//
// Go context.Context -> AbortSignal: "canceled ctx" cases assert a rejection
// whose name is 'AbortError' (what AbortController.abort() produces).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import {
    SessionPool,
    ErrPoolClosing,
    ErrPoolTimeout,
    newZAIChatBackend,
    deleteZAIChat,
    attachSessionPool,
    acquireStatelessSession,
    releaseStatelessSession,
} from '../src/sessionPool.js';
import { BASE_URL, setBaseURL, config } from '../src/config.js';
import { session } from '../src/state.js';

// ── stub backend ────────────────────────────────────────────────────────────

// Scriptable SessionBackend for pool tests (Go: stubBackend).
class StubBackend {
    constructor({ failCreates = 0, blockCreate = false } = {}) {
        this.nextID = 0;
        this.created = [];
        this.deleted = [];
        this.failCreates = failCreates; // that many upcoming creates fail first
        this.blockCreate = blockCreate; // park creates until their signal aborts
    }

    createChatSession(signal) {
        if (this.blockCreate) {
            return new Promise((_, reject) => {
                if (signal.aborted) reject(signal.reason);
                else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
        }
        if (this.failCreates > 0) {
            this.failCreates--;
            return Promise.reject(new Error('stub create failure'));
        }
        this.nextID++;
        const id = `stub-session-${this.nextID}`;
        this.created.push(id);
        return Promise.resolve(id);
    }

    async deleteChatSession(signal, ...ids) {
        this.deleted.push(...ids);
    }

    snapshot() {
        return { created: [...this.created], deleted: [...this.deleted] };
    }
}

// waitFor polls cond until it holds or the timeout elapses.
async function waitFor(what, timeoutMs, cond) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
}

// ── pool semantics ──────────────────────────────────────────────────────────

test('SessionPool: warmup / acquire / release / refill', async () => {
    const b = new StubBackend();
    const p = new SessionPool(b, 3);
    p.setMaxUses(1); // throwaway semantics (default reuse is 10)
    p.start();

    await waitFor('warmup to stock 3 sessions', 3000, () => p.ready() === 3);

    // The whole batch can be checked out; every ID is unique.
    const seen = new Set();
    let first = null;
    for (let i = 0; i < 3; i++) {
        const id = await p.acquire(undefined, 1000);
        assert.ok(!seen.has(id), `Acquire handed out duplicate session ${id}`);
        seen.add(id);
        if (i === 0) first = id;
    }
    assert.equal(p.ready(), 0, 'ready after draining the batch');

    // Releasing a consumed session deletes it upstream and refills the batch.
    p.release(first);
    await waitFor('used session deleted + batch refilled', 3000, () => {
        const { deleted } = b.snapshot();
        return deleted.length === 1 && deleted[0] === first && p.ready() === 1;
    });

    await p.shutdown();
});

test('SessionPool: acquire timeout and aborted signal', async () => {
    const b = new StubBackend();
    const p = new SessionPool(b, 1); // never started: batch stays empty

    const start = Date.now();
    await assert.rejects(p.acquire(undefined, 50), (err) => err === ErrPoolTimeout);
    assert.ok(Date.now() - start <= 2000, 'Acquire should take ~50ms');

    // An aborted request signal wins over the wait window.
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(p.acquire(ac.signal, 60000), (err) => err.name === 'AbortError');

    await p.shutdown();
});

test('SessionPool: shutdown clears leftovers, refuses acquire, is idempotent', async () => {
    const b = new StubBackend();
    const p = new SessionPool(b, 3);
    p.setMaxUses(1); // throwaway semantics (default reuse is 10)
    p.start();

    await waitFor('warmup to stock 3 sessions', 3000, () => p.ready() === 3);

    await p.shutdown();

    let { deleted } = b.snapshot();
    assert.equal(deleted.length, 3, `shutdown should delete all 3, deleted: ${deleted}`);
    assert.equal(p.ready(), 0, 'ready after shutdown');

    // Acquire after shutdown is refused, and a second shutdown is a no-op.
    await assert.rejects(p.acquire(undefined, 50), (err) => err === ErrPoolClosing);
    await p.shutdown();
    ({ deleted } = b.snapshot());
    assert.equal(deleted.length, 3, 'second shutdown must not delete more sessions');
});

test('SessionPool: release after shutdown retires without refilling', async () => {
    const b = new StubBackend();
    const p = new SessionPool(b, 1);
    p.start();

    await waitFor('warmup to stock 1 session', 3000, () => p.ready() === 1);

    const id = await p.acquire(undefined, 1000);

    await p.shutdown(); // nothing left in stock

    // The checked-out session is still retired by its request's release,
    // but the batch must NOT be rebuilt during shutdown.
    p.release(id);
    await waitFor('checked-out session deleted', 3000, () => {
        const { deleted } = b.snapshot();
        return deleted.length === 1 && deleted[0] === id;
    });
    await new Promise((r) => setTimeout(r, 50)); // give a wrongful refill a chance
    const { created } = b.snapshot();
    assert.equal(created.length, 1, `pool refilled during shutdown: created = ${created}`);
    assert.equal(p.ready(), 0, 'ready after shutdown release');
});

test('SessionPool: create retry backs off then stocks', async () => {
    const b = new StubBackend({ failCreates: 1 }); // first create fails, retry succeeds
    const p = new SessionPool(b, 1);
    p.start();

    // fillSlot backs off 1s after the failure, then stocks the retry.
    await waitFor('session stocked after create retry', 5000, () => p.ready() === 1);
    const { created } = b.snapshot();
    assert.equal(created.length, 1, `want exactly one successful session, created = ${created}`);
    await p.shutdown();
});

// ── Z.AI chat delete client ─────────────────────────────────────────────────

function startUpstream(handler) {
    const requests = [];
    const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => handler(req, res, body, requests));
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

function stopUpstream(server) {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(r));
}

// Points the bridge at a mock upstream with a pre-authenticated session and
// returns a restore function (Go: mockZAI + OverrideSessionState testhook).
function mockZAI(baseURL) {
    const oldBase = BASE_URL;
    const saved = {
        token: session.token,
        userID: session.userID,
        initialized: session.initialized,
    };
    setBaseURL(baseURL);
    session.token = 'test-token';
    session.userID = 'test-user';
    session.initialized = true;
    return () => {
        setBaseURL(oldBase);
        session.token = saved.token;
        session.userID = saved.userID;
        session.initialized = saved.initialized;
    };
}

test('deleteZAIChat: success / idempotent-gone / failure / empty-ID', async (t) => {
    const { server, requests, url } = await startUpstream((req, res, body, seen) => {
        seen.push({ method: req.method, path: req.url, auth: req.headers['authorization'] });
        if (req.url.startsWith('/api/v1/chats/ok-')) {
            res.writeHead(200).end('true');
        } else if (req.url.startsWith('/api/v1/chats/gone-')) {
            // The live reply for a chat that no longer exists.
            res.writeHead(404, { 'content-type': 'application/json' })
                .end('{"detail":"We could not find what you\'re looking for :/"}');
        } else {
            res.writeHead(500, { 'content-type': 'application/json' }).end('{"detail":"boom"}');
        }
    });
    t.after(() => stopUpstream(server));
    const restore = mockZAI(url);
    t.after(restore);

    // Success: DELETE with the bearer token, "true" reply.
    await deleteZAIChat('ok-123');
    // Already gone: idempotent success.
    await deleteZAIChat('gone-456');
    // Server error surfaces as a failure.
    await assert.rejects(deleteZAIChat('bad-789'), /Z\.AI chat delete failed: 500/);
    // Empty ID is a no-op.
    await deleteZAIChat('');

    assert.equal(requests.length, 3, 'empty ID must not hit the wire');
    assert.deepEqual(requests, [
        { method: 'DELETE', path: '/api/v1/chats/ok-123', auth: 'Bearer test-token' },
        { method: 'DELETE', path: '/api/v1/chats/gone-456', auth: 'Bearer test-token' },
        { method: 'DELETE', path: '/api/v1/chats/bad-789', auth: 'Bearer test-token' },
    ]);
});

// ── bridge glue (sync-mode path) ────────────────────────────────────────────

test('sync mode: acquire mints on demand, release deletes upstream via GC', async (t) => {
    // No pool attached -> legacy per-request flow, still garbage-collected.
    const restorePool = attachSessionPool(null, 10000);
    t.after(restorePool);
    // Pin throwaway semantics for this test (default reuse is 10).
    const savedReuse = config.sessionReuseCount;
    config.sessionReuseCount = 1;
    t.after(() => { config.sessionReuseCount = savedReuse; });

    const deletedPaths = [];
    const { server, url } = await startUpstream((req, res) => {
        if (req.method === 'DELETE' && req.url.startsWith('/api/v1/chats/')) {
            deletedPaths.push(req.url);
            res.writeHead(200).end('true');
            return;
        }
        res.writeHead(404).end('not found');
    });
    t.after(() => stopUpstream(server));
    const restore = mockZAI(url);
    t.after(restore);

    const { chatID, pooled } = await acquireStatelessSession();
    assert.equal(pooled, false, 'sync mode must not hand out pool-owned sessions');
    assert.ok(chatID, 'sync mode must mint a non-empty chat ID');

    releaseStatelessSession(chatID, pooled);

    // GC is fire-and-forget: poll for the DELETE to land upstream.
    await waitFor('GC to delete the used chat upstream', 5000, () =>
        deletedPaths.length === 1 && deletedPaths[0] === `/api/v1/chats/${chatID}`,
    );
});

test('acquireStatelessSession: starved pool falls back to on-demand creation', async (t) => {
    // A starved pool (batch exhausted, no refill coming) must fall back to
    // creating a session on demand after poolWait instead of stalling.
    const b = new StubBackend({ blockCreate: true }); // warmup/refill never produce
    const restore = attachSessionPool(new SessionPool(b, 1), 50);
    t.after(restore);

    const start = Date.now();
    const { chatID, pooled } = await acquireStatelessSession();
    assert.equal(pooled, false, 'on-demand fallback session must not be pool-owned');
    assert.ok(chatID, 'on-demand fallback must mint a non-empty chat ID');
    assert.ok(Date.now() - start <= 3000, 'fallback should take ~50ms poolWait');
});

test('acquireStatelessSession: draws from the pool, release retires + refills', async (t) => {
    const b = new StubBackend();
    const pool = new SessionPool(b, 2);
    pool.setMaxUses(1); // throwaway semantics (default reuse is 10)
    const restore = attachSessionPool(pool, 1000);
    t.after(async () => {
        await pool.shutdown();
        restore();
    });
    pool.start();

    await waitFor('warmup to stock 2 sessions', 3000, () => pool.ready() === 2);

    const { chatID, pooled } = await acquireStatelessSession();
    assert.equal(pooled, true, 'async mode must hand out pool-owned sessions');

    // Release retires it through the pool: deleted upstream + refilled.
    // Batch was 2 with one checked out, so after release+refill it is full.
    releaseStatelessSession(chatID, pooled);
    await waitFor('pool to retire + refill the session', 3000, () => {
        const { deleted } = b.snapshot();
        return deleted.length === 1 && deleted[0] === chatID && pool.ready() === 2;
    });
});
