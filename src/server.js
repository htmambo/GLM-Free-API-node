// Port of internal/zbridge/run.go — entry point of the Z.AI bridge.
//
// createHandler() assembles the bridge's complete HTTP surface: every route
// with the auth and CORS middleware applied (Go: NewHandler). It is exported
// on its own so integration tests can drive the full HTTP surface without
// starting a listener.
//
// run() is what the thin main.js calls (Go: Run): it parses the CLI flags,
// opens the token database, starts the captcha cache (agent mode), attaches
// the session pool, serves createHandler() and blocks until CTRL+C / SIGTERM
// — then drains in-flight requests and clears every still-pooled chat session
// on Z.AI before exiting (ported from the DeepseekFreeAPI reference).
//
// Go -> JS mapping:
//   - http.ServeMux          -> hand-written exact-path dispatch below.
//     Go's "/" pattern is a subtree catch-all; every other pattern is an
//     exact match. (Go mux's redirect-on-unclean-path behavior — e.g.
//     "//health" -> "/health" — is not reproduced.)
//   - io.ReadAll(r.Body)     -> the dispatcher buffers the request body once
//     and hands it to the handler as ctx.body (Buffer).
//   - r.Context()            -> ctx.signal, aborted when the client
//     disconnects before the response finished.
//   - flag package           -> parseArgs below (same flags, same semantics:
//     -flag / --flag / -flag=value / -flag value; bools accept no value;
//     parsing stops at the first non-flag argument; unknown flags exit 2,
//     -h/-help prints usage and exits 0).
//   - signal.NotifyContext + srv.Shutdown(10s) -> SIGINT/SIGTERM handler with
//     server.close() + a 10s deadline that force-closes remaining connections
//     via server.closeAllConnections(); a second signal force-exits.

import http from 'node:http';
import { existsSync } from 'node:fs';

import { config, BASE_URL, zaiRegion, accessKey, secretKey } from './config.js';
import { dbPath, setDbPath, gRunning } from './state.js';
import { logInfo, setVerbose } from './logger.js';
import { writeJSON, writeNotFound, corsMiddleware, authMiddleware } from './middleware.js';
import {
    dashboardHandler,
    statusHandler,
    statsHandler,
    healthHandler,
    clientsHandler,
    sqliteSwapHandler,
    injectHandler,
    stopHandler,
    modelsHandler,
    modelsHandler2,
    featuresHandler,
    chatCompletionsHandler,
} from './handlers.js';
import { anthropicMessagesHandler } from './anthropic.js';
import { captchaCache } from './captcha.js';
import { initDB, closeDB } from './db.js';
import { initializeSession, inspectZaiTokenExpiry } from './zai.js';
import { ensureToolParserLLMForUltra, toolParserLLMSGLangBaseURL } from './toolparserLLM.js';
import { ultraGateDebug } from './agentUltra.js';
import { fetchModelsFromZAI } from './models.js';
import {
    SessionPool,
    newZAIChatBackend,
    attachSessionPool,
    shutdownSyncSession,
} from './sessionPool.js';

// ============================================================================
// ROUTE TABLE (Go: NewHandler)
// ============================================================================

// readBody buffers the full request body (Go: io.ReadAll inside handlers).
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

// Go: NewHandler() http.Handler — every route with auth + CORS applied.
// Returns a node:http request listener; exported for the integration tests.
export function createHandler() {
    // Exact-path routes (Go mux semantics; "/" is the catch-all).
    const routes = new Map([
        ['/health', healthHandler],
        ['/status', statusHandler],
        ['/v1/models', authMiddleware(modelsHandler)],
        ['/models', authMiddleware(modelsHandler2)],
        ['/v1/chat/completions', authMiddleware(chatCompletionsHandler)],
        ['/v1/messages', authMiddleware(anthropicMessagesHandler)],
        ['/features', authMiddleware(featuresHandler)],
        ['/admin/stats', statsHandler],
        ['/admin/health', healthHandler],
        ['/admin/clients', clientsHandler],
        ['/sqlite', authMiddleware(sqliteSwapHandler)],
        ['/inject.js', injectHandler],
        ['/stop', authMiddleware(stopHandler)],
    ]);

    const mux = async (req, res, ctx) => {
        const handler = routes.get(ctx.url.pathname) ?? dashboardHandler;
        await handler(req, res, ctx);
    };

    const withCors = corsMiddleware(mux);

    return (req, res) => {
        (async () => {
            // Go: r.Context() is cancelled when the client goes away.
            const controller = new AbortController();
            res.on('close', () => {
                if (!res.writableEnded) controller.abort();
            });

            let body;
            try {
                body = await readBody(req);
            } catch {
                // Go: io.ReadAll error inside the handlers -> 400.
                if (!res.writableEnded) {
                    writeJSON(res, 400, {
                        error: { message: 'Failed to read body', type: 'invalid_request_error', code: null, param: null },
                    });
                }
                return;
            }

            const ctx = {
                url: new URL(req.url, 'http://localhost'),
                body,
                signal: controller.signal,
            };

            try {
                await withCors(req, res, ctx);
            } catch (err) {
                // Go: a panicking handler is recovered by net/http and the
                // connection is torn down; here we answer a 500 if possible.
                console.error(`[HTTP] handler error on ${req.method} ${req.url}: ${err.stack ?? err}`);
                if (!res.headersSent) {
                    writeJSON(res, 500, {
                        error: { message: 'Internal server error', type: 'server_error', code: null, param: null },
                    });
                } else if (!res.writableEnded) {
                    res.end();
                }
            }
            if (!res.writableEnded) res.end();
        })();
    };
}

// ============================================================================
// CLI FLAGS (Go: flag package)
// ============================================================================

function usage() {
    process.stderr.write(`Usage of GLM-Free-API:
  --db-path string
        Path to SQLite database (default "tokens.sqlite")
  --verbose
        Enable verbose logging
  --agent-mode
        Enable agent mode: translate tools & roles for Z.AI compatibility (modern shim by default)
  --agent-mode-variant string
        Agent mode shim variant: modern (default, XML-sectioned prompt) or legacy ([ROLE: ...] rewrite) (default "modern")
  --agent-mode-level string
        Agent mode repair level: empty (default, stock parser only) or ultra (buffer + ToolParserLLM malformed-tool repair; requires --agent-mode)
  --force-cpu
        Allow ToolParserLLM ultra repair on CPU-only hosts (degraded path; CPU inference is NOT recommended)
  --sync-mode
        Legacy synchronous session flow: reuse one sticky chat up to --session-reuse-count instead of drawing from the pre-warmed session pool
  --session-reuse-count int
        How many requests one chat session serves before it is deleted on Z.AI and replaced (default 10; 1 = throwaway per request)
`);
}

// Go strconv.ParseBool.
function parseBool(s) {
    switch (s) {
        case '1': case 't': case 'T': case 'true': case 'TRUE': case 'True': return true;
        case '0': case 'f': case 'F': case 'false': case 'FALSE': case 'False': return false;
        default: return null;
    }
}

// parseArgs mirrors Go's flag.Parse for the bridge's five flags.
export function parseArgs(argv) {
    const args = {
        dbPath: 'tokens.sqlite',
        verbose: false,
        agentMode: config.agentMode,
        agentModeVariant: config.agentModeVariant,
        agentModeLevel: config.agentModeLevel,
        forceCPU: config.forceCPU,
        syncMode: config.syncMode,
        sessionReuseCount: config.sessionReuseCount,
    };
    const stringFlags = {
        'db-path': 'dbPath',
        'agent-mode-variant': 'agentModeVariant',
        'agent-mode-level': 'agentModeLevel',
    };
    const intFlags = { 'session-reuse-count': 'sessionReuseCount' };
    const boolFlags = {
        'verbose': 'verbose',
        'agent-mode': 'agentMode',
        'force-cpu': 'forceCPU',
        'sync-mode': 'syncMode',
    };

    const fail = (msg) => {
        process.stderr.write(msg + '\n');
        usage();
        process.exit(2);
    };

    for (let i = 0; i < argv.length; i++) {
        let a = argv[i];
        if (a === '--') break; // Go: parsing stops at "--"
        if (a.length < 2 || a[0] !== '-') break; // first non-flag argument stops parsing
        if (a[1] === '-') a = a.slice(1); // "--flag" == "-flag"
        const name = a.slice(1);
        if (name === '' || name[0] === '-') fail(`flag provided but not defined: ${a}`);

        let value = null;
        let flagName = name;
        const eq = name.indexOf('=');
        if (eq !== -1) {
            flagName = name.slice(0, eq);
            value = name.slice(eq + 1);
        }

        if (flagName === 'h' || flagName === 'help') {
            usage();
            process.exit(0);
        }

        if (flagName in stringFlags) {
            if (value === null) {
                if (i + 1 >= argv.length) fail(`flag needs an argument: -${flagName}`);
                value = argv[++i];
            }
            args[stringFlags[flagName]] = value;
        } else if (flagName in intFlags) {
            if (value === null) {
                if (i + 1 >= argv.length) fail(`flag needs an argument: -${flagName}`);
                value = argv[++i];
            }
            if (!/^[+-]?\d+$/.test(value)) fail(`invalid value "${value}" for flag -${flagName}: parse error`);
            const n = Number(value);
            if (!Number.isSafeInteger(n)) fail(`invalid value "${value}" for flag -${flagName}: value out of range`);
            args[intFlags[flagName]] = n;
        } else if (flagName in boolFlags) {
            if (value === null) {
                args[boolFlags[flagName]] = true;
            } else {
                const b = parseBool(value);
                if (b === null) fail(`invalid boolean value "${value}" for -${flagName}`);
                args[boolFlags[flagName]] = b;
            }
        } else {
            fail(`flag provided but not defined: -${flagName}`);
        }
    }
    return args;
}

// ============================================================================
// ENTRY POINT (Go: Run)
// ============================================================================

export async function run() {
    const args = parseArgs(process.argv.slice(2));
    setDbPath(args.dbPath);
    setVerbose(args.verbose);
    config.agentMode = args.agentMode;
    config.agentModeVariant = args.agentModeVariant;
    config.agentModeLevel = args.agentModeLevel;
    config.forceCPU = args.forceCPU;
    config.syncMode = args.syncMode;
    config.sessionReuseCount = args.sessionReuseCount;

    // Warn (do NOT exit) when the captcha credentials are missing: they are
    // only needed to sign the captcha param on the chat path, so the rest of
    // the bridge (health, status, model listing) still works. The chat path
    // itself fails fast with a clear message at the request boundary — see
    // getCaptchaVerifyParam() in captcha.js.
    if (accessKey === '' || secretKey === '') {
        console.error(
            '[Startup] WARNING: Aliyun captcha credentials are not configured.\n' +
            '          Set ALIYUN_CAPTCHA_ACCESS_KEY_ID and ALIYUN_CAPTCHA_ACCESS_KEY_SECRET\n' +
            '          (see .env.example). Chat requests will fail until they are set;\n' +
            '          every other endpoint keeps working.');
    }

    // Warn when the configured ZAI_TOKEN is already expired (or about to
    // expire). Z.AI session tokens live about an hour, and an expired one
    // is rejected with a 401 on every chat request — much easier to act on
    // here than through a stream of failed completions.
    if (config.zaiToken !== '') {
        const info = inspectZaiTokenExpiry(config.zaiToken);
        if (info !== null && info.expired) {
            console.error(
                `[Startup] WARNING: ZAI_TOKEN expired at ${new Date(info.exp * 1000).toISOString()} ` +
                `(${Math.round(-info.secondsLeft / 60)} min ago) — every chat request will fail with 401.\n` +
                '          Z.AI session tokens are short-lived; refresh it from the site ' +
                '(devtools -> Application -> Local Storage -> "token") and restart.');
        } else if (info !== null && info.secondsLeft < 600) {
            console.error(
                `[Startup] WARNING: ZAI_TOKEN expires in ~${Math.round(info.secondsLeft / 60)} min ` +
                `(${new Date(info.exp * 1000).toISOString()}).`);
        }
    }

    if (!existsSync(dbPath)) {
        // Go: log.Println (stderr) + exit 1.
        console.error('Captcha db not found! Please run the token collector first (cmd/token-collector)');
        process.exit(1);
    }

    logInfo("Starting with db-path='" + dbPath + "' verbose=true");

    try {
        initDB(dbPath);
    } catch (err) {
        process.stderr.write(`Failed to open database: ${err.message}\n`);
        process.exit(1);
    }

    gRunning.value = true;

    if (config.agentMode) {
        // Go: go captchaCache.Run() — fire-and-forget background loop.
        captchaCache.run().catch((err) => {
            console.error(`[Captcha Cache] run loop exited: ${err.message}`);
        });
        logInfo('Agent mode: Captcha background cache started');
        if (config.agentModern()) {
            logInfo('Agent mode variant: MODERN (XML-sectioned prompt shim, tolerant marker/payload parsing)');
        } else {
            logInfo('Agent mode variant: LEGACY ([ROLE: ...] message rewrite shim)');
        }
    }

    // Ultra repair (opt-in beta, issue #44): strict double gate. Fail-fast
    // startup — a half-configured repair layer is worse than none.
    if (config.ultraEnabled()) {
        console.error(`[ToolParserLLM] ultra repair enabled (${ultraGateDebug()}) — ensuring base+LoRA assets and SGLang backend`);
        try {
            await ensureToolParserLLMForUltra();
        } catch (err) {
            console.error(`ToolParserLLM ultra startup failed: ${err.message}`);
            process.exit(1);
        }
        console.error(`[ToolParserLLM] ultra repair ready (SGLang at ${toolParserLLMSGLangBaseURL()})`);
    }

    const handler = createHandler();

    const addr = `${config.server.host}:${config.server.port}`;

    const tokenPadded = (config.auth.token + ' '.repeat(44)).slice(0, 44);
    console.log(`
╔═══════════════════════════════════════════════════════════════╗
║           Z.AI Direct Bridge Server Started                   ║
╠═══════════════════════════════════════════════════════════════╣
║  Mode:          DIRECT HTTP (no browser needed)               ║
║  Captcha IPC:   IN-MEMORY (no FIFO / named pipe)             ║
║  Health:        http://localhost:${config.server.port}/health               ║
╠═══════════════════════════════════════════════════════════════╣
║  OpenAI API:    http://localhost:${config.server.port}/v1/chat/completions
║  Anthropic API: http://localhost:${config.server.port}/v1/messages  ║
╠═══════════════════════════════════════════════════════════════╣
║  Auth Token:    ${tokenPadded}║
╚═══════════════════════════════════════════════════════════════╝
`);

    console.error(`[Startup] Upstream: ${BASE_URL} (x-region: ${zaiRegion})`);

    // Background session init + model-cache warmup; a failure here is not
    // fatal — the first request retries (Go: deferred retry).
    (async () => {
        try {
            await initializeSession();
        } catch {
            console.error('[Startup] Session init deferred — will retry on first request.');
        }
        await fetchModelsFromZAI();
    })();

    // ── Session lifecycle (ported from the DeepseekFreeAPI reference) ─────
    // Every stateless request runs on a throwaway chat session that is
    // deleted on Z.AI right after its response is fully processed, so no
    // server-side history outlives a request and the account never
    // accumulates dead sessions. By default the async flow keeps a standing
    // batch of pre-made sessions ready (SESSION_POOL_SIZE); --sync-mode
    // restores the legacy per-request flow (still garbage-collected).
    let sessionPool = null;
    if (config.syncMode) {
        console.error(`[Startup] Session mode: SYNC (--sync-mode: one sticky chat reused up to ${Math.max(1, config.sessionReuseCount)}x, deleted on Z.AI + rotated after)`);
    } else {
        // poolWait bounds how long a request waits for a pooled session
        // (0 => wait indefinitely; SESSION_ACQUIRE_TIMEOUT seconds).
        const waitMs = config.sessionAcquireTimeout <= 0 ? 0 : config.sessionAcquireTimeout * 1000;
        sessionPool = new SessionPool(newZAIChatBackend(), config.sessionPoolSize);
        attachSessionPool(sessionPool, waitMs);
        console.error(`[Startup] Session mode: ASYNC (pre-made chat batch x${sessionPool.size()}, each reused up to ${sessionPool.getMaxUses()}x then deleted on Z.AI + refilled)`);
        console.error(`[Startup]               SESSION_POOL_SIZE=${sessionPool.size()} SESSION_ACQUIRE_TIMEOUT=${config.sessionAcquireTimeout}s SESSION_REUSE_COUNT=${sessionPool.getMaxUses()}`);
    }

    const server = http.createServer(handler);

    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.server.port, config.server.host, resolve);
    });

    // Warm the standing session batch in the background; requests are served
    // meanwhile (they simply queue on acquire until sessions appear).
    if (sessionPool !== null) {
        sessionPool.start();
    }

    // ── Graceful shutdown (ported from the DeepseekFreeAPI reference) ─────
    // CTRL+C / SIGTERM stops accepting new connections, lets in-flight
    // responses finish (10s drain deadline), then deletes every still-pooled
    // chat session on Z.AI so nothing is left behind on the account. A
    // second CTRL+C force-exits immediately.
    let shuttingDown = false;
    const shutdown = () => {
        if (shuttingDown) {
            process.exit(1); // second signal: force-exit (Go re-arms default handling)
        }
        shuttingDown = true;
        console.error('[Shutdown] Graceful shutdown requested — draining connections and clearing all chat sessions...');

        let drainTimer = setTimeout(() => {
            console.error('[Shutdown] drain deadline hit (10s); closing remaining connections');
            server.closeAllConnections();
        }, 10_000);

        server.close(async () => {
            clearTimeout(drainTimer);
            // Clear any sessions still pooled so nothing is left behind on
            // the Z.AI account (checked-out ones are deleted by their own
            // release).
            if (sessionPool !== null) {
                await sessionPool.shutdown();
            } else {
                await shutdownSyncSession();
            }
            await closeDB();
            console.error('[Shutdown] All chat sessions cleared. Goodbye.');
            process.exit(0);
        });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
}
