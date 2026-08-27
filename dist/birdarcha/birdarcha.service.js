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
var BirdarchaService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.BirdarchaService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = __importDefault(require("axios"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const playwright_1 = require("playwright");
const SITE_URL = 'https://new.birdarcha.uz';
const API_HOST = 'api.birdarcha.uz';
const API_MARKER = 'open-register';
const CDP_PORT = 19222;
const IS_WINDOWS = process.platform === 'win32';
const NAV_TIMEOUT_MS = 45_000;
const RESPONSE_TIMEOUT_MS = 60_000;
let BirdarchaService = BirdarchaService_1 = class BirdarchaService {
    logger = new common_1.Logger(BirdarchaService_1.name);
    browser = null;
    chromeProc = null;
    queue = Promise.resolve();
    stats = {
        total: 0,
        ok: 0,
        notFound: 0,
        failed: 0,
        challengeLost: 0,
    };
    getStats() {
        return { ...this.stats };
    }
    async getTraderByPinfl(pinfl) {
        if (!/^\d{14}$/.test(String(pinfl || ''))) {
            throw new common_1.ServiceUnavailableException('PINFL must be 14 digits');
        }
        const run = this.queue.then(() => this.lookup(pinfl));
        this.queue = run.catch(() => { });
        return run;
    }
    async lookup(pinfl) {
        const startedAt = Date.now();
        const took = () => Date.now() - startedAt;
        this.stats.total++;
        this.logger.log(`▶ START pin=${pinfl} (lookup #${this.stats.total})`);
        let page = null;
        try {
            const browser = await this.ensureBrowser();
            const context = browser.contexts()[0] ?? (await browser.newContext());
            page = await context.newPage();
            const answer = this.waitForRegisterResponse(page);
            await page.goto(`${SITE_URL}/check-register`, {
                waitUntil: 'domcontentloaded',
                timeout: NAV_TIMEOUT_MS,
            });
            await this.submitSearch(page, pinfl);
            const answered = await answer;
            if (answered.kind === 'absent') {
                this.stats.notFound++;
                this.logger.log(`○ pin=${pinfl} — register has no such trader (${took()}ms)`);
                return { pinfl, found: false, data: null, tookMs: took() };
            }
            if (answered.kind === 'silent') {
                this.stats.challengeLost++;
                this.logger.error(`✖ pin=${pinfl} — no register response in ${took()}ms (challenge lost?)`);
                throw new common_1.ServiceUnavailableException('Register did not answer — Turnstile challenge likely unresolved');
            }
            const data = this.unwrap(answered.body);
            if (!data) {
                this.stats.notFound++;
                this.logger.log(`○ pin=${pinfl} — register has no such trader (${took()}ms)`);
                return { pinfl, found: false, data: null, tookMs: took() };
            }
            this.stats.ok++;
            this.logger.log(`✔ DONE pin=${pinfl} in ${took()}ms`);
            return { pinfl, found: true, data, tookMs: took() };
        }
        catch (err) {
            if (!(err instanceof common_1.ServiceUnavailableException)) {
                this.stats.failed++;
                this.logger.error(`✖ pin=${pinfl} failed after ${took()}ms — ${err}`);
            }
            throw err;
        }
        finally {
            await page?.close().catch(() => undefined);
        }
    }
    async submitSearch(page, pinfl) {
        const field = page.getByPlaceholder('JSHSHIR').first();
        await field.waitFor({ state: 'visible', timeout: 20_000 });
        await field.fill(pinfl);
        await field.press('Enter').catch(() => undefined);
        const submit = page.locator('button[type="submit"]').first();
        if (await submit.isVisible().catch(() => false)) {
            await submit.click({ timeout: 10_000 }).catch(() => undefined);
        }
    }
    waitForRegisterResponse(page) {
        return new Promise((resolve) => {
            const timer = setTimeout(() => resolve({ kind: 'silent' }), RESPONSE_TIMEOUT_MS);
            const settle = (a) => {
                clearTimeout(timer);
                resolve(a);
            };
            page.on('response', (resp) => {
                const url = resp.url();
                if (!url.includes(API_HOST) || !url.includes(API_MARKER))
                    return;
                const status = resp.status();
                if (status === 200) {
                    void resp
                        .json()
                        .then((body) => settle({ kind: 'body', body: body }))
                        .catch(() => undefined);
                    return;
                }
                if (status === 400) {
                    void resp
                        .text()
                        .then((text) => {
                        if (/NO_CONTENT|topilmadi|topilmadi|не найдена/i.test(text)) {
                            settle({ kind: 'absent' });
                        }
                        else {
                            this.logger.warn(`register rejected the search: ${text.slice(0, 200)}`);
                        }
                    })
                        .catch(() => undefined);
                    return;
                }
                this.logger.warn(`register answered HTTP ${status} on ${url.split('?')[0]}`);
            });
        });
    }
    unwrap(body) {
        if (Array.isArray(body)) {
            return body[0] ?? null;
        }
        if (!body || typeof body !== 'object')
            return null;
        const obj = body;
        if (Array.isArray(obj.data)) {
            return obj.data[0] ?? null;
        }
        if (obj.data && typeof obj.data === 'object') {
            return obj.data;
        }
        if (obj.pin || obj.certificate_number || obj.full_name)
            return obj;
        return null;
    }
    async ensureBrowser() {
        if (this.browser?.isConnected())
            return this.browser;
        this.browser = null;
        if (!(await this.isCdpUp())) {
            const chromePath = this.findChromePath();
            if (!chromePath) {
                throw new common_1.ServiceUnavailableException('Google Chrome not found on this machine');
            }
            const userDataDir = path.join(os.tmpdir(), 'license-cdp-chrome');
            const args = [
                `--remote-debugging-port=${CDP_PORT}`,
                `--user-data-dir=${userDataDir}`,
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-popup-blocking',
            ];
            if (!IS_WINDOWS) {
                args.push('--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu');
            }
            args.push('about:blank');
            this.logger.log('spawning Chrome for CDP');
            this.chromeProc = (0, child_process_1.spawn)(chromePath, args, {
                detached: true,
                stdio: 'ignore',
            });
            this.chromeProc.unref();
            for (let i = 0; i < 20 && !(await this.isCdpUp()); i++) {
                await new Promise((r) => setTimeout(r, 500));
            }
        }
        this.browser = await playwright_1.chromium.connectOverCDP(`http://localhost:${CDP_PORT}`);
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
    findChromePath() {
        const candidates = IS_WINDOWS
            ? [
                'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
                'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
            ]
            : [
                '/usr/bin/google-chrome',
                '/usr/bin/google-chrome-stable',
                '/usr/bin/chromium-browser',
                '/usr/bin/chromium',
                '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            ];
        return candidates.find((p) => fs.existsSync(p)) ?? null;
    }
};
exports.BirdarchaService = BirdarchaService;
exports.BirdarchaService = BirdarchaService = BirdarchaService_1 = __decorate([
    (0, common_1.Injectable)()
], BirdarchaService);
//# sourceMappingURL=birdarcha.service.js.map