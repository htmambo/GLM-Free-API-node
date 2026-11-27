// cmd/token-collector/index.js
//
// Standalone script that seeds tokens.sqlite with device tokens for the
// bridge (port of cmd/token-collector/main.go after the Fielin rewrite).
//
// One brief headful browser visit registers a trusted device session and
// captures one genuine device token; every remaining token is minted in
// process by feilin.js (AES-128-CBC payload + md5 seal).
//
// Differences from the Go version:
//   - No Bubble Tea TUI — plain CLI logs (the Go --no-tui behaviour, always on;
//     the flag is accepted as a no-op).
//   - modernc.org/sqlite → node:sqlite DatabaseSync (Node >= 22).
//
// Usage:
//   node index.js                       # interactive prompt
//   node index.js --tokens 850
//   node index.js --session-max-age 15m
//   node index.js --export-session session.json
//   node index.js --help

import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { createInterface } from 'node:readline';
import { existsSync, rmSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { chromium } from 'playwright';

import { SessionMinter, mintDeviceTokens } from './harvest.js';

// ---------- Configuration ----------
export const MAX_TOKENS = 1500;
export const DEFAULT_TOKENS = 850;
const DEFAULT_SESSION_MAX_AGE_MS = 15 * 60_000;

// ---------- CLI ----------

const USAGE = `Usage: node index.js [options]

  --tokens <n>             number of device tokens to mint (0 = prompt; default ${DEFAULT_TOKENS}, max ${MAX_TOKENS})
  --headed                 deprecated no-op: the browser must run headful
                           (headless device sessions are rejected by the
                           Aliyun risk layer)
  --no-tui                 accepted for compatibility (this port has no TUI)
  --export-session <path>  write the harvested session + payload template as JSON
  --session-max-age <dur>  how long a harvested session may be reused (default 15m)
  --help                   show this help
`;

// parseGoDuration accepts the subset of Go's duration syntax used here:
// "15m", "1h30m", "900s", "500ms".
export function parseGoDuration(s) {
    if (typeof s !== 'string' || s === '') return null;
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
    let total = 0;
    let consumed = 0;
    for (let m; (m = re.exec(s)) !== null;) {
        const n = Number(m[1]);
        const unit = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[m[2]];
        total += n * unit;
        consumed += m[0].length;
    }
    if (consumed !== s.length) return null;
    return total;
}

function parseCli(argv) {
    let values;
    try {
        ({ values } = parseArgs({
            args: argv,
            options: {
                tokens: { type: 'string' },
                headed: { type: 'string' }, // accepts --headed / --headed=false
                'no-tui': { type: 'boolean' },
                'export-session': { type: 'string' },
                'session-max-age': { type: 'string' },
                help: { type: 'boolean' },
            },
            allowPositionals: false,
            strict: true,
        }));
    } catch (err) {
        console.error(err.message);
        process.stderr.write(USAGE);
        process.exit(2);
    }

    // --headed is a boolean flag in Go; node:util needs type 'boolean' for a
    // bare flag, so handle the value form manually.
    const headed = values.headed === undefined || values.headed !== 'false';

    let tokens = 0;
    if (values.tokens !== undefined) {
        if (!/^[+-]?\d+$/.test(values.tokens)) {
            console.error(`invalid value "${values.tokens}" for flag -tokens`);
            process.exit(2);
        }
        tokens = Number(values.tokens);
    }

    let sessionMaxAgeMs = DEFAULT_SESSION_MAX_AGE_MS;
    if (values['session-max-age'] !== undefined) {
        const d = parseGoDuration(values['session-max-age']);
        if (d === null) {
            console.error(`invalid value "${values['session-max-age']}" for flag -session-max-age`);
            process.exit(2);
        }
        sessionMaxAgeMs = d;
    }

    return {
        tokens,
        headed,
        noTui: values['no-tui'] === true,
        exportSession: values['export-session'] ?? '',
        sessionMaxAgeMs,
        help: values.help === true,
    };
}

// ---------- Prompt ----------

async function promptInt(question, def, max) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const line = await new Promise((resolve) => rl.question(question, resolve));
        const trimmed = line.trim();
        if (trimmed === '') return def;
        if (!/^[+-]?\d+$/.test(trimmed)) {
            console.log(`⚠️  Invalid input, using default ${def}.`);
            return def;
        }
        const n = Number(trimmed);
        if (n <= 0) {
            console.log(`⚠️  Invalid input, using default ${def}.`);
            return def;
        }
        if (n > max) {
            console.log(`⚠️  Capping to max ${max}.`);
            return max;
        }
        return n;
    } finally {
        rl.close();
    }
}

// ---------- Persistent SQLite store ----------

// One connection, WAL mode + a large cache: the bridge consumes rows FIFO
// ("SELECT token FROM tokens ORDER BY id LIMIT 1") and deletes them after use.
export class TokenStore {
    constructor(dbPath) {
        this.db = new DatabaseSync(dbPath);
        this.db.exec('PRAGMA busy_timeout=10000');
        this.db.exec('PRAGMA journal_mode=WAL');
        this.db.exec('PRAGMA synchronous=NORMAL');
        this.db.exec('PRAGMA cache_size=-65536');
        this.db.exec('PRAGMA temp_store=MEMORY');
        this.db.exec('PRAGMA mmap_size=268435456');
        this.db.exec('PRAGMA wal_autocheckpoint=1000');
        this.db.exec(`CREATE TABLE IF NOT EXISTS tokens (
            id    INTEGER PRIMARY KEY AUTOINCREMENT,
            token TEXT    NOT NULL
        )`);
        this.insert = this.db.prepare('INSERT INTO tokens (token) VALUES (?)');
    }

    add(tokens) {
        this.db.exec('BEGIN');
        try {
            for (const tok of tokens) this.insert.run(tok);
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    close() {
        try { this.db.close(); } catch { /* already closed */ }
    }
}

// ---------- Browser launch ----------

// The risk layer judges the CLIENT, not the request bytes: headful Chromium is
// trusted, headless is not. --enable-automation is stripped from Playwright's
// defaults so the automation infobar flag never reaches the engine.
export async function launchBrowser() {
    return chromium.launch({
        headless: false,
        args: ['--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
    });
}

// ---------- Core run logic ----------

export async function run(tokenCount, sessionMaxAgeMs, exportSessionPath) {
    let browser;
    try {
        browser = await launchBrowser();
    } catch (err) {
        throw new Error(
            `playwright chromium launch failed: ${err.message}\n` +
            'Install the browser first: npx playwright install chromium ' +
            '(on a headless server also install the system deps, e.g. npx playwright install-deps)');
    }

    const dbPath = join('.', 'tokens.sqlite');
    try {
        // Start fresh, including the WAL/SHM sidecars.
        for (const suffix of ['', '-wal', '-shm']) {
            try { rmSync(dbPath + suffix, { force: true }); } catch { /* ignore */ }
        }

        const store = new TokenStore(dbPath);
        try {
            const minter = new SessionMinter(browser);
            const tokens = await mintDeviceTokens(minter, tokenCount, sessionMaxAgeMs);

            try {
                store.add(tokens);
            } catch (err) {
                throw new Error(`database insert: ${err.message}`);
            }

            if (exportSessionPath !== '') {
                try {
                    minter.exportSession(exportSessionPath);
                    console.log(`  🧾 Session exported to ${exportSessionPath}`);
                } catch (err) {
                    console.error(`⚠️  session export failed: ${err.message}`);
                }
            }

            console.log('\n══════════════════════════════════════════');
            console.log('  ✅ ALL TOKENS MINTED');
            console.log(`  📦 ${tokens.length} device tokens`);
            console.log(`  🌐 ${minter.stats()}`);
            if (existsSync(dbPath)) {
                console.log(`  💾 ${dbPath} (${(statSync(dbPath).size / 1024).toFixed(1)} KB)`);
            }
            console.log('══════════════════════════════════════════');
        } finally {
            store.close();
        }
    } finally {
        await browser.close();
    }
}

// ---------- Main ----------

async function main() {
    const opts = parseCli(process.argv.slice(2));
    if (opts.help) {
        process.stdout.write(USAGE);
        return;
    }
    if (!opts.headed) {
        console.error('⚠️  --headed=false is ignored: the Aliyun risk layer rejects');
        console.error('    headless device sessions, so the tokens would not verify.');
    }

    let tokenCount = opts.tokens;
    if (tokenCount <= 0) {
        tokenCount = await promptInt(
            `How many tokens to mint? [default: ${DEFAULT_TOKENS}, max: ${MAX_TOKENS}] `,
            DEFAULT_TOKENS, MAX_TOKENS);
    } else if (tokenCount > MAX_TOKENS) {
        console.log(`⚠️  Capping tokens to max ${MAX_TOKENS}.`);
        tokenCount = MAX_TOKENS;
    }

    try {
        await run(tokenCount, opts.sessionMaxAgeMs, opts.exportSession);
    } catch (err) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
    }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
