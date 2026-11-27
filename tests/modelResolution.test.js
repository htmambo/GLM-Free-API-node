// Regression tests for model-id resolution.
//
// The upstream answers an unknown model id with a bare "500 Internal Server
// Error" — the same opaque failure a request-shape drift produces. The
// bridge therefore resolves the requested id against the live catalogue
// before it is sent upstream.
//
// The catalogue is deployment-specific and changes over time: the deployment
// this bridge was verified against served glm-5.4 / x-preview-l / glm-5.3 /
// glm-5.2, and the generic id "glm-5" that older clients (and the original
// Go port) default to is NOT among them.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveModelID } from '../src/models.js';
import { setModelsCache } from '../src/state.js';
import { flushModelsCache } from '../src/handlers.js';

// The catalogue the upstream returned during verification.
const LIVE_MODELS = [
    { id: 'glm-5.4', name: 'GLM-5.4', capabilities: { reasoning_effort: true, vision: true } },
    { id: 'x-preview-l', name: 'GLM-5.3-Flash', capabilities: { reasoning_effort: true, vision: true } },
    { id: 'glm-5.3', name: 'GLM-5.3', capabilities: { reasoning_effort: true } },
    { id: 'glm-5.2', name: 'GLM-5.2', capabilities: { reasoning_effort: true } },
];

function withLiveCatalogue(fn) {
    flushModelsCache();
    setModelsCache(LIVE_MODELS);
    return Promise.resolve(fn()).finally(() => flushModelsCache());
}

test('an exact model id is used as-is', async () => {
    await withLiveCatalogue(async () => {
        const r = await resolveModelID('glm-5.2');
        assert.equal(r.model, 'glm-5.2');
        assert.equal(r.resolved, true);
        assert.equal(r.requested, 'glm-5.2');
    });
});

test('model matching is case-insensitive', async () => {
    await withLiveCatalogue(async () => {
        const r = await resolveModelID('GLM-5.4');
        assert.equal(r.model, 'glm-5.4');
        assert.equal(r.resolved, true);
    });
});

test('the generic "glm-5" id falls back to a model the upstream serves', async () => {
    await withLiveCatalogue(async () => {
        const r = await resolveModelID('glm-5');
        // "glm-5" is not in the catalogue — using it as-is is what produced the
        // upstream 500.
        assert.ok(!LIVE_MODELS.some((m) => m.id === 'glm-5'));
        assert.ok(LIVE_MODELS.some((m) => m.id === r.model), 'fallback must be a live model');
        assert.equal(r.resolved, false);
        assert.equal(r.requested, 'glm-5');
    });
});

test('an omitted model resolves to a model every tier can reach', async () => {
    await withLiveCatalogue(async () => {
        const r = await resolveModelID('');
        // The flagship models are gated behind a paid tier and answer "Model
        // not available for current user level" on a free account, so the
        // default is the Flash model.
        assert.equal(r.model, 'x-preview-l');
        assert.equal(r.resolved, false);
    });
});

test('an unknown model id never reaches the upstream unchanged', async () => {
    await withLiveCatalogue(async () => {
        for (const requested of ['gpt-4o', 'glm-9', 'glm-5.9', 'nonexistent']) {
            const r = await resolveModelID(requested);
            assert.notEqual(r.model, requested, `"${requested}" must not be forwarded as-is`);
            assert.ok(LIVE_MODELS.some((m) => m.id === r.model));
        }
    });
});

test('resolution degrades gracefully when the catalogue is empty', async () => {
    flushModelsCache();
    try {
        const r = await resolveModelID('glm-5');
        assert.equal(typeof r.model, 'string');
        assert.ok(r.model.length > 0, 'a fallback model id must always be produced');
    } finally {
        flushModelsCache();
    }
});
