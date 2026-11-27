// Tests for src/captcha.js (port of internal/zbridge/captcha.go).
//
// 无 Go 对照向量，仅锁定当前实现行为: the Go repo has no *_test.go vectors
// for aliHash / encrypt / generateArg and no Go toolchain is available in
// this environment to generate reference outputs. The snapshot values below
// were captured from this implementation after a line-by-line port review;
// they lock current behaviour against regressions but are NOT verified
// against the Go binary.
//
// Network parts (initCaptcha / verifyCaptcha / computeFinalPayload) are not
// tested — no mock fetch seam exists in zaiFetch.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';

import {
    aliHash,
    encrypt,
    generateArg,
    zlibCompress,
    buildTrackJSON,
    getNextToken,
    removeToken,
    CaptchaCache,
    captchaCache,
    seedCaptchaParam,
    getCaptchaVerifyParam,
} from '../src/captcha.js';
import { initDB } from '../src/db.js';
import { setDbPath, config } from '../src/state.js';

// ---------- aliHash ----------

test('aliHash: deterministic, 32-char lowercase hex', () => {
    const h1 = aliHash('hello', '0000');
    const h2 = aliHash('hello', '0000');
    assert.equal(h1, h2);
    assert.match(h1, /^[0-9a-f]{32}$/);
});

test('aliHash: sensitive to input and salt', () => {
    const base = aliHash('hello', '0000');
    assert.notEqual(aliHash('hellp', '0000'), base);
    assert.notEqual(aliHash('hello', '0001'), base);
    assert.notEqual(aliHash('', '0000'), base);
});

test('aliHash: snapshot lock (no Go reference vectors — see header)', () => {
    assert.equal(aliHash('', '0000'), 'cc55226600cc11884433224422dddd00');
    assert.equal(aliHash('a', '0000'), 'ccf822cb00611125449e22e92270ddad');
    assert.equal(aliHash('hello', '0000'), 'a17335d5d07fc13b9419f26ec1f73e2a');
    assert.equal(aliHash('{"TrackList":{}}', '0000'), 'c9624526f9bfca250b5239e1207a6e81');
    assert.equal(aliHash('hello', '1234'), '224184f515a0624ec893370a156c266c');
    assert.equal(
        aliHash('The quick brown fox jumps over the lazy dog', '0000'),
        'f3c370e37c16c0963300de451c00333a',
    );
});

// ---------- encrypt ----------

test('encrypt: deterministic, base64 output, empty input -> empty string', () => {
    assert.equal(encrypt(''), '');
    const e1 = encrypt('hello');
    assert.equal(e1, encrypt('hello'));
    assert.match(e1, /^[A-Za-z0-9+/]*={0,2}$/);
    assert.notEqual(encrypt('hellp'), e1);
});

test('encrypt: accepts Buffer/Uint8Array identically to string', () => {
    assert.equal(encrypt(Buffer.from('hello', 'utf8')), encrypt('hello'));
    assert.equal(encrypt(Uint8Array.from([104, 101, 108, 108, 111])), encrypt('hello'));
});

test('encrypt: snapshot lock (no Go reference vectors — see header)', () => {
    assert.equal(encrypt('a'), 'IQ==');
    assert.equal(encrypt('hello'), 'KAgxRwg=');
    assert.equal(encrypt('AAAA'), 'ASRukg==');
    assert.equal(encrypt('dGVzdA=='), 'JC5bWQdVBhY=');
    assert.equal(encrypt('eyJmb28iOiJiYXIifQ=='), 'JXxXRgVGAzooSAsvcnZXFU8JYUw=');
});

// ---------- generateArg ----------

test('generateArg: deterministic base64, snapshot lock (no Go vectors)', () => {
    assert.equal(generateArg('abc'), generateArg('abc'));
    assert.equal(generateArg('abc'), 'e39o');
    assert.equal(generateArg('certify-123-XYZ'), 'eWJ5Mk6Ed1WrJ4F0DmU9');
    assert.equal(generateArg('a%20b'), 'e6K5dkc=');
    assert.equal(generateArg('特殊字符'), '/QY+oPO429VBkgbN');
});

// ---------- buildTrackJSON (pure payload builder) ----------

test('buildTrackJSON: exact JSON lock incl. Go struct field order', () => {
    // Go marshals Track{TrackList{fi,ks,mc,mp,mu,startTime,tc,te,tmv},
    // TrackStartTime, VerifyTime, arg} in struct field order.
    const json = buildTrackJSON('abc', 1700000000000);
    assert.equal(
        json,
        '{"TrackList":{"fi":"","ks":"","mc":"","mp":"","mu":"","startTime":1700000000000,'
        + '"tc":"","te":"","tmv":""},"TrackStartTime":1700000000000,'
        + '"VerifyTime":1700000000300,"arg":"e39o"}',
    );
    const parsed = JSON.parse(json);
    assert.equal(parsed.TrackList.startTime, 1700000000000);
    assert.equal(parsed.TrackStartTime, 1700000000000);
    assert.equal(parsed.VerifyTime, 1700000000300); // ct + 300
    assert.equal(parsed.arg, generateArg('abc'));
});

// ---------- zlibCompress ----------

test('zlibCompress: zlib-format roundtrip', () => {
    const data = Buffer.from('captcha payload 123 / 测试', 'utf8');
    const compressed = zlibCompress(data);
    assert.equal(compressed[0], 0x78); // zlib magic
    assert.deepEqual(inflateSync(compressed), data);
});

// ---------- Database (initDB / getNextToken / removeToken) ----------

const tmpDir = mkdtempSync(join(tmpdir(), 'captcha-test-'));
const tmpDb = join(tmpDir, 'tokens.sqlite');

after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
});

test('initDB: opens the collector schema; getNextToken/removeToken work', async () => {
    // Production flow: the token collector creates the schema first (run.go
    // checks os.Stat before initDB; db.go does not create tables).
    const { DatabaseSync } = await import('node:sqlite');
    const seed = new DatabaseSync(tmpDb);
    seed.exec('CREATE TABLE tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL)');
    seed.prepare('INSERT INTO tokens (token) VALUES (?)').run('tok-b');
    seed.prepare('INSERT INTO tokens (token) VALUES (?)').run('tok-a');
    seed.close();

    setDbPath(tmpDb);
    initDB(tmpDb);

    // ORDER BY id LIMIT 1 -> insertion order, not lexical.
    assert.equal(getNextToken(), 'tok-b');

    removeToken('tok-b');
    assert.equal(getNextToken(), 'tok-a');
    removeToken('tok-a');
    assert.equal(getNextToken(), null);
});

test('getNextToken: missing DB file -> null (no throw)', () => {
    setDbPath(join(tmpDir, 'does-not-exist.sqlite'));
    assert.equal(getNextToken(), null);
    setDbPath(tmpDb); // restore
});

// ---------- CaptchaCache ----------

test('CaptchaCache.get: FIFO, TTL sweep at 75s, markActive', () => {
    const c = new CaptchaCache();
    assert.equal(c.active, false);
    assert.equal(c.get(), null);
    assert.equal(c.active, true); // markActive via get()

    const now = Date.now();
    c.params.push(
        { value: 'expired', generatedAt: now - 76_000 },
        { value: 'fresh-1', generatedAt: now },
        { value: 'fresh-2', generatedAt: now },
    );
    assert.equal(c.get(), 'fresh-1'); // expired swept, FIFO order
    assert.equal(c.get(), 'fresh-2');
    assert.equal(c.get(), null);
    assert.equal(c.params.length, 0);
});

test('seedCaptchaParam + getCaptchaVerifyParam: agent-mode cache hit (no network)', async () => {
    const oldAgent = config.agentMode;
    config.agentMode = true;
    try {
        seedCaptchaParam('seeded-value');
        const val = await getCaptchaVerifyParam();
        assert.equal(val, 'seeded-value');
        assert.equal(captchaCache.params.length, 0);
    } finally {
        config.agentMode = oldAgent;
    }
});

test('getCaptchaVerifyParam: cache miss + no tokens -> empty-payload error (no network)', async () => {
    // Empty token table (from the DB tests above) makes computeFinalPayload
    // return '' immediately, without any network call.
    const oldAgent = config.agentMode;
    config.agentMode = true;
    try {
        await assert.rejects(
            getCaptchaVerifyParam(),
            /captcha generation returned empty payload/,
        );
    } finally {
        config.agentMode = oldAgent;
    }
});
