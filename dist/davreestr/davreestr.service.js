"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var DavreestrService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DavreestrService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = require("@nestjs/axios");
const rxjs_1 = require("rxjs");
const user_agent_pool_1 = require("./user-agent.pool");
const html_parser_service_1 = require("../html-parser/html-parser.service");
const captcha_solver_client_1 = require("../common/captcha-solver.client");
const memory_cache_service_1 = require("../common/memory-cache.service");
const no_proxy_pool_1 = require("../common/no-proxy.pool");
let DavreestrService = DavreestrService_1 = class DavreestrService {
    httpService;
    htmlParser;
    solverClient;
    cacheManager;
    proxyPool;
    logger = new common_1.Logger(DavreestrService_1.name);
    session = {
        csrfToken: '',
        xsrfToken: '',
        laravelSession: '',
        cookieString: '',
        userAgent: '',
        proxy: null,
        proxyAgent: null,
    };
    userAgentIndex = 0;
    requestCount = 0;
    MAX_REQUESTS = 15;
    TIME_WINDOW = 60000;
    windowStart = Date.now();
    CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    CACHE_GET_TIMEOUT_MS = 2000;
    constructor(httpService, htmlParser, solverClient, cacheManager, proxyPool) {
        this.httpService = httpService;
        this.htmlParser = htmlParser;
        this.solverClient = solverClient;
        this.cacheManager = cacheManager;
        this.proxyPool = proxyPool;
    }
    DIRECT_TIMEOUT_MS = 30_000;
    PROXY_TIMEOUT_MS = 10_000;
    get transport() {
        if (!this.session.proxy) {
            return { timeout: this.DIRECT_TIMEOUT_MS };
        }
        return {
            httpsAgent: this.session.proxyAgent,
            proxy: false,
            timeout: this.PROXY_TIMEOUT_MS,
        };
    }
    isPartial(parsed) {
        const declared = Number(parsed?.totalCount) || 0;
        const rows = Number(parsed?.rowsSeen) || 0;
        const numbers = parsed?.cadNumbers?.length ?? 0;
        return declared > Math.max(rows, numbers);
    }
    cacheKeyForTin(tin) {
        return `davreestr:tin:${tin}`;
    }
    cacheKeyForCad(cadNumber) {
        return `davreestr:cad:${cadNumber}`;
    }
    async cacheGet(key) {
        try {
            const cached = await Promise.race([
                this.cacheManager.get(key),
                new Promise((_, reject) => setTimeout(() => reject(new Error('cache timeout')), this.CACHE_GET_TIMEOUT_MS)),
            ]);
            return cached ?? undefined;
        }
        catch (err) {
            this.logger.warn(`[cache] get failed (key=${key}): ${err.message}`);
            return undefined;
        }
    }
    async cacheSet(key, value) {
        try {
            await Promise.race([
                this.cacheManager.set(key, value, this.CACHE_TTL_MS),
                new Promise((_, reject) => setTimeout(() => reject(new Error('cache timeout')), this.CACHE_GET_TIMEOUT_MS)),
            ]);
        }
        catch (err) {
            this.logger.warn(`[cache] set failed (key=${key}): ${err.message}`);
        }
    }
    getNextUserAgent() {
        const userAgent = user_agent_pool_1.USER_AGENTS[this.userAgentIndex];
        this.userAgentIndex = (this.userAgentIndex + 1) % user_agent_pool_1.USER_AGENTS.length;
        this.logger.debug(`[ua] selected: ${userAgent.substring(0, 50)}...`);
        return userAgent;
    }
    getSessionUserAgent() {
        if (!this.session.userAgent) {
            this.session.userAgent = this.getNextUserAgent();
        }
        return this.session.userAgent;
    }
    async initializeSession(forceDirect = false) {
        try {
            this.session.proxy = forceDirect ? null : this.proxyPool.acquire();
            this.session.proxyAgent = this.session.proxy
                ? this.proxyPool.agentFor(this.session.proxy)
                : null;
            this.logger.log(`Sessiya boshlanmoqda... ${this.session.proxy ? `proxy=${this.session.proxy}` : "o'z IP"}`);
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.get('https://davreestr.uz/uz', {
                headers: {
                    'User-Agent': this.getSessionUserAgent(),
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7',
                    'Cache-Control': 'no-cache',
                    Pragma: 'no-cache',
                    Connection: 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                },
                ...this.transport,
            }));
            const html = response.data;
            const metaMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
            if (metaMatch) {
                this.session.csrfToken = metaMatch[1];
                this.logger.log(`CSRF token olindi: ${this.session.csrfToken}`);
            }
            const cookies = response.headers['set-cookie'];
            if (cookies) {
                cookies.forEach((cookie) => {
                    if (cookie.includes('XSRF-TOKEN')) {
                        this.session.xsrfToken = this.extractCookieValue(cookie);
                    }
                    else if (cookie.includes('laravel_session')) {
                        this.session.laravelSession = this.extractCookieValue(cookie);
                    }
                });
                this.session.cookieString = `XSRF-TOKEN=${this.session.xsrfToken}; laravel_session=${this.session.laravelSession}`;
                this.logger.log('Cookies olindi');
            }
        }
        catch (error) {
            if (this.session.proxy && !error.response) {
                const dead = this.session.proxy;
                this.proxyPool.report(dead, false);
                this.session.proxy = null;
                this.session.proxyAgent = null;
                this.logger.warn(`[proxy] ${dead} sessiyani ocholmadi — o'z IP bilan qayta urinilmoqda`);
                return this.initializeSession(true);
            }
            this.logger.error(`Sessiya boshlashda xatolik: ${error.message}`);
            throw error;
        }
    }
    captchaImgUrl = '';
    async fetchCaptcha() {
        try {
            if (!this.session.cookieString) {
                await this.initializeSession();
            }
            if (!this.captchaImgUrl) {
                await this.extractCaptchaUrl();
            }
            const captchaUrl = this.captchaImgUrl || 'https://davreestr.uz/captcha/default';
            this.logger.log(`Captcha URL: ${captchaUrl}`);
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.get(captchaUrl, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': this.getSessionUserAgent(),
                    Accept: 'image/*,*/*',
                    'Accept-Language': 'en,en-US;q=0.9,ru;q=0.8',
                    Referer: 'https://davreestr.uz/uz',
                    Cookie: this.session.cookieString,
                    Connection: 'keep-alive',
                },
                ...this.transport,
            }));
            this.updateCookies(response.headers['set-cookie']);
            return Buffer.from(response.data);
        }
        catch (error) {
            this.logger.error(`Captcha olishda xatolik: ${error.message}`);
            throw error;
        }
    }
    async extractCaptchaUrl() {
        try {
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.get('https://davreestr.uz/uz', {
                headers: {
                    'User-Agent': this.getSessionUserAgent(),
                    Accept: 'text/html,*/*',
                    Cookie: this.session.cookieString,
                },
                ...this.transport,
            }));
            this.updateCookies(response.headers['set-cookie']);
            const html = String(response.data);
            const imgMatch = html.match(/captcha\/default\?[^"'\s]+/);
            if (imgMatch) {
                this.captchaImgUrl = `https://davreestr.uz/${imgMatch[0]}`;
                this.logger.log(`Captcha URL topildi: ${this.captchaImgUrl}`);
            }
            const metaMatch = html.match(/<meta name="csrf-token" content="([^"]+)"/);
            if (metaMatch) {
                this.session.csrfToken = metaMatch[1];
            }
        }
        catch (error) {
            this.logger.warn(`Captcha URL olishda xatolik: ${error.message}`);
        }
    }
    MAX_SEARCH_RETRIES = 3;
    async searchByTin(tin, retryCount = 0) {
        try {
            if (retryCount === 0) {
                const cacheKey = this.cacheKeyForTin(tin);
                const cached = await this.cacheGet(cacheKey);
                if (cached !== undefined) {
                    this.logger.log(`[CACHE HIT] davreestr TIN=${tin}`);
                    return { success: true, data: cached, rateLimit: { cached: true } };
                }
                this.logger.log(`[CACHE MISS] davreestr TIN=${tin}`);
            }
            await this.checkRateLimit();
            if (!this.session.csrfToken) {
                await this.initializeSession();
            }
            const captchaCode = await this.solveCaptcha();
            this.logger.log(`Captcha yechildi: ${captchaCode}`);
            const formData = new URLSearchParams();
            formData.append('_token', this.session.csrfToken);
            formData.append('type', 'org_tin');
            formData.append('cad_number', '');
            formData.append('org_tin', tin);
            formData.append('captcha', captchaCode);
            this.logger.log(`So'rov yuborilmoqda: STIR=${tin}, Captcha=${captchaCode}`);
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.post('https://davreestr.uz/data/get-info/search', formData.toString(), {
                headers: {
                    'User-Agent': this.getSessionUserAgent(),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en,en-US;q=0.9,ru;q=0.8',
                    Origin: 'https://davreestr.uz',
                    Referer: 'https://davreestr.uz/uz',
                    Cookie: this.session.cookieString,
                    Connection: 'keep-alive',
                    'Cache-Control': 'max-age=0',
                    'Upgrade-Insecure-Requests': '1',
                },
                ...this.transport,
            }));
            this.requestCount++;
            this.updateCookies(response.headers['set-cookie']);
            const remaining = response.headers['x-ratelimit-remaining'];
            this.logger.log(`Qolgan so'rovlar: ${remaining}`);
            const html = String(response.data || '');
            const parsed = this.htmlParser.parseDavreestr(html);
            const hasDummy = Array.isArray(parsed.cadNumbers) &&
                parsed.cadNumbers.some((n) => String(n || '').startsWith('99:99:99:99:99:9999'));
            if (hasDummy) {
                try {
                    const fs = require('fs/promises');
                    const path = require('path');
                    const dir = path.join(process.cwd(), 'data', 'davreestr-dumps');
                    await fs.mkdir(dir, { recursive: true });
                    const ts = new Date().toISOString().replace(/[:.]/g, '-');
                    const file = path.join(dir, `dummy-${tin}-${ts}.html`);
                    await fs.writeFile(file, html, 'utf8');
                    this.logger.warn(`[davreestr DUMP] TIN=${tin} dummy javobi saqlandi: ${file}`);
                    const idx = html.indexOf('99:99:99:99:99:9999');
                    if (idx !== -1) {
                        const start = Math.max(0, idx - 200);
                        const end = Math.min(html.length, idx + 200);
                        this.logger.warn(`[davreestr DUMP] TIN=${tin} kontekst (yon-atrof):\n${html.substring(start, end)}`);
                    }
                }
                catch (e) {
                    this.logger.error(`[davreestr DUMP] saqlash xato: ${e.message}`);
                }
            }
            if (!parsed.success &&
                parsed.error &&
                parsed.error.includes("noto'g'ri") &&
                retryCount < this.MAX_SEARCH_RETRIES) {
                this.logger.warn(`Captcha xato (${retryCount + 1}/${this.MAX_SEARCH_RETRIES}), qayta urinish...`);
                await this.delay(1000);
                return this.searchByTin(tin, retryCount + 1);
            }
            if (parsed.success && !this.isPartial(parsed)) {
                await this.cacheSet(this.cacheKeyForTin(tin), parsed);
            }
            return {
                success: parsed.success,
                data: parsed,
                rateLimit: {
                    remaining: remaining,
                    limit: response.headers['x-ratelimit-limit'],
                },
            };
        }
        catch (error) {
            this.logger.error(`Xatolik: ${error.message}`);
            if (!error.response && this.session.proxy) {
                this.proxyPool.report(this.session.proxy, false);
            }
            if (error.response && retryCount < this.MAX_SEARCH_RETRIES) {
                const status = error.response.status;
                this.logger.error(`Status: ${status}`);
                if (status === 429) {
                    const retryAfter = parseInt(error.response.headers['retry-after']) || 60;
                    this.logger.warn(`429: ${retryAfter} sek kutish...`);
                    await this.delay(retryAfter * 1000);
                    return this.searchByTin(tin, retryCount + 1);
                }
                if (status === 419) {
                    this.logger.warn('419: Token eskirgan, sessiya yangilanmoqda...');
                    this.clearSession();
                    await this.delay(2000);
                    return this.searchByTin(tin, retryCount + 1);
                }
                if (status === 422) {
                    this.logger.warn('422: Captcha xato, qayta urinish...');
                    await this.delay(1000);
                    return this.searchByTin(tin, retryCount + 1);
                }
            }
            throw error;
        }
    }
    async searchByCadNumber(cadNumber, retryCount = 0) {
        try {
            if (retryCount === 0) {
                const cacheKey = this.cacheKeyForCad(cadNumber);
                const cached = await this.cacheGet(cacheKey);
                if (cached !== undefined) {
                    this.logger.log(`[CACHE HIT] davreestr CAD=${cadNumber}`);
                    return { success: true, data: cached, rateLimit: { cached: true } };
                }
                this.logger.log(`[CACHE MISS] davreestr CAD=${cadNumber}`);
            }
            await this.checkRateLimit();
            if (!this.session.csrfToken) {
                await this.initializeSession();
            }
            await this.reloadCaptcha();
            const captchaCode = await this.solveCaptcha();
            this.logger.log(`Kadastr captcha yechildi: ${captchaCode}`);
            const formData = new URLSearchParams();
            formData.append('_token', this.session.csrfToken);
            formData.append('cad_number_search', cadNumber);
            formData.append('captcha', captchaCode);
            this.logger.log(`Kadastr so'rov: ${cadNumber}, Captcha=${captchaCode}`);
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.post('https://davreestr.uz/data/get-info/cadastr-number', formData.toString(), {
                headers: {
                    'User-Agent': this.getSessionUserAgent(),
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Accept-Language': 'en,en-US;q=0.9,ru;q=0.8',
                    Origin: 'https://davreestr.uz',
                    Referer: 'https://davreestr.uz/data/get-info/search',
                    Cookie: this.session.cookieString,
                    Connection: 'keep-alive',
                    'Cache-Control': 'max-age=0',
                    'Upgrade-Insecure-Requests': '1',
                },
                ...this.transport,
            }));
            this.requestCount++;
            this.updateCookies(response.headers['set-cookie']);
            const remaining = response.headers['x-ratelimit-remaining'];
            this.logger.log(`Kadastr qolgan so'rovlar: ${remaining}`);
            const html = String(response.data || '');
            const parsed = this.htmlParser.parseCadProperty(html);
            if (!parsed.success &&
                parsed.error &&
                parsed.error.includes("noto'g'ri") &&
                retryCount < this.MAX_SEARCH_RETRIES) {
                this.logger.warn(`Kadastr captcha xato (${retryCount + 1}/${this.MAX_SEARCH_RETRIES})`);
                await this.delay(1000);
                return this.searchByCadNumber(cadNumber, retryCount + 1);
            }
            if (parsed.success) {
                await this.cacheSet(this.cacheKeyForCad(cadNumber), parsed);
            }
            return {
                success: parsed.success,
                data: parsed,
                rateLimit: {
                    remaining,
                    limit: response.headers['x-ratelimit-limit'],
                },
            };
        }
        catch (error) {
            this.logger.error(`Kadastr xatolik: ${error.message}`);
            if (!error.response && this.session.proxy) {
                this.proxyPool.report(this.session.proxy, false);
            }
            if (error.response && retryCount < this.MAX_SEARCH_RETRIES) {
                const status = error.response.status;
                if (status === 429) {
                    const retryAfter = parseInt(error.response.headers['retry-after']) || 60;
                    this.logger.warn(`429: ${retryAfter} sek kutish...`);
                    await this.delay(retryAfter * 1000);
                    return this.searchByCadNumber(cadNumber, retryCount + 1);
                }
                if (status === 419) {
                    this.clearSession();
                    await this.delay(2000);
                    return this.searchByCadNumber(cadNumber, retryCount + 1);
                }
                if (status === 422) {
                    await this.delay(1000);
                    return this.searchByCadNumber(cadNumber, retryCount + 1);
                }
            }
            throw error;
        }
    }
    async reloadCaptcha() {
        try {
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.get('https://davreestr.uz/reload-captcha', {
                headers: {
                    'User-Agent': this.getSessionUserAgent(),
                    Accept: '*/*',
                    Referer: 'https://davreestr.uz/data/get-info/search',
                    Cookie: this.session.cookieString,
                    'X-Requested-With': 'XMLHttpRequest',
                },
                ...this.transport,
            }));
            this.updateCookies(response.headers['set-cookie']);
            const data = response.data;
            if (data && typeof data === 'object') {
                if (data.captcha) {
                    const srcMatch = String(data.captcha).match(/src="([^"]+)"/);
                    if (srcMatch) {
                        this.captchaImgUrl = srcMatch[1];
                        this.logger.log(`Reload captcha URL: ${this.captchaImgUrl}`);
                        return;
                    }
                }
            }
            this.captchaImgUrl = '';
        }
        catch (error) {
            this.logger.warn(`Reload captcha xato: ${error.message}`);
            this.captchaImgUrl = '';
        }
    }
    async checkRateLimit() {
        const now = Date.now();
        if (now - this.windowStart >= this.TIME_WINDOW) {
            this.requestCount = 0;
            this.windowStart = now;
        }
        if (this.requestCount >= this.MAX_REQUESTS) {
            const waitMs = this.TIME_WINDOW - (now - this.windowStart);
            this.logger.warn(`Rate limit: ${Math.ceil(waitMs / 1000)} sek kutish...`);
            await this.delay(waitMs);
            this.requestCount = 0;
            this.windowStart = Date.now();
        }
    }
    MAX_CAPTCHA_ATTEMPTS = 5;
    async solveCaptcha() {
        for (let attempt = 1; attempt <= this.MAX_CAPTCHA_ATTEMPTS; attempt++) {
            this.logger.log(`Captcha yechish urinishi: ${attempt}/${this.MAX_CAPTCHA_ATTEMPTS}`);
            this.captchaImgUrl = '';
            const rawImage = await this.fetchCaptcha();
            const code = await this.solverClient.solve(rawImage, {
                type: 'digits',
                length: 4,
            });
            if (code) {
                this.logger.log(`Captcha yechildi (urinish ${attempt}): ${code}`);
                return code;
            }
            this.logger.warn(`Urinish ${attempt}: solver 4 xonali natija bermadi, yangi captcha olinmoqda...`);
        }
        throw new Error(`${this.MAX_CAPTCHA_ATTEMPTS} urinishdan keyin captcha yechilmadi`);
    }
    updateCookies(setCookieHeader) {
        if (!setCookieHeader)
            return;
        const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [];
        for (const c of arr) {
            if (c.includes('XSRF-TOKEN')) {
                this.session.xsrfToken = this.extractCookieValue(c);
            }
            else if (c.includes('laravel_session')) {
                this.session.laravelSession = this.extractCookieValue(c);
            }
        }
        this.session.cookieString = `XSRF-TOKEN=${this.session.xsrfToken}; laravel_session=${this.session.laravelSession}`;
    }
    extractCookieValue(cookie) {
        const match = cookie.match(/=([^;]+)/);
        return match ? match[1] : '';
    }
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    clearSession(ok = true) {
        if (this.session.proxy)
            this.proxyPool.report(this.session.proxy, ok);
        this.session = {
            csrfToken: '',
            xsrfToken: '',
            laravelSession: '',
            cookieString: '',
            userAgent: '',
            proxy: null,
            proxyAgent: null,
        };
        this.captchaImgUrl = '';
        this.logger.log('Sessiya tozalandi');
    }
};
exports.DavreestrService = DavreestrService;
exports.DavreestrService = DavreestrService = DavreestrService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [axios_1.HttpService,
        html_parser_service_1.HtmlParserService,
        captcha_solver_client_1.CaptchaSolverClient,
        memory_cache_service_1.MemoryCacheService,
        no_proxy_pool_1.NoProxyPool])
], DavreestrService);
//# sourceMappingURL=davreestr.service.js.map