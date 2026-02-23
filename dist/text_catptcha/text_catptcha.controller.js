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
var __param = (this && this.__param) || function (paramIndex, decorator) {
    return function (target, key) { decorator(target, key, paramIndex); }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CaptchaController = void 0;
const common_1 = require("@nestjs/common");
const text_catptcha_service_1 = require("./text_catptcha.service");
let CaptchaController = class CaptchaController {
    captchaSolver;
    constructor(captchaSolver) {
        this.captchaSolver = captchaSolver;
    }
    async solveCaptcha(tin) {
        try {
            const result = await this.captchaSolver.searchByTin(tin);
            return {
                success: true,
                data: result.data,
                message: "Ma'lumotlar topildi",
            };
        }
        catch (error) {
            return {
                success: false,
                error: error.message,
            };
        }
    }
};
exports.CaptchaController = CaptchaController;
__decorate([
    (0, common_1.Post)('solve'),
    __param(0, (0, common_1.Body)('tin')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", Promise)
], CaptchaController.prototype, "solveCaptcha", null);
exports.CaptchaController = CaptchaController = __decorate([
    (0, common_1.Controller)('captcha'),
    __metadata("design:paramtypes", [text_catptcha_service_1.CaptchaSolverService])
], CaptchaController);
//# sourceMappingURL=text_catptcha.controller.js.map