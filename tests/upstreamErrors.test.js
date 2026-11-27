// Regression tests for upstream failure handling.
//
// Z.AI reports "this model is busy" as MODEL_CONCURRENCY_LIMIT inside a
// HTTP 200 SSE stream. That is a transient condition on the upstream's side:
// the identical request succeeds minutes later. The bridge therefore
//   * retries once with another model from the catalogue, and
//   * answers 503 (retryable) instead of 500 when it cannot.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isCapacityError, statusFromError } from '../src/zai.js';

test('a capacity error is recognised', () => {
    assert.equal(isCapacityError(new Error(
        'Z.AI error: Model is currently at capacity. Please try again later. (code: MODEL_CONCURRENCY_LIMIT)')), true);
});

test('other upstream errors are not capacity errors', () => {
    assert.equal(isCapacityError(new Error('Z.AI error: 401 Unauthorized')), false);
    assert.equal(isCapacityError(new Error('Z.AI error 400: message id (id) is required')), false);
    assert.equal(isCapacityError(null), false);
    assert.equal(isCapacityError(new Error('')), false);
});

test('a tier-gated model is treated as a capacity condition', () => {
    // The flagship models answer this on a free account; another model in
    // the same catalogue serves the request fine.
    assert.equal(isCapacityError(new Error(
        'Z.AI error 403: Model not available for current user level (code: 403)')), true);
});

test('capacity and transient upstream faults answer 503, not 500', () => {
    // 500 tells the client the request itself was broken. These failures are
    // on Z.AI's side and the same request succeeds later, so they must be
    // reported as retryable.
    assert.equal(statusFromError(
        'Z.AI error: Model is currently at capacity. (code: MODEL_CONCURRENCY_LIMIT)'), 503);
    assert.equal(statusFromError(
        'Z.AI error: Oops, something went wrong. (code: INTERNAL_ERROR)'), 503);
});

test('client-side upstream errors keep their own status codes', () => {
    assert.equal(statusFromError('Z.AI 401 Unauthorized'), 401);
    assert.equal(statusFromError('Z.AI 403 Forbidden'), 403);
    assert.equal(statusFromError('Z.AI error 429: too many requests'), 429);
    assert.equal(statusFromError('Z.AI error 400: bad request'), 400);
});

test('an unrecognised upstream failure still answers 500', () => {
    assert.equal(statusFromError('Z.AI error 418: something odd'), 500);
});
