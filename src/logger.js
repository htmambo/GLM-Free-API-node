// Port of the logging parts of internal/zbridge/util.go + types.go.
//
// Go original: verbose is a global flag (types.go), logError/logInfo
// (util.go) are silent unless verbose, timestamps are UTC
// "2006-01-02T15:04:05Z", output goes to stderr under logMu.
// logMu is omitted: Node's single-threaded event loop makes the mutex
// unnecessary.
//
// Note: the Go codebase has NO logDebug/logVerbose functions — other files
// call log.Printf directly. logDebug below is a small convenience addition
// for later phases (gated on verbose AND config.logging.level === 'debug',
// mirroring the debug check in warmupCookies).

import { config } from './config.js';

let verbose = false;

export function setVerbose(v) {
    verbose = !!v;
}

export function isVerbose() {
    return verbose;
}

function timestampUTC() {
    // Go layout "2006-01-02T15:04:05Z" — ISO without milliseconds.
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function logError(msg) {
    if (!verbose) return;
    process.stderr.write(`[${timestampUTC()}] ERROR: ${msg}\n`);
}

export function logInfo(msg) {
    if (!verbose) return;
    process.stderr.write(`[${timestampUTC()}] INFO: ${msg}\n`);
}

export function logDebug(msg) {
    if (!verbose || config.logging.level !== 'debug') return;
    process.stderr.write(`[${timestampUTC()}] DEBUG: ${msg}\n`);
}
