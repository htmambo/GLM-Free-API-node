// Port of internal/zbridge/types.go — global state.
//
// All Go mutexes (session.mu, dbMu, logMu, modelsCacheMu,
// modelFeatureStatesMu) are omitted: Node's single-threaded event loop
// makes them unnecessary for these structures.
//
// Field names are camelCase equivalents of the Go structs:
//   SessionState.Token -> session.token, UserID -> userID, ChatID -> chatID,
//   SaltKey -> saltKey, FeVersion -> feVersion, Initialized -> initialized,
//   Initializing -> initializing. Go struct types (Message, ZAIResult,
//   SendOptions, captcha DTOs, ...) become plain objects in later phases.
//
// Mutable exports use ESM live bindings: mutate them ONLY through the
// setter functions below; importers read the live binding at call time.

import { SALT_KEY, DEFAULT_FE_VERSION } from './config.js';
import { randomUUID } from './util.js';

export { config } from './config.js';

// ---------- Captcha globals (types.go: dbPath, gRunning, globalDB) ----------

// Path to the captcha-token SQLite database ('' = unset).
export let dbPath = '';
export function setDbPath(p) {
    dbPath = p;
}

// Go: gRunning atomic.Bool. Wrapped in an object so importers can mutate
// it in place (ESM live bindings are read-only for importers).
export const gRunning = { value: false };

// The active SQLite database (formerly globalDB) lives in db.js behind the
// hot-swappable holder: see withTokenDB / swapDB / closeDB.

// ---------- Z.AI globals ----------

// Go: var session = &SessionState{...} — a single mutable object.
// features mirrors Go Features{Thinking: true} (enable_thinking on by
// default; the remaining feature flags default to false).
export const session = {
    token: '',
    userID: '',
    userName: 'Guest',
    chatID: randomUUID(),
    messages: [],
    saltKey: SALT_KEY,
    feVersion: DEFAULT_FE_VERSION,
    features: {
        webSearch: false,
        autoWebSearch: false,
        thinking: true,
        imageGen: false,
        previewMode: false,
    },
    initialized: false,
    initializing: false,
};

// ---------- Models cache ----------

// Go: modelsCache []ModelInfo / modelsCacheTime time.Time.
// ModelInfo = { id, name, description, capabilities, created }.
export let modelsCache = [];
export let modelsCacheTime = 0; // ms epoch; 0 = zero time.Time (never cached)
export function setModelsCache(list, timeMs = Date.now()) {
    modelsCache = list;
    modelsCacheTime = timeMs;
}

export const modelsCacheTTL = 5 * 60 * 1000; // 5 * time.Minute

// Fallback if Z.AI API is unreachable and cache is empty (verbatim from
// types.go).
export const fallbackModels = [
    { id: 'glm-5.2', name: 'GLM-5.2', description: 'Flagship model, excels at coding and long-horizon tasks' },
    { id: 'GLM-5.1', name: 'GLM-5.1', description: 'Previous flagship model' },
    { id: 'GLM-5-Turbo', name: 'GLM-5-Turbo', description: 'New model for chat, coding, and agentic task' },
    { id: 'GLM-5v-Turbo', name: 'GLM-5V-Turbo', description: 'Vision model with evolved intelligence',
        capabilities: { vision: true } },
    { id: 'glm-4.7', name: 'GLM-4.7', description: 'Classic high-performance model' },
];

export const feVersionRe = /prod-fe-\d+\.\d+\.\d+/;

// ---------- Per-model feature state (dynamic, model-aware) ----------

// Go: map[string]*ModelFeatureState — ModelFeatureState tracks per-model
// feature configuration: { includeAll, overrides }. includeAll: when true,
// ALL server capabilities are sent to /completions. overrides: user-supplied
// per-model feature overrides (snake_case keys).
export const modelFeatureStates = new Map();
