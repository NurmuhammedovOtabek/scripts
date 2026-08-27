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
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppService = void 0;
const birdarcha_service_1 = require("./birdarcha/birdarcha.service");
const common_1 = require("@nestjs/common");
const stat_registry_service_1 = require("./stat-registry/stat-registry.service");
const court_cases_service_1 = require("./court-cases/court-cases.service");
const license_service_1 = require("./license/license.service");
const davreestr_service_1 = require("./davreestr/davreestr.service");
const tax_risk_service_1 = require("./tax-risk/tax-risk.service");
const tax_debtor_service_1 = require("./tax-debtor/tax-debtor.service");
const garov_service_1 = require("./garov/garov.service");
const sert_service_1 = require("./sert/sert.service");
const mib_service_1 = require("./mib/mib.service");
const large_taxpayer_service_1 = require("./large-taxpayer/large-taxpayer.service");
let AppService = class AppService {
    statRegistry;
    courtCases;
    license;
    davreestr;
    taxRisk;
    taxDebtor;
    garov;
    sert;
    mib;
    largeTaxpayer;
    birdarcha;
    constructor(statRegistry, courtCases, license, davreestr, taxRisk, taxDebtor, garov, sert, mib, largeTaxpayer, birdarcha) {
        this.statRegistry = statRegistry;
        this.courtCases = courtCases;
        this.license = license;
        this.davreestr = davreestr;
        this.taxRisk = taxRisk;
        this.taxDebtor = taxDebtor;
        this.garov = garov;
        this.sert = sert;
        this.mib = mib;
        this.largeTaxpayer = largeTaxpayer;
        this.birdarcha = birdarcha;
    }
    getFromStatus(inn) {
        return this.statRegistry.getFromStatus(inn);
    }
    getCourtCases(tin, caseNumber) {
        return this.courtCases.getCourtCases(tin, caseNumber);
    }
    getLicensesByTin(tin) {
        return this.license.getLicensesByTin(tin);
    }
    getLicenseStats() {
        return this.license.getStats();
    }
    getHealth() {
        const s = this.license.getStats();
        const degraded = s.failStreak >= 3;
        return {
            status: degraded ? 'degraded' : 'ok',
            reason: degraded ? `${s.failStreak} consecutive license failures` : null,
            uptimeSec: Math.round(process.uptime()),
            startedAt: s.startedAt,
            license: {
                total: s.total,
                ok: s.ok,
                failed: s.failed,
                failStreak: s.failStreak,
                avgMs: s.avgMs,
                browserAlive: s.browserAlive,
                queueBusy: s.queueBusy,
                lastOkAt: s.lastOkAt,
                lastError: s.lastError,
            },
        };
    }
    getCadastreByTin(tin) {
        return this.davreestr.searchByTin(tin);
    }
    getCadastreByNumber(cadNumber) {
        return this.davreestr.searchByCadNumber(cadNumber);
    }
    getTaxRisk(tin, pinfl) {
        return pinfl
            ? this.taxRisk.checkByPinfl(pinfl)
            : this.taxRisk.checkByInn(tin);
    }
    getTaxDebt(tin, pinfl) {
        return pinfl
            ? this.taxDebtor.checkByPinfl(pinfl)
            : this.taxDebtor.checkByInn(tin);
    }
    getGarov(inn, pinfl) {
        return pinfl ? this.garov.getByPinfl(pinfl) : this.garov.getByInn(inn);
    }
    getCertificates(tin) {
        return this.sert.getByInn(tin);
    }
    getMibDebts(tin, pinfl) {
        return pinfl
            ? this.mib.checkDebtByPinfl(pinfl)
            : this.mib.checkDebtByInn(tin);
    }
    getLargeTaxpayer(tin) {
        return this.largeTaxpayer.checkByInn(tin);
    }
    getBirdarcha(pin) {
        return this.birdarcha.getTraderByPinfl(pin);
    }
};
exports.AppService = AppService;
exports.AppService = AppService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [stat_registry_service_1.StatRegistryService,
        court_cases_service_1.CourtCasesService,
        license_service_1.LicenseService,
        davreestr_service_1.DavreestrService,
        tax_risk_service_1.TaxRiskService,
        tax_debtor_service_1.TaxDebtorService,
        garov_service_1.GarovService,
        sert_service_1.SertScriptService,
        mib_service_1.MibScriptService,
        large_taxpayer_service_1.LargeTaxpayerService,
        birdarcha_service_1.BirdarchaService])
], AppService);
//# sourceMappingURL=app.service.js.map