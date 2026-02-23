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
Object.defineProperty(exports, "__esModule", { value: true });
exports.CourtCasesService = void 0;
const common_1 = require("@nestjs/common");
const axios_1 = __importDefault(require("axios"));
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
let CourtCasesService = class CourtCasesService {
    async getCourtCases(tin, caseNumber) {
        if (!tin && !caseNumber) {
            throw new common_1.InternalServerErrorException('Provide either ?tin= or ?case= parameter');
        }
        const findBy = tin ? 'findByTin' : 'findByNumber';
        const input = tin || caseNumber.replace(/\//g, '@');
        const courtTypes = ['ECONOMIC', 'CIVIL', 'CRIMINAL', 'ADMINISTRATIVE'];
        const urls = [
            `https://jadval.sud.uz/case/${findBy}/${encodeURIComponent(input)}`,
            ...courtTypes.map((type) => `https://jadvalapi.sud.uz/online-monitoring/${type}/${findBy}/${encodeURIComponent(input)}`),
        ];
        const results = [];
        const headers = {
            'User-Agent': DEFAULT_USER_AGENT,
            Accept: 'application/json',
            Origin: 'https://my.sud.uz',
            Referer: 'https://my.sud.uz/',
        };
        await Promise.all(urls.map(async (url) => {
            try {
                const resp = await axios_1.default.get(url, { timeout: 15_000, headers });
                const data = resp.data;
                if (Array.isArray(data) && data.length > 0) {
                    results.push(...data);
                }
            }
            catch {
            }
        }));
        if (results.length === 0) {
            return {
                message: 'Ишлар топилмади (No court cases found)',
                tin,
                caseNumber,
            };
        }
        return results;
    }
};
exports.CourtCasesService = CourtCasesService;
exports.CourtCasesService = CourtCasesService = __decorate([
    (0, common_1.Injectable)()
], CourtCasesService);
//# sourceMappingURL=court-cases.service.js.map