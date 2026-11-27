// Port of cmd/token-collector/harvest.go — ONE brief browser use, then
// programmatic minting.
//
// The Z.AI risk layer trusts a device session only when the Log1 request that
// created it came from a client it recognises as a real browser, and only
// once the device has uploaded its fingerprint (Log2/Log3) for that session.
// A pure HTTP client can therefore never mint a usable device token: the
// request bytes are not the problem, the *client* is.
//
// So the browser is used exactly once, briefly, to
//   1. boot the Aliyun-SAF captcha SDK on chat.z.ai (Log1 -> InitCaptchaV3 ->
//      Log2 -> Log3, which registers the device), and
//   2. hand us the DeviceConfig (trusted session) and one genuine device token
//      whose payload becomes the collector template.
// After that every token is produced in-process by feilin.js.

import { writeFileSync } from 'node:fs';

import {
    SCENE_ID,
    decryptDeviceConfig,
    verifyToken,
    newPayloadTemplate,
    mintTokens,
} from './feilin.js';

// ZAI_BASE_URL selects a regional deployment (mainland: https://zchat.z.ai).
export const URL = (process.env.ZAI_BASE_URL || 'https://chat.z.ai').trim().replace(/\/+$/, '');

// The Aliyun captcha front-end bundle.
const captchaSDKURL = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js';

// bootCaptchaJS boots the SDK inside the page and returns one genuine device
// token. The mount element must be visible (an off-screen element never gets
// an instance), so the script creates styled elements itself.
export const bootCaptchaJS = `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    try {
        window.AliyunCaptchaConfig = { region: 'sgp', prefix: 'no8xfe' };
        if (!window.initAliyunCaptcha) {
            await new Promise((res, rej) => {
                const s = document.createElement('script');
                s.src = '${captchaSDKURL}';
                s.onload = res;
                s.onerror = () => rej(new Error('captcha sdk load failed'));
                document.head.appendChild(s);
            });
        }
        const el = document.createElement('div');
        el.id = '__zai_cap_el';
        el.style.cssText = 'position:fixed;left:10px;top:200px;width:320px;height:200px;z-index:2147483647;';
        document.body.appendChild(el);
        const btn = document.createElement('button');
        btn.id = '__zai_cap_btn';
        btn.type = 'button';
        btn.textContent = 'go';
        btn.style.cssText = 'position:fixed;left:10px;top:420px;width:120px;height:40px;z-index:2147483647;';
        document.body.appendChild(btn);

        let instance = null;
        window.initAliyunCaptcha({
            SceneId: '${SCENE_ID}',
            mode: 'embed',
            element: '#__zai_cap_el',
            button: '#__zai_cap_btn',
            captchaLogoImg: 'https://z-cdn.chatglm.cn/z-ai/static/logo.svg',
            upLang: true,
            language: 'en',
            timeout: 10000,
            delayBeforeSuccess: false,
            success: () => {}, fail: () => {}, onError: () => {}, onClose: () => {},
            getInstance: (i) => { instance = i; window.__zai_cap_inst = i; },
        });

        const t0 = Date.now();
        while (Date.now() - t0 < 60000) {
            if (instance && instance.captcha && window.z_um &&
                typeof window.z_um.getToken === 'function') break;
            await sleep(200);
        }
        if (!window.z_um || typeof window.z_um.getToken !== 'function') {
            return { ok: false, error: 'captcha SDK did not expose z_um.getToken' };
        }
        // let the collector finish its probes so the payload template is complete
        await sleep(3000);
        const tok = window.z_um.getToken();
        return { ok: true, token: (tok && typeof tok.then === 'function') ? await tok : tok };
    } catch (e) {
        return { ok: false, error: String((e && e.stack) || e) };
    }
})()`;

// harvestSession performs the one-off browser visit.
export async function harvestSession(browser) {
    const ctx = await browser.newContext({});
    try {
        const page = await ctx.newPage();

        // Capture the device service's Log1 response — it carries the
        // DeviceConfig with the trusted session.
        const log1Queue = [];
        page.on('response', (r) => {
            if (!r.url().includes('cloudauth-device-dualstack')) return;
            r.text().then((txt) => {
                if (txt.includes('DeviceConfig')) log1Queue.push(txt);
            }).catch(() => { /* body already gone */ });
        });

        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

        const res = await page.evaluate(bootCaptchaJS);
        if (!res || typeof res !== 'object') {
            throw new Error(`boot captcha: unexpected result ${typeof res}`);
        }
        if (!res.ok) throw new Error(`boot captcha: ${res.error}`);
        if (!res.token) throw new Error('boot captcha: SDK returned an empty device token');
        const token = res.token;

        // The Log1 response may have arrived before or after evaluate returns.
        const log1 = await waitForFirst(log1Queue, 15_000);
        if (!log1) throw new Error('device service Log1 response not captured');

        let lr;
        try {
            lr = JSON.parse(log1);
        } catch (err) {
            throw new Error(`parse Log1 response: ${err.message}`);
        }
        const blob = lr?.ResultObject?.DeviceConfig ?? '';
        if (blob === '') throw new Error('Log1 response carried no DeviceConfig');

        const session = decryptDeviceConfig(blob);

        // The genuine token's payload is the collector template for this device.
        let fields;
        try {
            fields = verifyToken(token, session.sessionKey);
        } catch (err) {
            throw new Error(`decrypt captured device token: ${err.message}`);
        }
        const template = newPayloadTemplate(fields);

        // GatherCost (tC) is a per-SESSION constant; take it from the token the
        // SDK itself produced rather than inventing one.
        const parts = Buffer.from(token, 'base64').toString('utf8').split('#');
        if (parts.length === 5) {
            const gc = Number.parseInt(parts[3], 10);
            if (Number.isFinite(gc) && gc > 0) session.gatherCost = parts[3];
        }

        return { session, template };
    } finally {
        await ctx.close();
    }
}

function waitForFirst(queue, timeoutMs) {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            if (queue.length > 0) return resolve(queue.shift());
            if (Date.now() - started >= timeoutMs) return resolve('');
            setTimeout(tick, 1);
        };
        tick();
    });
}

// MaxHarvestAttempts is how often the one-off browser visit is retried — the
// only network-bound step.
export const MAX_HARVEST_ATTEMPTS = 3;

// sessionMinter turns ONE brief browser visit into many device tokens.
export class SessionMinter {
    constructor(browser) {
        this.browser = browser;
        this.session = null;
        this.template = null;
        this.harvestedAt = 0;
        this.harvestCount = 0;
        this.minted = 0;
    }

    // ensure harvests when there is no usable session or it aged past maxAge.
    async ensure(maxAgeMs) {
        if (this.session && this.session.sessionId !== '' && Date.now() - this.harvestedAt < maxAgeMs) {
            return;
        }
        console.log('🌐 One-off browser visit: registering this device with the FeiLin device service...');
        const h = await harvestSession(this.browser);
        this.session = h.session;
        this.template = h.template;
        this.harvestedAt = Date.now();
        this.harvestCount++;
        console.log(`✅ Trusted device session ${h.session.sessionId} (key ${h.session.sessionKey}) from ${h.template.fields.length} field payload template`);
    }

    // reset drops the current session so the next ensure() re-harvests it.
    reset() {
        if (this.session) this.session.sessionId = '';
    }

    mint(n) {
        if (this.template === null) throw new Error('no payload template - harvest first');
        const toks = mintTokens(this.session, this.template, n, 0);
        this.minted += toks.length;
        return toks;
    }

    stats() {
        return `${this.harvestCount} browser visit(s), ${this.minted} tokens minted programmatically`;
    }

    // exportSession writes the harvested session + genuine payload template as
    // JSON (consumable by .assets/scripts/live_validate.py --session-mint).
    exportSession(path) {
        if (this.template === null) throw new Error('no session to export');
        const blob = {
            session: {
                sessionKey: this.session.sessionKey,
                sessionId: this.session.sessionId,
                serverTs: this.session.serverTs,
                initTime: this.session.initTime,
                ip: this.session.ip,
                tC: this.session.gatherCost,
                region: this.session.region,
            },
            template: this.template.fields,
        };
        writeFileSync(path, JSON.stringify(blob, null, 2));
    }
}

// mintDeviceTokens harvests (retrying) then mints every token in-process.
export async function mintDeviceTokens(minter, total, maxAgeMs) {
    let lastErr = null;
    for (let attempt = 1; attempt <= MAX_HARVEST_ATTEMPTS; attempt++) {
        try {
            await minter.ensure(maxAgeMs);
            lastErr = null;
            break;
        } catch (err) {
            lastErr = err;
            console.log(`❌ Harvest attempt ${attempt}/${MAX_HARVEST_ATTEMPTS} failed: ${err.message}`);
            if (attempt < MAX_HARVEST_ATTEMPTS) {
                console.log('♻️  Retrying the one-off browser visit...');
                minter.reset();
            }
        }
    }
    if (lastErr !== null) throw lastErr;

    console.log(`⚙️  Minting ${total} device tokens from the harvested session (no further browser use)...`);
    const t0 = Date.now();
    const toks = minter.mint(total);
    console.log(`✅ Minted ${toks.length} unique device tokens in ${((Date.now() - t0) / 1000).toFixed(2)}s`);
    return toks;
}
