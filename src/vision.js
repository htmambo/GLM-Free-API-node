// Port of internal/zbridge/vision.go — vision (image input) support.
//
// Both the OpenAI (/v1/chat/completions) and Anthropic (/v1/messages) surfaces
// accept image inputs, but Z.AI's /api/v2/chat/completions endpoint does not
// take inline image payloads — images must first be uploaded to Z.AI's file
// endpoint and then referenced via a top-level "files" array on the completion
// request (this mirrors what the official chat.z.ai web client does).
//
// Pipeline (processVisionMessages):
//
//  1. Scan the OpenAI-formatted messages for image_url parts (the Anthropic
//     handler converts its own image blocks into this shape first).
//  2. Resolve each image to raw bytes: http(s) URLs are downloaded, data: URLs
//     are base64-decoded. Both paths enforce maxImageSize.
//  3. Upload each image to POST {BASE_URL}/api/v1/files/ as multipart/form-data
//     (field name "file"), authenticated with the active Z.AI token.
//  4. Build one "files" entry per upload in the exact shape the web client uses.
//  5. Rewrite the messages so each image_url part's "url" points at the
//     uploaded file id (the web client's reference form).
//
// Limits: maxImagesPerRequest images per request, each at most maxImageSize.
// Text-only requests are returned byte-for-byte unchanged (no "files" field is
// ever added to the upstream body in that case).
//
// Auth: the file-upload endpoint requires a LOGGED-IN account token. Guest
// sessions (no ZAI_TOKEN) are rejected with 401 on upload, so vision input is
// effectively a ZAI_TOKEN-only feature; model listing and text completions are
// unaffected.
//
// Go -> JS notes:
//   - raw json.RawMessage arguments become JSON strings (or parsed values,
//     which are re-serialized). Return values are JSON strings, like Go's
//     re-marshaled bytes. Go re-marshals map[string]json.RawMessage with
//     alphabetically sorted keys; JS preserves insertion order — the JSON is
//     semantically identical, only key order may differ.
//   - Go's (…, error) returns become thrown Errors; callers surface them as
//     400, same as Go.
//   - The goroutine worker pool (imageUploadWorkers) becomes a small
//     promise-pool with the same bound of 4.
//   - imageHTTPClient (plain client honoring proxy env) becomes plain
//     zaiFetch with cookieJar: null — no uTLS fingerprint spoofing needed
//     (see httpClient.js header); honor HTTP(S)_PROXY by starting node with
//     NODE_USE_ENV_PROXY=1.

import { randomBytes } from 'node:crypto';
import { BASE_URL, zaiUserAgent, config } from './config.js';
import { session } from './state.js';
import { randomUUID, base64Decode } from './util.js';
import { logDebug } from './logger.js';
import { zaiFetch } from './httpClient.js';
import { initializeSession } from './zai.js';

// ============================================================================
// LIMITS
// ============================================================================

// Bounds how many images one completion request may carry (Z.AI web client
// caps attachments; this keeps uploads bounded).
export const maxImagesPerRequest = 10;
// Bounds a single image (bytes).
export const maxImageSize = 50 << 20; // 50 MB
// Bounds one external image download (ms).
export const imageDownloadTimeout = 60_000;
// Bounds one upload to Z.AI /api/v1/files/ (ms).
export const imageUploadTimeout = 120_000;
// Bounds concurrent resolve+upload tasks.
export const imageUploadWorkers = 4;

// resolvedImage: { data: Buffer, filename: string, contentType: string }

// ============================================================================
// ENTRY POINT
// ============================================================================

// processVisionMessages scans an OpenAI-formatted messages array (as a raw
// JSON string, or a parsed array) for image_url parts, uploads every image
// to Z.AI, and returns:
//
//   { rewritten, files }
//
//   - rewritten: JSON string of the messages where every image_url part's
//     "url" has been REPLACED with the uploaded file's id (this is how the
//     official web client references attachments — the part stays, its url
//     becomes the file UUID). Equal to the input when no images are present.
//   - files: one "files" entry per uploaded image (null when none).
//
// Throws when the request is invalid (too many images) or any
// download/upload failed; callers should surface it as a 400.
export async function processVisionMessages(raw, signal) {
    const rawStr = typeof raw === 'string' ? raw : JSON.stringify(raw);

    let messages;
    try {
        messages = JSON.parse(rawStr);
    } catch {
        // Not a JSON array of objects — nothing to extract; pass through.
        return { rewritten: rawStr, files: null };
    }
    if (!Array.isArray(messages)) return { rewritten: rawStr, files: null };

    const found = []; // [{ msgIndex, partIndex, url }]
    const imageMsgIdx = new Set();

    // ── Pass 1: locate every image_url part ──
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg || typeof msg !== 'object') continue;
        const parts = msg.content;
        if (!Array.isArray(parts)) continue; // string content carries no images
        for (let p = 0; p < parts.length; p++) {
            const u = extractImageURL(parts[p]);
            if (u !== '') {
                found.push({ msgIndex: i, partIndex: p, url: u });
                imageMsgIdx.add(i);
            }
        }
    }

    if (found.length === 0) return { rewritten: rawStr, files: null };
    if (found.length > maxImagesPerRequest) {
        throw new Error(
            `too many images: ${found.length} provided, max ${maxImagesPerRequest} per request`);
    }

    // One ref_user_msg_id per image-bearing message (the web client ties each
    // attachment to the user message it was sent with).
    const refIDs = new Map();
    for (const f of found) {
        if (!refIDs.has(f.msgIndex)) refIDs.set(f.msgIndex, randomUUID());
    }

    // ── Pass 2: resolve + upload with bounded concurrency (order-preserving) ──
    const entries = new Array(found.length);
    const errs = new Array(found.length).fill(null);
    let next = 0;
    const worker = async () => {
        while (next < found.length) {
            const idx = next++;
            const f = found[idx];
            try {
                const img = await resolveImage(f.url, signal);
                const fileObj = await uploadImageToZAI(img, signal);
                entries[idx] = buildZAIFileEntry(fileObj, img, refIDs.get(f.msgIndex));
            } catch (err) {
                errs[idx] = err;
            }
        }
    };
    await Promise.all(
        Array.from({ length: Math.min(imageUploadWorkers, found.length) }, worker));

    const errMsgs = errs.filter((e) => e !== null).map((e) => e.message);
    if (errMsgs.length > 0) {
        throw new Error(`image processing failed: ${errMsgs.join('; ')}`);
    }

    // ── Pass 3: point every image_url part at its uploaded file id ──
    const fileIDByMsg = new Map(); // msgIndex -> Map(partIndex -> file id)
    for (let idx = 0; idx < found.length; idx++) {
        const f = found[idx];
        if (!fileIDByMsg.has(f.msgIndex)) fileIDByMsg.set(f.msgIndex, new Map());
        fileIDByMsg.get(f.msgIndex).set(f.partIndex, entries[idx].id ?? '');
    }

    for (let i = 0; i < messages.length; i++) {
        if (!imageMsgIdx.has(i)) continue;
        const msg = messages[i];
        const parts = msg.content;
        if (!Array.isArray(parts)) continue;
        const byPart = fileIDByMsg.get(i);
        for (let p = 0; p < parts.length; p++) {
            const fileID = byPart.get(p);
            if (!fileID) continue;
            const part = parts[p];
            if (part && typeof part === 'object' &&
                part.image_url && typeof part.image_url === 'object') {
                part.image_url.url = fileID; // the web client's reference form
            }
        }
    }

    return { rewritten: JSON.stringify(messages), files: entries };
}

// extractImageParts returns every image_url content part found in an
// OpenAI-formatted messages array (raw JSON string or parsed), in message
// order. After processVisionMessages has run, each returned part's "url" is
// the uploaded Z.AI file id — the reference the model needs to actually
// receive the pixels. Used to re-attach image references after
// transformations that flatten message content to plain text (see
// agentTransformMessages).
export function extractImageParts(raw) {
    let messages;
    try {
        messages = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch {
        return null;
    }
    if (!Array.isArray(messages)) return null;
    const parts = [];
    for (const msg of messages) {
        if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) continue;
        for (const p of msg.content) {
            if (extractImageURL(p) !== '') parts.push(p);
        }
    }
    return parts;
}

// attachImageParts appends image_url parts to the LAST user message of a
// transformed messages array (raw JSON string or parsed), converting string
// content to the typed-parts form when needed. Returns the re-encoded
// messages JSON string, or throws when the input is not a messages array
// (in which case the caller keeps the original).
export function attachImageParts(transformed, imageParts) {
    if (!imageParts || imageParts.length === 0) return transformed;
    let messages;
    try {
        messages = typeof transformed === 'string' ? JSON.parse(transformed) : transformed;
    } catch {
        throw new Error('attach image parts: not a messages array');
    }
    if (!Array.isArray(messages) || messages.length === 0) {
        throw new Error('attach image parts: not a messages array');
    }

    // Locate the last user message (fallback: the last message overall).
    let target = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i].role === 'user') {
            target = i;
            break;
        }
    }
    if (target < 0) target = messages.length - 1;

    const msg = messages[target];
    const content = msg.content;

    let newParts;
    if (Array.isArray(content)) {
        // Already a parts array — append to it.
        newParts = [...content];
    } else if (typeof content === 'string' && content !== '') {
        // String content — promote to a text part first.
        newParts = [{ type: 'text', text: content }];
    } else {
        newParts = [];
    }
    newParts.push(...imageParts);

    msg.content = newParts;
    return JSON.stringify(messages);
}

// ============================================================================
// IMAGE DETECTION & RESOLUTION
// ============================================================================

// extractImageURL returns the image URL from an OpenAI image_url content part,
// or '' if the part is not an image. Accepts the standard shape
// {"type":"image_url","image_url":{"url":"..."}}.
export function extractImageURL(part) {
    if (!part || typeof part !== 'object') return '';
    if (part.type !== 'image_url') return '';
    const iu = part.image_url;
    if (!iu || typeof iu !== 'object') return '';
    return typeof iu.url === 'string' ? iu.url.trim() : '';
}

// resolveImage reduces one image reference (http(s) URL or data: URL) to raw
// bytes plus filename/content-type metadata, enforcing maxImageSize.
export async function resolveImage(rawURL, signal) {
    rawURL = String(rawURL).trim();
    if (rawURL === '') throw new Error('empty image URL');
    if (rawURL.startsWith('data:')) return resolveDataURL(rawURL);
    return downloadImage(rawURL, signal);
}

// resolveDataURL decodes a base64 data: URL (data:<mime>;base64,<payload>).
export function resolveDataURL(rawURL) {
    const comma = rawURL.indexOf(',');
    if (comma < 0) throw new Error("malformed data URL (missing ',')");
    const prefix = 'data:';
    if (comma < prefix.length) throw new Error('malformed data URL');
    const header = rawURL.slice(prefix.length, comma);
    const payload = rawURL.slice(comma + 1);

    const segs = header.split(';');
    let mime = segs[0].trim();
    let base64Flag = false;
    for (const s of segs.slice(1)) {
        if (s.trim().toLowerCase() === 'base64') base64Flag = true;
    }
    if (!base64Flag) {
        throw new Error('unsupported data URL encoding (only ;base64 is supported)');
    }

    // Go tries base64.StdEncoding first and falls back to the lenient
    // decoder (missing padding / URL-safe). Node's decoder is lenient
    // throughout, so one decode covers both paths.
    let data;
    try {
        data = base64Decode(payload);
    } catch (err) {
        throw new Error(`invalid base64 payload in data URL: ${err.message}`);
    }
    if (data.length > maxImageSize) {
        throw new Error(`image exceeds max size of ${maxImageSize} bytes`);
    }
    if (mime === '') mime = detectContentType(data);
    return { data, filename: 'image' + extFromMime(mime), contentType: mime };
}

// downloadImage fetches an http(s) image, capping the read at maxImageSize.
export async function downloadImage(rawURL, signal) {
    let u;
    try {
        u = new URL(rawURL);
    } catch (err) {
        throw new Error(`invalid image URL ${JSON.stringify(rawURL)}: ${err.message}`);
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error(`unsupported image URL scheme ${JSON.stringify(u.protocol.slice(0, -1))}`);
    }

    let resp;
    try {
        resp = await zaiFetch(rawURL, {
            method: 'GET',
            headers: {
                'User-Agent': zaiUserAgent,
                'Accept': 'image/*,*/*;q=0.8',
            },
            cookieJar: null, // Go's imageHTTPClient has no jar attached
            signal: AbortSignal.any(
                [AbortSignal.timeout(imageDownloadTimeout), ...(signal ? [signal] : [])]),
        });
    } catch (err) {
        throw new Error(`image download failed: ${err.message}`);
    }
    if (resp.status < 200 || resp.status >= 300) {
        resp.body?.cancel().catch(() => {});
        throw new Error(`image download returned status ${resp.status} for ${rawURL}`);
    }

    // io.ReadAll(io.LimitReader(resp.Body, maxImageSize+1))
    const chunks = [];
    let total = 0;
    for await (const chunk of resp.body ?? []) {
        chunks.push(chunk);
        total += chunk.length;
        if (total > maxImageSize) break;
    }
    const data = Buffer.concat(chunks);
    if (data.length > maxImageSize) {
        throw new Error(`image exceeds max size of ${maxImageSize} bytes`);
    }

    // Content type: prefer a real detected image type, else the header.
    let ct = detectContentType(data);
    if (!ct.startsWith('image/')) {
        const hct = (resp.headers.get('content-type') ?? '').split(';')[0].trim();
        if (hct.startsWith('image/')) ct = hct;
    }

    let filename = filenameFromURL(u);
    if (filename === '') filename = 'image' + extFromMime(ct);
    return { data, filename, contentType: ct };
}

// ============================================================================
// UPLOAD TO Z.AI
// ============================================================================

// uploadImageToZAI POSTs one image to {BASE_URL}/api/v1/files/ as
// multipart/form-data (field "file") and returns the parsed file object. It
// re-initialises the Z.AI session once on a 401, mirroring deleteZAIChat.
//
// NOTE: the /api/v1/files/ endpoint only accepts a LOGGED-IN account token.
// Guest sessions (no ZAI_TOKEN) are rejected with 401 even though the same
// guest token works for /api/models and chat completions. In that case the
// retry re-initialises a fresh guest session, is rejected again, and the
// caller surfaces "file upload unauthorized (401)" as a 400. Vision therefore
// requires ZAI_TOKEN to be set.
export async function uploadImageToZAI(img, signal) {
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
        const token = session.token;
        const initialized = session.initialized;

        if (token === '' || !initialized) {
            try {
                await initializeSession();
            } catch (err) {
                throw new Error(`session init for file upload: ${err.message}`);
            }
            continue; // re-read the fresh token
        }

        const boundary = '----WebKitFormBoundary' + randomBytes(16).toString('hex');
        const disposition =
            `Content-Disposition: form-data; name="file"; filename=${goQuote(img.filename)}\r\n` +
            (img.contentType !== '' ? `Content-Type: ${img.contentType}\r\n` : '') +
            '\r\n';
        const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\n${disposition}`, 'utf8'),
            img.data,
            Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
        ]);

        if (config.logging.level === 'debug') {
            logDebug(`Z.AI file upload: POST ${BASE_URL}/api/v1/files/ filename=${img.filename} size=${img.data.length} ct=${img.contentType}`);
        }

        let resp;
        try {
            resp = await zaiFetch(BASE_URL + '/api/v1/files/', {
                method: 'POST',
                headers: {
                    'authorization': 'Bearer ' + token,
                    'User-Agent': zaiUserAgent,
                    'Accept': 'application/json',
                    'Content-Type': `multipart/form-data; boundary=${boundary}`,
                },
                body,
                signal: AbortSignal.any(
                    [AbortSignal.timeout(imageUploadTimeout), ...(signal ? [signal] : [])]),
            });
        } catch (err) {
            throw new Error(`file upload connection error: ${err.message}`);
        }
        const respBody = await resp.text();

        if (config.logging.level === 'debug') {
            logDebug(`Z.AI file upload response: ${resp.status} ${truncateString(respBody, 400)}`);
        }

        if (resp.status === 401) {
            session.initialized = false;
            lastErr = new Error('file upload unauthorized (401)');
            continue;
        }
        if (resp.status >= 200 && resp.status < 300) {
            let fileObj;
            try {
                fileObj = JSON.parse(respBody);
            } catch (err) {
                throw new Error(`file upload: invalid JSON response: ${err.message}`);
            }
            if (typeof fileObj.id !== 'string' || fileObj.id === '') {
                throw new Error(`file upload: response missing file id: ${truncateString(respBody, 300)}`);
            }
            return fileObj;
        }
        throw new Error(`file upload failed: ${resp.status}: ${truncateString(respBody, 300)}`);
    }
    if (lastErr === null) lastErr = new Error('file upload: max retries exceeded');
    throw lastErr;
}

// goQuote renders a string the way Go's fmt %q verb does for the inputs that
// reach it here (already-sanitized filenames): wrap in double quotes, escape
// backslash, quote, and control characters.
function goQuote(s) {
    return '"' + s.replace(/["\\\r\n\t]/g, (c) => {
        switch (c) {
            case '"': return '\\"';
            case '\\': return '\\\\';
            case '\r': return '\\r';
            case '\n': return '\\n';
            default: return '\\t';
        }
    }) + '"';
}

// ============================================================================
// FILES PAYLOAD
// ============================================================================

// buildZAIFileEntry shapes one uploaded file into the exact "files" array entry
// the chat.z.ai web client sends alongside a completion request.
export function buildZAIFileEntry(fileObj, img, refUserMsgID) {
    const id = typeof fileObj.id === 'string' ? fileObj.id : '';

    let name = img.filename;
    if (typeof fileObj.filename === 'string' && fileObj.filename !== '') {
        name = fileObj.filename;
    }

    let size = img.data.length;
    const meta = fileObj.meta;
    if (meta && typeof meta === 'object' &&
        typeof meta.size === 'number' && meta.size > 0) {
        size = Math.trunc(meta.size);
    }

    return {
        type: 'image',
        file: fileObj,
        id,
        url: '/api/v1/files/' + id,
        name,
        status: 'uploaded',
        size,
        error: '',
        itemId: randomUUID(),
        media: 'image',
        uploadedAt: Date.now(),
        ref_user_msg_id: refUserMsgID,
    };
}

// ============================================================================
// SMALL HELPERS
// ============================================================================

// extFromMime maps a MIME type to a file extension (with leading dot).
export function extFromMime(mime) {
    switch (String(mime).trim().toLowerCase()) {
        case 'image/png': return '.png';
        case 'image/jpeg':
        case 'image/jpg': return '.jpg';
        case 'image/gif': return '.gif';
        case 'image/webp': return '.webp';
        case 'image/bmp': return '.bmp';
        case 'image/svg+xml': return '.svg';
        case 'image/tiff': return '.tiff';
        case 'image/avif': return '.avif';
        default: return '.bin';
    }
}

// detectContentType is the image-relevant subset of Go's
// http.DetectContentType (magic-byte sniffing on the first 512 bytes).
// Go's sniffer has no SVG/TIFF/AVIF signatures either — those fall through
// to text/plain / application/octet-stream exactly as here.
export function detectContentType(data) {
    const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const head = b.subarray(0, 512);
    const has = (sig, off = 0) =>
        head.length >= off + sig.length && sig.every((v, i) => head[off + i] === v);

    if (has([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (has([0xff, 0xd8, 0xff])) return 'image/jpeg';
    if (head.subarray(0, 6).toString('latin1') === 'GIF87a' ||
        head.subarray(0, 6).toString('latin1') === 'GIF89a') return 'image/gif';
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' &&
        head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    if (has([0x42, 0x4d])) return 'image/bmp'; // "BM"

    // Go: if the first 512 bytes look like text, report text/plain.
    let binary = false;
    for (const byte of head) {
        // Go's sniff considers these non-text bytes.
        if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d &&
            byte !== 0x0c && byte !== 0x08) {
            binary = true;
            break;
        }
    }
    return binary ? 'application/octet-stream' : 'text/plain; charset=utf-8';
}

// filenameFromURL derives a sanitized filename from a URL path, or '' if none.
export function filenameFromURL(u) {
    // path.Base(u.Path): strip trailing slashes, take the last segment.
    let p = u.pathname.replace(/\/+$/, '');
    let base = p.slice(p.lastIndexOf('/') + 1).trim();
    if (base === '' || base === '.' || base === '/') return '';
    let out = '';
    for (const r of base) {
        if ((r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') ||
            (r >= '0' && r <= '9') || r === '-' || r === '_' || r === '.') {
            out += r;
        } else {
            out += '_';
        }
    }
    if (out.length > 100) out = out.slice(0, 100);
    return out;
}

// truncateString clips s to at most n BYTES, appending an ellipsis when cut.
// (The Go comment says runes, but the implementation is byte-based —
// `s[:n]` — and can cut mid-rune; ported byte-faithfully, with the cut
// bytes surfacing as U+FFFD via Buffer's lenient decode, as they would in
// a Go log line.)
export function truncateString(s, n) {
    const buf = Buffer.from(s, 'utf8');
    if (buf.length <= n) return s;
    return buf.subarray(0, n).toString('utf8') + '...';
}
