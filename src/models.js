// Port of internal/zbridge/models.go — Z.AI model listing + capability
// helpers.
//
// Go's synchronous fetchModelsFromZAI becomes async (it performs network
// I/O); every helper that consults the model list is therefore async too.
// The HTTP handler layer (writeJSON / modelsHandler / modelsHandler2) is
// Phase 4 — the pure payload builders live here as buildModelsListResponse
// and buildModelsSimpleResponse.

import { BASE_URL, zaiUserAgent } from './config.js';
import {
    session,
    modelsCache,
    modelsCacheTime,
    setModelsCache,
    modelsCacheTTL,
    fallbackModels,
} from './state.js';
import { logError, logInfo } from './logger.js';
import { zaiFetch } from './httpClient.js';

// fetchModelsFromZAI retrieves models from Z.AI /api/models,
// keeping only glm-4.7 and newer (the API returns newest-first).
// ModelInfo = { id, name, description, capabilities, created }.
export async function fetchModelsFromZAI() {
    // Go: modelsCacheMu omitted (single-threaded event loop).
    if (modelsCache.length > 0 && Date.now() - modelsCacheTime < modelsCacheTTL) {
        return modelsCache;
    }

    let body;
    try {
        const resp = await zaiFetch(BASE_URL + '/api/models', {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'authorization': 'Bearer ' + session.token,
                'User-Agent': zaiUserAgent,
            },
            signal: AbortSignal.timeout(15_000),
        });
        if (resp.status !== 200) {
            logError(`fetchModels status: ${resp.status}`);
            return modelsCache.length > 0 ? modelsCache : fallbackModels;
        }
        body = await resp.json();
    } catch (err) {
        logError('fetchModels: ' + err.message);
        return modelsCache.length > 0 ? modelsCache : fallbackModels;
    }

    const data = Array.isArray(body?.data) ? body.data : [];
    const filtered = [];
    for (const m of data) {
        filtered.push({
            id: m.id,
            name: m.name,
            description: m.info?.meta?.description,
            capabilities: m.info?.meta?.capabilities,
            created: m.created,
        });
        if (m.id === 'glm-4.7') break;
    }

    if (filtered.length > 0) {
        setModelsCache(filtered);
        logInfo(`Fetched ${filtered.length} models from Z.AI`);
    }

    return modelsCache.length > 0 ? modelsCache : fallbackModels;
}

// getFeaturesForModel maps a model's capabilities to a Features object.
// thinking defaults to true; webSearch/autoWebSearch default to false.
export async function getFeaturesForModel(modelID) {
    const f = {
        webSearch: false,
        autoWebSearch: false,
        thinking: true, // enable_thinking enabled by default
        imageGen: false,
        previewMode: false,
    };
    for (const m of await fetchModelsFromZAI()) {
        // strings.EqualFold — ASCII case-insensitive suffices for model IDs.
        if (m.id.toLowerCase() === modelID.toLowerCase()) {
            const caps = m.capabilities ?? {};
            if (typeof caps.enable_thinking === 'boolean') f.thinking = caps.enable_thinking;
            if (typeof caps.preview_mode === 'boolean') f.previewMode = caps.preview_mode;
            break;
        }
    }
    return f;
}

// getModelCapabilities returns the raw capabilities map for a model,
// or null when the model is unknown.
export async function getModelCapabilities(modelID) {
    for (const m of await fetchModelsFromZAI()) {
        if (m.id.toLowerCase() === modelID.toLowerCase()) {
            return m.capabilities ?? null;
        }
    }
    return null;
}

// modelSupportsReasoningEffort returns true only when the model's capabilities
// JSON explicitly contains "reasoning_effort": true.
// Models with "reasoning_effort": false or without the field are NOT supported.
export async function modelSupportsReasoningEffort(modelID) {
    if (!modelID) return false;
    const caps = await getModelCapabilities(modelID);
    if (caps === null) return false;
    return caps.reasoning_effort === true;
}

// isValidReasoningEffort validates the accepted reasoning_effort values.
// Accepted: "high", "max". Any other value is rejected.
export function isValidReasoningEffort(value) {
    return value === 'high' || value === 'max';
}

// modelSupportsVision returns true only when the model's capabilities JSON
// explicitly contains "vision": true. Models without the field (or with it
// set to false) are treated as text-only.
export async function modelSupportsVision(modelID) {
    if (!modelID) return false;
    const caps = await getModelCapabilities(modelID);
    if (caps === null) return false;
    return caps.vision === true;
}

// architectureFor builds the OpenAI-style architecture object for a model.
// Vision-capable models accept text+image input; everything is text-output.
export function architectureFor(caps) {
    const vision = caps != null && caps.vision === true;
    const inputModalities = vision ? ['text', 'image'] : ['text'];
    return {
        modality: vision ? 'text+image->text' : 'text->text',
        input_modalities: inputModalities,
        output_modalities: ['text'],
    };
}

// ============================================================================
// /v1/models PAYLOAD BUILDERS (pure logic of modelsHandler / modelsHandler2;
// the HTTP layer is Phase 4)
// ============================================================================

// Go: modelsHandler — OpenAI GET /v1/models response payload.
export async function buildModelsListResponse() {
    const now = Math.floor(Date.now() / 1000);
    const models = await fetchModelsFromZAI();
    const data = models.map((m) => ({
        id: m.id,
        object: 'model',
        created: m.created || now,
        owned_by: 'z-ai',
        display_name: m.name,
        description: m.description,
        architecture: architectureFor(m.capabilities),
    }));
    return { object: 'list', data };
}

// Go: modelsHandler2 — simple id list + current model.
export async function buildModelsSimpleResponse() {
    const models = await fetchModelsFromZAI();
    const ids = models.map((m) => m.id);
    return {
        models: ids,
        currentModel: ids.length > 0 ? ids[0] : 'glm-5.2',
    };
}
