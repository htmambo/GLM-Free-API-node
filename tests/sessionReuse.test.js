// Port of internal/zbridge/session_reuse_test.go — one chat session serves up
// to SESSION_REUSE_COUNT requests before DELETE + rotation, in both async
// (pool) and sync (sticky) modes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { setBaseURL } from '../src/config.js';

import { SessionPool, attachSessionPool, acquireStatelessSession, releaseStatelessSession } from '../src/sessionPool.js';
import { config } from '../src/config.js';

class StubBackend {
    constructor() {
        this.created = [];
        this.deleted = [];
        this.seq = 0;
    }
    async createChatSession() {
        const id = `chat-${++this.seq}`;
        this.created.push(id);
        return id;
    }
    async deleteChatSession(signal, ...ids) {
        this.deleted.push(...ids);
    }
}

async function waitFor(what, timeoutMs, cond) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (cond()) return;
        await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error(`timed out waiting for ${what}`);
}

test('TestPoolReusesUpToMaxUses', async () => {
    const saved = config.sessionReuseCount;
    config.sessionReuseCount = 3;
    const b = new StubBackend();
    const pool = new SessionPool(b, 1);
    pool.setMaxUses(3);
    try {
        pool.start();
        await waitFor('warmup', 1000, () => pool.ready() === 1);

        // Request 1
        const id1 = await pool.acquire(undefined, 1000);
        pool.release(id1);
        await waitFor('first reuse', 1000, () => pool.ready() === 1);
        assert.equal(b.deleted.length, 0, 'request 1 must not delete the chat');
        assert.equal(pool.usesOf(id1), 1);

        // Request 2 (same chat)
        const id2 = await pool.acquire(undefined, 1000);
        assert.equal(id2, id1, 'the same chat must be handed out again');
        pool.release(id2);
        await waitFor('second reuse', 1000, () => pool.ready() === 1);
        assert.equal(b.deleted.length, 0, 'request 2 must not delete the chat');
        assert.equal(pool.usesOf(id1), 2);

        // Request 3 hits the cap: delete + rotate.
        const id3 = await pool.acquire(undefined, 1000);
        assert.equal(id3, id1);
        pool.release(id3);
        await waitFor('rotation', 1000, () => b.deleted.includes(id1) && pool.ready() === 1);
        assert.equal(pool.usesOf(id1), 0, 'uses entries are cleared after rotation');
        assert.equal(pool.size(), 1);
    } finally {
        await pool.shutdown();
        config.sessionReuseCount = saved;
    }
});

test('TestPoolMaxUsesOneIsThrowaway', async () => {
    const b = new StubBackend();
    const pool = new SessionPool(b, 1);
    pool.setMaxUses(1);
    try {
        pool.start();
        await waitFor('warmup', 1000, () => pool.ready() === 1);
        const id = await pool.acquire(undefined, 1000);
        pool.release(id);
        await waitFor('throwaway delete', 1000, () => b.deleted.includes(id));
    } finally {
        await pool.shutdown();
    }
});

test('sync mode: sticky chat is reused, then rotated', async (t) => {
    const saved = config.sessionReuseCount;
    config.sessionReuseCount = 3;
    const restore = attachSessionPool(null, 1000);
    // Local upstream so the rotation DELETE never leaves the machine.
    const server = http.createServer((req, res) => { res.writeHead(200); res.end('true'); });
    const url = await new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
    setBaseURL(url);
    t.after(async () => {
        restore();
        config.sessionReuseCount = saved;
        setBaseURL('https://chat.z.ai');
        await new Promise((r) => server.close(r));
    });

    const a1 = await acquireStatelessSession();
    assert.equal(a1.pooled, false);

    // Uses 1 and 2: the same sticky chat is handed out again.
    for (let use = 1; use <= 2; use++) {
        const again = await acquireStatelessSession();
        assert.equal(again.chatID, a1.chatID, `use ${use} must reuse the sticky chat`);
        releaseStatelessSession(again.chatID, again.pooled);
    }

    const third = await acquireStatelessSession();
    assert.equal(third.chatID, a1.chatID, 'third use still reuses the chat');
    releaseStatelessSession(third.chatID, third.pooled);

    // The third release rotated the chat: the next acquire mints a fresh one.
    const a4 = await acquireStatelessSession();
    assert.notEqual(a4.chatID, a1.chatID, 'sticky chat must rotate at the cap');
});
