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
exports.LogsController = void 0;
const common_1 = require("@nestjs/common");
const log_file_1 = require("../common/log-file");
let LogsController = class LogsController {
    assertAllowed(token) {
        const expected = process.env.LOGS_TOKEN?.trim();
        if (!expected) {
            throw new common_1.ForbiddenException('LOGS_TOKEN is not set on this box — the log endpoint is closed');
        }
        if (token !== expected) {
            throw new common_1.ForbiddenException('bad or missing x-logs-token');
        }
    }
    read(res, token, lines, q) {
        this.assertAllowed(token);
        res.type('text/plain; charset=utf-8');
        const n = Math.min(Math.max(parseInt(lines ?? '200', 10) || 200, 1), 2000);
        const result = (0, log_file_1.tail)(n, q?.trim() || undefined);
        const header = `# ${result.file} (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB)` +
            `${q ? ` · filter="${q}"` : ''} · last ${result.lines.length} line(s)\n\n`;
        return result.lines.length
            ? header + result.lines.join('\n') + '\n'
            : header + '(nothing matched)\n';
    }
    info(token) {
        this.assertAllowed(token);
        const result = (0, log_file_1.tail)(1);
        return {
            file: log_file_1.LOG_FILE,
            sizeBytes: result.sizeBytes,
            sizeMb: +(result.sizeBytes / 1024 / 1024).toFixed(2),
            lastLine: result.lines[0] ?? null,
        };
    }
};
exports.LogsController = LogsController;
__decorate([
    (0, common_1.Get)(),
    __param(0, (0, common_1.Res)({ passthrough: true })),
    __param(1, (0, common_1.Headers)('x-logs-token')),
    __param(2, (0, common_1.Query)('lines')),
    __param(3, (0, common_1.Query)('q')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [Object, String, String, String]),
    __metadata("design:returntype", String)
], LogsController.prototype, "read", null);
__decorate([
    (0, common_1.Get)('info'),
    __param(0, (0, common_1.Headers)('x-logs-token')),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [String]),
    __metadata("design:returntype", void 0)
], LogsController.prototype, "info", null);
exports.LogsController = LogsController = __decorate([
    (0, common_1.Controller)('logs')
], LogsController);
//# sourceMappingURL=logs.controller.js.map