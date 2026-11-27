// Tests for src/tokenFile.js — ZAI_TOKEN_FILE hot reload.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { reloadTokenFromFile } from '../src/tokenFile.js';
import { config } from '../src/state.js';

const dir = mkdtempSync(join(tmpdir(), 'zai-token-file-'));
const original = { token: config.zaiToken, file: config.zaiTokenFile };

after(() => {
    config.zaiToken = original.token;
    config.zaiTokenFile = original.file;
    rmSync(dir, { recursive: true, force: true });
});

let seq = 0;

function jwt(payload) {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${enc({ alg: 'HS256', typ: 'JWT' })}.${enc(payload)}.sig`;
}

function validToken(tag = 'user') {
    return jwt({ id: tag, exp: Math.floor(Date.now() / 1000) + 3600 });
}

function expiredToken() {
    return jwt({ id: 'user', exp: Math.floor(Date.now() / 1000) - 60 });
}

// Atomic write: tmp file + rename, like cmd/zai-token-refresher does.
function writeTokenFile(content) {
    const path = join(dir, `token-${++seq}`);
    const tmp = path + '.tmp';
    writeFileSync(tmp, content, { mode: 0o600 });
    renameSync(tmp, path);
    config.zaiTokenFile = path;
    return path;
}

test('no ZAI_TOKEN_FILE configured: no-op', () => {
    config.zaiTokenFile = '';
    config.zaiToken = 'keep-me';
    assert.equal(reloadTokenFromFile({ force: true }), false);
    assert.equal(config.zaiToken, 'keep-me');
});

test('missing file: keeps the current token', () => {
    config.zaiTokenFile = join(dir, 'does-not-exist');
    config.zaiToken = 'keep-me';
    assert.equal(reloadTokenFromFile({ force: true }), false);
    assert.equal(config.zaiToken, 'keep-me');
});

test('empty file: keeps the current token', () => {
    writeTokenFile('   \n');
    config.zaiToken = 'keep-me';
    assert.equal(reloadTokenFromFile({ force: true }), false);
    assert.equal(config.zaiToken, 'keep-me');
});

test('malformed / expired token: never replaces a valid one', () => {
    writeTokenFile('not-a-jwt');
    config.zaiToken = 'keep-me';
    assert.equal(reloadTokenFromFile({ force: true }), false);

    writeTokenFile(expiredToken());
    assert.equal(reloadTokenFromFile({ force: true }), false);
    assert.equal(config.zaiToken, 'keep-me');
});

test('valid token: swapped in, reported as a change', () => {
    writeTokenFile(validToken('swap'));
    config.zaiToken = 'old-token';
    assert.equal(reloadTokenFromFile({ force: true }), true);
    assert.notEqual(config.zaiToken, 'old-token');
    assert.equal(config.zaiToken.split('.').length, 3);
});

test('same content twice: second call is not a change', () => {
    const token = validToken('same');
    writeTokenFile(token);
    assert.equal(reloadTokenFromFile({ force: true }), true);
    assert.equal(reloadTokenFromFile({ force: true }), false);
});

test('mtime/size cache: unchanged file is skipped without force', () => {
    writeTokenFile(validToken('cache'));
    assert.equal(reloadTokenFromFile({ force: true }), true);
    // No write since the forced read above.
    assert.equal(reloadTokenFromFile(), false);
});

test('rotated file: next read picks up the new value', () => {
    writeTokenFile(validToken('first'));
    assert.equal(reloadTokenFromFile({ force: true }), true);
    const first = config.zaiToken;

    // Different payload length guarantees a different size even within the
    // same millisecond.
    const second = validToken('second-with-a-longer-id');
    writeTokenFile(second);
    assert.equal(reloadTokenFromFile(), true);
    assert.notEqual(config.zaiToken, first);
    assert.equal(config.zaiToken, second);
    assert.ok(statSync(config.zaiTokenFile).size > 0);
});
