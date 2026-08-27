"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AppModule = void 0;
const common_1 = require("@nestjs/common");
const config_1 = require("@nestjs/config");
const logs_controller_1 = require("./logs/logs.controller");
const app_controller_1 = require("./app.controller");
const app_service_1 = require("./app.service");
const stat_registry_module_1 = require("./stat-registry/stat-registry.module");
const court_cases_module_1 = require("./court-cases/court-cases.module");
const license_module_1 = require("./license/license.module");
const text_catptcha_module_1 = require("./text_catptcha/text_catptcha.module");
const common_module_1 = require("./common/common.module");
const davreestr_module_1 = require("./davreestr/davreestr.module");
const tax_risk_module_1 = require("./tax-risk/tax-risk.module");
const tax_debtor_module_1 = require("./tax-debtor/tax-debtor.module");
const garov_module_1 = require("./garov/garov.module");
const sert_module_1 = require("./sert/sert.module");
const mib_module_1 = require("./mib/mib.module");
const large_taxpayer_module_1 = require("./large-taxpayer/large-taxpayer.module");
const birdarcha_module_1 = require("./birdarcha/birdarcha.module");
let AppModule = class AppModule {
};
exports.AppModule = AppModule;
exports.AppModule = AppModule = __decorate([
    (0, common_1.Module)({
        imports: [
            config_1.ConfigModule.forRoot(),
            stat_registry_module_1.StatRegistryModule,
            court_cases_module_1.CourtCasesModule,
            license_module_1.LicenseModule,
            text_catptcha_module_1.CaptchaModule,
            common_module_1.CommonModule,
            davreestr_module_1.DavreestrModule,
            tax_risk_module_1.TaxRiskModule,
            tax_debtor_module_1.TaxDebtorModule,
            garov_module_1.GarovModule,
            sert_module_1.SertModule,
            mib_module_1.MibModule,
            large_taxpayer_module_1.LargeTaxpayerModule,
            birdarcha_module_1.BirdarchaModule,
        ],
        controllers: [app_controller_1.AppController, logs_controller_1.LogsController],
        providers: [app_service_1.AppService],
    })
], AppModule);
//# sourceMappingURL=app.module.js.map