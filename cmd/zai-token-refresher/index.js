#!/usr/bin/env node
// zai-token-refresher — keeps the bridge's ZAI_TOKEN_FILE fresh.
//
// A bare bearer token cannot be renewed upstream (README: "ZAI_TOKEN 过期了怎么办"),
// but the site's own web client keeps localStorage.token current for as long as
// its login cookies are valid. This tool keeps those cookies in a persistent
// Chromium profile, reads the token the page has already refreshed, and
// atomically writes it where the bridge expects it (ZAI_TOKEN_FILE).
//
// First run: log in by hand in the window that opens; the profile keeps the
// cookies. Later runs only need the cookies, but the browser stays headful by
// default because the site's risk layer dislikes headless clients. On a
// headless server run it under Xvfb (`xvfb-run -a node index.js`).

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Defaults are anchored to this directory, not the cwd: the profile has to
// stay next to the tool (and .gitignore) and the token has to land in the
// repo-root runtime/ that the bridge's ZAI_TOKEN_FILE points at.
const HERE = dirname(fileURLToPath(import.meta.url));

const DEFAULTS = {
    profile: resolve(HERE, '.profile'),
    out: resolve(HERE, '../../runtime/zai-token'),
    interval: 900,
    loginTimeout: 600,
};

const BASE_URL = (process.env.ZAI_BASE_URL || 'https://chat.z.ai').trim().replace(/\/+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usage() {
    process.stdout.write(`Usage: node index.js [options]

  --profile <dir>      Chromium profile directory (default ${DEFAULTS.profile})
  --out <file>         Token output file (default ${DEFAULTS.out})
  --interval <sec>     Refresh interval, 0 = once then exit (default ${DEFAULTS.interval})
  --login-timeout <s>  How long to wait for a manual login (default ${DEFAULTS.loginTimeout})
  --headless           Run without a window (needs an already-authenticated profile)
  -h, --help           Show this help

The bridge reads the file when ZAI_TOKEN_FILE points at it.
`);
}

function parseArgs(argv) {
    const args = { ...DEFAULTS, headless: false };
    const take = (i, name) => {
        if (i + 1 >= argv.length) {
            process.stderr.write(`flag needs an argument: ${name}\n`);
            process.exit(2);
        }
        return argv[i + 1];
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        switch (a) {
            case '--profile': args.profile = take(i, a); i++; break;
            case '--out': args.out = take(i, a); i++; break;
            case '--interval': args.interval = Number(take(i, a)); i++; break;
            case '--login-timeout': args.loginTimeout = Number(take(i, a)); i++; break;
            case '--headless': args.headless = true; break;
            case '-h':
            case '--help': usage(); process.exit(0);
            default:
                process.stderr.write(`unknown argument: ${a}\n`);
                usage();
                process.exit(2);
        }
    }
    for (const k of ['interval', 'loginTimeout']) {
        if (!Number.isFinite(args[k]) || args[k] < 0) {
            process.stderr.write(`invalid value for --${k.replace('Timeout', '-timeout')}: ${args[k]}\n`);
            process.exit(2);
        }
    }
    return args;
}

const args = parseArgs(process.argv.slice(2));
const profileDir = resolve(args.profile);
const outFile = resolve(args.out);

function log(msg) {
    process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

// tokenExpiry returns the exp claim in milliseconds, or null when the token
// is not a parseable JWT.
function tokenExpiry(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
    } catch {
        return null;
    }
}

// writeAtomic writes through a tmp file + rename so the bridge never observes
// a half-written token. Mode 0600: the file is a session credential.
function writeAtomic(path, data) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, data + '\n', { mode: 0o600 });
    renameSync(tmp, path);
    chmodSync(path, 0o600);
}

const readToken = (page) => page.evaluate(() => localStorage.getItem('token'));

async function refreshOnce(page, firstRun, state) {
    try {
        if (firstRun) {
            await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        } else {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
        }
    } catch (err) {
        log(`page load failed: ${err.message}`);
        return;
    }

    // The page refreshes the token from its JS bundle after the document
    // loads; give it a moment before reading.
    await sleep(3000);

    let token = await readToken(page);

    if (!token && firstRun && !args.headless) {
        log('No token in localStorage — log in in the browser window.');
        log(`Waiting up to ${args.loginTimeout}s for the login to complete...`);
        const deadline = Date.now() + args.loginTimeout * 1000;
        while (!token && Date.now() < deadline) {
            await sleep(3000);
            token = await readToken(page);
        }
    }
    if (!token) {
        log('No token in localStorage (login may be required or the session expired).');
        return;
    }

    const exp = tokenExpiry(token);
    if (exp !== null && exp <= Date.now()) {
        log('Page token is already expired — waiting for the site to refresh it.');
        return;
    }
    if (token === state.lastWritten) {
        log('Token unchanged.');
        return;
    }

    writeAtomic(outFile, token);
    state.lastWritten = token;
    log(`Wrote ${outFile} (expires ${exp === null ? 'unknown' : new Date(exp).toISOString()}).`);
}

async function main() {
    log(`Profile: ${profileDir}`);
    log(`Output:  ${outFile}`);
    log(`Site:    ${BASE_URL}`);

    // Imported lazily so --help works before `npm install`.
    let chromium;
    try {
        ({ chromium } = await import('playwright'));
    } catch {
        process.stderr.write(
            'playwright is not installed — run:\n' +
            '  npm install\n' +
            '  npx playwright install chromium\n');
        process.exit(1);
    }

    const context = await chromium.launchPersistentContext(profileDir, {
        headless: args.headless,
        viewport: null,
        args: ['--disable-blink-features=AutomationControlled'],
    });

    process.on('SIGINT', async () => {
        log('Shutting down.');
        await context.close().catch(() => {});
        process.exit(0);
    });

    try {
        const page = context.pages()[0] ?? await context.newPage();
        const state = { lastWritten: '' };
        let firstRun = true;
        for (;;) {
            await refreshOnce(page, firstRun, state);
            firstRun = false;
            if (args.interval === 0) break;
            await sleep(args.interval * 1000);
        }
    } finally {
        await context.close().catch(() => {});
    }
}

main().catch((err) => {
    process.stderr.write(`fatal: ${err.message}\n`);
    process.exit(1);
});
