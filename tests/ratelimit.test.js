// Tests for src/ratelimit.js — port of internal/zbridge/ratelimit_test.go.
//
// Go http.RoundTripper -> async base(req) function; req carries an optional
// AbortSignal instead of a context. recordingTransport becomes recordingBase.
// Timing assertions keep the Go slack values (timers fire no earlier than
// requested; scheduling slack is allowed).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    PacedTransport,
    newPacedTransport,
    upstreamMinInterval,
    randomUpstreamInterval,
    minUpstreamIntervalMS,
    maxUpstreamIntervalMS,
} from '../src/ratelimit.js';

// Notes when each request reached the underlying transport.
function recordingBase() {
    const times = [];
    const base = async (req) => {
        times.push(Date.now());
        return { status: 200, req };
    };
    base.times = times;
    base.gaps = () => times.slice(1).map((t, i) => t - times[i]);
    return base;
}

// pacedWithGap: builds a transport with a fixed interval, bypassing the
// environment lookup.
function pacedWithGap(base, gap) {
    return new PacedTransport(base, () => gap);
}

const REQ = () => ({ url: 'https://example.invalid/' });

function withEnv(t, value) {
    const saved = process.env.UPSTREAM_MIN_INTERVAL_MS;
    if (value === undefined) delete process.env.UPSTREAM_MIN_INTERVAL_MS;
    else process.env.UPSTREAM_MIN_INTERVAL_MS = value;
    t.after(() => {
        if (saved === undefined) delete process.env.UPSTREAM_MIN_INTERVAL_MS;
        else process.env.UPSTREAM_MIN_INTERVAL_MS = saved;
    });
}

test('paced transport spaces sequential requests', async () => {
    const rec = recordingBase();
    const gap = 40;
    const rt = pacedWithGap(rec, gap);

    for (let i = 0; i < 4; i++) {
        await rt.roundTrip(REQ());
    }
    for (const [i, got] of rec.gaps().entries()) {
        assert.ok(got >= gap - 5, `gap ${i} too small: ${got}ms, want >= ${gap}ms`);
    }
});

// A burst is the shape that trips the WAF, so concurrent callers must be
// spread out too, not merely delayed by the same amount.
test('paced transport spreads a burst', async () => {
    const rec = recordingBase();
    const gap = 25;
    const n = 6;
    const rt = pacedWithGap(rec, gap);

    const start = Date.now();
    await Promise.all(Array.from({ length: n }, () => rt.roundTrip(REQ())));

    assert.equal(rec.times.length, n, `want ${n} requests through`);
    // n requests at one per gap cannot finish faster than (n-1) gaps.
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= (n - 1) * gap - 10, `burst was not paced: ${n} requests in ${elapsed}ms`);
});

test('paced transport honours request cancellation', async () => {
    const rec = recordingBase();
    const rt = pacedWithGap(rec, 1000);

    // First request claims the slot immediately, the second must wait a second.
    await rt.roundTrip(REQ());

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20);
    try {
        await assert.rejects(rt.roundTrip({ ...REQ(), signal: ac.signal }), (err) => err.name === 'AbortError');
    } finally {
        clearTimeout(timer);
    }
    assert.equal(rec.times.length, 1, 'cancelled request still reached upstream');
});

// A zero interval must hand the request straight to the base transport.
test('paced transport disabled with zero interval', async () => {
    const rec = recordingBase();
    const rt = pacedWithGap(rec, 0);
    const start = Date.now();
    for (let i = 0; i < 3; i++) {
        await rt.roundTrip(REQ());
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed <= 20, `pacing still applied with a zero interval: ${elapsed}ms`);
});

// The interval is read on first use, so a value set after construction still
// takes effect — that is what lets the test harness switch pacing off.
test('paced transport reads the interval lazily', async (t) => {
    const rec = recordingBase();
    const rt = newPacedTransport(rec);
    withEnv(t, '0');
    const start = Date.now();
    for (let i = 0; i < 3; i++) {
        await rt.roundTrip(REQ());
    }
    const elapsed = Date.now() - start;
    assert.ok(elapsed <= 20, `environment set after construction was ignored: ${elapsed}ms`);
});

test('upstreamMinInterval from env', async (t) => {
    const cases = { '0': 0, '750': 750, '100': 100 };
    for (const [raw, want] of Object.entries(cases)) {
        process.env.UPSTREAM_MIN_INTERVAL_MS = raw;
        assert.equal(upstreamMinInterval(), want, `UPSTREAM_MIN_INTERVAL_MS=${raw}`);
    }

    // Unset / unparsable / negative values fall back to a random draw in
    // [200ms, 500ms].
    for (const raw of ['', 'nonsen', '-5']) {
        process.env.UPSTREAM_MIN_INTERVAL_MS = raw;
        for (let i = 0; i < 50; i++) {
            const got = upstreamMinInterval();
            assert.ok(
                got >= minUpstreamIntervalMS && got <= maxUpstreamIntervalMS,
                `UPSTREAM_MIN_INTERVAL_MS=${raw}: got ${got}, want [${minUpstreamIntervalMS}, ${maxUpstreamIntervalMS}]`,
            );
        }
    }
    delete process.env.UPSTREAM_MIN_INTERVAL_MS;
    const got = upstreamMinInterval();
    assert.ok(got >= minUpstreamIntervalMS && got <= maxUpstreamIntervalMS);
    t.after(() => delete process.env.UPSTREAM_MIN_INTERVAL_MS);
});

// The default draw must be crypto-random in [200ms, 500ms]. This cannot
// assert unpredictability (that is the point of crypto randomness), but it
// can assert the range and that repeated draws are not all identical — a
// pinned constant or a broken rand would fail the latter, since 200 draws
// of a uniform [200,500] draw colliding entirely is astronomically unlikely.
test('upstream interval random draw', () => {
    const seen = new Set();
    for (let i = 0; i < 200; i++) {
        const got = randomUpstreamInterval();
        assert.ok(
            got >= minUpstreamIntervalMS && got <= maxUpstreamIntervalMS,
            `draw ${i} out of range: ${got}`,
        );
        seen.add(got);
    }
    assert.ok(seen.size >= 2, `all 200 draws identical — the interval is not random`);
});
