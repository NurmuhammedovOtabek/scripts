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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
var GarovService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.GarovService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = __importDefault(require("axios"));
const https = __importStar(require("https"));
const memory_cache_service_1 = require("../common/memory-cache.service");
const httpsAgent = new https.Agent({ rejectUnauthorized: false });
let GarovService = GarovService_1 = class GarovService {
    cacheManager;
    logger = new common_1.Logger(GarovService_1.name);
    BASE = 'https://www.garov.uz';
    SEARCH_URL = `${this.BASE}/record/getDeclarationOrderSearchWA`;
    UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
    httpTimeout = 15_000;
    CACHE_TTL_MS = 24 * 60 * 60 * 1000;
    queue = Promise.resolve();
    constructor(cacheManager) {
        this.cacheManager = cacheManager;
    }
    async getByInn(inn, filters = {}) {
        const cacheKey = this.cacheKey(inn, filters);
        try {
            const cached = await this.cacheManager.get(cacheKey);
            if (cached !== undefined && cached !== null)
                return cached;
        }
        catch (err) {
            this.logger.warn(`[garov] cache get failed for ${inn}: ${err?.message || err}`);
        }
        const liveRows = await this.runQueued(() => this.fetchByInn(inn));
        if (liveRows.length > 0) {
        }
        const rows = liveRows;
        if (liveRows.length > 0) {
            try {
                await this.cacheManager.set(cacheKey, rows, this.CACHE_TTL_MS);
            }
            catch { }
        }
        return rows;
    }
    async getByPinfl(pinfl) {
        const cacheKey = `garov:pinfl:${pinfl}`;
        try {
            const cached = await this.cacheManager.get(cacheKey);
            if (cached !== undefined && cached !== null)
                return cached;
        }
        catch (err) {
            this.logger.warn(`[garov] cache get failed for pinfl ${pinfl}: ${err?.message || err}`);
        }
        const rows = await this.runQueued(() => this.fetchByPinfl(pinfl));
        if (rows.length > 0) {
            try {
                await this.cacheManager.set(cacheKey, rows, this.CACHE_TTL_MS);
            }
            catch { }
        }
        return rows;
    }
    async refreshByInn(inn) {
        const liveRows = await this.runQueued(() => this.fetchByInn(inn));
        try {
            await this.cacheManager.del(this.cacheKey(inn, {}));
            await this.cacheManager.del(this.cacheKey(inn, { state: 'active' }));
            await this.cacheManager.del(this.cacheKey(inn, { state: 'resolved' }));
        }
        catch {
        }
        return { ...result, total: liveRows.length };
    }
    async verifyByCode(code) {
        const rows = await this.runQueued(() => this.fetchByCode(code));
        return rows.length > 0 ? rows[0] : null;
    }
    async fetchByInn(inn) {
        return this.postSearch({ inn }, `inn=${inn}`);
    }
    async fetchByPinfl(pinfl) {
        return this.postSearch({ pin: pinfl }, `pinfl=${pinfl}`);
    }
    async fetchByCode(code) {
        return this.postSearch({ code }, `code=${code}`);
    }
    async fetchCaptchaToken() {
        try {
            const resp = await axios_1.default.get(`${this.BASE}/security/captcha`, {
                timeout: this.httpTimeout,
                httpsAgent,
                headers: { 'User-Agent': this.UA },
                validateStatus: () => true,
            });
            const setCookie = Array.isArray(resp.headers['set-cookie'])
                ? resp.headers['set-cookie']
                : resp.headers['set-cookie']
                    ? [resp.headers['set-cookie']]
                    : [];
            for (const c of setCookie) {
                const m = c.match(/captcha=([^;]+)/);
                if (m)
                    return m[1];
            }
        }
        catch {
        }
        return this.randomToken();
    }
    async postSearch(filter, logKey) {
        const captcha = await this.fetchCaptchaToken();
        try {
            const resp = await axios_1.default.post(this.SEARCH_URL, {
                data: {
                    code: filter.code ?? null,
                    inn: filter.inn ?? null,
                    pin: filter.pin ?? null,
                    body_num: null,
                    cadastre: null,
                    tech_num: null,
                    doc_num: null,
                },
                captcha,
                lang: 'oz',
            }, {
                timeout: this.httpTimeout,
                httpsAgent,
                headers: {
                    'User-Agent': this.UA,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                    Origin: this.BASE,
                    Referer: `${this.BASE}/`,
                    Cookie: `captcha=${captcha}`,
                },
                validateStatus: () => true,
            });
            const rows = resp.data?.data?.data;
            if (!Array.isArray(rows)) {
                this.notifyFailure(logKey, `unexpected shape: ${JSON.stringify(resp.data).slice(0, 200)}`);
                return [];
            }
            const found = rows.filter((r) => !r?.not_found_code);
            this.logger.log(`[garov] live ${logKey} rows=${found.length}`);
            return found.map((r) => this.mapRecord(filter.inn ?? r.inn ?? '', r));
        }
        catch (err) {
            const reason = err?.code || err?.message || String(err);
            this.notifyFailure(logKey, reason);
            return [];
        }
    }
    async runQueued(fn) {
        const job = this.queue.then(fn);
        this.queue = job.catch(() => { });
        return job;
    }
    failureAlerts = new Map();
    notifyFailure(logKey, reason) {
        this.logger.error(`[garov] ${logKey} failed: ${reason}`);
        const now = Date.now();
        const last = this.failureAlerts.get(logKey) ?? 0;
        if (now - last < 10 * 60 * 1000)
            return;
        this.failureAlerts.set(logKey, now);
        const short = reason.length > 120 ? reason.slice(0, 120) + '…' : reason;
    }
    cacheKey(inn, filters) {
        const state = filters.state ?? 'all';
        const sort = filters.sort ?? '-';
        const order = filters.order ?? '-';
        return `garov:${inn}:${state}:${sort}:${order}`;
    }
    randomToken() {
        return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
    }
    mapRecord(inn, r) {
        return {
            inn,
            code: String(r.code ?? ''),
            debtor_name: r.debtor_name ?? null,
            state_name: r.state_name ?? null,
            state: r.state != null ? String(r.state) : null,
            creditor_name: r.creditor_name ?? null,
            creditor_phone: r.creditor_phone ?? null,
            printable: typeof r.printable === 'number' ? r.printable : null,
            order: r.order != null ? String(r.order) : null,
        };
    }
};
exports.GarovService = GarovService;
exports.GarovService = GarovService = GarovService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [memory_cache_service_1.MemoryCacheService])
], GarovService);
//# sourceMappingURL=garov.service.js.map