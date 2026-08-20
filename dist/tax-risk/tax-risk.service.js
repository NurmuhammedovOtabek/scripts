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
var TaxRiskService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.TaxRiskService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = require("@nestjs/axios");
const rxjs_1 = require("rxjs");
const captcha_solver_client_1 = require("../common/captcha-solver.client");
const BASE_URL = 'https://old.soliq.uz';
const PAGE_URL = `${BASE_URL}/activities/tax-risk-analysis?lang=latn`;
const CAPTCHA_URL = `${BASE_URL}/activities/captcha`;
const SUBMIT_URL = `${BASE_URL}/activities/analysis/item`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const WRONG_CAPTCHA_PATTERN = /noto.?g.?ri kiritilgan|неправ|incorrect/i;
let TaxRiskService = TaxRiskService_1 = class TaxRiskService {
    httpService;
    solver;
    logger = new common_1.Logger(TaxRiskService_1.name);
    queue = Promise.resolve();
    constructor(httpService, solver) {
        this.httpService = httpService;
        this.solver = solver;
    }
    async checkByInn(inn, maxAttempts = 10) {
        const job = this.queue.then(() => this.runCheck(inn, maxAttempts, true));
        this.queue = job.catch(() => { });
        return job;
    }
    async checkByPinfl(pinfl, maxAttempts = 10) {
        const job = this.queue.then(() => this.runCheck(pinfl, maxAttempts, false));
        this.queue = job.catch(() => { });
        return job;
    }
    async runCheck(inn, maxAttempts, persist) {
        this.logger.log(`[tax-risk] ${persist ? 'INN' : 'PINFL'}=${inn} — starting (maxAttempts=${maxAttempts})`);
        const jar = new Map();
        await this.initSession(jar);
        let attempt = 0;
        let lastReason = '';
        while (attempt < maxAttempts) {
            attempt++;
            const imgBuf = await this.fetchCaptcha(jar);
            const code = await this.solver.solve(imgBuf, {
                type: 'digits',
                length: 4,
            });
            if (!code) {
                this.logger.debug(`[tax-risk] attempt ${attempt}: solver returned no 4-digit code`);
                continue;
            }
            const result = await this.submitForm(inn, code, jar);
            const reason = result?.reason || '';
            if (result?.success) {
                this.logger.log(`[tax-risk] ✅ INN=${inn} on risk list, solved in ${attempt} attempt(s)`);
                const data = this.mapResponse(result.data);
                return {
                    success: true,
                    in_risk_list: true,
                    attempts: attempt,
                    data,
                    raw: result,
                };
            }
            if (!WRONG_CAPTCHA_PATTERN.test(reason)) {
                this.logger.log(`[tax-risk] ℹ️ INN=${inn} not on risk list (captcha OK in ${attempt} attempt(s)): "${reason}"`);
                return {
                    success: true,
                    in_risk_list: false,
                    reason,
                    attempts: attempt,
                    raw: result,
                };
            }
            lastReason = reason;
        }
        this.logger.warn(`[tax-risk] ❌ INN=${inn} — exhausted ${maxAttempts} attempts`);
        return {
            success: false,
            in_risk_list: false,
            reason: `Captcha not solved after ${maxAttempts} attempts (last: ${lastReason})`,
            attempts: maxAttempts,
        };
    }
    absorbSetCookie(jar, setCookie) {
        if (!setCookie)
            return;
        for (const header of setCookie) {
            const pair = header.split(';')[0];
            const eq = pair.indexOf('=');
            if (eq > 0) {
                jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
            }
        }
    }
    jarToHeader(jar) {
        return Array.from(jar.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; ');
    }
    async initSession(jar) {
        const resp = await (0, rxjs_1.firstValueFrom)(this.httpService.get(PAGE_URL, {
            headers: { 'User-Agent': UA },
            maxRedirects: 0,
            validateStatus: () => true,
        }));
        this.absorbSetCookie(jar, resp.headers['set-cookie']);
    }
    async fetchCaptcha(jar) {
        const resp = await (0, rxjs_1.firstValueFrom)(this.httpService.get(CAPTCHA_URL, {
            headers: {
                'User-Agent': UA,
                Cookie: this.jarToHeader(jar),
                Referer: PAGE_URL,
                'X-Requested-With': 'XMLHttpRequest',
            },
            timeout: 10000,
        }));
        this.absorbSetCookie(jar, resp.headers['set-cookie']);
        const imgSrc = resp.data?.imgSrc;
        if (!imgSrc)
            throw new Error('Captcha response has no imgSrc');
        const b64 = imgSrc.split(',')[1].trim();
        return Buffer.from(b64, 'base64');
    }
    async submitForm(inn, captcha, jar) {
        const body = new URLSearchParams({ tin: inn, captcha });
        const resp = await (0, rxjs_1.firstValueFrom)(this.httpService.post(SUBMIT_URL, body.toString(), {
            headers: {
                'User-Agent': UA,
                Cookie: this.jarToHeader(jar),
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                Referer: PAGE_URL,
                'X-Requested-With': 'XMLHttpRequest',
                Accept: 'application/json, text/javascript, */*; q=0.01',
            },
            timeout: 15000,
            validateStatus: () => true,
        }));
        this.absorbSetCookie(jar, resp.headers['set-cookie']);
        return resp.data;
    }
    mapResponse(r) {
        const status = typeof r?.status === 'number' ? r.status : 0;
        const obnal = r?.obnal;
        return {
            tin: String(r?.tin ?? ''),
            name: r?.name ?? null,
            region: r?.ns10Name ?? null,
            ns11_name: r?.ns11Name ?? null,
            status,
            status_text: status === 1 ? 'Ishonchli' : 'Shubhali',
            obnal: obnal ?? null,
            obnal_text: obnal === 1 ? 'Ha' : obnal === 0 ? "Yo'q" : null,
            sum_debt: r?.sumDebt ?? null,
            vat_state: r?.vatState ?? null,
            tax_gap: r?.taxGap ?? null,
            reg_date: r?.regDate ?? null,
            founders: r?.founders ?? null,
            personal_data: r?.personalData ?? null,
        };
    }
};
exports.TaxRiskService = TaxRiskService;
exports.TaxRiskService = TaxRiskService = TaxRiskService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [axios_1.HttpService,
        captcha_solver_client_1.CaptchaSolverClient])
], TaxRiskService);
//# sourceMappingURL=tax-risk.service.js.map