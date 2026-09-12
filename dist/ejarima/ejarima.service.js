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
var EjarimaService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.EjarimaService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = __importDefault(require("axios"));
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const playwright_1 = require("playwright");
const ejarima_parse_1 = require("./ejarima.parse");
const PAGE_URL = 'https://www.ejarima.uz/oz/search-admin';
const FORM_ACTION_SUFFIX = '/search-admin/passport';
const CDP_PORT = 19222;
const IS_WINDOWS = process.platform === 'win32';
const NAV_TIMEOUT_MS = 45_000;
const TOKEN_TIMEOUT_MS = 20_000;
const RESULT_TIMEOUT_MS = 60_000;
const SERIAL_SHAPE = /^[A-Z]{2}$/;
const NUMBER_SHAPE = /^\d{7}$/;
let EjarimaService = EjarimaService_1 = class EjarimaService {
    logger = new common_1.Logger(EjarimaService_1.name);
    browser = null;
    chromeProc = null;
    queue = Promise.resolve();
    stats = {
        total: 0,
        found: 0,
        none: 0,
        failed: 0,
        tokenLost: 0,
    };
    getStats() {
        return { ...this.stats };
    }
    async getByPassport(serial, number, withHtml = false) {
        const s = String(serial ?? '')
            .toUpperCase()
            .replace(/[^A-Z]/g, '');
        const n = String(number ?? '').replace(/\D/g, '');
        if (!SERIAL_SHAPE.test(s) || !NUMBER_SHAPE.test(n)) {
            throw new common_1.ServiceUnavailableException('passport must be two letters and seven digits (AA1234567)');
        }
        const run = this.queue.then(() => this.lookup(s, n, withHtml));
        this.queue = run.catch(() => { });
        return run;
    }
    async lookup(serial, number, withHtml) {
        const startedAt = Date.now();
        const took = () => Date.now() - startedAt;
        this.stats.total++;
        const tag = `${serial}·******${number.slice(-1)}`;
        this.logger.log(`▶ START ${tag} (lookup #${this.stats.total})`);
        let page = null;
        try {
            const browser = await this.ensureBrowser();
            const context = browser.contexts()[0] ?? (await browser.newContext());
            page = await context.newPage();
            await page.goto(PAGE_URL, {
                waitUntil: 'domcontentloaded',
                timeout: NAV_TIMEOUT_MS,
            });
            await this.waitForToken(page);
            const html = await this.submit(page, serial, number);
            const result = (0, ejarima_parse_1.parsePassportPage)(html, serial, number);
            if (result.outcome === 'unavailable') {
                this.stats.failed++;
                this.logger.error(`✖ ${tag} — the site did not answer the search after ${took()}ms` +
                    (result.message ? ` — "${result.message}"` : ''));
                throw new common_1.ServiceUnavailableException(result.message || 'ejarima.uz did not run the search');
            }
            if (result.outcome === 'found')
                this.stats.found++;
            else
                this.stats.none++;
            this.logger.log(`✔ DONE ${tag} — ${result.protocols.length} protocol(s), ` +
                `${result.unpaidCount} unpaid in ${took()}ms`);
            return { ...result, tookMs: took(), ...(withHtml ? { html } : {}) };
        }
        catch (err) {
            if (!(err instanceof common_1.ServiceUnavailableException)) {
                this.stats.failed++;
                this.logger.error(`✖ ${tag} failed after ${took()}ms — ${err}`);
            }
            throw err;
        }
        finally {
            await page?.close().catch(() => undefined);
        }
    }
    async waitForToken(page) {
        try {
            await page.waitForFunction(() => {
                const el = document.getElementById('recaptcha-password');
                return !!el && el.value.length > 50;
            }, undefined, { timeout: TOKEN_TIMEOUT_MS });
        }
        catch {
            this.stats.tokenLost++;
            throw new common_1.ServiceUnavailableException('reCAPTCHA did not issue a token — the site would refuse the search');
        }
    }
    async submit(page, serial, number) {
        await page.fill('#serial', serial);
        await page.fill('#number', number);
        await Promise.all([
            page.waitForNavigation({
                waitUntil: 'domcontentloaded',
                timeout: RESULT_TIMEOUT_MS,
            }),
            page.evaluate((suffix) => {
                const form = document.querySelector(`form[action$="${suffix}"]`);
                if (!form)
                    throw new Error('passport form not found on the page');
                form.submit();
            }, FORM_ACTION_SUFFIX),
        ]);
        return page.content();
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
exports.EjarimaService = EjarimaService;
exports.EjarimaService = EjarimaService = EjarimaService_1 = __decorate([
    (0, common_1.Injectable)()
], EjarimaService);
//# sourceMappingURL=ejarima.service.js.map