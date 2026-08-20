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
var LargeTaxpayerService_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.LargeTaxpayerService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = require("@nestjs/axios");
const rxjs_1 = require("rxjs");
const BASE_URL = 'https://old.soliq.uz';
const LIST_URL = `${BASE_URL}/activities/list`;
const PAGE_URL = `${BASE_URL}/activities/large-taxpayers?lang=latn`;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
let LargeTaxpayerService = LargeTaxpayerService_1 = class LargeTaxpayerService {
    httpService;
    logger = new common_1.Logger(LargeTaxpayerService_1.name);
    constructor(httpService) {
        this.httpService = httpService;
    }
    async checkByInn(inn) {
        this.logger.log(`[large-taxpayer] INN=${inn}`);
        const resp = await (0, rxjs_1.firstValueFrom)(this.httpService.get(LIST_URL, {
            params: { tin: inn, sEcho: 1, iDisplayStart: 0, iDisplayLength: 10 },
            headers: {
                'User-Agent': UA,
                Referer: PAGE_URL,
                'X-Requested-With': 'XMLHttpRequest',
                Accept: 'application/json',
            },
            timeout: 15000,
            validateStatus: () => true,
        }));
        const rows = resp.data?.data || [];
        const match = rows.find((r) => String(r.tin) === inn) || rows[0];
        if (!match) {
            this.logger.log(`[large-taxpayer] INN=${inn} — not a large taxpayer`);
            return { inn, is_large_taxpayer: false };
        }
        this.logger.log(`[large-taxpayer] INN=${inn} — ✅ YES (${match.name})`);
        return {
            inn,
            is_large_taxpayer: true,
            data: {
                tin: String(match.tin),
                name: match.name,
                region: match.ns10Name ?? null,
                district: match.ns11Name ?? null,
            },
        };
    }
};
exports.LargeTaxpayerService = LargeTaxpayerService;
exports.LargeTaxpayerService = LargeTaxpayerService = LargeTaxpayerService_1 = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [axios_1.HttpService])
], LargeTaxpayerService);
//# sourceMappingURL=large-taxpayer.service.js.map