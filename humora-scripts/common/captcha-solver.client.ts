import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';

export type CaptchaCharset = 'digits' | 'alpha' | 'alnum';

export interface SolveOptions {
  type?: CaptchaCharset;
  length?: number;
}

interface Pending {
  resolve: (code: string | null) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Long-lived subprocess that wraps the Python ddddocr model.
 *
 * The Python process is spawned once on module init — the ONNX model stays
 * loaded, so each solve is ~10-30ms (vs ~500ms if we respawned per request).
 *
 * Protocol: JSON-lines over stdin/stdout, each request/response tagged with
 * a numeric `id` so concurrent callers don't trip over each other.
 */
@Injectable()
export class CaptchaSolverClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CaptchaSolverClient.name);
  private readonly pythonBin =
    process.env.PYTHON_BIN ||
    (process.platform === 'win32' ? 'python' : 'python3');
  private readonly scriptPath =
    process.env.CAPTCHA_SOLVER_SCRIPT ||
    path.resolve(process.cwd(), 'python/solver.py');
  private readonly solveTimeoutMs = 10_000;

  private proc: ChildProcess | null = null;
  private stdoutBuffer = '';
  private pending = new Map<number, Pending>();
  private nextId = 0;
  private ready = false;
  private readyWaiters: Array<() => void> = [];
  private shuttingDown = false;

  onModuleInit() {
    this.spawnProcess();

    // Belt-and-suspenders: OnModuleDestroy only fires on a clean app.close()
    // (reliable on Linux/Docker but not on a hard Windows signal). These
    // process-level hooks run during any Node exit path and kill the child
    // so it never leaks as a zombie.
    const cleanup = () => {
      this.shuttingDown = true;
      if (this.proc && !this.proc.killed) this.proc.kill();
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

  async solve(imgBuf: Buffer, opts: SolveOptions = {}): Promise<string | null> {
    await this.waitReady();

    const id = ++this.nextId;
    const { type = 'digits', length } = opts;

    return new Promise<string | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`captcha solver timeout after ${this.solveTimeoutMs}ms`),
        );
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

  // ─── process lifecycle ─────────────────────────────────────────────────

  private spawnProcess(): void {
    this.logger.log(`[captcha] starting: ${this.pythonBin} ${this.scriptPath}`);
    this.ready = false;

    this.proc = spawn(this.pythonBin, [this.scriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout!.on('data', (chunk: Buffer) =>
      this.onStdout(chunk.toString()),
    );
    this.proc.stderr!.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (!line) return;
      // ddddocr prints "[solver] ready" once the model is loaded
      if (line.includes('[solver] ready')) {
        this.markReady();
      }
      this.logger.debug(`[captcha:py] ${line}`);
    });

    this.proc.on('exit', (code, signal) => {
      this.logger.warn(
        `[captcha] process exited code=${code} signal=${signal}`,
      );
      this.ready = false;

      // Fail every pending caller so they don't hang forever.
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('captcha solver died'));
      }
      this.pending.clear();

      if (!this.shuttingDown) {
        // Respawn after a short delay so a crash loop doesn't burn CPU.
        setTimeout(() => this.spawnProcess(), 2000);
      }
    });

    this.proc.on('error', (err) => {
      this.logger.error(`[captcha] spawn error: ${err.message}`);
    });
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    this.logger.log('[captcha] ready');
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w();
  }

  private waitReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve) => this.readyWaiters.push(resolve));
  }

  // ─── stdout demultiplexer ──────────────────────────────────────────────

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;

      let msg: { id?: number; code?: string; error?: string };
      try {
        msg = JSON.parse(line);
      } catch {
        this.logger.warn(
          `[captcha] malformed stdout line: ${line.slice(0, 200)}`,
        );
        continue;
      }

      const id = msg.id;
      if (typeof id !== 'number') continue;

      const pending = this.pending.get(id);
      if (!pending) continue;

      clearTimeout(pending.timer);
      this.pending.delete(id);

      if (msg.error) {
        // length-mismatch is not a hard error — caller should retry with a fresh captcha
        if (/length mismatch/.test(msg.error)) {
          pending.resolve(null);
        } else {
          pending.reject(new Error(msg.error));
        }
      } else {
        pending.resolve(msg.code ?? null);
      }
    }
  }
}
