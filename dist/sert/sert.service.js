"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var SertScriptService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.SertScriptService = void 0;
exports.hasStorableContent = hasStorableContent;
const common_1 = require("@nestjs/common");
const axios_1 = __importDefault(require("axios"));
const cheerio_1 = require("cheerio");
function hasStorableContent(cert) {
    if (cert.registry_number?.trim())
        return true;
    return Boolean(cert.cert_body?.trim() ||
        cert.blank_number?.trim() ||
        cert.issued_date?.trim() ||
        cert.expiry_date?.trim() ||
        cert.product_name?.trim() ||
        cert.scheme?.trim() ||
        cert.tnved_code?.trim() ||
        cert.applicant_name?.trim() ||
        cert.country?.trim() ||
        cert.status?.trim());
}
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
let SertScriptService = SertScriptService_1 = class SertScriptService {
    logger = new common_1.Logger(SertScriptService_1.name);
    INDEX_URL = 'http://sert2.standart.uz/site/index';
    SEARCH_URL = 'http://sert2.standart.uz/site/register';
    async getSession() {
        const resp = await axios_1.default.get(this.INDEX_URL, {
            headers: { 'User-Agent': UA },
            timeout: 15000,
            validateStatus: () => true,
        });
        const setCookies = resp.headers['set-cookie'] || [];
        const cookies = setCookies
            .map((raw) => raw.split(';')[0].trim())
            .filter(Boolean);
        if (cookies.length === 0) {
            throw new Error('sert2.standart.uz: no session cookies from index page');
        }
        return cookies.join('; ');
    }
    async searchByInn(inn, session) {
        let currentSession = session;
        for (let attempt = 1; attempt <= 2; attempt++) {
            const resp = await axios_1.default.get(this.SEARCH_URL, {
                params: { 'Search[inn]': inn },
                headers: {
                    'User-Agent': UA,
                    Cookie: currentSession,
                    Referer: this.INDEX_URL,
                    Accept: 'text/html',
                },
                timeout: 30000,
                maxRedirects: 0,
                validateStatus: (s) => s < 400 || s === 302,
            });
            if (resp.status === 302) {
                this.logger.debug(`[sert] session expired for INN=${inn}, refreshing`);
                currentSession = await this.getSession();
                continue;
            }
            return { certs: this.parse(resp.data), session: currentSession };
        }
        return { certs: [], session: currentSession };
    }
    async getByInn(inn) {
        try {
            const session = await this.getSession();
            const { certs } = await this.searchByInn(inn, session);
            this.logger.log(`sert2.standart.uz: INN=${inn} — ${certs.length} certs`);
            return certs;
        }
        catch (err) {
            this.logger.error(`sert2.standart.uz error INN=${inn}: ${err.message}`);
            return [];
        }
    }
    parse(html) {
        const $ = (0, cheerio_1.load)(String(html || ''));
        const data = [];
        $('table tbody tr').each((_, tr) => {
            const tds = $(tr).find('td');
            if (tds.length >= 14) {
                data.push({
                    cert_body: $(tds[2]).text().trim(),
                    blank_number: $(tds[3]).text().trim(),
                    registry_number: $(tds[4]).text().trim(),
                    issued_date: $(tds[5]).text().trim(),
                    expiry_date: $(tds[6]).text().trim(),
                    product_name: $(tds[7]).text().trim(),
                    scheme: $(tds[8]).text().trim(),
                    applicant_inn: $(tds[9]).text().trim(),
                    tnved_code: $(tds[10]).text().trim(),
                    applicant_name: $(tds[11]).text().trim(),
                    country: $(tds[12]).text().trim(),
                    status: $(tds[13]).text().trim(),
                });
            }
        });
        return data;
    }
};
exports.SertScriptService = SertScriptService;
exports.SertScriptService = SertScriptService = SertScriptService_1 = __decorate([
    (0, common_1.Injectable)()
], SertScriptService);
//# sourceMappingURL=sert.service.js.map