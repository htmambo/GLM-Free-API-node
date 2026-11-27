// Port of internal/zbridge/ratelimit.go — upstream pacing.
//
// One proxied chat request costs several upstream calls (captcha challenge,
// the completion, the retiring DELETE) plus background pool refills, so
// bursts hit chat.z.ai far harder than the request count suggests — and
// Aliyun's WAF answers a burst by blocking the source IP for hours. Pacing
// every upstream call through one shared gate keeps a burst from ever
// forming. It is deliberately a floor on the gap between requests, not a
// token bucket: a bucket lets a burst through as long as the average holds,
// which is exactly the shape that trips the WAF.
//
// Go -> JS mapping:
//   - http.RoundTripper wrapper -> PacedTransport wrapping a `base(req)`
//     async function (the seam where httpClient's fetch backend plugs in).
//     `req` is opaque to the transport; if it carries an `signal`
//     (AbortSignal), a pending wait aborts with it (Go: req.Context()).
//   - sync.Mutex / sync.Once    -> omitted (single-threaded event loop);
//     the lazy gap resolution uses a resolved flag instead of gapOnce.
//   - time.Duration             -> milliseconds (number).
//
// UPSTREAM_MIN_INTERVAL_MS pins the interval explicitly; 0 disables pacing
// entirely. Unset, the interval is drawn once per transport from a
// cryptographically random 200–500 ms — a fixed gap is itself a fingerprint,
// and node:crypto (not Math.random) so the draw is not guessable.

import { randomInt } from 'node:crypto';

export const minUpstreamIntervalMS = 200;
export const maxUpstreamIntervalMS = 500;

// Go: randomUpstreamInterval() — cryptographically random duration in
// [200ms, 500ms]. Falls back to the midpoint if the entropy source fails
// (never happens with node:crypto, but a dead source must not take pacing
// down with it).
export function randomUpstreamInterval() {
    try {
        return minUpstreamIntervalMS + randomInt(maxUpstreamIntervalMS - minUpstreamIntervalMS + 1);
    } catch {
        return Math.floor((minUpstreamIntervalMS + maxUpstreamIntervalMS) / 2);
    }
}

// Go strconv.Atoi semantics: optional sign + digits only.
function atoi(s) {
    if (!/^[+-]?\d+$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isSafeInteger(n)) return null;
    return n;
}

// Go: upstreamMinInterval() — env override, else one random draw. Unset,
// empty, unparsable or negative values fall back to the random draw.
export function upstreamMinInterval() {
    const raw = process.env.UPSTREAM_MIN_INTERVAL_MS;
    if (raw === undefined || raw === '') {
        return randomUpstreamInterval();
    }
    const ms = atoi(raw);
    if (ms === null || ms < 0) {
        return randomUpstreamInterval();
    }
    return ms;
}

function abortError(signal) {
    if (signal && signal.reason instanceof Error) return signal.reason;
    const err = new Error('The operation was aborted');
    err.name = 'AbortError';
    return err;
}

// Sleep that rejects if the signal aborts first (Go: select on timer.C /
// req.Context().Done()).
function sleepWithSignal(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError(signal));
            return;
        }
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, ms);
        const onAbort = () => {
            cleanup();
            reject(abortError(signal));
        };
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

// Go: pacingGate. One slot allocator, shared process-wide. The Go version
// moved the clock out of pacedTransport because per-transport clocks interleave
// their slots: alternating Z.AI and Aliyun calls collapsed the real gap to
// nearly zero, which is exactly the burst shape issue #41 tripped on.
export class PacingGate {
    // gapFor: () => ms, default reads the env.
    constructor(gapFor = upstreamMinInterval) {
        this.gapFor = gapFor;
        this.gapResolved = false;
        this.gap = 0;
        this.next = 0; // ms epoch: earliest instant the next request may start
    }

    minGap() {
        if (!this.gapResolved) {
            const gapFor = this.gapFor ?? upstreamMinInterval;
            this.gap = gapFor();
            this.gapResolved = true;
        }
        return this.gap;
    }

    // claim returns how long the caller must wait before starting. Concurrent
    // callers queue up instead of all waiting for the same instant and then
    // firing together. (Single-threaded, so this read-modify-write is atomic
    // between awaits.)
    claim() {
        const minGap = this.minGap();
        if (minGap <= 0) return 0; // pacing disabled
        const now = Date.now();
        let slot = this.next;
        if (slot < now) slot = now;
        this.next = slot + minGap;
        return slot - now;
    }

    // resetForTests re-reads the interval on the next claim.
    resetForTests() {
        this.gapResolved = false;
        this.gap = 0;
        this.next = 0;
    }
}

// Go: sharedPacingGate — the one gate every upstream transport uses.
export const sharedPacingGate = new PacingGate();

// Go: pacedTransport. Spaces out the requests handed to base. Callers await
// roundTrip until their slot is due, so pacing applies no matter which code
// path issues the call.
export class PacedTransport {
    // base: async (req) => response. gate: PacingGate, or a gapFor function
    // (tests), defaulting to the shared gate.
    constructor(base, gate = sharedPacingGate) {
        this.base = base;
        this.gate = typeof gate === 'function' ? new PacingGate(gate) : gate;
    }

    async roundTrip(req) {
        const wait = this.gate.claim();
        if (wait > 0) {
            await sleepWithSignal(wait, req?.signal);
        }
        return this.base(req);
    }
}

// Go: newPacedTransport(base) — wraps base with the shared gate.
export function newPacedTransport(base) {
    return new PacedTransport(base);
}

// pace() is the direct seam for call sites that are not a RoundTripper
// equivalent (zaiFetch in httpClient.js). It applies the same shared gate.
export async function pace(signal) {
    const wait = sharedPacingGate.claim();
    if (wait > 0) {
        await sleepWithSignal(wait, signal);
    }
}
