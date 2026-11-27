// Regression tests for the /api/v2/chat/completions request contract.
//
// The z.ai web client (verified against the prod bundle, prod-fe-1.2.x) sends
// a specific query-parameter set, a specific header set and a specific body
// shape. When the bridge drifts from it, the upstream answers with a bare
// "500 Internal Server Error" — no field name, no hint. These tests pin the
// contract so a drift shows up as a failing test instead of an opaque 500.
//
// Reference: the site's own request builder
//   fetch(`${base}/chat/completions?${urlParams}`, {
//     headers: { Authorization, Content-Type, Accept-Language, X-FE-Version, X-Signature },
//     body: JSON.stringify({ stream, model, messages, signature_prompt, params,
//                             extra, files?, mcp_servers?, features, variables,
//                             session_id, chat_id, id, ...versionExtras })
//   })
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { config, clientVersion, zaiUserAgent, SALT_KEY, defaultSceneID } from '../src/config.js';
import { generateZaSignature, fingerprintParams } from '../src/util.js';
import { buildChatRequestBody } from '../src/zai.js';

// ---------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------

// The browser-fingerprint set the web client sends. A request that omits any
// of them can be rejected with an opaque 500.
const FINGERPRINT_KEYS = [
    'version',
    'platform',
    'token',
    'user_agent',
    'language',
    'languages',
    'timezone',
    'cookie_enabled',
    'screen_width',
    'screen_height',
    'screen_resolution',
    'viewport_height',
    'viewport_width',
    'viewport_size',
    'color_depth',
    'pixel_ratio',
    'current_url',
    'pathname',
    'search',
    'hash',
    'host',
    'hostname',
    'protocol',
    'referrer',
    'title',
    'timezone_offset',
    'local_time',
    'utc_time',
    'is_mobile',
    'is_touch',
    'max_touch_points',
];

function parseQuery(urlParams) {
    const out = {};
    for (const pair of urlParams.split('&')) {
        const idx = pair.indexOf('=');
        out[pair.slice(0, idx)] = decodeURIComponent(pair.slice(idx + 1).replace(/\+/g, ' '));
    }
    return out;
}

test('signed query carries the full web-client fingerprint set', () => {
    const { urlParams } = generateZaSignature('hello', 'tok', 'uid');
    const q = parseQuery(urlParams);

    for (const key of FINGERPRINT_KEYS) {
        assert.ok(key in q, `missing fingerprint parameter: ${key}`);
    }
    // The signature envelope on top of the fingerprint.
    for (const key of ['timestamp', 'requestId', 'user_id', 'signature_timestamp']) {
        assert.ok(key in q, `missing signature parameter: ${key}`);
    }
});

test('fingerprint parameters agree with the request headers', () => {
    const q = fingerprintParams('tok');
    // A mismatch between the query user_agent and the User-Agent header reads
    // as a spoofed client — they must be the same string.
    assert.equal(q.user_agent, zaiUserAgent);
    assert.equal(q.version, clientVersion);
    assert.equal(q.platform, 'web');
    assert.equal(q.token, 'tok');
});

test('version parameter matches what the deployed web client sends', () => {
    // prod bundle: version:"0.0.1"
    assert.equal(clientVersion, '0.0.1');
});

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

test('signature follows the web client algorithm', () => {
    const prompt = 'hello world';
    const { signature, timestamp, urlParams } = generateZaSignature(prompt, 'tok', 'uid');
    const q = parseQuery(urlParams);

    // sortedPayload: requestId/timestamp/user_id joined as "k,v" pairs, keys
    // sorted ascending.
    const sortedPayload = [
        ['requestId', q.requestId],
        ['timestamp', q.timestamp],
        ['user_id', q.user_id],
    ].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k},${v}`).join(',');

    const promptB64 = Buffer.from(prompt.trim(), 'utf8').toString('base64');
    const bucket = Math.floor(Number(timestamp) / 300000);
    const wKey = createHmac('sha256', Buffer.from(SALT_KEY)).update(String(bucket)).digest('hex');
    const expected = createHmac('sha256', Buffer.from(wKey))
        .update(sortedPayload + '|' + promptB64 + '|' + timestamp)
        .digest('hex');

    assert.equal(signature, expected);
});

test('signature_timestamp matches the signed timestamp', () => {
    const { timestamp, urlParams } = generateZaSignature('x', 'tok', 'uid');
    const q = parseQuery(urlParams);
    assert.equal(q.signature_timestamp, timestamp);
    assert.equal(q.timestamp, timestamp);
});

// ---------------------------------------------------------------------------
// Request body
// ---------------------------------------------------------------------------

const BASE_MESSAGES = [
    { role: 'user', id: 'm1', content: 'first' },
    { role: 'assistant', id: 'm2', content: 'reply' },
    { role: 'user', id: 'm3', content: 'second' },
];

test('body carries the v2 current-user-message identification', () => {
    const body = buildChatRequestBody({
        model: 'glm-5',
        chatID: 'chat-1',
        messages: BASE_MESSAGES,
        prompt: 'second',
        captchaParam: 'cap',
        features: { enable_thinking: true },
    });

    // The current user turn is identified by id, and by that message's parent.
    assert.equal(body.current_user_message_id, 'm3');
    assert.equal(body.current_user_message_parent_id, 'm2');
    // ...and the top-level id mirrors it.
    assert.equal(body.id, 'm3');
});

test('body always carries the web client container fields', () => {
    const body = buildChatRequestBody({
        model: 'glm-5',
        chatID: 'chat-1',
        messages: BASE_MESSAGES,
        prompt: 'second',
        captchaParam: 'cap',
        features: { enable_thinking: true },
    });

    for (const key of [
        'model', 'chat_id', 'messages', 'signature_prompt', 'stream', 'id',
        'current_user_message_id', 'current_user_message_parent_id',
        'captcha_verify_param', 'features', 'params', 'variables', 'extra',
        'session_id',
    ]) {
        assert.ok(key in body, `missing body field: ${key}`);
    }
    assert.equal(body.stream, true);
    assert.equal(body.session_id, 'chat-1');
});

test('a first-turn conversation has a null parent id', () => {
    const body = buildChatRequestBody({
        model: 'glm-5',
        chatID: 'chat-1',
        messages: [{ role: 'user', id: 'm1', content: 'only' }],
        prompt: 'only',
        captchaParam: 'cap',
        features: {},
    });

    assert.equal(body.current_user_message_id, 'm1');
    assert.equal(body.current_user_message_parent_id, null);
});

test('body omits files unless images were uploaded', () => {
    const common = {
        model: 'glm-5',
        chatID: 'chat-1',
        messages: BASE_MESSAGES,
        prompt: 'second',
        captchaParam: 'cap',
        features: {},
    };
    assert.equal('files' in buildChatRequestBody({ ...common }), false);
    assert.deepEqual(
        buildChatRequestBody({ ...common, files: [{ file_id: 'f1' }] }).files,
        [{ file_id: 'f1' }],
    );
});

test('body carries mcp_servers only for advanced search', () => {
    const common = {
        model: 'glm-5',
        chatID: 'chat-1',
        messages: BASE_MESSAGES,
        prompt: 'second',
        captchaParam: 'cap',
        features: {},
    };
    assert.equal('mcp_servers' in buildChatRequestBody({ ...common }), false);
    assert.deepEqual(
        buildChatRequestBody({ ...common, advancedSearch: true }).mcp_servers,
        ['advanced-search'],
    );
});

// ---------------------------------------------------------------------------
// Captcha scene
// ---------------------------------------------------------------------------

// The web client picks the captcha scene by hostname (prod bundle):
//   get SCENE_ID(){ return location.hostname === "chat.z.ai"
//                        ? "didk33e0" : "xswyjefn" }
// A captcha issued for the wrong scene is rejected by the upstream with a
// bare "500 Internal Server Error" — no field name, no hint.
test('captcha scene follows the deployment hostname', () => {
    assert.equal(defaultSceneID('https://chat.z.ai'), 'didk33e0');
    assert.equal(defaultSceneID('https://zchat.z.ai'), 'xswyjefn');
    assert.equal(defaultSceneID('https://zchat.z.ai/'), 'xswyjefn');
    // Anything that is not the international host uses the mainland scene.
    assert.equal(defaultSceneID('https://example.invalid'), 'xswyjefn');
});
