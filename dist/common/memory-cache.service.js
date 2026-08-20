"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MemoryCacheService = void 0;
const common_1 = require("@nestjs/common");
let MemoryCacheService = class MemoryCacheService {
    store = new Map();
    get(key) {
        const hit = this.store.get(key);
        if (!hit)
            return Promise.resolve(undefined);
        if (hit.expiresAt <= Date.now()) {
            this.store.delete(key);
            return Promise.resolve(undefined);
        }
        return Promise.resolve(hit.value);
    }
    set(key, value, ttlMs) {
        this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
        if (this.store.size % 64 === 0)
            this.sweep();
        return Promise.resolve();
    }
    del(key) {
        this.store.delete(key);
        return Promise.resolve();
    }
    sweep() {
        const now = Date.now();
        for (const [k, v] of this.store) {
            if (v.expiresAt <= now)
                this.store.delete(k);
        }
    }
};
exports.MemoryCacheService = MemoryCacheService;
exports.MemoryCacheService = MemoryCacheService = __decorate([
    (0, common_1.Injectable)()
], MemoryCacheService);
//# sourceMappingURL=memory-cache.service.js.map