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
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
var CaptchaSolverService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CaptchaSolverService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = require("@nestjs/axios");
const rxjs_1 = require("rxjs");
const Tesseract = __importStar(require("tesseract.js"));
const user_agent_pool_1 = require("./user-agent.pool");
let CaptchaSolverService = CaptchaSolverService_1 = class CaptchaSolverService {
    httpService;
    logger = new common_1.Logger(CaptchaSolverService_1.name);
    session = {
        csrfToken: '',
        xsrfToken: '',
        laravelSession: '',
        cookieString: '',
    };
    userAgentIndex = 0;
    requestCount = 0;
    MAX_REQUESTS = 15;
    TIME_WINDOW = 10000;
    constructor(httpService) {
        this.httpService = httpService;
    }
    getNextUserAgent() {
        const userAgent = user_agent_pool_1.USER_AGENTS[this.userAgentIndex];
        this.userAgentIndex = (this.userAgentIndex + 1) % user_agent_pool_1.USER_AGENTS.length;
        this.logger.log(`User-Agent: ${userAgent.substring(0, 50)}...`);
        return userAgent;
    }
    async initializeSession() {
        try {
            this.logger.log('Sessiya boshlanmoqda...');
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.get('https://davreestr.uz/uz', {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7',
                    'Cache-Control': 'no-cache',
                    Pragma: 'no-cache',
                    Connection: 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                },
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
            this.logger.error(`Sessiya boshlashda xatolik: ${error.message}`);
            throw error;
        }
    }
    async fetchCaptcha() {
        try {
            if (!this.session.cookieString) {
                await this.initializeSession();
            }
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.get('https://davreestr.uz/captcha/generate', {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    Accept: 'image/webp,image/apng,image/*,*/*;q=0.8',
                    'Accept-Language': 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7',
                    Referer: 'https://davreestr.uz/uz',
                    Cookie: this.session.cookieString,
                    'X-CSRF-TOKEN': this.session.xsrfToken,
                    Connection: 'keep-alive',
                },
            }));
            return Buffer.from(response.data);
        }
        catch (error) {
            this.logger.error(`Captcha olishda xatolik: ${error.message}`);
            throw error;
        }
    }
    async searchByTin(tin) {
        try {
            await this.checkRateLimit();
            if (!this.session.csrfToken) {
                await this.initializeSession();
            }
            const captchaCode = await this.solveCaptcha();
            this.logger.log(`Captcha yechildi: ${captchaCode}`);
            const formData = new URLSearchParams();
            formData.append('_token', this.session.csrfToken);
            formData.append('type', 'org_tin');
            formData.append('org_tin', tin);
            formData.append('captcha', captchaCode);
            this.logger.log(`So'rov yuborilmoqda: 
        Token: ${this.session.csrfToken.substring(0, 20)}...
        STIR: ${tin}
        Captcha: ${captchaCode}
        User-Agent: ${'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'.substring(0, 30)}...
      `);
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.post('https://davreestr.uz/data/get-info/search', formData.toString(), {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 11.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Content-Type': 'application/x-www-form-urlencoded',
                    Accept: 'application/json, text/plain, */*',
                    'Accept-Language': 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7',
                    Origin: 'https://davreestr.uz',
                    Referer: 'https://davreestr.uz/uz',
                    Cookie: this.session.cookieString,
                    'X-CSRF-TOKEN': this.session.xsrfToken,
                    'X-Requested-With': 'XMLHttpRequest',
                    Connection: 'keep-alive',
                },
            }));
            this.requestCount++;
            const remaining = response.headers['x-ratelimit-remaining'];
            this.logger.log(`Qolgan so'rovlar: ${remaining}/15`);
            return {
                success: true,
                data: response.data,
                rateLimit: {
                    remaining: remaining,
                    limit: response.headers['x-ratelimit-limit'],
                },
            };
        }
        catch (error) {
            this.logger.error(`Xatolik: ${error.message}`);
            if (error.response) {
                this.logger.error(`Status: ${error.response.status}`);
                if (error.response.status === 429) {
                    const retryAfter = error.response.headers['retry-after'] || 10;
                    this.logger.log(`429 xatosi: ${retryAfter} sekund kutish...`);
                    await this.delay(retryAfter * 1000);
                    this.logger.log('Yangi User-Agent bilan qayta urinilmoqda...');
                    return this.searchByTin(tin);
                }
                if (error.response.status === 419) {
                    this.logger.log('Token eskirgan, qayta urinilmoqda...');
                    this.clearSession();
                    await this.delay(2000);
                    return this.searchByTin(tin);
                }
                if (error.response.status === 422) {
                    this.logger.log('Captcha xato, qayta urinilmoqda...');
                    return this.searchByTin(tin);
                }
            }
            throw error;
        }
    }
    async checkRateLimit() {
        if (this.requestCount >= this.MAX_REQUESTS) {
            this.logger.warn('Rate limit chegarasiga yetildi, 1 daqiqa kutish...');
            await this.delay(this.TIME_WINDOW);
            this.requestCount = 0;
        }
    }
    async solveCaptcha() {
        const rawImage = await this.fetchCaptcha();
        return this.readWithTesseract(rawImage);
    }
    worker = null;
    async getWorker() {
        if (!this.worker) {
            this.worker = await Tesseract.createWorker('eng');
            await this.worker.setParameters({
                tessedit_char_whitelist: '0123456789',
            });
        }
        return this.worker;
    }
    async readWithTesseract(buffer) {
        const worker = await this.getWorker();
        const { data } = await worker.recognize(buffer);
        return data.text.replace(/[^0-9]/g, '').substring(0, 4);
    }
    extractCookieValue(cookie) {
        const match = cookie.match(/=([^;]+)/);
        return match ? match[1] : '';
    }
    delay(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    clearSession() {
        this.session = {
            csrfToken: '',
            xsrfToken: '',
            laravelSession: '',
            cookieString: '',
        };
        this.logger.log('Sessiya tozalandi');
    }
    async onModuleDestroy() {
        if (this.worker) {
            await this.worker.terminate();
        }
    }
};
exports.CaptchaSolverService = CaptchaSolverService;
exports.CaptchaSolverService = CaptchaSolverService = CaptchaSolverService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [axios_1.HttpService])
], CaptchaSolverService);
//# sourceMappingURL=text_catptcha.service.js.map