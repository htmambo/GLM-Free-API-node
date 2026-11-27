// Port of internal/zbridge/config.go — configuration loading & constants.
// Field names are camelCase equivalents of the Go struct:
//   Server.Port -> server.port, Auth.Token -> auth.token,
//   Timeouts.Default -> timeouts.default, ZaiToken -> zaiToken,
//   AgentModeVariant -> agentModeVariant, Logging.Level -> logging.level,
//   KnownModels -> knownModels, StreamHoldback -> streamHoldback,
//   SyncMode -> syncMode, SessionPoolSize -> sessionPoolSize,
//   SessionAcquireTimeout -> sessionAcquireTimeout

// ============================================================================
// CONSTANTS
// ============================================================================

// Aliyun captcha credentials.
//
// These are the chat.z.ai site constants that the upstream Go project
// hardcodes (and that ship inside the site's public client bundle). They are
// read from the ENVIRONMENT here so that no credential literal ever lands in
// the repository — GitHub push protection blocks Alibaba Cloud AccessKey
// patterns, and a committed secret cannot be un-committed.
//
//   ALIYUN_CAPTCHA_ACCESS_KEY_ID       — AccessKey ID
//   ALIYUN_CAPTCHA_ACCESS_KEY_SECRET   — AccessKey Secret
//
// Both are required: the captcha param is signed on every chat request.
// `run()` in server.js fails fast at startup when they are missing.
//
// sceneID is a scene identifier, not a credential — it stays inline, but can
// be overridden for a different deployment.
export const accessKey = (process.env.ALIYUN_CAPTCHA_ACCESS_KEY_ID || '').trim();
export const secretKey = (process.env.ALIYUN_CAPTCHA_ACCESS_KEY_SECRET || '').trim();
export const sceneID = (process.env.ALIYUN_CAPTCHA_SCENE_ID || '').trim() || 'didk33e0';
export const maxTokenRetries = 5;

// Z.AI direct config
export const SALT_KEY = 'key-@@@@)))()((9))-xxxx&&&%%%%%';
export const DEFAULT_FE_VERSION = 'prod-fe-1.1.93';
export const zaiUserAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

// clientVersion is the "version" query parameter the web client sends on
// /api/v2/chat/completions. The upstream rejects requests whose version is
// below its current minimum (it answers "Your client version (unknown) is
// outdated. Minimum required: <x>"), so the value has to track the deployed
// web build. Override it with ZAI_CLIENT_VERSION when the upstream raises
// the bar again.
export const clientVersion = (process.env.ZAI_CLIENT_VERSION || '').trim() || '1.0.91';

// Session pool defaults (Go: session_pool.go defaultPoolSize / defaultPoolWait /
// defaultSessionReuse)
export const defaultPoolSize = 5;
export const defaultPoolWaitSec = 10; // defaultPoolWait = 10 * time.Second
// defaultSessionReuse is how many requests one chat session serves before it
// is deleted on Z.AI and replaced. Reuse makes the traffic look like a human
// carrying several turns in one chat; it also cuts DELETE volume by N.
export const defaultSessionReuse = 10;

// BASE_URL is a `let` (not const) only so tests can point the bridge at a
// mock upstream; the default value is the production endpoint.
// Importers must read it at call time (ESM live binding), not snapshot it.
//
// Node-only extension (the Go original hardcodes the international host):
// ZAI_BASE_URL points the bridge at a regional deployment, e.g.
// ZAI_BASE_URL=https://zchat.z.ai for the mainland-China site.
export let BASE_URL = 'https://chat.z.ai';

const envBaseURL = (process.env.ZAI_BASE_URL || '').trim().replace(/\/+$/, '');
if (envBaseURL !== '') BASE_URL = envBaseURL;

// zaiRegion is the x-region header value. The international site expects
// "overseas"; a mainland deployment may expect another value (ZAI_REGION).
export const zaiRegion = (process.env.ZAI_REGION || '').trim() || 'overseas';

export function setBaseURL(url) {
    BASE_URL = url;
}

// ============================================================================
// CONFIG LOADING
// ============================================================================

// Go strconv.Atoi semantics: optional sign + digits only; anything else
// (spaces, decimals, trailing junk that JS parseInt would silently eat)
// is rejected and the default is kept.
function atoi(s) {
    if (!/^[+-]?\d+$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isSafeInteger(n)) return null;
    return n;
}

export function loadConfig() {
    const c = {
        server: { port: 3001, host: '0.0.0.0' },
        auth: { enabled: true, token: 'Waguri' },
        timeouts: { default: 300000 },
        zaiToken: '',
        agentMode: false,
        // AgentModeVariant selects the agent-mode compatibility shim:
        //   "modern" (default) — XML-sectioned prompt shim ported from
        //                        DeepseekFreeAPI (see agent.go)
        //   "legacy"           — the original [ROLE: ...] rewrite shim
        agentModeVariant: 'modern',
        // agentModeLevel selects the ToolParserLLM repair layer. Only
        // "ultra" (case-insensitive) enables it, and only together with
        // agentMode; every other value keeps the layer fully dormant.
        agentModeLevel: '',
        // forceCPU allows ToolParserLLM ultra on CPU-only hosts (degraded).
        forceCPU: false,
        // sessionReuseCount is how many requests one chat session serves
        // before it is deleted on Z.AI and replaced (>= 1).
        sessionReuseCount: defaultSessionReuse,
        logging: { level: 'debug', format: 'text' },
        knownModels: ['GLM-5.1', 'GLM-5'],
        // streamHoldback is the number of runes kept pending at the tail of
        // the streamed content before it is forwarded to clients (see Go
        // config.go / issue #23). 0 disables the hold-back.
        streamHoldback: 24,
        // syncMode disables the async session pool and restores the legacy
        // synchronous flow: every request creates its own chat session first.
        syncMode: false,
        sessionPoolSize: defaultPoolSize,
        sessionAcquireTimeout: defaultPoolWaitSec,

        // agentModern reports whether the modern agent-mode shim
        // (XML-sectioned prompt — see agent.go) is active.
        agentModern() {
            return this.agentMode && this.agentModeVariant.toLowerCase() !== 'legacy';
        },
        // agentLegacy reports whether the legacy [ROLE: ...] shim is active.
        agentLegacy() {
            return this.agentMode && this.agentModeVariant.toLowerCase() === 'legacy';
        },
        // ultraEnabled is the strict double switch for the ToolParserLLM
        // repair layer: agent mode AND level "ultra".
        ultraEnabled() {
            return this.agentMode && this.agentModeLevel.trim().toLowerCase() === 'ultra';
        },
    };

    const env = process.env;

    if (env.PORT) {
        const n = atoi(env.PORT);
        if (n !== null) c.server.port = n;
    }
    if (env.HOST) c.server.host = env.HOST;
    if (env.AUTH_TOKEN) c.auth.token = env.AUTH_TOKEN;
    if (env.TIMEOUT) {
        const n = atoi(env.TIMEOUT);
        if (n !== null) c.timeouts.default = n;
    }
    if (env.ZAI_TOKEN) c.zaiToken = env.ZAI_TOKEN;
    if (env.AGENT_MODE) {
        switch (env.AGENT_MODE.toLowerCase()) {
            case '1':
            case 'true':
            case 'yes':
            case 'on':
            case 'modern':
                c.agentMode = true;
                break;
            case 'legacy':
                // Explicit opt-in to the old [ROLE: ...] rewrite shim.
                c.agentMode = true;
                c.agentModeVariant = 'legacy';
                break;
            case '0':
            case 'false':
            case 'no':
            case 'off':
                c.agentMode = false;
                break;
        }
    }
    // AGENT_MODE_VARIANT overrides the shim variant independently of the
    // AGENT_MODE on/off switch: "modern" (default) or "legacy".
    if (env.AGENT_MODE_VARIANT) {
        switch (env.AGENT_MODE_VARIANT.toLowerCase()) {
            case 'legacy':
                c.agentModeVariant = 'legacy';
                break;
            case 'modern':
                c.agentModeVariant = 'modern';
                break;
        }
    }
    if (env.AGENT_MODE_LEVEL) c.agentModeLevel = env.AGENT_MODE_LEVEL.trim().toLowerCase();
    // FORCE_CPU and its TOOLPARSER_LLM_* alias are independent: the alias can
    // override the plain switch.
    for (const name of ['FORCE_CPU', 'TOOLPARSER_LLM_FORCE_CPU']) {
        const v = env[name];
        if (!v) continue;
        switch (v.toLowerCase()) {
            case '1': case 'true': case 'yes': case 'on':
                c.forceCPU = true;
                break;
            case '0': case 'false': case 'no': case 'off':
                c.forceCPU = false;
                break;
        }
    }
    if (env.SESSION_REUSE_COUNT) {
        const n = atoi(env.SESSION_REUSE_COUNT);
        if (n !== null && n >= 1) c.sessionReuseCount = n;
    }
    if (env.LOG_LEVEL) c.logging.level = env.LOG_LEVEL;
    if (env.LOG_FORMAT) c.logging.format = env.LOG_FORMAT;
    if (env.STREAM_HOLDBACK) {
        const n = atoi(env.STREAM_HOLDBACK);
        if (n !== null && n >= 0) c.streamHoldback = n;
    }
    // SYNC_MODE restores the legacy synchronous session flow (one chat
    // created per request). Used sessions are still deleted after use.
    if (env.SYNC_MODE) {
        switch (env.SYNC_MODE.toLowerCase()) {
            case '1':
            case 'true':
            case 'yes':
            case 'on':
                c.syncMode = true;
                break;
            case '0':
            case 'false':
            case 'no':
            case 'off':
                c.syncMode = false;
                break;
        }
    }
    if (env.SESSION_POOL_SIZE) {
        const n = atoi(env.SESSION_POOL_SIZE);
        if (n !== null && n >= 1) c.sessionPoolSize = n;
    }
    if (env.SESSION_ACQUIRE_TIMEOUT) {
        const n = atoi(env.SESSION_ACQUIRE_TIMEOUT);
        if (n !== null && n >= 0) c.sessionAcquireTimeout = n;
    }
    return c;
}

export const config = loadConfig();
