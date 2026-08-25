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
Object.defineProperty(exports, "__esModule", { value: true });
exports.stripAnsi = exports.LOG_FILE = void 0;
exports.teeConsoleToFile = teeConsoleToFile;
exports.redact = redact;
exports.tail = tail;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
exports.LOG_FILE = process.env.LOG_FILE ?? path.join(process.cwd(), 'logs', 'scraper.log');
const MAX_BYTES = parseInt(process.env.LOG_MAX_BYTES ?? String(20 * 1024 * 1024), 10);
let stream = null;
let written = 0;
function open() {
    fs.mkdirSync(path.dirname(exports.LOG_FILE), { recursive: true });
    written = fs.existsSync(exports.LOG_FILE) ? fs.statSync(exports.LOG_FILE).size : 0;
    return fs.createWriteStream(exports.LOG_FILE, { flags: 'a' });
}
function rotate() {
    try {
        stream?.end();
        fs.renameSync(exports.LOG_FILE, `${exports.LOG_FILE}.1`);
    }
    catch {
    }
    stream = open();
}
function teeConsoleToFile() {
    if (stream)
        return;
    stream = open();
    for (const name of ['stdout', 'stderr']) {
        const target = process[name];
        const original = target.write.bind(target);
        target.write = ((chunk, ...rest) => {
            try {
                const text = typeof chunk === 'string' ? chunk : String(chunk);
                stream?.write(text);
                written += Buffer.byteLength(text);
                if (written >= MAX_BYTES)
                    rotate();
            }
            catch {
            }
            return original(chunk, ...rest);
        });
    }
}
function redact(text) {
    return text.replace(/\b\d{14}\b/g, '[pinfl]');
}
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text) => text.replace(ANSI_RE, '');
exports.stripAnsi = stripAnsi;
function tail(lines, filter) {
    if (!fs.existsSync(exports.LOG_FILE)) {
        return { lines: [], file: exports.LOG_FILE, sizeBytes: 0 };
    }
    const size = fs.statSync(exports.LOG_FILE).size;
    const want = Math.min(size, Math.min(lines, 2000) * 400);
    const buf = Buffer.alloc(want);
    const fd = fs.openSync(exports.LOG_FILE, 'r');
    try {
        fs.readSync(fd, buf, 0, want, size - want);
    }
    finally {
        fs.closeSync(fd);
    }
    let out = buf
        .toString('utf8')
        .split('\n')
        .slice(want < size ? 1 : 0)
        .filter((l) => l.trim().length > 0);
    if (filter) {
        const needle = filter.toLowerCase();
        out = out.filter((l) => l.toLowerCase().includes(needle));
    }
    return {
        lines: out.slice(-lines).map((l) => redact((0, exports.stripAnsi)(l))),
        file: exports.LOG_FILE,
        sizeBytes: size,
    };
}
//# sourceMappingURL=log-file.js.map