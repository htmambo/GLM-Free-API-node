// Port of internal/zbridge/waf.go — Aliyun WAF circuit breaker (issue #41).
//
// Sustained agent traffic trips the Aliyun WAF in front of chat.z.ai: the
// egress IP (not the bridge, not the account) gets served the block page on
// POST /api/v2/chat/completions for a while. The block is IP-wide and
// outlives any single request, so retrying immediately is guaranteed to fail
// while making the block worse.
//
// Once the block page is detected the breaker opens: requests fail fast with
// a clean error instead of burning a captcha (each one costs a harvested
// device token and ~10-15 s of signing work), chat deletions pause, and a
// dedicated background prober re-checks the blocked endpoint after each
// cooldown — doubling the backoff while the block persists — and resumes
// traffic automatically the moment it lifts.
//
// Go -> JS mapping:
//   - sync.Mutex + probeGen uint64 -> single-threaded event loop; the async
//     prober re-reads state between awaits, and probeGen still guards
//     stale probers that were suspended across a transition.
//   - time.Duration                -> milliseconds (number).

import { BASE_URL, zaiUserAgent } from './config.js';
import { zaiFetch } from './httpClient.js';
import { writeJSON } from './middleware.js';

export const ERR_WAF_BLOCK =
    "chat.z.ai has temporarily blocked this server's IP (Aliyun WAF). " +
    'All requests will fail until the block expires; retry after the suggested delay';

// Breaker states. There is no half-open state on purpose: probing is owned by
// a dedicated background prober, so request handlers only ever see closed
// (proceed) or open (fail fast).
export const breakerClosed = 0;
export const breakerOpen = 1;

const wafBaseCooldown = 60_000; // 60s
const wafMaxCooldown = 30 * 60_000; // 30min
const wafProbeEndpoint = '/api/v2/chat/completions';
const wafBlockMarker = 'blocked as it may cause potential threats';
const wafProbeBodyLimit = 8192;
const errorBodyLimit = 512;

// wafProberSlice is how often a waiting prober re-checks the breaker state.
// Exported for tests to shrink.
export let wafProberSlice = 1000;

export function setWafProberSliceForTests(ms) {
    wafProberSlice = ms;
}

// Shortens the live cooldown so a prober reaches its probe in tests.
export function setWafCooldownForTests(ms) {
    if (wafBreaker.state === breakerOpen) wafBreaker.cooldown = ms;
}

const wafBreaker = {
    state: breakerClosed,
    openedAt: 0,
    cooldown: 0,
    blockCount: 0,
    // probeGen invalidates outstanding probers: every transition that changes
    // the plan bumps it, and a prober holding a stale generation exits.
    probeGen: 0,
};

// wafProbeTransport issues the actual probe: a bare POST to the blocked
// endpoint with no auth and an empty body. A package-level binding so tests
// can swap it for a stub.
export let wafProbeTransport = async () => {
    const resp = await zaiFetch(BASE_URL + wafProbeEndpoint, {
        method: 'POST',
        headers: {
            'User-Agent': zaiUserAgent,
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.9',
            'Content-Type': 'application/json',
        },
        body: '{}',
    });
    const text = await resp.text();
    return { status: resp.status, body: text };
};

export function setWafProbeTransportForTests(fn) {
    wafProbeTransport = fn;
}

// isWAFBlockResponse reports whether an upstream response is the Aliyun WAF
// block page. The page is served with status 405 (occasionally 403) and its
// body carries the marker string; the status alone is not enough because
// Z.AI itself returns 405 for genuinely unsupported methods on other paths.
export function isWAFBlockResponse(statusCode, body) {
    if (statusCode !== 405 && statusCode !== 403) return false;
    if (!body || body.length === 0) return false;
    const s = typeof body === 'string' ? body : String(body);
    // Cheap pre-filter: the block page is HTML; a JSON error is not.
    if (!s.includes('<')) return false;
    return s.includes(wafBlockMarker) ||
        s.includes('errors.aliyun.com') ||
        s.includes('您的访问被阻断');
}

function logWAFBlock(msg) {
    // Standard error path (not the verbose-gated logInfo) on purpose: an
    // IP-level block is an operational event operators must see.
    console.error(`[WAF] ${msg}`);
}

// RecordWAFBlock marks the IP as blocked and opens the breaker. Opening it
// also launches the background prober; callers never own the probe.
export function recordWAFBlock() {
    wafBreaker.blockCount++;
    if (wafBreaker.state === breakerClosed) {
        wafBreaker.state = breakerOpen;
        wafBreaker.openedAt = Date.now();
        wafBreaker.cooldown = wafBaseCooldown;
        wafBreaker.probeGen++;
        const gen = wafBreaker.probeGen;
        logWAFBlock('WAF block detected — opening circuit breaker (fail fast; probing with backoff)');
        wafProber(gen).catch((err) => {
            logWAFBlock(`prober stopped unexpectedly: ${err?.message ?? err}`);
        });
    }
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

// wafProber waits out the current cooldown, then probes once. If the block
// persists it re-opens with a doubled cooldown (and schedules itself again);
// if cleared it closes the breaker. A stale generation exits without probing.
async function wafProber(gen) {
    for (;;) {
        if (!(await wafSleepCooldown(gen))) return;
        if (!wafClaimProbe(gen)) return;
        const blocked = await wafProbeOnce();

        if (wafBreaker.probeGen !== gen || wafBreaker.state === breakerClosed) {
            return; // closed or superseded while the probe was in flight
        }
        if (blocked) {
            wafBreaker.state = breakerOpen;
            wafBreaker.openedAt = Date.now();
            wafBreaker.cooldown = Math.min(wafBreaker.cooldown * 2, wafMaxCooldown);
            logWAFBlock(`WAF block persists — backing off ${Math.round(wafBreaker.cooldown / 1000)}s before next probe`);
            continue;
        }
        wafBreaker.state = breakerClosed;
        wafBreaker.cooldown = 0;
        wafBreaker.blockCount = 0;
        wafBreaker.probeGen++;
        logWAFBlock('WAF block cleared — circuit breaker closed, traffic resumed');
        return;
    }
}

// wafSleepCooldown waits out the CURRENT cooldown in slices, recomputing the
// deadline from live state each tick. Returns false when the breaker closed
// or was superseded while waiting.
async function wafSleepCooldown(gen) {
    for (;;) {
        if (wafBreaker.probeGen !== gen || wafBreaker.state === breakerClosed) return false;
        let remaining = wafBreaker.openedAt + wafBreaker.cooldown - Date.now();
        if (remaining <= 0) return true;
        if (remaining > wafProberSlice) remaining = wafProberSlice;
        await sleep(remaining);
    }
}

function wafClaimProbe(gen) {
    return wafBreaker.probeGen === gen && wafBreaker.state !== breakerClosed;
}

async function wafProbeOnce() {
    try {
        const resp = await wafProbeTransport();
        const body = resp.body == null ? '' : String(resp.body).slice(0, wafProbeBodyLimit);
        return isWAFBlockResponse(resp.status, body);
    } catch {
        // A transport-level failure is treated as "still blocked"
        // (conservative) but never throws.
        return true;
    }
}

// RecordWAFSuccess notes that upstream is reachable again. Any non-block
// response (even a normal API error like 401/400) proves the IP is not
// blocked, so it closes the breaker and resets the backoff.
export function recordWAFSuccess() {
    if (wafBreaker.state !== breakerClosed || wafBreaker.blockCount !== 0) {
        wafBreaker.state = breakerClosed;
        wafBreaker.cooldown = 0;
        wafBreaker.blockCount = 0;
        wafBreaker.probeGen++;
    }
}

// CheckWAF returns { err: string|null, retryIn: ms }. Never blocks and never
// issues network traffic: probing is owned by the background prober.
export function checkWAF() {
    if (wafBreaker.state === breakerClosed) return { err: null, retryIn: 0 };
    const remaining = Math.max(0, wafBreaker.cooldown - (Date.now() - wafBreaker.openedAt));
    return {
        err: `${ERR_WAF_BLOCK} (retry in ~${formatDuration(roundSeconds(remaining))})`,
        retryIn: remaining,
    };
}

// wafRetryHint reports the current cooldown for error messages.
export function wafRetryHint() {
    if (wafBreaker.state === breakerClosed) return wafBaseCooldown;
    return Math.max(0, wafBreaker.cooldown - (Date.now() - wafBreaker.openedAt));
}

// WAFStatus reports the breaker state for /status.
export function wafStatus() {
    const st = {
        blocked: wafBreaker.state !== breakerClosed,
        state: wafBreaker.state,
    };
    if (wafBreaker.state !== breakerClosed) {
        const remaining = Math.max(0, wafBreaker.openedAt + wafBreaker.cooldown - Date.now());
        st.retryIn = formatDuration(roundSeconds(remaining));
        st.consecutiveBlocks = wafBreaker.blockCount;
    }
    return st;
}

// RejectIfWAFBlocked is the handler-level gate. Returns true when the request
// has been answered (503 + Retry-After).
export function rejectIfWAFBlocked(res) {
    const { err, retryIn } = checkWAF();
    if (err === null) return false;
    writeWAFResponse(res, err, retryIn);
    return true;
}

function writeWAFResponse(res, err, retryIn) {
    res.setHeader('Retry-After', String(Math.trunc(retryIn / 1000 + 0.5)));
    writeJSON(res, 503, {
        error: {
            type: 'overloaded_error',
            code: 'waf_block',
            message: err,
            retryIn: formatDuration(roundSeconds(retryIn)),
        },
    });
}

function roundSeconds(ms) {
    return Math.round(ms / 1000) * 1000;
}

// formatDuration renders whole-second durations the way Go's
// time.Duration.String does ("45s", "1m30s", "0s").
export function formatDuration(ms) {
    const total = Math.trunc(ms / 1000);
    if (total <= 0) return '0s';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    let out = '';
    if (h > 0) out += `${h}h`;
    if (h > 0 || m > 0) out += `${m}m`;
    out += `${s}s`;
    return out;
}

// truncateErrorBody keeps non-WAF upstream error bodies short in
// client-facing messages (issue #41).
export function truncateErrorBody(body) {
    const s = String(body ?? '').trim();
    if (s.length <= errorBodyLimit) return s;
    return s.slice(0, errorBodyLimit) + '...(truncated)';
}

// resetWAFForTests restores the process-wide breaker to its initial state.
export function resetWAFForTests() {
    wafBreaker.state = breakerClosed;
    wafBreaker.openedAt = 0;
    wafBreaker.cooldown = 0;
    wafBreaker.blockCount = 0;
    wafBreaker.probeGen++;
}
