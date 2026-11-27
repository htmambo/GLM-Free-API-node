// Port of internal/zbridge/db_test.go + tests/db_hotswap_test.go — the
// hot-swappable token database, token counting and the POST /sqlite endpoint.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';

import {
    initDB,
    closeDB,
    tokenCount,
    swapDB,
    validateTokenDB,
    activeDBPath,
    setTokenCountTTLForTests,
} from '../src/db.js';
import { createHandler } from '../src/server.js';
import { config } from '../src/config.js';

const tmpDir = mkdtempSync(join(tmpdir(), 'db-test-'));
test.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

let seq = 0;
function makeSQLite(n) {
    const p = join(tmpDir, `tokens-${seq++}.sqlite`);
    const db = new DatabaseSync(p);
    db.exec('CREATE TABLE tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO tokens (token) VALUES (?)');
    db.exec('BEGIN');
    for (let i = 0; i < n; i++) insert.run(`tok-${i}`);
    db.exec('COMMIT');
    db.close();
    return p;
}

test('TestTokenCountRealTime', () => {
    setTokenCountTTLForTests(0);
    const p = makeSQLite(7);
    setActive(p);
    assert.equal(tokenCount(), 7);
});

test('TestTokenCountNoDB', async () => {
    await closeDB();
    assert.equal(tokenCount(), -1);
});

test('TestTokenCountTTLCache', () => {
    setTokenCountTTLForTests(500);
    const p = makeSQLite(3);
    setActive(p);
    assert.equal(tokenCount(), 3);

    // Grow the table behind the cache: within the TTL the cached value holds.
    const db = new DatabaseSync(p);
    db.prepare('INSERT INTO tokens (token) VALUES (?)').run('extra');
    db.close();
    assert.equal(tokenCount(), 3, 'cached value must be served inside the TTL');

    setTokenCountTTLForTests(0);
    assert.equal(tokenCount(), 4, 'expired cache must reflect the new row');
});

test('TestTokenCountReflectsSwapImmediately', async () => {
    setTokenCountTTLForTests(60_000);
    const a = makeSQLite(2);
    const b = makeSQLite(99);
    setActive(a);
    assert.equal(tokenCount(), 2);
    await swapDB(b);
    assert.equal(tokenCount(), 99, 'swap must invalidate the count cache');
    assert.equal(activeDBPath(), b);
});

test('swap rejects non-SQLite files without touching the active DB', async () => {
    const good = makeSQLite(5);
    setActive(good);

    const junk = join(tmpDir, 'junk.sqlite');
    writeFileSync(junk, 'this is not a sqlite database');
    await assert.rejects(() => swapDB(junk));
    assert.equal(activeDBPath(), good, 'failed swap must keep the active DB');
    assert.equal(tokenCount(), 5);

    await assert.rejects(() => swapDB(''), /db_path is empty/);
    await assert.rejects(() => swapDB(join(tmpDir, 'missing.sqlite')), /not accessible/);
    await assert.rejects(() => swapDB(tmpDir), /is a directory/);
});

test('validateTokenDB rejects a schema without the token column', () => {
    const p = join(tmpDir, 'wrong-schema.sqlite');
    const db = new DatabaseSync(p);
    db.exec('CREATE TABLE tokens (id INTEGER PRIMARY KEY, other TEXT)');
    db.close();
    assert.throws(() => validateTokenDB(p), /has no 'token' column/);
});

test('POST /sqlite swaps the database over HTTP and /health reports tokenCount', async () => {
    setTokenCountTTLForTests(0);
    const first = makeSQLite(4);
    const second = makeSQLite(11);
    initDB(first);

    const server = http.createServer(createHandler());
    const url = await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });

    try {
        const health = await fetch(url + '/health');
        assert.equal((await health.json()).tokenCount, 4);

        const auth = { Authorization: 'Bearer ' + config.auth.token };

        // Non-POST -> 405
        const get = await fetch(url + '/sqlite', { headers: auth });
        assert.equal(get.status, 405);

        // Missing db_path -> 400
        const missing = await fetch(url + '/sqlite', {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: '{}',
        });
        assert.equal(missing.status, 400);
        assert.match((await missing.json()).error, /missing required field 'db_path'/);

        // Bad path -> 400, active DB unchanged
        const bad = await fetch(url + '/sqlite', {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ db_path: join(tmpDir, 'nope.sqlite') }),
        });
        assert.equal(bad.status, 400);

        // Success
        const ok = await fetch(url + '/sqlite', {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            body: JSON.stringify({ db_path: second }),
        });
        assert.equal(ok.status, 200);
        const body = await ok.json();
        assert.equal(body.success, true);
        assert.equal(body.message, 'database swapped');
        assert.equal(body.db_path, second);
        assert.equal(body.token_count, 11);
        assert.match(body.swapped_in, /^\d+ms$/);

        const health2 = await fetch(url + '/health');
        assert.equal((await health2.json()).tokenCount, 11);

        // Auth is required.
        const unauth = await fetch(url + '/sqlite', { method: 'POST', body: '{}' });
        assert.equal(unauth.status, 401);
    } finally {
        await new Promise((r) => server.close(r));
    }
});

function setActive(path) {
    // initDB validates existence then attaches.
    initDB(path);
}
