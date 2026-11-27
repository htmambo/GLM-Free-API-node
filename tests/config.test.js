// Tests for src/config.js env-loading semantics (port of Go loadConfig).
// config.js evaluates loadConfig() at import time, so each case re-imports
// the module with a cache-busting query string after setting the env.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const ENV_KEYS = [
    'PORT', 'HOST', 'AUTH_TOKEN', 'TIMEOUT', 'ZAI_TOKEN',
    'AGENT_MODE', 'AGENT_MODE_VARIANT', 'LOG_LEVEL', 'LOG_FORMAT',
    'STREAM_HOLDBACK', 'SYNC_MODE', 'SESSION_POOL_SIZE', 'SESSION_ACQUIRE_TIMEOUT',
    'AGENT_MODE_LEVEL', 'FORCE_CPU', 'TOOLPARSER_LLM_FORCE_CPU', 'SESSION_REUSE_COUNT',
    'ZAI_BASE_URL', 'ZAI_REGION',
];

let importCount = 0;

async function importConfigModule(env = {}) {
    const saved = {};
    for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        delete process.env[k];
    }
    Object.assign(process.env, env);
    try {
        return await import(`../src/config.js?case=${importCount++}`);
    } finally {
        for (const k of ENV_KEYS) {
            if (saved[k] === undefined) delete process.env[k];
            else process.env[k] = saved[k];
        }
    }
}

async function importConfig(env = {}) {
    const mod = await importConfigModule(env);
    return mod.config;
}

test('defaults match Go loadConfig', async () => {
    const c = await importConfig();
    assert.equal(c.server.port, 3001);
    assert.equal(c.server.host, '0.0.0.0');
    assert.equal(c.auth.enabled, true);
    assert.equal(c.auth.token, 'Waguri');
    assert.equal(c.timeouts.default, 300000);
    assert.equal(c.zaiToken, '');
    assert.equal(c.agentMode, false);
    assert.equal(c.agentModeVariant, 'modern');
    assert.equal(c.agentModeLevel, '');
    assert.equal(c.forceCPU, false);
    assert.equal(c.sessionReuseCount, 10);
    assert.equal(c.ultraEnabled(), false);
    assert.equal(c.logging.level, 'debug');
    assert.equal(c.logging.format, 'text');
    assert.deepEqual(c.knownModels, ['GLM-5.1', 'GLM-5']);
    assert.equal(c.streamHoldback, 24);
    assert.equal(c.syncMode, false);
    assert.equal(c.sessionPoolSize, 5);          // defaultPoolSize
    assert.equal(c.sessionAcquireTimeout, 10);   // defaultPoolWait / time.Second
    assert.equal(c.agentModern(), false);
    assert.equal(c.agentLegacy(), false);
});

test('PORT / HOST / AUTH_TOKEN / TIMEOUT / ZAI_TOKEN overrides', async () => {
    const c = await importConfig({
        PORT: '8080', HOST: '127.0.0.1', AUTH_TOKEN: 'tok',
        TIMEOUT: '60000', ZAI_TOKEN: 'zt',
    });
    assert.equal(c.server.port, 8080);
    assert.equal(c.server.host, '127.0.0.1');
    assert.equal(c.auth.token, 'tok');
    assert.equal(c.timeouts.default, 60000);
    assert.equal(c.zaiToken, 'zt');
});

test('invalid ints keep defaults (Go strconv.Atoi semantics)', async () => {
    const c = await importConfig({ PORT: 'abc', TIMEOUT: '12.5', STREAM_HOLDBACK: 'x' });
    assert.equal(c.server.port, 3001);
    assert.equal(c.timeouts.default, 300000);
    assert.equal(c.streamHoldback, 24);
});

test('AGENT_MODE truthy words enable modern variant', async () => {
    for (const v of ['1', 'true', 'yes', 'on', 'modern', 'TRUE']) {
        const c = await importConfig({ AGENT_MODE: v });
        assert.equal(c.agentMode, true, v);
        assert.equal(c.agentModeVariant, 'modern', v);
        assert.equal(c.agentModern(), true, v);
        assert.equal(c.agentLegacy(), false, v);
    }
});

test('AGENT_MODE=legacy enables legacy variant', async () => {
    const c = await importConfig({ AGENT_MODE: 'legacy' });
    assert.equal(c.agentMode, true);
    assert.equal(c.agentModeVariant, 'legacy');
    assert.equal(c.agentModern(), false);
    assert.equal(c.agentLegacy(), true);
});

test('AGENT_MODE falsy words disable agent mode', async () => {
    for (const v of ['0', 'false', 'no', 'off']) {
        const c = await importConfig({ AGENT_MODE: v });
        assert.equal(c.agentMode, false, v);
    }
});

test('AGENT_MODE_VARIANT overrides variant independently', async () => {
    const c = await importConfig({ AGENT_MODE_VARIANT: 'legacy' });
    assert.equal(c.agentMode, false);
    assert.equal(c.agentModeVariant, 'legacy');
    assert.equal(c.agentLegacy(), false); // agentMode off -> neither shim

    const c2 = await importConfig({ AGENT_MODE: 'on', AGENT_MODE_VARIANT: 'LEGACY' });
    assert.equal(c2.agentLegacy(), true);
});

test('STREAM_HOLDBACK: 0 allowed, negative rejected', async () => {
    assert.equal((await importConfig({ STREAM_HOLDBACK: '0' })).streamHoldback, 0);
    assert.equal((await importConfig({ STREAM_HOLDBACK: '-5' })).streamHoldback, 24);
});

test('SYNC_MODE parsing', async () => {
    assert.equal((await importConfig({ SYNC_MODE: 'on' })).syncMode, true);
    assert.equal((await importConfig({ SYNC_MODE: 'off' })).syncMode, false);
});

test('SESSION_POOL_SIZE requires >= 1, SESSION_ACQUIRE_TIMEOUT allows 0', async () => {
    assert.equal((await importConfig({ SESSION_POOL_SIZE: '8' })).sessionPoolSize, 8);
    assert.equal((await importConfig({ SESSION_POOL_SIZE: '0' })).sessionPoolSize, 5);
    assert.equal((await importConfig({ SESSION_ACQUIRE_TIMEOUT: '0' })).sessionAcquireTimeout, 0);
    assert.equal((await importConfig({ SESSION_ACQUIRE_TIMEOUT: '-1' })).sessionAcquireTimeout, 10);
});

test('LOG_LEVEL / LOG_FORMAT pass through verbatim', async () => {
    const c = await importConfig({ LOG_LEVEL: 'info', LOG_FORMAT: 'json' });
    assert.equal(c.logging.level, 'info');
    assert.equal(c.logging.format, 'json');
});

test('AGENT_MODE_LEVEL / FORCE_CPU / SESSION_REUSE_COUNT parsing', async () => {
    const c = await importConfig({
        AGENT_MODE: '1',
        AGENT_MODE_LEVEL: ' ULTRA ',
        FORCE_CPU: 'yes',
        SESSION_REUSE_COUNT: '3',
    });
    assert.equal(c.agentModeLevel, 'ultra');
    assert.equal(c.forceCPU, true);
    assert.equal(c.sessionReuseCount, 3);
    assert.equal(c.ultraEnabled(), true, 'agent mode + ultra must enable the repair layer');

    // ultra without agent mode stays dormant.
    const off = await importConfig({ AGENT_MODE_LEVEL: 'ultra' });
    assert.equal(off.ultraEnabled(), false);

    // TOOLPARSER_LLM_FORCE_CPU is an independent alias for FORCE_CPU.
    const alias = await importConfig({ TOOLPARSER_LLM_FORCE_CPU: '1' });
    assert.equal(alias.forceCPU, true);

    // Invalid / out-of-range reuse counts keep the default.
    const bad = await importConfig({ SESSION_REUSE_COUNT: '0' });
    assert.equal(bad.sessionReuseCount, 10);
    const junk = await importConfig({ SESSION_REUSE_COUNT: 'many' });
    assert.equal(junk.sessionReuseCount, 10);
});

test('ZAI_BASE_URL / ZAI_REGION select a regional deployment', async () => {
    const mod = await importConfigModule({ ZAI_BASE_URL: 'https://zchat.z.ai/', ZAI_REGION: 'cn' });
    assert.equal(mod.BASE_URL, 'https://zchat.z.ai', 'trailing slash must be stripped');
    assert.equal(mod.zaiRegion, 'cn');

    const defaults = await importConfigModule({});
    assert.equal(defaults.BASE_URL, 'https://chat.z.ai');
    assert.equal(defaults.zaiRegion, 'overseas');
});
