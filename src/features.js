// Port of internal/zbridge/features.go — per-model feature state plus the
// pure business logic of the /features endpoint (featuresHandler in
// handlers.go; the HTTP layer itself is Phase 4).
//
// Go's modelFeatureStatesMu is omitted (single-threaded event loop);
// modelFeatureStates is a Map in state.js.
//
// resolveFeaturesForModel consults the (possibly remote) model list, so it —
// and everything depending on it — is async, unlike the Go original.

import { modelFeatureStates, session } from './state.js';
import { logInfo } from './logger.js';
import { getModelCapabilities } from './models.js';

// Go: normalizeFeatureKey — camelCase -> snake_case (insert '_' before every
// uppercase rune except the first character, then lowercase).
export function normalizeFeatureKey(k) {
    let sb = '';
    let i = 0;
    for (const r of String(k)) {
        if (i > 0 && r >= 'A' && r <= 'Z') sb += '_';
        sb += r >= 'A' && r <= 'Z' ? r.toLowerCase() : r;
        i++;
    }
    return sb;
}

// getModelFeatureState returns the per-model state, creating it if necessary.
// ModelFeatureState = { includeAll: boolean, overrides: { snake_case: any } }.
export function getModelFeatureState(modelID) {
    let s = modelFeatureStates.get(modelID);
    if (s === undefined) {
        s = { includeAll: false, overrides: {} };
        modelFeatureStates.set(modelID, s);
    }
    return s;
}

// resolveFeaturesForModel computes the final feature map for /completions.
//
// Rules:
//   - By default, auto_web_search and web_search are NOT included.
//   - enable_thinking defaults to true for all models.
//   - 'think' is never included — only enable_thinking reaches the request.
//   - includeAll: include ALL server capabilities.
//   - User overrides always take precedence.
//   - image_generation is ALWAYS forced to false.
export async function resolveFeaturesForModel(modelID) {
    const caps = await getModelCapabilities(modelID);
    const state = modelFeatureStates.get(modelID) ??
        { includeAll: false, overrides: {} };
    return resolveFeaturesWithState(caps, state);
}

// resolveFeaturesWithState does the actual resolution given caps + state.
// caps may be null (unknown model).
export function resolveFeaturesWithState(caps, state) {
    const result = {};

    if (state.includeAll && caps != null) {
        // Include ALL server capabilities except reasoning_effort
        // (reasoning_effort in capabilities is a boolean support flag,
        //  not an actual feature value — handled separately per-request)
        for (const [k, v] of Object.entries(caps)) {
            if (k === 'reasoning_effort') continue;
            result[k] = v;
        }
    }
    // By default: no auto_web_search, no web_search, no think.
    // enable_thinking defaults to true (set below).

    // Apply user overrides (per-model stored overrides take precedence)
    for (const [k, v] of Object.entries(state.overrides)) {
        result[k] = v;
    }

    // Defensive: reasoning_effort is never a stored feature — strip any stale value.
    // It is a per-request parameter validated against model capabilities in sendToZAI.
    delete result.reasoning_effort;

    // enable_thinking defaults to true unless explicitly overridden
    if (!('enable_thinking' in result)) result.enable_thinking = true;

    // Remove 'think' entirely — only enable_thinking reaches the request
    delete result.think;

    // ALWAYS exclude image_generation
    result.image_generation = false;

    return result;
}

// ============================================================================
// /features ENDPOINT — pure logic (Go: featuresHandler in handlers.go).
// Both functions return { status, payload }; Phase 4 writes them as JSON.
// ============================================================================

// GET logic: with a model, its resolved features + state + capabilities;
// without one, every stored per-model state.
export async function getFeaturesResponse(model) {
    if (model) {
        const resolved = await resolveFeaturesForModel(model);
        const state = getModelFeatureState(model);
        const caps = await getModelCapabilities(model);
        return {
            status: 200,
            payload: {
                model,
                features: resolved,
                includeAll: state.includeAll,
                overrides: state.overrides,
                capabilities: caps,
            },
        };
    }
    const states = {};
    for (const [k, v] of modelFeatureStates) {
        states[k] = { includeAll: v.includeAll, overrides: v.overrides };
    }
    return { status: 200, payload: { states } };
}

// POST logic: update per-model feature state.
//   body: parsed JSON object (must contain "model"; every other key is a
//         feature override)
//   includeAll: the Include-All-Features header, already compared
//         case-insensitively against "true" by the caller (Phase 4).
// Returns { status, payload }; status 400 payloads carry { error }.
export async function applyFeatureOverrides(body, includeAll) {
    const model = typeof body?.model === 'string' ? body.model : '';
    if (model === '') {
        return { status: 400, payload: { error: 'model is required' } };
    }

    const state = getModelFeatureState(model);

    // Set includeAll flag if the header was present
    if (includeAll) state.includeAll = true;

    // Process user overrides — any key except "model" is treated as a
    // feature override. Special handling: reasoning/thinking -> enable_thinking
    for (const [k, v] of Object.entries(body)) {
        if (k === 'model') continue;

        // reasoning: true/false -> enable_thinking
        if (k === 'reasoning') {
            if (typeof v === 'boolean') state.overrides.enable_thinking = v;
            continue;
        }

        // "thinking": {"type":"enabled"|"disabled"} or thinking: true/false
        // -> enable_thinking
        if (k === 'thinking') {
            if (typeof v === 'boolean') {
                state.overrides.enable_thinking = v;
                continue;
            }
            if (v && typeof v === 'object') {
                if (typeof v.type === 'string') {
                    state.overrides.enable_thinking = v.type === 'enabled';
                }
                continue;
            }
            continue;
        }

        // All other keys: convert camelCase to snake_case (no alias mapping)
        const snakeKey = normalizeFeatureKey(k);
        // image_generation overrides are ignored — always forced false
        if (snakeKey === 'image_generation') continue;
        // 'think' is not accepted — use enable_thinking, reasoning, or thinking
        if (snakeKey === 'think') continue;
        // reasoning_effort is a per-request parameter validated against model
        // capabilities; it is NOT stored as a persistent override.
        if (snakeKey === 'reasoning_effort') continue;
        state.overrides[snakeKey] = v;
    }

    // Resolve final features for the response
    const caps = await getModelCapabilities(model);
    const resolved = resolveFeaturesWithState(caps, state);
    const includeAllNow = state.includeAll;
    const overrides = { ...state.overrides };

    // Update session.features for backward compat (dashboard display)
    if (typeof resolved.auto_web_search === 'boolean') {
        session.features.webSearch = resolved.auto_web_search;
        session.features.autoWebSearch = resolved.auto_web_search;
    }
    if (typeof resolved.enable_thinking === 'boolean') {
        session.features.thinking = resolved.enable_thinking;
    }
    if (typeof resolved.preview_mode === 'boolean') {
        session.features.previewMode = resolved.preview_mode;
    }
    session.features.imageGen = false;

    logInfo(
        `[Features] model=${model} includeAll=${includeAllNow} overrides=${JSON.stringify(overrides)} resolved=${JSON.stringify(resolved)}`);

    return {
        status: 200,
        payload: {
            success: true,
            model,
            includeAll: includeAllNow,
            overrides,
            features: resolved,
        },
    };
}
