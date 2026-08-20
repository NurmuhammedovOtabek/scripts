"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommonModule = void 0;
const common_1 = require("@nestjs/common");
const captcha_solver_client_1 = require("./captcha-solver.client");
const memory_cache_service_1 = require("./memory-cache.service");
const no_proxy_pool_1 = require("./no-proxy.pool");
const html_parser_service_1 = require("../html-parser/html-parser.service");
let CommonModule = class CommonModule {
};
exports.CommonModule = CommonModule;
exports.CommonModule = CommonModule = __decorate([
    (0, common_1.Global)(),
    (0, common_1.Module)({
        providers: [captcha_solver_client_1.CaptchaSolverClient, memory_cache_service_1.MemoryCacheService, no_proxy_pool_1.NoProxyPool, html_parser_service_1.HtmlParserService],
        exports: [captcha_solver_client_1.CaptchaSolverClient, memory_cache_service_1.MemoryCacheService, no_proxy_pool_1.NoProxyPool, html_parser_service_1.HtmlParserService],
    })
], CommonModule);
//# sourceMappingURL=common.module.js.map