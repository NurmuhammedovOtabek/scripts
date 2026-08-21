"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LicenseService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = __importDefault(require("axios"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const playwright_1 = require("playwright");
const API_BASE = 'https://api.licenses.uz';
const SITE_URL = 'https://license.gov.uz';
const OPEN_SOURCE_PATH = '/v1/register/open_source';
const TURNSTILE_SOLVE_TIMEOUT_MS = 25_000;
const CLICK_RESPONSE_TIMEOUT_MS = 15_000;
const AXIOS_TIMEOUT_MS = 15_000;
const LICENSE_PAGE_SIZE = 50;
const MAX_LICENSE_PAGES = 50;
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const CDP_PORT = 19222;
const IS_WINDOWS = process.platform === 'win32';
const BROWSER_IDLE_MS = 10 * 60 * 1000;
const CHROME_CANDIDATES = IS_WINDOWS
    ? [
        `${process.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
        `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
    ]
    : [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/snap/bin/chromium',
    ];
const RECENT_SAMPLE = 50;
let LicenseService = class LicenseService {
    licenseQueue = Promise.resolve();
    browser = null;
    chromeProc = null;
    idleTimer = null;
    logger = new common_1.Logger('License');
    stats = {
        startedAt: new Date().toISOString(),
        total: 0,
        ok: 0,
        failed: 0,
        emptyResult: 0,
        turnstileSolved: 0,
        turnstileTimeout: 0,
        chromeSpawns: 0,
        apiStatus: {},
        lastOkAt: null,
        lastFailAt: null,
        lastError: null,
        recentMs: [],
        failStreak: 0,
        worstFailStreak: 0,
    };
    async onModuleDestroy() {
        await this.disposeBrowser();
    }
    getStats() {
        const r = this.stats.recentMs;
        return {
            ...this.stats,
            apiStatus: { ...this.stats.apiStatus },
            recentMs: [...r],
            queueBusy: this.busy,
            browserAlive: this.browser?.isConnected() ?? false,
            avgMs: r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null,
        };
    }
    busy = false;
    async getLicensesByTin(tin) {
        const queuedAt = Date.now();
        const result = this.licenseQueue.then(() => {
            const waited = Date.now() - queuedAt;
            if (waited > 1000) {
                this.logger.log(`TIN=${tin} waited ${waited}ms in queue`);
            }
            return this._doGetLicenses(tin);
        });
        this.licenseQueue = result.catch(() => { });
        return result;
    }
    async _doGetLicenses(tin) {
        let page = null;
        const startedAt = Date.now();
        const took = () => Date.now() - startedAt;
        this.busy = true;
        this.stats.total++;
        this.logger.log(`▶ START TIN=${tin} (lookup #${this.stats.total})`);
        try {
            const browser = await this.ensureBrowser();
            const context = browser.contexts()[0];
            page = await context.newPage();
            const captured = await this.captureTokenFromBrowser(page, tin);
            if (captured.token) {
                const certs = await this.fetchLicenseCertificates(tin, captured.token);
                this.recordOk(certs.length, took());
                this.logger.log(`✔ DONE TIN=${tin} — ${certs.length} cert(s) from API list in ${took()}ms`);
                return certs;
            }
            if (captured.certificates.length > 0) {
                this.recordOk(captured.certificates.length, took());
                this.logger.warn(`⚠ TIN=${tin} — no token; returning ${captured.certificates.length} cert(s) ` +
                    `from the browser response, which may be page 1 only`);
                return captured.certificates;
            }
            throw new Error('Turnstile token not obtained — the lookup never reached the registry');
        }
        catch (err) {
            const alive = this.browser?.isConnected() ?? false;
            if (this.browser && !alive) {
                this.logger.error('Chrome died mid-lookup — disposing so the next call respawns');
                await this.disposeBrowser();
            }
            const msg = err instanceof Error ? err.message : String(err);
            this.recordFail(tin, msg, took());
            this.logger.error(`✖ FAIL TIN=${tin} after ${took()}ms — ${msg} (streak=${this.stats.failStreak}, chromeAlive=${alive})`);
            throw new common_1.InternalServerErrorException(`Failed to fetch licenses for TIN ${tin}: ${msg}`);
        }
        finally {
            this.busy = false;
            if (page)
                await page.close().catch(() => { });
            this.scheduleIdleShutdown();
        }
    }
    findChromePath() {
        for (const p of CHROME_CANDIDATES) {
            try {
                fs.accessSync(p);
                return p;
            }
            catch { }
        }
        return null;
    }
    async waitForCdpReady(timeout = 10_000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
            try {
                await axios_1.default.get(`http://localhost:${CDP_PORT}/json/version`, {
                    timeout: 1000,
                });
                return;
            }
            catch {
                await new Promise((r) => setTimeout(r, 500));
            }
        }
        throw new Error(`Chrome CDP endpoint not available after ${timeout}ms`);
    }
    pushDuration(ms) {
        this.stats.recentMs.push(ms);
        if (this.stats.recentMs.length > RECENT_SAMPLE)
            this.stats.recentMs.shift();
    }
    recordOk(certCount, ms) {
        this.stats.ok++;
        if (certCount === 0)
            this.stats.emptyResult++;
        this.stats.failStreak = 0;
        this.stats.lastOkAt = new Date().toISOString();
        this.pushDuration(ms);
    }
    recordFail(tin, reason, ms) {
        this.stats.failed++;
        this.stats.failStreak++;
        if (this.stats.failStreak > this.stats.worstFailStreak) {
            this.stats.worstFailStreak = this.stats.failStreak;
        }
        this.stats.lastFailAt = new Date().toISOString();
        this.stats.lastError = `TIN=${tin}: ${reason}`;
        this.pushDuration(ms);
        if (this.stats.failStreak >= 3) {
            this.logger.error(`⚠ ${this.stats.failStreak} FAILURES IN A ROW — possible rate limit or upstream change. Last: ${reason}`);
        }
    }
    async ensureBrowser() {
        if (this.browser?.isConnected())
            return this.browser;
        await this.disposeBrowser();
        if (!(await this.isCdpUp())) {
            const chromePath = this.findChromePath();
            if (!chromePath) {
                throw new Error('Google Chrome not found. Install Chrome to proceed.');
            }
            const userDataDir = path.join(os.tmpdir(), 'license-cdp-chrome');
            const chromeArgs = [
                `--remote-debugging-port=${CDP_PORT}`,
                `--user-data-dir=${userDataDir}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-popup-blocking',
            ];
            if (!IS_WINDOWS) {
                chromeArgs.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
            }
            chromeArgs.push('about:blank');
            this.chromeProc = (0, child_process_1.spawn)(chromePath, chromeArgs, {
                detached: true,
                stdio: 'ignore',
            });
            this.chromeProc.unref();
            this.stats.chromeSpawns++;
            this.logger.log(`Chrome spawned (PID ${this.chromeProc.pid}) — spawn #${this.stats.chromeSpawns}`);
            await this.waitForCdpReady();
        }
        else {
            this.logger.log('reusing Chrome already listening on CDP');
        }
        this.browser = await playwright_1.chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
        this.logger.log('connected to Chrome (kept alive between lookups)');
        return this.browser;
    }
    async isCdpUp() {
        try {
            await axios_1.default.get(`http://localhost:${CDP_PORT}/json/version`, {
                timeout: 1000,
            });
            return true;
        }
        catch {
            return false;
        }
    }
    async disposeBrowser() {
        if (this.idleTimer) {
            clearTimeout(this.idleTimer);
            this.idleTimer = null;
        }
        if (this.browser) {
            await this.browser.close().catch(() => { });
            this.browser = null;
        }
        this.killChromeProcess(this.chromeProc);
        this.chromeProc = null;
    }
    scheduleIdleShutdown() {
        if (this.idleTimer)
            clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => {
            this.logger.log('idle — closing Chrome to release memory');
            void this.disposeBrowser();
        }, BROWSER_IDLE_MS);
        this.idleTimer.unref?.();
    }
    killChromeProcess(proc) {
        if (!proc?.pid)
            return;
        try {
            if (IS_WINDOWS) {
                (0, child_process_1.execSync)(`taskkill /F /PID ${proc.pid} /T`, { stdio: 'ignore' });
            }
            else {
                (0, child_process_1.execSync)(`kill -9 ${proc.pid}`, { stdio: 'ignore' });
            }
            this.logger.log(`Chrome process ${proc.pid} killed`);
        }
        catch { }
    }
    async captureTokenFromBrowser(page, tin) {
        const collectedUuids = new Set();
        const collectedCertificates = [];
        let capturedToken = null;
        page.on('response', async (resp) => {
            try {
                const url = resp.url();
                if (!url.includes('api.licenses.uz'))
                    return;
                const status = resp.status();
                const token = resp.request().headers()['x-turnstile-token'];
                const key = String(status);
                this.stats.apiStatus[key] = (this.stats.apiStatus[key] ?? 0) + 1;
                if (status === 429 || status === 403) {
                    this.logger.error(`⚠ REGISTRY REFUSED: HTTP ${status} on ${url.split('?')[0]} — rate limit or block`);
                }
                else if (status >= 400) {
                    this.logger.warn(`registry HTTP ${status} on ${url.split('?')[0]}`);
                }
                if (token && !capturedToken) {
                    capturedToken = token;
                    this.logger.log('Turnstile token captured');
                }
                if (url.includes('open_source') && status === 200) {
                    const body = await resp.json().catch(() => null);
                    if (body) {
                        const certs = body?.data?.certificates;
                        if (Array.isArray(certs) && certs.length > 0) {
                            for (const c of certs)
                                collectedCertificates.push(c);
                            this.logger.log(`captured ${certs.length} certificate(s) from response`);
                        }
                        const uuids = this.extractUuids(body);
                        for (const id of uuids)
                            collectedUuids.add(id);
                        if (body?.uuid)
                            collectedUuids.add(String(body.uuid));
                        if (body?.data?.uuid)
                            collectedUuids.add(String(body.data.uuid));
                    }
                }
            }
            catch (err) {
                this.logger.warn(`response handler error: ${err}`);
            }
        });
        this.logger.log(`navigating to registry for TIN=${tin}`);
        const navAt = Date.now();
        await page.goto(`${SITE_URL}/registry?filter[tin]=${encodeURIComponent(tin)}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForLoadState('networkidle').catch(() => { });
        this.logger.log(`page ready in ${Date.now() - navAt}ms`);
        const solveAt = Date.now();
        const turnstileToken = await this.extractTurnstileToken(page);
        const solveMs = Date.now() - solveAt;
        if (turnstileToken) {
            this.stats.turnstileSolved++;
            this.logger.log(`Turnstile solved in ${solveMs}ms`);
        }
        else {
            this.stats.turnstileTimeout++;
            const share = this.stats.turnstileTimeout /
                Math.max(1, this.stats.turnstileSolved + this.stats.turnstileTimeout);
            this.logger.warn(`Turnstile TIMED OUT after ${solveMs}ms — timeout rate ${(share * 100).toFixed(0)}% (${this.stats.turnstileTimeout}/${this.stats.turnstileSolved + this.stats.turnstileTimeout})`);
        }
        if (turnstileToken || capturedToken) {
            await page.waitForTimeout(5000);
        }
        const token = capturedToken || turnstileToken;
        if (token && collectedUuids.size > 0) {
            return {
                token,
                uuids: [...collectedUuids],
                certificates: collectedCertificates,
            };
        }
        if (token) {
            return { token, uuids: [], certificates: collectedCertificates };
        }
        try {
            const detailPromise = page
                .waitForResponse((resp) => this.isTokenBearingResponse(resp), {
                timeout: CLICK_RESPONSE_TIMEOUT_MS,
            })
                .catch(() => null);
            await this.clickFirstResult(page, tin);
            const detailResp = await detailPromise;
            if (detailResp) {
                const tkn = detailResp.request().headers()['x-turnstile-token'];
                if (tkn) {
                    const urlUuids = detailResp.url().match(UUID_RE);
                    if (urlUuids)
                        for (const id of urlUuids)
                            collectedUuids.add(id);
                    return {
                        token: tkn,
                        uuids: [...collectedUuids],
                        certificates: collectedCertificates,
                    };
                }
            }
        }
        catch (err) {
            this.logger.warn(`fallback click failed: ${err}`);
        }
        throw new Error('Could not obtain Turnstile token — Turnstile did not solve');
    }
    async extractTurnstileToken(page) {
        const hasTurnstile = await page.evaluate(() => ({
            cfWidget: !!document.querySelector('.cf-turnstile'),
            cfIframe: !!document.querySelector('iframe[src*="turnstile"]'),
        }));
        if (hasTurnstile.cfWidget || hasTurnstile.cfIframe) {
            try {
                const frame = page.frameLocator('iframe[src*="turnstile"]');
                await frame
                    .locator('input[type="checkbox"], .mark, body')
                    .first()
                    .click({ timeout: 3000 });
            }
            catch {
                try {
                    await page.locator('.cf-turnstile').first().click({ timeout: 2000 });
                }
                catch { }
            }
        }
        try {
            const handle = await page.waitForFunction(() => {
                try {
                    const t = window.turnstile;
                    if (t && typeof t.getResponse === 'function') {
                        const r = t.getResponse();
                        if (r && typeof r === 'string' && r.length > 20)
                            return r;
                    }
                }
                catch { }
                const input = document.querySelector('[name="cf-turnstile-response"]');
                if (input?.value && input.value.length > 20)
                    return input.value;
                const widget = document.querySelector('.cf-turnstile');
                if (widget) {
                    const val = widget.getAttribute('data-response') ||
                        widget.getAttribute('data-token');
                    if (val && val.length > 20)
                        return val;
                }
                return null;
            }, { timeout: TURNSTILE_SOLVE_TIMEOUT_MS });
            return (await handle.jsonValue());
        }
        catch {
            return null;
        }
    }
    isTokenBearingResponse(resp) {
        const url = resp.url();
        if (!url.includes('api.licenses.uz'))
            return false;
        if (!url.includes('open_source'))
            return false;
        if (resp.status() !== 200)
            return false;
        return !!resp.request().headers()['x-turnstile-token'];
    }
    async clickFirstResult(page, _tin) {
        const chipBox = await page
            .locator(`text=/STIR/i`)
            .first()
            .boundingBox()
            .catch(() => null);
        const minY = chipBox ? chipBox.y + chipBox.height + 50 : 380;
        const allLinks = await page.locator('a:visible').all();
        for (let i = 0; i < allLinks.length; i++) {
            const link = allLinks[i];
            const box = await link.boundingBox().catch(() => null);
            const text = ((await link.textContent()) || '').trim().slice(0, 60);
            if (!box)
                continue;
            if (box.y < minY || box.width < 20 || box.height < 10)
                continue;
            if (text === 'Barcha' || text.startsWith('STIR'))
                continue;
            await link.click();
            return;
        }
        for (const label of ['License', 'Litsenziya', 'Ruxsatnoma']) {
            const el = page.getByText(label).first();
            const vis = await el.isVisible().catch(() => false);
            if (vis) {
                const box = await el.boundingBox().catch(() => null);
                if (box && box.y >= minY) {
                    await el.click();
                    return;
                }
            }
        }
        const clickInfo = await page.evaluate((minY) => {
            const els = document.querySelectorAll('div, span, td, tr, li, article');
            for (const el of els) {
                const rect = el.getBoundingClientRect();
                if (rect.top < minY || rect.width < 50 || rect.height < 20)
                    continue;
                if (window.getComputedStyle(el).cursor === 'pointer') {
                    el.click();
                    return true;
                }
            }
            return false;
        }, minY);
        if (clickInfo)
            return;
        if (chipBox) {
            const x = chipBox.x + 200;
            const y = chipBox.y + chipBox.height + 150;
            await page.mouse.click(x, y);
        }
    }
    extractUuids(body) {
        if (!body || typeof body !== 'object')
            return [];
        const obj = body;
        let items = [];
        const arraySource = obj?.data?.certificates ??
            obj?.data?.content ??
            obj?.data?.items ??
            obj?.content ??
            obj?.items;
        if (Array.isArray(arraySource)) {
            items = arraySource;
        }
        else if (Array.isArray(obj?.data)) {
            items = obj.data;
        }
        else if (obj?.data && typeof obj.data === 'object') {
            const values = Object.values(obj.data);
            if (values.length > 0 &&
                values.every((v) => v && typeof v === 'object')) {
                items = values;
            }
        }
        const uuids = [];
        const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        for (const item of items) {
            if (!item || typeof item !== 'object')
                continue;
            const it = item;
            const id = it.uuid ??
                it.id ??
                it.registerId ??
                it.register_id ??
                it.certificateId ??
                it.certificate_id ??
                it.docId;
            if (id && typeof id === 'string' && uuidPattern.test(id)) {
                uuids.push(id);
            }
        }
        if (uuids.length === 0 && items.length > 0) {
            const jsonStr = JSON.stringify(items);
            const globalUuidRe = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
            let match;
            while ((match = globalUuidRe.exec(jsonStr)) !== null) {
                if (!uuids.includes(match[0]))
                    uuids.push(match[0]);
            }
        }
        return uuids;
    }
    buildApiHeaders(token) {
        return {
            Accept: 'application/json',
            Origin: SITE_URL,
            Referer: `${SITE_URL}/`,
            'User-Agent': DEFAULT_USER_AGENT,
            'x-turnstile-token': token,
        };
    }
    async fetchLicenseCertificates(tin, token) {
        const all = [];
        let reportedTotal = null;
        for (let page = 0; page < MAX_LICENSE_PAGES; page++) {
            const url = `${API_BASE}${OPEN_SOURCE_PATH}` +
                `?tin=${encodeURIComponent(tin)}&page=${page}&size=${LICENSE_PAGE_SIZE}`;
            const resp = await axios_1.default.get(url, {
                headers: this.buildApiHeaders(token),
                timeout: AXIOS_TIMEOUT_MS,
            });
            const body = resp.data?.data;
            const certs = body?.certificates;
            if (!Array.isArray(certs) || certs.length === 0)
                break;
            all.push(...certs);
            const total = body?.total_items ?? body?.total ?? body?.totalCount;
            if (typeof total === 'number')
                reportedTotal = total;
            if (certs.length < LICENSE_PAGE_SIZE)
                break;
            if (reportedTotal !== null && all.length >= reportedTotal)
                break;
        }
        if (all.length === MAX_LICENSE_PAGES * LICENSE_PAGE_SIZE) {
            this.logger.warn(`TIN=${tin} — hit the ${MAX_LICENSE_PAGES}-page cap at ${all.length} certificates; ` +
                `the list may be incomplete`);
        }
        else if (reportedTotal !== null && all.length < reportedTotal) {
            this.logger.warn(`TIN=${tin} — collected ${all.length} of ${reportedTotal} certificates the registry reports`);
        }
        return all;
    }
};
exports.LicenseService = LicenseService;
exports.LicenseService = LicenseService = __decorate([
    (0, common_1.Injectable)()
], LicenseService);
//# sourceMappingURL=license.service.js.map