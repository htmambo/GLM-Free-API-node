// Port of internal/zbridge/vision_test.go — tests for the vision pipeline's
// message rewriting. The upload endpoint is mocked via BASE_URL (setBaseURL);
// no captcha/session pool is involved.
//
// Go's OverrideSessionState test hook has no exported Node counterpart yet —
// the session singleton is a plain object, so the test swaps and restores
// the fields directly (same effect).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { processVisionMessages } from '../src/vision.js';
import { setBaseURL, BASE_URL } from '../src/config.js';
import { session } from '../src/state.js';

// tinyPngB64 is a valid 1x1 transparent PNG (base64).
const tinyPngB64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

// Swap the Z.AI session identity and return a restore function
// (Go: testhooks.go OverrideSessionState).
function overrideSessionState(token, userID, initialized) {
    const old = { token: session.token, userID: session.userID, initialized: session.initialized };
    session.token = token;
    session.userID = userID;
    session.initialized = initialized;
    return () => {
        session.token = old.token;
        session.userID = old.userID;
        session.initialized = old.initialized;
    };
}

// Verifies the core vision linkage: every image_url part stays in the
// message, but its url is replaced with the uploaded file's id (the exact
// reference form the chat.z.ai web client sends). Text parts and message
// structure are preserved.
test('processVisionMessages replaces url with file id', async (t) => {
    const mockFileID = 'test-file-id-123';

    const upstream = createServer((req, res) => {
        if (req.url === '/api/v1/files/' && req.method === 'POST') {
            const ct = req.headers['content-type'] ?? '';
            if (!ct.startsWith('multipart/form-data;')) {
                res.writeHead(400).end('expected multipart/form-data');
                return;
            }
            // Drain the upload body; verify it carries a "file" part.
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => {
                const body = Buffer.concat(chunks).toString('latin1');
                if (!body.includes('name="file"')) {
                    res.writeHead(400).end('missing file part');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: mockFileID,
                    user_id: 'test-user',
                    hash: null,
                    filename: 'image.png',
                    data: {},
                    meta: {
                        name: 'image.png',
                        content_type: 'image/png',
                        size: 70,
                        cdn_url: 'https://cdn.example/' + mockFileID,
                        data: {},
                        oss_endpoint: 'bj',
                    },
                    created_at: 1787884926,
                    updated_at: 1787884926,
                }));
            });
            return;
        }
        res.writeHead(404).end();
    });
    await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
    t.after(() => upstream.close());
    const port = upstream.address().port;

    const oldBase = BASE_URL;
    setBaseURL(`http://127.0.0.1:${port}`);
    t.after(() => setBaseURL(oldBase));
    const restoreSession = overrideSessionState('test-token', 'test-user', true);
    t.after(restoreSession);

    const raw = `[
      {"role":"system","content":"be brief"},
      {"role":"user","content":[
        {"type":"text","text":"what is this"},
        {"type":"image_url","image_url":{"url":"data:image/png;base64,${tinyPngB64}"}}
      ]}
    ]`;

    const { rewritten, files } = await processVisionMessages(raw);
    assert.equal(files.length, 1, 'files len');
    assert.equal(files[0].id, mockFileID, 'files[0].id');

    // Parse the rewritten messages and check the image_url part now points
    // at the file id while the text part and system message are untouched.
    const msgs = JSON.parse(rewritten);
    assert.equal(msgs.length, 2, 'rewritten messages len');
    assert.equal(msgs[0].role, 'system');
    assert.equal(msgs[0].content, 'be brief', 'system message altered');

    const parts = msgs[1].content;
    assert.ok(Array.isArray(parts), 'user content must stay a parts array');
    assert.equal(parts.length, 2, 'user content parts (image part must be kept)');
    assert.equal(parts[0].type, 'text');
    assert.equal(parts[0].text, 'what is this', 'text part altered');
    assert.equal(parts[1].type, 'image_url');
    assert.ok(parts[1].image_url, 'image_url part missing');
    assert.equal(parts[1].image_url.url, mockFileID, 'image_url.url must be the file id');
    assert.ok(!rewritten.includes('data:image/png;base64,'),
        'original data: URL still present in rewritten messages');
});

// Text-only requests pass through byte-for-byte with no files.
test('processVisionMessages: no images passthrough', async () => {
    const raw = '[{"role":"user","content":"just text"}]';
    const { rewritten, files } = await processVisionMessages(raw);
    assert.equal(files, null, 'files must be null for text-only input');
    assert.equal(rewritten, raw, 'text-only messages altered');
});
