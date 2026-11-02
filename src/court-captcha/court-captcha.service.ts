import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { chromium, type Browser } from 'playwright';
import { Worker } from 'worker_threads';
import { join } from 'path';

const CAPTCHA_API = 'https://recaptcha.sud.uz/api/v1/captcha';
const SITE_KEY = 'site_1842e42b6e31fb21ac22c681def0e326';

/**
 * The captcha server reports difficulty in leading zero BITS, not hex chars.
 *   16 bits →  4 hex zeros  →  ~65 K iterations  →  ~7-80 ms
 *   20 bits →  5 hex zeros  →  ~1 M iterations   →  ~500 ms
 *   24 bits →  6 hex zeros  →  ~16 M iterations  →  ~8 s
 */
const MAX_DIFFICULTY_BITS = 24;
const POW_TIMEOUT_MS = 30_000;

const BROWSER_IDLE_MS = 10 * 60 * 1000;

interface PowChallenge {
  challenge: string;
  difficulty: number;
}

export interface CourtCaptchaStats {
  startedAt: string;
  total: number;
  ok: number;
  failed: number;
  failStreak: number;
  worstFailStreak: number;
  lastOkAt: string | null;
  lastFailAt: string | null;
  lastError: string | null;
  recentMs: number[];
  browserAlive: boolean;
}

/**
 * Acquires a recaptcha token from recaptcha.sud.uz for court document
 * PDF downloads.
 *
 * Architecture:
 *   - A headless Chromium (Playwright built-in) stays open while requests
 *     come in, torn down after 10 min idle.
 *   - Each getToken() creates a **fresh browser context** — the captcha
 *     server tracks sessions: reusing a context after the first token
 *     returns score=0 with a math challenge. A fresh context makes every
 *     request look like a new visitor (score=0.85).
 *   - PoW challenge is fetched from the browser (Chrome TLS fingerprint).
 *   - PoW is solved in a worker thread (fast, off the event loop).
 *   - /analyze is called from the browser (real fingerprint → score ≥ 0.85).
 *   - PDF download uses the token via plain HTTP (no browser needed).
 */
@Injectable()
export class CourtCaptchaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('CourtCaptcha');

  private powQueue: Promise<void> = Promise.resolve();

  private browser: Browser | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  private readonly stats: CourtCaptchaStats = {
    startedAt: new Date().toISOString(),
    total: 0,
    ok: 0,
    failed: 0,
    failStreak: 0,
    worstFailStreak: 0,
    lastOkAt: null,
    lastFailAt: null,
    lastError: null,
    recentMs: [],
    browserAlive: false,
  };

  async onModuleInit() {
    this.logger.log('court-captcha service ready');
  }

  async onModuleDestroy() {
    await this.disposeBrowser();
  }

  getStats(): CourtCaptchaStats {
    return {
      ...this.stats,
      recentMs: [...this.stats.recentMs],
      browserAlive: this.browser?.isConnected() ?? false,
    };
  }

  async getToken(action = 'file_download'): Promise<string | null> {
    const startedAt = Date.now();
    this.stats.total++;
    this.logger.log(`▶ token request #${this.stats.total}`);

    let context: any = null;
    try {
      const browser = await this.ensureBrowser();
      context = await browser.newContext({
        locale: 'uz-UZ',
        timezoneId: 'Asia/Tashkent',
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      });

      const page = await context.newPage();
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
        if (!(window as any).chrome) {
          (window as any).chrome = {
            runtime: {},
            loadTimes: () => ({}),
            csi: () => ({}),
          };
        }
      });

      await page.goto('https://public.sud.uz/report', {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });

      const { challenge, difficulty } = await this.fetchPowChallenge(page);
      const hexZeros = Math.ceil(difficulty / 4);
      this.logger.log(
        `PoW: difficulty=${difficulty} bits (${hexZeros} hex zeros)`,
      );

      if (difficulty > MAX_DIFFICULTY_BITS) {
        throw new Error(
          `difficulty ${difficulty} bits exceeds cap ${MAX_DIFFICULTY_BITS}`,
        );
      }

      const pow = await this.solvePowInWorker(challenge, difficulty);
      this.logger.log(`PoW solved: ${pow.solveTimeMs}ms, nonce ${pow.nonce}`);

      const token = await this.analyzeInBrowser(page, action, {
        challenge,
        nonce: pow.nonce,
        solveTimeMs: pow.solveTimeMs,
        solved: true,
      });

      const took = Date.now() - startedAt;
      if (token) {
        this.recordOk(took);
        this.logger.log(`✔ token acquired in ${took}ms`);
      } else {
        this.recordFail('no token (challenge required)', took);
        this.logger.warn(`✖ no token — visual challenge required (${took}ms)`);
      }
      return token;
    } catch (err: any) {
      const took = Date.now() - startedAt;
      this.recordFail(err.message, took);
      this.logger.error(`✖ failed after ${took}ms — ${err.message}`);

      if (
        err.message.includes('browser') ||
        err.message.includes('Target closed')
      ) {
        await this.disposeBrowser();
      }
      return null;
    } finally {
      if (context) {
        try {
          await context.close();
        } catch {}
      }
      this.scheduleIdleShutdown();
    }
  }

  // ── Browser lifecycle ───────────────────────────────────────────────

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    await this.disposeBrowser();

    this.browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--headless=new',
      ],
      executablePath: chromium.executablePath(),
    });
    this.logger.log('Chromium launched');
    return this.browser;
  }

  private async disposeBrowser(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
      this.logger.log('Chromium closed');
    }
  }

  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.logger.log('idle — closing Chromium');
      void this.disposeBrowser();
    }, BROWSER_IDLE_MS);
    this.idleTimer.unref?.();
  }

  // ── Stats ───────────────────────────────────────────────────────────

  private recordOk(ms: number): void {
    this.stats.ok++;
    this.stats.failStreak = 0;
    this.stats.lastOkAt = new Date().toISOString();
    this.stats.recentMs.push(ms);
    if (this.stats.recentMs.length > 50) this.stats.recentMs.shift();
  }

  private recordFail(reason: string, ms: number): void {
    this.stats.failed++;
    this.stats.failStreak++;
    if (this.stats.failStreak > this.stats.worstFailStreak) {
      this.stats.worstFailStreak = this.stats.failStreak;
    }
    this.stats.lastFailAt = new Date().toISOString();
    this.stats.lastError = reason;
    this.stats.recentMs.push(ms);
    if (this.stats.recentMs.length > 50) this.stats.recentMs.shift();
  }

  // ── PoW challenge (from browser) ────────────────────────────────────

  private async fetchPowChallenge(page: any): Promise<PowChallenge> {
    const result = await page.evaluate(
      async ({ api, siteKey }: { api: string; siteKey: string }) => {
        try {
          const res = await fetch(`${api}/pow/challenge`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ siteKey }),
          });
          if (!res.ok) return { error: `HTTP ${res.status}` };
          return await res.json();
        } catch (e: any) {
          return { error: e.message };
        }
      },
      { api: CAPTCHA_API, siteKey: SITE_KEY },
    );

    if (result.error) throw new Error(`pow/challenge: ${result.error}`);
    return result as PowChallenge;
  }

  // ── PoW solver (worker thread) ──────────────────────────────────────

  private solvePowInWorker(
    challenge: string,
    difficulty: number,
  ): Promise<{ nonce: string; solveTimeMs: number }> {
    return new Promise((resolve, reject) => {
      const prev = this.powQueue;
      this.powQueue = prev.then(
        () =>
          new Promise<void>((done) => {
            const workerPath = join(__dirname, 'pow-worker.js');
            const worker = new Worker(workerPath, {
              workerData: { challenge, difficulty },
            });

            const timeout = setTimeout(() => {
              worker.terminate();
              reject(new Error(`pow timed out after ${POW_TIMEOUT_MS / 1000}s`));
              done();
            }, POW_TIMEOUT_MS);

            worker.on('message', (result) => {
              clearTimeout(timeout);
              if (result.solved) {
                resolve({
                  nonce: result.nonce,
                  solveTimeMs: result.solveTimeMs,
                });
              } else {
                reject(new Error('pow not solved within limit'));
              }
              done();
            });

            worker.on('error', (err) => {
              clearTimeout(timeout);
              reject(new Error(`pow worker error: ${err.message}`));
              done();
            });

            worker.on('exit', (code) => {
              if (code !== 0 && code !== null) {
                clearTimeout(timeout);
                reject(new Error(`pow worker exited with code ${code}`));
                done();
              }
            });
          }),
      );
    });
  }

  // ── Analyze (from browser — real fingerprint) ───────────────────────

  private async analyzeInBrowser(
    page: any,
    action: string,
    pow: {
      challenge: string;
      nonce: string;
      solveTimeMs: number;
      solved: boolean;
    },
  ): Promise<string | null> {
    const result = await page.evaluate(
      async ({
        api,
        siteKey,
        action: act,
        pow: p,
      }: {
        api: string;
        siteKey: string;
        action: string;
        pow: {
          challenge: string;
          nonce: string;
          solveTimeMs: number;
          solved: boolean;
        };
      }) => {
        const canvas = document.createElement('canvas');
        canvas.width = 200;
        canvas.height = 50;
        const ctx = canvas.getContext('2d')!;
        ctx.textBaseline = 'top';
        ctx.font = '14px Arial';
        ctx.fillStyle = '#f60';
        ctx.fillRect(125, 1, 62, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('browser fingerprint', 2, 15);
        const cd = canvas.toDataURL();
        let h = 0;
        for (let i = 0; i < cd.length; i++)
          h = ((h << 5) - h + cd.charCodeAt(i)) | 0;

        let webgl = '';
        try {
          const gl = document.createElement('canvas').getContext('webgl');
          if (gl) {
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            if (dbg) webgl = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
          }
        } catch {}

        const now = Date.now();
        const signals = {
          mouse: {
            moveCount: 40 + Math.floor(Math.random() * 60),
            speeds: Array.from(
              { length: 15 },
              () => +(0.2 + Math.random() * 1.8).toFixed(3),
            ),
            clickCount: 2 + Math.floor(Math.random() * 3),
            points: Array.from({ length: 10 }, (_, i) => ({
              x: 100 + Math.floor(Math.random() * 800),
              y: 100 + Math.floor(Math.random() * 500),
              t: now - 5000 + i * 150,
            })),
          },
          keyboard: {
            keystrokeCount: 5 + Math.floor(Math.random() * 10),
            intervals: Array.from(
              { length: 8 },
              () => 80 + Math.floor(Math.random() * 120),
            ),
            holdDurations: Array.from(
              { length: 6 },
              () => 40 + Math.floor(Math.random() * 80),
            ),
          },
          scroll: {
            count: 3 + Math.floor(Math.random() * 5),
            directionChanges: 1,
            smoothCount: 2,
            totalCount: 8,
          },
          touch: {
            eventCount: 0,
            gestureTypes: [] as string[],
            multiTouch: false,
          },
          timing: {
            pageLoadTime: now - 15000 - Math.floor(Math.random() * 30000),
            firstInteractionTime:
              now - 10000 - Math.floor(Math.random() * 10000),
          },
          fingerprint: {
            canvas: h.toString(36),
            webgl: webgl || 'unknown',
            platform: navigator.platform,
            languages: [...navigator.languages],
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            screenResolution: `${screen.width}x${screen.height}`,
            colorDepth: screen.colorDepth,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: (navigator as any).deviceMemory || 8,
            maxTouchPoints: navigator.maxTouchPoints,
            plugins: [...navigator.plugins].map((pl) => pl.name).slice(0, 5),
          },
          botFlags: {
            webdriver: !!(navigator as any).webdriver,
            selenium: !!(window as any)._selenium,
            nightmare: !!(window as any).__nightmare,
            phantom: !!(window as any).callPhantom,
            chromeObjectMissing: !(window as any).chrome,
            zeroPlugins: navigator.plugins.length === 0,
            headlessUserAgent: /headless/i.test(navigator.userAgent),
            zeroOuterDimensions:
              window.outerWidth === 0 || window.outerHeight === 0,
          },
          honeypotFilled: false,
          pow: p,
        };

        try {
          const res = await fetch(`${api}/analyze`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              siteKey,
              action: act,
              timestamp: now,
              signals,
            }),
          });
          if (!res.ok) return { error: `analyze HTTP ${res.status}` };
          const data = await res.json();
          return {
            token: data.token || null,
            score: data.score,
            challengeRequired: data.challengeRequired || false,
          };
        } catch (e: any) {
          return { error: e.message };
        }
      },
      { api: CAPTCHA_API, siteKey: SITE_KEY, action, pow },
    );

    if (result.error) throw new Error(result.error);
    if (result.token) return result.token;

    if (result.challengeRequired) {
      this.logger.warn(
        `visual challenge required (score=${result.score}) — cannot solve`,
      );
      return null;
    }

    throw new Error(`analyze: no token (score=${result.score})`);
  }
}
