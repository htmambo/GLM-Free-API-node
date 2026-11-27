// Port of internal/zbridge/toolparser_llm.go — Qwen2.5-0.5B-Instruct +
// LoRA tool-call normaliser served by SGLang.
//
// Dormancy contract: nothing in this file runs unless ultra mode is active
// (--agent-mode + --agent-mode-level=ultra). startToolParserLLM() is called
// only under that gate; request handlers fetch the repairer under the same
// gate. Every other path never loads, warms up, or references this module.
//
// Node -> Go mapping:
//   - archive/zip      -> a minimal central-directory reader + inflateRawSync
//   - exec.Command     -> node:child_process spawn/execFile
//   - http.Client      -> global fetch
//   - io.Copy          -> ReadableStream pipe + fs.createWriteStream

import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { agentToolStart, agentToolEnd, agentCallSchema } from './agent.js';
import { config } from './config.js';

export const TOOLPARSER_LLM_BASE_MODEL_ID = 'Qwen/Qwen2.5-0.5B-Instruct';
export const TOOLPARSER_LLM_LORA_URL =
    'https://www.kaggle.com/api/v1/datasets/download/zoxoashouko/v28-flagship-toolparser';
export const TOOLPARSER_LLM_LORA_EXPECTED_FILES = ['adapter_model.safetensors', 'adapter_config.json'];

// ---------------------------------------------------------------------------
// ENV CONFIG
// ---------------------------------------------------------------------------

function envTrim(name) {
    const v = process.env[name];
    return typeof v === 'string' ? v.trim() : '';
}

export function toolParserLLMCacheDir() {
    const d = envTrim('TOOLPARSER_LLM_CACHE_DIR');
    if (d !== '') return d;
    // Go: os.UserCacheDir(); on macOS/Linux it is ~/.cache or ~/Library/Caches.
    const base = process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache');
    return path.join(base, 'glm-free-api', 'toolparser-llm');
}

export function toolParserLLMLoRAURL() {
    return envTrim('TOOLPARSER_LLM_LORA_URL') || TOOLPARSER_LLM_LORA_URL;
}

export function toolParserLLMBaseRef() {
    return envTrim('TOOLPARSER_LLM_BASE_PATH') || TOOLPARSER_LLM_BASE_MODEL_ID;
}

export function toolParserLLMSGLangAddr() {
    return envTrim('TOOLPARSER_LLM_SGLANG_ADDR') || '127.0.0.1:30000';
}

export function toolParserLLMCachePaths() {
    const root = toolParserLLMCacheDir();
    return {
        baseRef: toolParserLLMBaseRef(),
        loraDir: path.join(root, 'lora'),
        loraZip: path.join(root, 'lora-full.zip'),
    };
}

// ToolParserLLMCanonicalSpec is derived from agent.js constants so the model
// and the validator can never drift apart.
export function toolParserLLMCanonicalSpec() {
    return 'Canonical tool-call format (copy character for character, no fences, no narration):\n' +
        agentToolStart + '\n' +
        agentCallSchema + '\n' +
        agentToolEnd + '\n' +
        'The JSON has exactly two keys: "name" (a tool from <tools>) and "arguments" (that tool\'s parameter object). ' +
        'Markers are literal constants ' + agentToolStart + ' / ' + agentToolEnd +
        ' (tolerant parse accepts 2..4 brackets per side, but emit canonical 3).';
}

// ---------------------------------------------------------------------------
// GPU DETECTION
// ---------------------------------------------------------------------------

export function detectGPU() {
    const vis = envTrim('NVIDIA_VISIBLE_DEVICES');
    if (vis !== '' && vis !== 'void' && vis !== 'none') {
        return { ok: true, evidence: `NVIDIA_VISIBLE_DEVICES=${vis}` };
    }
    for (const dev of ['/dev/nvidia0', '/dev/nvidiactl', '/dev/nvidia-uvm']) {
        if (existsSync(dev)) return { ok: true, evidence: `${dev} present` };
    }
    if (existsSync('/proc/driver/nvidia/version')) {
        return { ok: true, evidence: '/proc/driver/nvidia/version present' };
    }
    try {
        const out = execFileSync('nvidia-smi', ['-L'], { timeout: 5000, encoding: 'utf8' });
        const first = out.trim().split('\n')[0];
        if (first !== '') return { ok: true, evidence: `nvidia-smi: ${first}` };
    } catch { /* not available */ }
    return {
        ok: false,
        evidence: 'no NVIDIA device found (checked NVIDIA_VISIBLE_DEVICES, /dev/nvidia*, /proc/driver/nvidia/version, nvidia-smi)',
    };
}

// ---------------------------------------------------------------------------
// ZIP (minimal reader: stored + deflate entries)
// ---------------------------------------------------------------------------

function findEOCD(buf) {
    // EOCD is 22 bytes + up to 65535 comment bytes at the end.
    const min = Math.max(0, buf.length - 22 - 0xffff);
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) return i;
    }
    return -1;
}

function unzipBuffer(buf, destDir) {
    const eocd = findEOCD(buf);
    if (eocd < 0) throw new Error('zip: end-of-central-directory not found');
    const count = buf.readUInt16LE(eocd + 10);
    let off = buf.readUInt32LE(eocd + 16);

    mkdirSync(destDir, { recursive: true });
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('zip: corrupt central directory');
        const method = buf.readUInt16LE(off + 10);
        const compSize = buf.readUInt32LE(off + 20);
        const nameLen = buf.readUInt16LE(off + 28);
        const extraLen = buf.readUInt16LE(off + 30);
        const commentLen = buf.readUInt16LE(off + 32);
        const localOff = buf.readUInt32LE(off + 42);
        const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
        off += 46 + nameLen + extraLen + commentLen;

        const clean = path.normalize(name);
        // Zip-slip guard.
        if (clean.includes('..') || path.isAbsolute(clean)) continue;
        const out = path.join(destDir, clean);
        if (name.endsWith('/')) {
            mkdirSync(out, { recursive: true });
            continue;
        }
        if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error(`zip: corrupt local header for ${name}`);
        const lNameLen = buf.readUInt16LE(localOff + 26);
        const lExtraLen = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lNameLen + lExtraLen;
        const data = buf.subarray(dataStart, dataStart + compSize);
        const raw = method === 0 ? data : inflateRawSync(data);
        mkdirSync(path.dirname(out), { recursive: true });
        writeFileSync(out, raw);
    }
}

// ---------------------------------------------------------------------------
// DOWNLOAD + VERIFY + CACHE
// ---------------------------------------------------------------------------

function fileExistsNonEmpty(p) {
    try {
        const st = statSync(p);
        return !st.isDirectory() && st.size > 0;
    } catch {
        return false;
    }
}

function verifyLoRABundle(dir) {
    const missing = [];
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { /* missing dir */ }
    const subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    const locate = (f) => {
        const cands = [path.join(dir, f), ...subdirs.map((d) => path.join(dir, d, f))];
        return cands.find(fileExistsNonEmpty) ?? '';
    };

    for (const f of TOOLPARSER_LLM_LORA_EXPECTED_FILES) {
        if (locate(f) === '') missing.push(f);
    }
    if (missing.length > 0) {
        throw new Error(
            `ToolParserLLM LoRA bundle incomplete in ${dir}: missing ${JSON.stringify(missing)} ` +
            `(expected ${JSON.stringify(TOOLPARSER_LLM_LORA_EXPECTED_FILES)}); re-download from ` +
            `${toolParserLLMLoRAURL()} or set TOOLPARSER_LLM_LORA_PATH to a directory containing them`);
    }
    const cfgPath = locate('adapter_config.json');
    try {
        JSON.parse(readFileSync(cfgPath, 'utf8'));
    } catch (err) {
        throw new Error(`ToolParserLLM LoRA config at ${cfgPath} is not valid JSON: ${err.message}`);
    }
}

async function downloadFile(url, dst, timeoutMs = 10 * 60_000) {
    const resp = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) {
        throw new Error(`GET ${url} returned ${resp.status} — check TOOLPARSER_LLM_LORA_URL / network`);
    }
    mkdirSync(path.dirname(dst), { recursive: true });
    const tmp = dst + '.part';
    if (!resp.body) throw new Error(`GET ${url} returned an empty body`);
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(tmp));
    if (statSync(tmp).size === 0) {
        await rm(tmp, { force: true });
        throw new Error(`download from ${url} yielded 0 bytes — refusing empty bundle`);
    }
    renameSync(tmp, dst);
}

async function ensureToolParserLLMAssets() {
    const { baseRef: baseRefEnv, loraDir: defaultLoraDir } = toolParserLLMCachePaths();
    let baseRef = baseRefEnv;
    let loraDir = defaultLoraDir;
    let zipPath = toolParserLLMCachePaths().loraZip;

    // Local LoRA override (air-gapped / dev machines).
    const lp = envTrim('TOOLPARSER_LLM_LORA_PATH');
    if (lp !== '') {
        if (!existsSync(lp)) throw new Error(`TOOLPARSER_LLM_LORA_PATH=${lp} not found`);
        if (statSync(lp).isDirectory()) {
            verifyLoRABundle(lp);
            return { baseRef, loraDir: lp };
        }
        loraDir = path.join(toolParserLLMCacheDir(), 'lora-override');
        zipPath = lp;
    }
    if (envTrim('TOOLPARSER_LLM_BASE_PATH') !== '') {
        if (!existsSync(envTrim('TOOLPARSER_LLM_BASE_PATH')) || !statSync(envTrim('TOOLPARSER_LLM_BASE_PATH')).isDirectory()) {
            throw new Error(`TOOLPARSER_LLM_BASE_PATH=${envTrim('TOOLPARSER_LLM_BASE_PATH')} is not a readable directory — unset it to use HF id ${TOOLPARSER_LLM_BASE_MODEL_ID}`);
        }
        baseRef = envTrim('TOOLPARSER_LLM_BASE_PATH');
    }

    const marker = path.join(loraDir, '.verified');
    if (fileExistsNonEmpty(marker)) {
        try {
            verifyLoRABundle(loraDir);
            return { baseRef, loraDir };
        } catch {
            await rm(marker, { force: true }); // stale cache: re-fetch
        }
    }

    if (baseRef !== TOOLPARSER_LLM_BASE_MODEL_ID) {
        if (!existsSync(baseRef) || !statSync(baseRef).isDirectory()) {
            throw new Error(`v28 base model path ${baseRef} unreadable — set TOOLPARSER_LLM_BASE_PATH to a HF snapshot dir or unset it to use ${TOOLPARSER_LLM_BASE_MODEL_ID}`);
        }
    }

    let needsDownload = true;
    if (envTrim('TOOLPARSER_LLM_LORA_PATH') !== '' && existsSync(zipPath) &&
        !statSync(zipPath).isDirectory() && statSync(zipPath).size > 0) {
        needsDownload = false;
    }
    if (needsDownload && fileExistsNonEmpty(zipPath)) {
        needsDownload = false;
        if (envTrim('TOOLPARSER_LLM_REFRESH') === '1') needsDownload = true;
    }
    if (needsDownload) {
        const url = toolParserLLMLoRAURL();
        console.error(`[ToolParserLLM] downloading LoRA bundle from ${url} ...`);
        await downloadFile(url, zipPath);
    }

    if (!fileExistsNonEmpty(zipPath)) {
        throw new Error(`ToolParserLLM LoRA zip missing or empty at ${zipPath} (wanted bundle from ${toolParserLLMLoRAURL()}) — check download / TOOLPARSER_LLM_LORA_PATH`);
    }
    const zipBytes = readFileSync(zipPath);
    console.error(`[ToolParserLLM] LoRA zip ${zipPath} (${zipBytes.length} bytes)`);

    const want = envTrim('TOOLPARSER_LLM_LORA_SHA256').toLowerCase();
    if (want !== '') {
        const got = createHash('sha256').update(zipBytes).digest('hex');
        if (got !== want) {
            throw new Error(`ToolParserLLM LoRA checksum mismatch: got ${got} want ${want} — refusing corrupt bundle (delete ${zipPath} and retry)`);
        }
        console.error(`[ToolParserLLM] LoRA SHA256 verified (${got.slice(0, 16)}…)`);
    }

    mkdirSync(loraDir, { recursive: true });
    unzipBuffer(zipBytes, loraDir);
    verifyLoRABundle(loraDir);
    writeFileSync(marker, `${new Date().toISOString()}\n${zipPath}\n`);
    console.error(`[ToolParserLLM] LoRA bundle verified in ${loraDir} (weights + config present)`);
    return { baseRef, loraDir };
}

// ---------------------------------------------------------------------------
// SGLANG SERVING
// ---------------------------------------------------------------------------

let sglangChild = null;
let sglangBaseURL = '';

export function toolParserLLMSGLangBaseURL() {
    return sglangBaseURL;
}

async function startSGLangWithToolParserLLM(baseRef, loraDir) {
    const addr = toolParserLLMSGLangAddr();
    let host = '127.0.0.1';
    let port = '30000';
    const ci = addr.indexOf(':');
    if (ci > 0 && ci < addr.length - 1) {
        host = addr.slice(0, ci);
        port = addr.slice(ci + 1);
    }
    const py = envTrim('TOOLPARSER_LLM_PYTHON') || 'python3';
    const args = ['-m', 'sglang.launch_server',
        '--model-path', baseRef,
        '--lora-paths', `toolparserllm=${loraDir}`,
        '--host', host, '--port', port,
    ];
    if (!detectGPU().ok) args.push('--device', 'cpu');

    console.error(`[ToolParserLLM] starting SGLang: ${py} ${args.join(' ')}`);
    const child = spawn(py, args, { stdio: ['ignore', 'inherit', 'inherit'] });
    child.on('error', (err) => {
        console.error(`[ToolParserLLM] SGLang spawn failed: ${err.message}`);
    });
    sglangChild = child;
    const base = `http://${host}:${port}`;
    sglangBaseURL = base;

    const deadline = Date.now() + 5 * 60_000;
    while (Date.now() < deadline) {
        for (const p of ['/health', '/v1/models']) {
            try {
                const resp = await fetch(base + p, { signal: AbortSignal.timeout(5000) });
                await resp.text();
                if (resp.status < 500) {
                    console.error(`[ToolParserLLM] SGLang ready at ${base} (base=${baseRef} lora=toolparserllm)`);
                    return;
                }
            } catch { /* not ready yet */ }
        }
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`SGLang at ${base} did not become ready in 5m — check \`pip show sglang\`, GPU/CPU flags, and SGLang logs above`);
}

// ensureToolParserLLMForUltra is the ONLY startup entry point. Callers gate
// on config.ultraEnabled() first.
export async function ensureToolParserLLMForUltra() {
    const gpu = detectGPU();
    if (!gpu.ok && !config.forceCPU) {
        throw new Error(
            `ToolParserLLM ultra mode requires a GPU for SGLang, but none was detected (${gpu.evidence}). ` +
            'CPU inference is NOT recommended (Qwen2.5-0.5B LoRA is ~10-50x slower on CPU and may time out agent requests). ' +
            'Aborting startup. Either run on a GPU host, or pass --force-cpu (env FORCE_CPU=1) to accept the degraded CPU path');
    }
    if (!gpu.ok) {
        console.error(`[ToolParserLLM] WARNING: no GPU detected (${gpu.evidence}) — CPU inference is NOT recommended and will be slow. Proceeding only because --force-cpu was passed (degraded path).`);
        console.error('[ToolParserLLM] WARNING (repeat): ultra repair latency on CPU may exceed agent timeouts; prefer a GPU host with SGLang.');
    } else {
        console.error(`[ToolParserLLM] GPU detected (${gpu.evidence}) — serving ToolParserLLM via SGLang.`);
    }

    const { baseRef, loraDir } = await ensureToolParserLLMAssets();
    await startSGLangWithToolParserLLM(baseRef, loraDir);
    toolParserLLMRepairer = newToolParserSGLangRepairer(toolParserLLMSGLangBaseURL());
}

// ---------------------------------------------------------------------------
// REPAIR CLIENT
// ---------------------------------------------------------------------------

let toolParserLLMRepairer = null;

export function getToolParserLLMRepairer() {
    return toolParserLLMRepairer;
}

export function setToolParserLLMRepairerForTests(r) {
    const prev = toolParserLLMRepairer;
    toolParserLLMRepairer = r;
    return () => { toolParserLLMRepairer = prev; };
}

// ToolParserLLMRepairPrompt sends the canonical spec + tools + the EXTRACTED
// fragment only (never the whole response).
export function toolParserLLMRepairPrompt(fragment, toolsJSON) {
    let tools = (toolsJSON ?? '').trim();
    if (tools === '') tools = '(no tools provided)';
    return 'You are a tool-call normalizer. ' +
        'Given AVAILABLE TOOLS and a MALFORMED tool-call fragment, output ONLY one canonical block, no fences, no narration.\n' +
        toolParserLLMCanonicalSpec() + '\n' +
        '<tools>\n' + tools + '\n</tools>\n' +
        '<malformed>\n' + fragment + '\n</malformed>\n' +
        'Rules: infer the lowercased tool name from the fragment; keep arguments VERBATIM; emit ONLY keys present; ' +
        'copy long values exactly (never abbreviate with ...); never invent or drop arguments.';
}

// newToolParserSGLangRepairer builds the default SGLang-backed repairer.
export function newToolParserSGLangRepairer(baseURL) {
    const base = baseURL.replace(/\/+$/, '');
    return {
        async repairFragment(fragment, toolsJSON, timeoutMs = 60_000) {
            const prompt = toolParserLLMRepairPrompt(fragment, toolsJSON);
            const resp = await fetch(base + '/generate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    text: prompt,
                    sampling_params: { temperature: 0, max_new_tokens: 500 },
                    lora_path: 'toolparserllm',
                    return_logprob: false,
                    stream: false,
                }),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const raw = await resp.text();
            if (!resp.ok) throw new Error(`sglang /generate returned ${resp.status}: ${raw}`);
            try {
                const out = JSON.parse(raw);
                if (typeof out?.text === 'string' && out.text !== '') return out.text.trim();
            } catch { /* fall through to raw text */ }
            return raw.trim();
        },
    };
}
