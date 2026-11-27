// Port of cmd/token-collector/feilin_test.go — golden-vector tests for the
// device-token primitives. The vectors come from live captures, so this also
// cross-checks the Node port against the Go and Python implementations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
    RES_KEY,
    MD5_SECRET,
    IDX_IP,
    IDX_LOG,
    IDX_INIT_TIME,
    IDX_NOW,
    IDX_SERVER_TS,
    IDX_EMPTY_93,
    IDX_EMPTY_94,
    aesCBCEncrypt,
    aesCBCDecrypt,
    decryptB64,
    encryptB64,
    decryptDeviceConfig,
    newPayloadTemplate,
    mintTokens,
    verifyToken,
} from '../cmd/token-collector/feilin.js';

// ---------- golden vectors ----------

const goldenDeviceConfig = 'wN32kvF2iZuLdXqR9SvIIDy5WLu2p9xzJPVdtSxOaTAAFuQhfAzge1b2KK6jxvBs8dGMNR++31iG+CCS6kMRf9JYA4zuU4B5PpOiPliAnU23UQw5FN+DGQQeOwJ48T3HJy9LrGS4uz2g49qaDhLhatXK3dUOKqahUgwpj5hsLPx3qWfVeSCA8hKNrk54gtBkCoox4qBXZMbYM7zfOIU3rIskHnDS6ODyK+wX03GIGTRXDivevyfMLIsU73fFeBPic2vVwcgAhn6YQHo3ZPF5OvxCp39IYwlpND1oJqCg4jKJaCAzAy7FjHP+jXxansE8';
const goldenSessionKey = '682efd18149e39a6';
const goldenSessionID = '3795d28242a11619bc25f786f84e53d4-h-1788007723938-9472a56a25dc49bc8d669b22c6db0142';
const goldenServerTs = 1788007723939;
const goldenIP = '106.219.217.208';
const goldenToken = 'U0dfV0VCIzM3OTVkMjgyNDJhMTE2MTliYzI1Zjc4NmY4NGU1M2Q0LWgtMTc4ODAwNzcyMzkzOC05NDcyYTU2YTI1ZGM0OWJjOGQ2NjliMjJjNmRiMDE0MiN6a1hnQTBlZEliVDR0RkN2Ly94VHlvTmVQRC9YbEZzbWNUZTRVOWI3bEtDK1gxbmFmeG93a1oxYVRrWHFIRHhWUnpKYzZvcnZaUlorYmxtbzZzQ29pdDh1VEx6eWR6MzlPSGFBelpoR216TlMwcS9xYkc4R2pRS1JTdDdjTTBianpIZGE2UE52U1A1TmZvVHlNWGVadmV3a2N0OFNYSEQyWHVVWHRxanQweXFkTWdBWWVvc2w5M0k4NkVNNUc2NTVjS0hlamJnVFdSQ1dvb2xjTWVnOTlleU9qeEl5TXBXbE50SHQ5SkMybDcxOW9FandkZlpIVWpNUEJuOW9sT2JyYnd5UVdwdG5lQkNYQVJCaGpEMGNLeDIxN1VRTDBocGZ0MVMweDRROXZxZWlSSVVVN2FEN2kyNksxVUJ0T3VocVR2OWdPMUE3dVdpYzg5R0YwK2s3YWh2RjJMRWFWOEhCZkxCZHNSVEtmaG0rZXg3MWJVQ0hHWjF1WGlGUSszeTdPd0dOd2JMcVAzQkRSZUNVcWNuMStOdTBXT1kreldlZlZ0NnhrVldNQ3A1ZzZVYU1lL3VHd0d6M3crN3FCcUdIbG1DVTdGdlJOMVZiM2V6VEFQWlJtSU1ZUllzd3h2YXhheGJlMlE5Skx3UFdlOEg4bGxiWkxXZExYTFlocDNKWER1SDhGbUpES3AzRXJtVm1URGVxNkZkMkIvSFcrc0cxNExDU0V2UnBObTVFQ1FWREFZd0xQejFPZ3R3a0lqTS9zSFZpeXJGclBiY0krZys4OGxZdWQ4V3ZFZk1lc1lSVWxWZHhyb25MOHo3OGtHVWVtK25Sc2VVcVY1ZDlONjVqL2dPWnNtNm51dSsvMWt2aFgrbzdvdndzL2tDQTc0OGc1WFpSMUJCOHliZGZCOHBpcmlMUkVHR2lQSjEzYkw3WUZjUGRGSlNMRE1GV2srYmdhbDNpNXlvcHUzTGV5Y3hHRGJ3em5aQ3VyWVlhYXNtVkx4TURDU1VwOWpFYVdTOXcxOXd2TWdPYlpadHVWQXZ6eERscyt2dE82QmJ4RkZxNzJ2QjluOXVxSGJWMnhURlk0NUJxay9hMDhTQWpTVkFOMkJzZ1lKRFNBbGlmZWV4UHNPS2tDY1ZTU05wWTU1UlVxK0ozTkl4S1duST0jNDA1OCNhZjQzNDI5YzY4NjkzZTlhN2I1ZjIzMmM1OThlZGVjNQ==';

test('TestDecryptDeviceConfig', () => {
    const s = decryptDeviceConfig(goldenDeviceConfig);
    assert.equal(s.sessionKey, goldenSessionKey);
    assert.equal(s.sessionId, goldenSessionID);
    assert.equal(s.serverTs, goldenServerTs);
    assert.equal(s.ip, goldenIP);
    // HC1: the sessionId embeds serverTs-1
    let embedded = s.sessionId.slice(s.sessionId.indexOf('-h-') + 3);
    const idx = embedded.indexOf('-');
    if (idx > 0) embedded = embedded.slice(0, idx);
    assert.equal(embedded, '1788007723938');
});

test('TestGoldenTokenRoundTrip', () => {
    const raw = Buffer.from(goldenToken, 'base64').toString('utf8');
    const parts = raw.split('#');
    assert.equal(parts.length, 5);
    const [tF, Q, w, tC, p] = parts;
    assert.equal(tF, 'SG_WEB');
    assert.equal(Q, goldenSessionID);
    assert.equal(tC, '4058');

    const seal = createHash('md5').update([tF, Q, w, tC, MD5_SECRET].join('#'), 'utf8').digest('hex');
    assert.equal(seal, p, 'md5 seal mismatch');

    const plain = decryptB64(goldenSessionKey, w);
    const fields = plain.split('#');
    assert.equal(fields.length, 140);

    // re-encrypt must reproduce w byte-exactly
    assert.equal(encryptB64(goldenSessionKey, plain), w);
});

test('TestAESCBCRoundTrip', () => {
    const key = '0123456789abcdef';
    for (const pt of ['', 'a', '0123456789abcdef', 'x'.repeat(1000)]) {
        const ct = aesCBCEncrypt(key, pt);
        assert.equal(ct.length % 16, 0);
        assert.equal(aesCBCDecrypt(key, ct).toString('utf8'), pt);
    }
});

test('TestMintTokensAreDistinctAndVerifiable', () => {
    const s = decryptDeviceConfig(goldenDeviceConfig);
    const raw = decryptB64(goldenSessionKey, Buffer.from(goldenToken, 'base64').toString('utf8').split('#')[2]);
    const tpl = newPayloadTemplate(raw.split('#'));

    const toks = mintTokens(s, tpl, 5, 0);
    assert.equal(toks.length, 5);
    const seen = new Set();
    for (const [i, tok] of toks.entries()) {
        assert.ok(!seen.has(tok), `token ${i} is a duplicate`);
        seen.add(tok);

        const fields = verifyToken(tok, s.sessionKey);
        assert.equal(fields.length, 140);
        assert.notEqual(fields[IDX_NOW], '');
        assert.equal(fields[IDX_IP], s.ip);
        assert.equal(fields[IDX_SERVER_TS], '1788007723939');

        const entries = fields[IDX_LOG].split('|');
        assert.ok(entries.length >= 2);
        const c93 = Number.parseInt(entries[entries.length - 2].split('-')[1], 10);
        const c94 = Number.parseInt(entries[entries.length - 1].split('-')[1], 10);
        assert.ok(c94 > c93, `entry 94 (${c94}) is not after entry 93 (${c93})`);
        assert.ok(c94 - c93 <= 15);

        const now = Number.parseInt(fields[IDX_NOW], 10);
        const init = Number.parseInt(fields[IDX_INIT_TIME], 10);
        assert.equal(c93, now - init);

        assert.equal(fields[IDX_EMPTY_93], '');
        assert.equal(fields[IDX_EMPTY_94], '');
    }
});

test('RES_KEY decrypts the golden blob', () => {
    assert.ok(decryptB64(RES_KEY, goldenDeviceConfig).split('#').length >= 9);
});
