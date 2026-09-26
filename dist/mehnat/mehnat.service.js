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
var MehnatService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.MehnatService = void 0;
exports.rowsForTin = rowsForTin;
const common_1 = require("@nestjs/common");
const axios_1 = require("@nestjs/axios");
const rxjs_1 = require("rxjs");
const BASE_URL = 'https://ishapi.mehnat.uz/api/v1';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const PAGE_SIZE = 100;
const DETAIL_CONCURRENCY = 6;
const DETAIL_BUDGET_MS = 7000;
let MehnatService = MehnatService_1 = class MehnatService {
    http;
    logger = new common_1.Logger(MehnatService_1.name);
    constructor(http) {
        this.http = http;
    }
    async getVacancies(tin) {
        const t = String(tin ?? '').trim();
        if (!/^\d{9}$/.test(t)) {
            throw new common_1.BadRequestException('tin must be 9 digits');
        }
        const startedAt = Date.now();
        let rows;
        let pages;
        try {
            ({ rows, pages } = await this.listAll(t));
        }
        catch (err) {
            this.logger.warn(`[mehnat] tin=${t} list failed: ${err?.message ?? err}`);
            throw new common_1.BadGatewayException('ish.mehnat.uz did not answer');
        }
        const deadline = Date.now() + DETAIL_BUDGET_MS;
        const details = {};
        await mapLimit(rows, DETAIL_CONCURRENCY, async (r) => {
            const id = String(r?.id ?? '');
            if (!id)
                return;
            if (Date.now() > deadline) {
                details[id] = null;
                return;
            }
            try {
                const d = await this.fetchJson(`${BASE_URL}/vacancies/${encodeURIComponent(id)}`, {}, 10000);
                details[id] = d?.data ?? null;
            }
            catch (err) {
                this.logger.warn(`[mehnat] vacancy ${id} failed: ${err?.message ?? err}`);
                details[id] = null;
            }
        });
        const missing = Object.values(details).filter((d) => d === null).length;
        this.logger.log(`[mehnat] tin=${t} — ${rows.length} vacancy(ies) in ${pages} page(s), ${missing} detail(s) missing, ${Date.now() - startedAt}ms`);
        return { tin: t, rows, details };
    }
    async listAll(tin) {
        const rows = [];
        let page = 1;
        let lastPage = 1;
        let pages = 0;
        do {
            pages++;
            const body = await this.fetchJson(`${BASE_URL}/vacancies`, { company_tin: tin, per_page: PAGE_SIZE, page }, 15000);
            const pageRows = body?.data?.data;
            const all = Array.isArray(pageRows) ? pageRows : [];
            const mine = rowsForTin(body, tin);
            rows.push(...mine);
            if (mine.length < all.length)
                break;
            lastPage = Number(body?.data?.last_page) || 1;
            page++;
        } while (page <= lastPage);
        return { rows, pages };
    }
    async fetchJson(url, params, timeout) {
        const resp = await (0, rxjs_1.firstValueFrom)(this.http.get(url, {
            params,
            headers: { 'User-Agent': UA, Accept: 'application/json' },
            timeout,
            validateStatus: () => true,
        }));
        if (resp.status !== 200)
            throw new Error(`HTTP ${resp.status}`);
        return resp.data;
    }
};
exports.MehnatService = MehnatService;
exports.MehnatService = MehnatService = MehnatService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [axios_1.HttpService])
], MehnatService);
function rowsForTin(body, tin) {
    const rows = body?.data?.data;
    if (!Array.isArray(rows))
        return [];
    return rows.filter((r) => String(r?.company_tin) === tin);
}
async function mapLimit(items, limit, fn) {
    let next = 0;
    const worker = async () => {
        while (next < items.length)
            await fn(items[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
//# sourceMappingURL=mehnat.service.js.map