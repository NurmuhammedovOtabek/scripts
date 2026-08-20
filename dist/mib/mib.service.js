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
var MibScriptService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MibScriptService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = require("@nestjs/axios");
const rxjs_1 = require("rxjs");
const Tesseract = __importStar(require("tesseract.js"));
const jimp_1 = require("jimp");
const mib_parser_1 = require("./mib.parser");
const mib_debt_parser_1 = require("./mib-debt.parser");
const mib_captcha_solver_1 = require("./mib-captcha.solver");
const mib_captcha_image_1 = require("./mib-captcha.image");
let MibScriptService = MibScriptService_1 = class MibScriptService {
    httpService;
    logger = new common_1.Logger(MibScriptService_1.name);
    BASE_URL = 'https://mib.uz';
    session = {
        cookies: '',
        token: '',
    };
    lastDebtPageUrl = '';
    defaultHeaders = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'uz-UZ,uz;q=0.9,ru;q=0.8,en;q=0.7',
        Connection: 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
    };
    worker = null;
    constructor(httpService) {
        this.httpService = httpService;
    }
    parseAmount(raw) {
        if (!raw)
            return null;
        const cleaned = String(raw)
            .replace(/[^\d.,]/g, '')
            .replace(',', '.');
        return parseFloat(cleaned) || null;
    }
    async checkDebtByInn(inn) {
        return this.checkDebt(inn, 'inn');
    }
    async checkDebtByPinfl(pinfl) {
        return this.checkDebt(pinfl, 'pinfl');
    }
    async checkDebt(inn, key) {
        const MAX_ATTEMPTS = 3;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
            this.logger.log(`=== Urinish ${attempt}/${MAX_ATTEMPTS}, INN: ${inn} ===`);
            try {
                const homeData = await this.fetchHome();
                if (!homeData.debtCheckUrl) {
                    return {
                        success: false,
                        error: 'Qarzdorlik linki topilmadi',
                        summary: null,
                        debts: [],
                    };
                }
                const debtPageHtml = await this.fetchPage(homeData.debtCheckUrl);
                const formData = (0, mib_debt_parser_1.parseDebtCheckPage)(debtPageHtml, this.lastDebtPageUrl, key);
                if (!formData) {
                    return {
                        success: false,
                        error: 'STIR formasi topilmadi',
                        summary: null,
                        debts: [],
                    };
                }
                this.logger.log(`Form topildi: ${formData.formId}, captcha: ${formData.captchaImgUrl ? 'bor' : "yo'q"}`);
                const captchaAnswer = await this.solveCaptcha(formData.captchaImgUrl);
                if (captchaAnswer === null) {
                    this.logger.warn(`Captcha yechilmadi, qayta urinish...`);
                    continue;
                }
                this.logger.log(`Captcha javob: ${captchaAnswer}`);
                const resultHtml = await this.submitDebtForm(formData, inn, String(captchaAnswer));
                const result = (0, mib_debt_parser_1.parseDebtResult)(resultHtml);
                if (!result.success &&
                    result.error &&
                    /captcha|код|himoya|tekshiruv/i.test(result.error)) {
                    this.logger.warn(`captcha rejected: ${result.error} — retrying`);
                    continue;
                }
                return result;
            }
            catch (error) {
                this.logger.error(`attempt ${attempt} failed: ${error.message}`);
                if (attempt === MAX_ATTEMPTS)
                    throw error;
            }
        }
        return {
            success: false,
            error: `${MAX_ATTEMPTS} urinishdan keyin muvaffaqiyatsiz`,
            summary: null,
            debts: [],
        };
    }
    async getWorker() {
        if (!this.worker) {
            try {
                this.worker = await Tesseract.createWorker('uzb_cyrl');
            }
            catch (err) {
                this.logger.warn(`[captcha] uzb_cyrl model unavailable (${err.message}) — falling back to rus`);
                this.worker = await Tesseract.createWorker('rus');
            }
            await this.worker.setParameters({
                tessedit_pageseg_mode: Tesseract.PSM.SINGLE_LINE,
            });
        }
        return this.worker;
    }
    async solveCaptcha(captchaImgUrl) {
        if (!captchaImgUrl)
            return null;
        try {
            this.logger.log(`Captcha rasmi yuklanmoqda: ${captchaImgUrl.substring(0, 80)}...`);
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.get(captchaImgUrl, {
                responseType: 'arraybuffer',
                headers: {
                    'User-Agent': this.defaultHeaders['User-Agent'],
                    Accept: 'image/*,*/*',
                    Referer: this.lastDebtPageUrl || `${this.BASE_URL}/home`,
                    Cookie: this.session.cookies,
                },
            }));
            this.saveCookies(response.headers['set-cookie']);
            const imageBuffer = Buffer.from(response.data);
            this.logger.log(`Captcha rasmi yuklandi: ${imageBuffer.length} bayt`);
            const operator = await (0, mib_captcha_image_1.readOperator)(imageBuffer);
            this.logger.debug(`[captcha] amal belgisi: ${operator ?? 'aniqlanmadi'}`);
            const strategies = await this.preprocessCaptcha(imageBuffer);
            const worker = await this.getWorker();
            const ocrResults = [];
            for (const { name, buffer } of strategies) {
                const { data } = await worker.recognize(buffer);
                const rawText = data.text.trim();
                this.logger.debug(`[captcha] OCR [${name}]: "${rawText}"`);
                ocrResults.push({ name, text: rawText });
                const answer = (0, mib_captcha_solver_1.solveMathCaptcha)(rawText, operator);
                if (answer !== null) {
                    this.logger.log(`[captcha] solved by strategy=${name}: "${rawText}" ${operator ?? '?'} = ${answer}`);
                    return answer;
                }
            }
            this.logger.warn(`[captcha] all ${strategies.length} strategies failed; outputs=${JSON.stringify(ocrResults)}`);
            return null;
        }
        catch (error) {
            this.logger.error(`[captcha] error: ${error.message}`, error.stack);
            return null;
        }
    }
    async preprocessCaptcha(imageBuffer) {
        const results = [];
        let src = imageBuffer;
        try {
            const framed = await jimp_1.Jimp.read(src);
            src = await (0, mib_captcha_image_1.cropFrame)(framed).getBuffer('image/png');
        }
        catch (e) {
            this.logger.warn(`[captcha] ramkani kesib bo'lmadi: ${e.message}`);
        }
        try {
            const img = await jimp_1.Jimp.read(src);
            img.resize({ w: 600, h: 120 });
            const buf = await img.getBuffer('image/png');
            results.push({ name: 'resize-only', buffer: buf });
        }
        catch (e) {
            this.logger.warn(`strategy 1 failed: ${e.message}`);
        }
        try {
            const img = await jimp_1.Jimp.read(src);
            img.greyscale();
            img.contrast(0.3);
            img.resize({ w: 600, h: 120 });
            const buf = await img.getBuffer('image/png');
            results.push({ name: 'grey-soft-contrast', buffer: buf });
        }
        catch (e) {
            this.logger.warn(`strategy 2 failed: ${e.message}`);
        }
        try {
            const img = await jimp_1.Jimp.read(src);
            img.greyscale();
            img.contrast(0.8);
            img.threshold({ max: 180 });
            img.resize({ w: 600, h: 120 });
            const buf = await img.getBuffer('image/png');
            results.push({ name: 'grey-strong-threshold', buffer: buf });
        }
        catch (e) {
            this.logger.warn(`strategy 3 failed: ${e.message}`);
        }
        try {
            const img = await jimp_1.Jimp.read(src);
            img.greyscale();
            img.invert();
            img.contrast(0.5);
            img.threshold({ max: 160 });
            img.resize({ w: 600, h: 120 });
            const buf = await img.getBuffer('image/png');
            results.push({ name: 'invert', buffer: buf });
        }
        catch (e) {
            this.logger.warn(`strategy 4 failed: ${e.message}`);
        }
        results.push({ name: 'raw', buffer: imageBuffer });
        return results;
    }
    async submitDebtForm(form, inn, secureCode) {
        const submitUrl = form.ajaxSubmitUrl || form.formAction;
        this.logger.log(`Form yuborilmoqda: INN=${inn}, code=${secureCode}`);
        this.logger.log(`Submit URL: ${submitUrl.substring(0, 80)}...`);
        const formData = new URLSearchParams();
        formData.append(form.hiddenFieldName, form.hiddenFieldValue);
        formData.append(form.keyFieldName, inn);
        formData.append('secure_code', secureCode);
        formData.append('submit_button', '1');
        const isAjax = form.ajaxSubmitUrl && form.ajaxSubmitUrl !== form.formAction;
        const headers = {
            'User-Agent': this.defaultHeaders['User-Agent'],
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: isAjax ? 'application/xml, text/xml, */*' : 'text/html,*/*',
            Referer: this.lastDebtPageUrl || `${this.BASE_URL}/home`,
            Cookie: this.session.cookies,
            Origin: this.BASE_URL,
            Connection: 'keep-alive',
        };
        if (isAjax) {
            headers['Wicket-Ajax'] = 'true';
            headers['Wicket-Ajax-BaseURL'] = '.';
            headers['Wicket-FocusedElementId'] = 'id6c';
        }
        const response = await (0, rxjs_1.firstValueFrom)(this.httpService.post(submitUrl, formData.toString(), {
            headers,
            maxRedirects: 0,
            validateStatus: (status) => status < 500,
        }));
        this.saveCookies(response.headers['set-cookie']);
        const responseText = String(response.data || '');
        this.logger.log(`Form javob: status=${response.status}, hajm=${responseText.length} belgi`);
        const redirectMatch = responseText.match(/<redirect><!\[CDATA\[([^\]]+)\]\]>/);
        if (redirectMatch) {
            let redirectUrl = redirectMatch[1];
            if (!redirectUrl.startsWith('http')) {
                redirectUrl = `${this.BASE_URL}/${redirectUrl.replace(/^\.\//, '')}`;
            }
            redirectUrl = this.cleanUrl(redirectUrl);
            this.logger.log(`Wicket AJAX redirect: ${redirectUrl.substring(0, 80)}...`);
            return await this.fetchPage(redirectUrl);
        }
        if (response.status >= 300 && response.status < 400) {
            const location = response.headers['location'];
            if (location) {
                const redirectUrl = location.startsWith('http')
                    ? location
                    : `${this.BASE_URL}${location.startsWith('/') ? '' : '/'}${location}`;
                this.logger.log(`HTTP redirect: ${redirectUrl.substring(0, 80)}...`);
                return await this.fetchPage(this.cleanUrl(redirectUrl));
            }
        }
        return responseText;
    }
    saveCookies(setCookieHeader) {
        if (!setCookieHeader)
            return;
        const newPairs = setCookieHeader.map((c) => c.split(';')[0]);
        const cookieMap = new Map();
        if (this.session.cookies) {
            this.session.cookies.split('; ').forEach((pair) => {
                const [key] = pair.split('=');
                if (key)
                    cookieMap.set(key, pair);
            });
        }
        newPairs.forEach((pair) => {
            const [key] = pair.split('=');
            if (key)
                cookieMap.set(key, pair);
        });
        this.session.cookies = Array.from(cookieMap.values()).join('; ');
    }
    cleanUrl(url) {
        return url.replace(/;jsessionid=[^?&/]*/gi, '');
    }
    async fetchHome() {
        try {
            this.logger.log('mib.uz/home sahifasi yuklanmoqda...');
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.get(`${this.BASE_URL}/home`, {
                headers: {
                    ...this.defaultHeaders,
                    ...(this.session.cookies && { Cookie: this.session.cookies }),
                },
                maxRedirects: 10,
            }));
            this.saveCookies(response.headers['set-cookie']);
            const html = String(response.data || '');
            const parsed = (0, mib_parser_1.parseMibHome)(html, this.BASE_URL);
            if (parsed.debtCheckUrl) {
                parsed.debtCheckUrl = this.cleanUrl(parsed.debtCheckUrl);
                this.logger.log(`Qarzdorlik linki: ${parsed.debtCheckUrl.substring(0, 80)}...`);
            }
            else {
                this.logger.warn('Qarzdorlik linki topilmadi!');
            }
            return parsed;
        }
        catch (error) {
            this.logger.error(`mib.uz/home failed: ${error.message}`);
            throw error;
        }
    }
    async fetchPage(url) {
        const cleanedUrl = this.cleanUrl(url);
        this.logger.log(`Sahifa yuklanmoqda: ${cleanedUrl.substring(0, 80)}...`);
        let currentUrl = cleanedUrl;
        let attempts = 0;
        const maxAttempts = 5;
        while (attempts < maxAttempts) {
            attempts++;
            const response = await (0, rxjs_1.firstValueFrom)(this.httpService.get(currentUrl, {
                headers: {
                    ...this.defaultHeaders,
                    Referer: `${this.BASE_URL}/home`,
                    Cookie: this.session.cookies,
                },
                maxRedirects: 0,
                validateStatus: (status) => status < 400,
            }));
            this.saveCookies(response.headers['set-cookie']);
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers['location'];
                if (location) {
                    currentUrl = location.startsWith('http')
                        ? location
                        : `${this.BASE_URL}${location.startsWith('/') ? '' : '/'}${location}`;
                    currentUrl = this.cleanUrl(currentUrl);
                    this.logger.log(`Redirect (${response.status}): ${currentUrl.substring(0, 60)}...`);
                    continue;
                }
            }
            const html = String(response.data || '');
            const metaRefresh = html.match(/content="[^"]*URL=([^"]+)"/i);
            if (metaRefresh) {
                const redirectUrl = metaRefresh[1];
                currentUrl = redirectUrl.startsWith('http')
                    ? redirectUrl
                    : `${this.BASE_URL}${redirectUrl.startsWith('/') ? '' : '/'}${redirectUrl}`;
                currentUrl = this.cleanUrl(currentUrl);
                this.logger.log(`Meta refresh redirect: ${currentUrl.substring(0, 60)}...`);
                continue;
            }
            this.lastDebtPageUrl = currentUrl;
            this.logger.log(`Sahifa yuklandi, hajmi: ${html.length} belgi`);
            return html;
        }
        throw new Error(`${maxAttempts} ta redirect dan keyin sahifa yuklanmadi`);
    }
    async getDebtCheckInfo() {
        const homeData = await this.fetchHome();
        if (homeData.debtCheckUrl) {
            const debtPageHtml = await this.fetchPage(homeData.debtCheckUrl);
            return { homeData, debtPageHtml };
        }
        return { homeData };
    }
    async testCaptchaSolving() {
        const homeData = await this.fetchHome();
        if (!homeData.debtCheckUrl) {
            return { success: false, error: 'Qarzdorlik linki topilmadi' };
        }
        const debtPageHtml = await this.fetchPage(homeData.debtCheckUrl);
        const formData = (0, mib_debt_parser_1.parseDebtCheckPage)(debtPageHtml, this.lastDebtPageUrl);
        if (!formData || !formData.captchaImgUrl) {
            return { success: false, error: 'Captcha rasmi topilmadi' };
        }
        const answer = await this.solveCaptcha(formData.captchaImgUrl);
        const ocrResults = [];
        const captchaResp = await (0, rxjs_1.firstValueFrom)(this.httpService.get(formData.captchaImgUrl, {
            responseType: 'arraybuffer',
            headers: {
                'User-Agent': this.defaultHeaders['User-Agent'],
                Accept: 'image/*,*/*',
                Referer: this.lastDebtPageUrl || `${this.BASE_URL}/home`,
                Cookie: this.session.cookies,
            },
        }));
        this.saveCookies(captchaResp.headers['set-cookie']);
        const imgBuf = Buffer.from(captchaResp.data);
        const strategies = await this.preprocessCaptcha(imgBuf);
        const worker = await this.getWorker();
        for (const { name, buffer } of strategies) {
            const { data } = await worker.recognize(buffer);
            ocrResults.push({ name, text: data.text.trim() });
        }
        return {
            success: answer !== null,
            captchaImgUrl: formData.captchaImgUrl,
            answer,
            ocrResults,
            message: answer !== null
                ? `Captcha yechildi: ${answer}`
                : 'Captcha yechilmadi. debug-captcha papkasidagi rasmlarni tekshiring.',
        };
    }
    async onModuleDestroy() {
        if (this.worker) {
            await this.worker.terminate();
        }
    }
};
exports.MibScriptService = MibScriptService;
exports.MibScriptService = MibScriptService = MibScriptService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [axios_1.HttpService])
], MibScriptService);
//# sourceMappingURL=mib.service.js.map