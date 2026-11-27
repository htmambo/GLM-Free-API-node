// Port of internal/zbridge/middleware.go — JSON helpers + auth/CORS
// middleware.
//
// Handler shape across the whole HTTP surface (Phase 4 convention):
//   handler(req, res, ctx)  — ctx = { url: URL, body: Buffer, signal }
// Middlewares wrap such a handler: wrap(handler) -> handler.
//
// Go -> JS mapping:
//   - json.Marshal -> JSON.stringify (toJSON)
//   - json.NewEncoder(w).Encode(v) -> JSON body + trailing '\n' (writeJSON)
//   - http.Error -> writeError (text/plain + nosniff, message + '\n')
//   - sync.Mutex / flusher interplay lives in the handlers, not here.

import { config } from './config.js';

// Go: toJSON(v) string.
export function toJSON(v) {
    return JSON.stringify(v);
}

// Go: writeJSON(w, status, v) — Content-Type: application/json, status, then
// the JSON document. Go's json.Encoder appends a newline; kept verbatim.
export function writeJSON(res, status, v) {
    const body = JSON.stringify(v) + '\n';
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(body);
}

// Go: http.Error(w, message, status) — text/plain, X-Content-Type-Options:
// nosniff, body is the message plus a trailing newline.
export function writeError(res, message, status) {
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
    });
    res.end(message + '\n');
}

// Go: http.NotFound(w, r) — "404 page not found".
export function writeNotFound(res) {
    writeError(res, '404 page not found', 404);
}

// ============================================================================
// MIDDLEWARE
// ============================================================================

// Go: corsMiddleware(next http.Handler).
export function corsMiddleware(next) {
    return async (req, res, ctx) => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        res.setHeader(
            'Access-Control-Allow-Headers',
            'Content-Type, Authorization, Include-All-Features, x-api-key, anthropic-version');
        if (req.method === 'OPTIONS') {
            res.writeHead(200);
            res.end();
            return;
        }
        await next(req, res, ctx);
    };
}

// Go: checkAuth(r) bool. The token arrives as "Bearer <token>" on the
// Authorization header, or — from Anthropic clients — verbatim on x-api-key.
export function checkAuth(req) {
    if (!config.auth.enabled) return true;
    const authHeader = req.headers['authorization'] ?? '';
    let provided = authHeader;
    if (authHeader.length >= 7 && authHeader.slice(0, 7).toLowerCase() === 'bearer ') {
        provided = authHeader.slice(7);
    }
    if (provided === '') {
        provided = req.headers['x-api-key'] ?? '';
    }
    return provided === config.auth.token;
}

// Go: authMiddleware(next http.HandlerFunc).
export function authMiddleware(next) {
    return async (req, res, ctx) => {
        if (!config.auth.enabled) {
            await next(req, res, ctx);
            return;
        }
        if (!checkAuth(req)) {
            writeJSON(res, 401, {
                type: 'error',
                error: {
                    type: 'authentication_error',
                    message: 'Invalid or missing authentication token',
                },
            });
            return;
        }
        await next(req, res, ctx);
    };
}
