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
var CaptchaSolverClient_1;
Object.defineProperty(exports, "__esModule", { value: true });
exports.CaptchaSolverClient = void 0;
const common_1 = require("@nestjs/common");
const child_process_1 = require("child_process");
const path = __importStar(require("path"));
let CaptchaSolverClient = CaptchaSolverClient_1 = class CaptchaSolverClient {
    logger = new common_1.Logger(CaptchaSolverClient_1.name);
    pythonBin = process.env.PYTHON_BIN ||
        (process.platform === 'win32' ? 'python' : 'python3');
    scriptPath = process.env.CAPTCHA_SOLVER_SCRIPT ||
        path.resolve(process.cwd(), 'python/solver.py');
    solveTimeoutMs = 10_000;
    proc = null;
    stdoutBuffer = '';
    pending = new Map();
    nextId = 0;
    ready = false;
    readyWaiters = [];
    shuttingDown = false;
    onModuleInit() {
        this.spawnProcess();
        const cleanup = () => {
            this.shuttingDown = true;
            if (this.proc && !this.proc.killed)
                this.proc.kill();
        };
        process.once('exit', cleanup);
        process.once('SIGINT', () => {
            cleanup();
            process.exit(0);
        });
        process.once('SIGTERM', () => {
            cleanup();
            process.exit(0);
        });
    }
    async onModuleDestroy() {
        this.shuttingDown = true;
        if (this.proc && !this.proc.killed) {
            this.proc.kill();
        }
        for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('solver shutting down'));
        }
        this.pending.clear();
    }
    async solve(imgBuf, opts = {}) {
        await this.waitReady();
        const id = ++this.nextId;
        const { type = 'digits', length } = opts;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`captcha solver timeout after ${this.solveTimeoutMs}ms`));
            }, this.solveTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            const payload = JSON.stringify({
                id,
                image_base64: imgBuf.toString('base64'),
                type,
                ...(length ? { length } : {}),
            });
            if (!this.proc?.stdin?.writable) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new Error('captcha solver stdin not writable'));
                return;
            }
            this.proc.stdin.write(payload + '\n');
        });
    }
    spawnProcess() {
        this.logger.log(`[captcha] starting: ${this.pythonBin} ${this.scriptPath}`);
        this.ready = false;
        this.proc = (0, child_process_1.spawn)(this.pythonBin, [this.scriptPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.proc.stdout.on('data', (chunk) => this.onStdout(chunk.toString()));
        this.proc.stderr.on('data', (chunk) => {
            const line = chunk.toString().trim();
            if (!line)
                return;
            if (line.includes('[solver] ready')) {
                this.markReady();
            }
            this.logger.debug(`[captcha:py] ${line}`);
        });
        this.proc.on('exit', (code, signal) => {
            this.logger.warn(`[captcha] process exited code=${code} signal=${signal}`);
            this.ready = false;
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new Error('captcha solver died'));
            }
            this.pending.clear();
            if (!this.shuttingDown) {
                setTimeout(() => this.spawnProcess(), 2000);
            }
        });
        this.proc.on('error', (err) => {
            this.logger.error(`[captcha] spawn error: ${err.message}`);
        });
    }
    markReady() {
        if (this.ready)
            return;
        this.ready = true;
        this.logger.log('[captcha] ready');
        const waiters = this.readyWaiters;
        this.readyWaiters = [];
        for (const w of waiters)
            w();
    }
    waitReady() {
        if (this.ready)
            return Promise.resolve();
        return new Promise((resolve) => this.readyWaiters.push(resolve));
    }
    onStdout(chunk) {
        this.stdoutBuffer += chunk;
        let idx;
        while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
            const line = this.stdoutBuffer.slice(0, idx).trim();
            this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
            if (!line)
                continue;
            let msg;
            try {
                msg = JSON.parse(line);
            }
            catch {
                this.logger.warn(`[captcha] malformed stdout line: ${line.slice(0, 200)}`);
                continue;
            }
            const id = msg.id;
            if (typeof id !== 'number')
                continue;
            const pending = this.pending.get(id);
            if (!pending)
                continue;
            clearTimeout(pending.timer);
            this.pending.delete(id);
            if (msg.error) {
                if (/length mismatch/.test(msg.error)) {
                    pending.resolve(null);
                }
                else {
                    pending.reject(new Error(msg.error));
                }
            }
            else {
                pending.resolve(msg.code ?? null);
            }
        }
    }
};
exports.CaptchaSolverClient = CaptchaSolverClient;
exports.CaptchaSolverClient = CaptchaSolverClient = CaptchaSolverClient_1 = __decorate([
    (0, common_1.Injectable)()
], CaptchaSolverClient);
//# sourceMappingURL=captcha-solver.client.js.map