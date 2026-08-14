import {
  Injectable,
  InternalServerErrorException,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import axios from 'axios';
import { spawn, execSync, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  chromium,
  type Browser,
  type Page,
  type Response as PwResponse,
} from 'playwright';

// ─── Constants ──────────────────────────────────────────────────────────────

const API_BASE = 'https://api.licenses.uz';
const SITE_URL = 'https://license.gov.uz';
const OPEN_SOURCE_PATH = '/v1/register/open_source';

const TURNSTILE_SOLVE_TIMEOUT_MS = 25_000;
const CLICK_RESPONSE_TIMEOUT_MS = 15_000;
const AXIOS_TIMEOUT_MS = 15_000;
const UUID_RE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const CDP_PORT = 19222;
const IS_WINDOWS = process.platform === 'win32';

/**
 * How long an idle Chrome is kept alive. Holding it costs ~400MB, so on a
 * machine that also serves other work we hand the memory back once lookups
 * stop, and pay the spawn cost again only on the next burst.
 */
const BROWSER_IDLE_MS = 10 * 60 * 1000;

const CHROME_CANDIDATES = IS_WINDOWS
  ? [
      `${process.env['PROGRAMFILES']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env['LOCALAPPDATA']}\\Google\\Chrome\\Application\\chrome.exe`,
    ]
  : [
      // macOS — the app bundle is the only place Chrome installs itself.
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
    ];

// ─── Types ──────────────────────────────────────────────────────────────────

type LicenseDetail = any;

interface CapturedTokenData {
  token: string;
  uuids: string[];
  certificates: LicenseDetail[];
}

/**
 * What the service has seen since boot. The registry publishes no rate limit,
 * so the only way to learn one is to watch real traffic: a limit shows up as a
 * run of 429/403 answers, or as the Turnstile challenge suddenly refusing to
 * solve. Both are counted here rather than inferred from the logs after the
 * fact.
 */
export interface LicenseStats {
  startedAt: string;
  total: number;
  ok: number;
  failed: number;
  emptyResult: number;
  turnstileSolved: number;
  turnstileTimeout: number;
  chromeSpawns: number;
  /** HTTP status → how many times the registry API answered with it. */
  apiStatus: Record<string, number>;
  lastOkAt: string | null;
  lastFailAt: string | null;
  lastError: string | null;
  /** Wall-clock ms of the most recent lookups, newest last. */
  recentMs: number[];
  /** Consecutive failures right now — a rising run is the rate-limit signal. */
  failStreak: number;
  worstFailStreak: number;
}

const RECENT_SAMPLE = 50;

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class LicenseService implements OnModuleDestroy {
  private licenseQueue: Promise<any> = Promise.resolve();

  /**
   * Chrome outlives a single lookup. Booting it was the dominant per-request
   * cost (~5-10s), so only the page is per-request now; the browser is shared
   * across calls and torn down after BROWSER_IDLE_MS of quiet.
   */
  private browser: Browser | null = null;
  private chromeProc: ChildProcess | null = null;
  private idleTimer: NodeJS.Timeout | null = null;

  private readonly logger = new Logger('License');

  private readonly stats: LicenseStats = {
    startedAt: new Date().toISOString(),
    total: 0,
    ok: 0,
    failed: 0,
    emptyResult: 0,
    turnstileSolved: 0,
    turnstileTimeout: 0,
    chromeSpawns: 0,
    apiStatus: {},
    lastOkAt: null,
    lastFailAt: null,
    lastError: null,
    recentMs: [],
    failStreak: 0,
    worstFailStreak: 0,
  };

  async onModuleDestroy(): Promise<void> {
    await this.disposeBrowser();
  }

  /** Snapshot for the /stats endpoint. */
  getStats(): LicenseStats & {
    queueBusy: boolean;
    browserAlive: boolean;
    avgMs: number | null;
  } {
    const r = this.stats.recentMs;
    return {
      ...this.stats,
      apiStatus: { ...this.stats.apiStatus },
      recentMs: [...r],
      queueBusy: this.busy,
      browserAlive: this.browser?.isConnected() ?? false,
      avgMs: r.length ? Math.round(r.reduce((a, b) => a + b, 0) / r.length) : null,
    };
  }

  private busy = false;

  async getLicensesByTin(tin: string): Promise<LicenseDetail[]> {
    const queuedAt = Date.now();
    const result = this.licenseQueue.then(() => {
      const waited = Date.now() - queuedAt;
      if (waited > 1000) {
        this.logger.log(`TIN=${tin} waited ${waited}ms in queue`);
      }
      return this._doGetLicenses(tin);
    });
    this.licenseQueue = result.catch(() => {});
    return result;
  }

  private async _doGetLicenses(tin: string): Promise<LicenseDetail[]> {
    let page: Page | null = null;
    const startedAt = Date.now();
    const took = () => Date.now() - startedAt;

    this.busy = true;
    this.stats.total++;
    this.logger.log(`▶ START TIN=${tin} (lookup #${this.stats.total})`);

    try {
      const browser = await this.ensureBrowser();
      const context = browser.contexts()[0];

      // A fresh page per lookup: the response listener and any page state must
      // not leak into the next TIN. The browser itself is deliberately reused.
      page = await context.newPage();

      const captured = await this.captureTokenFromBrowser(page, tin);

      // The registry's open_source response already carries the FULL certificate
      // objects, so if the browser captured them during navigation we're done.
      if (captured.certificates.length > 0) {
        this.recordOk(captured.certificates.length, took());
        this.logger.log(
          `✔ DONE TIN=${tin} — ${captured.certificates.length} cert(s) from browser response in ${took()}ms`,
        );
        return captured.certificates;
      }

      // Otherwise re-query the list endpoint with the captured Turnstile token.
      // It returns the full certificates too. NOTE: the old per-uuid detail
      // endpoint (open_source/{uuid}) now returns 400 — the list already has
      // everything, so we no longer call it.
      if (captured.token) {
        const certs = await this.fetchLicenseCertificates(tin, captured.token);
        this.recordOk(certs.length, took());
        this.logger.log(
          `✔ DONE TIN=${tin} — ${certs.length} cert(s) from API list in ${took()}ms`,
        );
        return certs;
      }

      // No token: almost always a Turnstile timeout. Counted separately from a
      // crash because it is the shape throttling would take.
      this.recordFail(tin, 'no Turnstile token', took());
      this.logger.warn(
        `✖ EMPTY TIN=${tin} — no Turnstile token after ${took()}ms (streak=${this.stats.failStreak})`,
      );
      return [];
    } catch (err) {
      // Only tear Chrome down when it actually died. A lookup that merely
      // failed to get a token must not cost the next caller a fresh spawn.
      const alive = this.browser?.isConnected() ?? false;
      if (this.browser && !alive) {
        this.logger.error('Chrome died mid-lookup — disposing so the next call respawns');
        await this.disposeBrowser();
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.recordFail(tin, msg, took());
      this.logger.error(
        `✖ FAIL TIN=${tin} after ${took()}ms — ${msg} (streak=${this.stats.failStreak}, chromeAlive=${alive})`,
      );
      throw new InternalServerErrorException(
        `Failed to fetch licenses for TIN ${tin}: ${msg}`,
      );
    } finally {
      this.busy = false;
      if (page) await page.close().catch(() => {});
      this.scheduleIdleShutdown();
    }
  }

  // ─── Chrome lifecycle helpers ─────────────────────────────────────────

  private findChromePath(): string | null {
    for (const p of CHROME_CANDIDATES) {
      try {
        fs.accessSync(p);
        return p;
      } catch {}
    }
    return null;
  }

  private async waitForCdpReady(timeout = 10_000): Promise<void> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        await axios.get(`http://localhost:${CDP_PORT}/json/version`, {
          timeout: 1000,
        });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    throw new Error(`Chrome CDP endpoint not available after ${timeout}ms`);
  }

  private pushDuration(ms: number): void {
    this.stats.recentMs.push(ms);
    if (this.stats.recentMs.length > RECENT_SAMPLE) this.stats.recentMs.shift();
  }

  private recordOk(certCount: number, ms: number): void {
    this.stats.ok++;
    if (certCount === 0) this.stats.emptyResult++;
    this.stats.failStreak = 0;
    this.stats.lastOkAt = new Date().toISOString();
    this.pushDuration(ms);
  }

  private recordFail(tin: string, reason: string, ms: number): void {
    this.stats.failed++;
    this.stats.failStreak++;
    if (this.stats.failStreak > this.stats.worstFailStreak) {
      this.stats.worstFailStreak = this.stats.failStreak;
    }
    this.stats.lastFailAt = new Date().toISOString();
    this.stats.lastError = `TIN=${tin}: ${reason}`;
    this.pushDuration(ms);

    // Three in a row is the earliest point where "bad luck" stops being the
    // likely explanation and a block or an upstream change becomes one.
    if (this.stats.failStreak >= 3) {
      this.logger.error(
        `⚠ ${this.stats.failStreak} FAILURES IN A ROW — possible rate limit or upstream change. Last: ${reason}`,
      );
    }
  }

  /**
   * Returns a connected browser, spawning Chrome only when there isn't one.
   *
   * A Chrome left listening by an earlier run of this process is reused rather
   * than spawning a second instance against the same user-data-dir, which
   * Chrome would refuse anyway.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    // Stale handle from a Chrome that died between requests.
    await this.disposeBrowser();

    if (!(await this.isCdpUp())) {
      const chromePath = this.findChromePath();
      if (!chromePath) {
        throw new Error('Google Chrome not found. Install Chrome to proceed.');
      }

      const userDataDir = path.join(os.tmpdir(), 'license-cdp-chrome');

      const chromeArgs = [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
      ];

      if (!IS_WINDOWS) {
        chromeArgs.push(
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        );
      }

      chromeArgs.push('about:blank');

      this.chromeProc = spawn(chromePath, chromeArgs, {
        detached: true,
        stdio: 'ignore',
      });
      this.chromeProc.unref();
      this.stats.chromeSpawns++;
      this.logger.log(`Chrome spawned (PID ${this.chromeProc.pid}) — spawn #${this.stats.chromeSpawns}`);

      await this.waitForCdpReady();
    } else {
      this.logger.log('reusing Chrome already listening on CDP');
    }

    this.browser = await chromium.connectOverCDP(
      `http://localhost:${CDP_PORT}`,
    );
    this.logger.log('connected to Chrome (kept alive between lookups)');
    return this.browser;
  }

  private async isCdpUp(): Promise<boolean> {
    try {
      await axios.get(`http://localhost:${CDP_PORT}/json/version`, {
        timeout: 1000,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async disposeBrowser(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
    this.killChromeProcess(this.chromeProc);
    this.chromeProc = null;
  }

  /** Restarts the idle countdown after every lookup. */
  private scheduleIdleShutdown(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.logger.log('idle — closing Chrome to release memory');
      void this.disposeBrowser();
    }, BROWSER_IDLE_MS);
    // Never hold the event loop open just for this timer.
    this.idleTimer.unref?.();
  }

  private killChromeProcess(proc: ChildProcess | null): void {
    if (!proc?.pid) return;
    try {
      if (IS_WINDOWS) {
        execSync(`taskkill /F /PID ${proc.pid} /T`, { stdio: 'ignore' });
      } else {
        execSync(`kill -9 ${proc.pid}`, { stdio: 'ignore' });
      }
      this.logger.log(`Chrome process ${proc.pid} killed`);
    } catch {}
  }

  // ─── Token capture ────────────────────────────────────────────────────

  private async captureTokenFromBrowser(
    page: Page,
    tin: string,
  ): Promise<CapturedTokenData> {
    const collectedUuids = new Set<string>();
    const collectedCertificates: LicenseDetail[] = [];
    let capturedToken: string | null = null;

    page.on('response', async (resp) => {
      try {
        const url = resp.url();
        if (!url.includes('api.licenses.uz')) return;

        const status = resp.status();
        const token = resp.request().headers()['x-turnstile-token'];

        // Every registry answer is tallied by status. A block would surface
        // here as 429/403 long before it shows up as a missing token.
        const key = String(status);
        this.stats.apiStatus[key] = (this.stats.apiStatus[key] ?? 0) + 1;
        if (status === 429 || status === 403) {
          this.logger.error(
            `⚠ REGISTRY REFUSED: HTTP ${status} on ${url.split('?')[0]} — rate limit or block`,
          );
        } else if (status >= 400) {
          this.logger.warn(`registry HTTP ${status} on ${url.split('?')[0]}`);
        }

        if (token && !capturedToken) {
          capturedToken = token;
          this.logger.log('Turnstile token captured');
        }

        if (url.includes('open_source') && status === 200) {
          const body = await resp.json().catch(() => null);
          if (body) {
            const certs = body?.data?.certificates;
            if (Array.isArray(certs) && certs.length > 0) {
              for (const c of certs) collectedCertificates.push(c);
              this.logger.log(`captured ${certs.length} certificate(s) from response`);
            }
            const uuids = this.extractUuids(body);
            for (const id of uuids) collectedUuids.add(id);
            if (body?.uuid) collectedUuids.add(String(body.uuid));
            if (body?.data?.uuid) collectedUuids.add(String(body.data.uuid));
          }
        }
      } catch (err) {
        this.logger.warn(`response handler error: ${err}`);
      }
    });

    this.logger.log(`navigating to registry for TIN=${tin}`);
    const navAt = Date.now();
    await page.goto(
      `${SITE_URL}/registry?filter[tin]=${encodeURIComponent(tin)}`,
      { waitUntil: 'domcontentloaded', timeout: 30_000 },
    );

    await page.waitForLoadState('networkidle').catch(() => {});
    this.logger.log(`page ready in ${Date.now() - navAt}ms`);

    const solveAt = Date.now();
    const turnstileToken = await this.extractTurnstileToken(page);
    const solveMs = Date.now() - solveAt;

    if (turnstileToken) {
      this.stats.turnstileSolved++;
      this.logger.log(`Turnstile solved in ${solveMs}ms`);
    } else {
      this.stats.turnstileTimeout++;
      // A rising share of these is the clearest early warning that the site
      // has started treating this IP as a bot.
      const share =
        this.stats.turnstileTimeout /
        Math.max(1, this.stats.turnstileSolved + this.stats.turnstileTimeout);
      this.logger.warn(
        `Turnstile TIMED OUT after ${solveMs}ms — timeout rate ${(share * 100).toFixed(0)}% (${this.stats.turnstileTimeout}/${this.stats.turnstileSolved + this.stats.turnstileTimeout})`,
      );
    }

    if (turnstileToken || capturedToken) {
      await page.waitForTimeout(5000);
    }

    const token = capturedToken || turnstileToken;
    if (token && collectedUuids.size > 0) {
      return {
        token,
        uuids: [...collectedUuids],
        certificates: collectedCertificates,
      };
    }

    if (token) {
      return { token, uuids: [], certificates: collectedCertificates };
    }

    try {
      const detailPromise = page
        .waitForResponse((resp) => this.isTokenBearingResponse(resp), {
          timeout: CLICK_RESPONSE_TIMEOUT_MS,
        })
        .catch(() => null);

      await this.clickFirstResult(page, tin);

      const detailResp = await detailPromise;
      if (detailResp) {
        const tkn = detailResp.request().headers()['x-turnstile-token'];
        if (tkn) {
          const urlUuids = detailResp.url().match(UUID_RE);
          if (urlUuids) for (const id of urlUuids) collectedUuids.add(id);
          return {
            token: tkn,
            uuids: [...collectedUuids],
            certificates: collectedCertificates,
          };
        }
      }
    } catch (err) {
      this.logger.warn(`fallback click failed: ${err}`);
    }

    throw new Error(
      'Could not obtain Turnstile token — Turnstile did not solve',
    );
  }

  // ─── Turnstile token extraction ───────────────────────────────────────

  private async extractTurnstileToken(page: Page): Promise<string | null> {
    const hasTurnstile = await page.evaluate(() => ({
      cfWidget: !!document.querySelector('.cf-turnstile'),
      cfIframe: !!document.querySelector('iframe[src*="turnstile"]'),
    }));

    if (hasTurnstile.cfWidget || hasTurnstile.cfIframe) {
      try {
        const frame = page.frameLocator('iframe[src*="turnstile"]');
        await frame
          .locator('input[type="checkbox"], .mark, body')
          .first()
          .click({ timeout: 3000 });
      } catch {
        try {
          await page.locator('.cf-turnstile').first().click({ timeout: 2000 });
        } catch {}
      }
    }

    try {
      const handle = await page.waitForFunction(
        () => {
          try {
            const t = (window as any).turnstile;
            if (t && typeof t.getResponse === 'function') {
              const r = t.getResponse();
              if (r && typeof r === 'string' && r.length > 20) return r;
            }
          } catch {}

          const input = document.querySelector(
            '[name="cf-turnstile-response"]',
          ) as HTMLInputElement | null;
          if (input?.value && input.value.length > 20) return input.value;

          const widget = document.querySelector('.cf-turnstile');
          if (widget) {
            const val =
              widget.getAttribute('data-response') ||
              widget.getAttribute('data-token');
            if (val && val.length > 20) return val;
          }

          return null;
        },
        { timeout: TURNSTILE_SOLVE_TIMEOUT_MS },
      );

      return (await handle.jsonValue()) as string | null;
    } catch {
      return null;
    }
  }

  // ─── Predicates ───────────────────────────────────────────────────────

  private isTokenBearingResponse(resp: PwResponse): boolean {
    const url = resp.url();
    if (!url.includes('api.licenses.uz')) return false;
    if (!url.includes('open_source')) return false;
    if (resp.status() !== 200) return false;
    return !!resp.request().headers()['x-turnstile-token'];
  }

  // ─── Result clicking (fallback) ───────────────────────────────────────

  private async clickFirstResult(page: Page, _tin: string): Promise<void> {
    const chipBox = await page
      .locator(`text=/STIR/i`)
      .first()
      .boundingBox()
      .catch(() => null);
    const minY = chipBox ? chipBox.y + chipBox.height + 50 : 380;

    const allLinks = await page.locator('a:visible').all();
    for (let i = 0; i < allLinks.length; i++) {
      const link = allLinks[i];
      const box = await link.boundingBox().catch(() => null);
      const text = ((await link.textContent()) || '').trim().slice(0, 60);
      if (!box) continue;
      if (box.y < minY || box.width < 20 || box.height < 10) continue;
      if (text === 'Barcha' || text.startsWith('STIR')) continue;
      await link.click();
      return;
    }

    for (const label of ['License', 'Litsenziya', 'Ruxsatnoma']) {
      const el = page.getByText(label).first();
      const vis = await el.isVisible().catch(() => false);
      if (vis) {
        const box = await el.boundingBox().catch(() => null);
        if (box && box.y >= minY) {
          await el.click();
          return;
        }
      }
    }

    const clickInfo = await page.evaluate((minY: number) => {
      const els = document.querySelectorAll('div, span, td, tr, li, article');
      for (const el of els) {
        const rect = el.getBoundingClientRect();
        if (rect.top < minY || rect.width < 50 || rect.height < 20) continue;
        if (window.getComputedStyle(el).cursor === 'pointer') {
          (el as HTMLElement).click();
          return true;
        }
      }
      return false;
    }, minY);
    if (clickInfo) return;

    if (chipBox) {
      const x = chipBox.x + 200;
      const y = chipBox.y + chipBox.height + 150;
      await page.mouse.click(x, y);
    }
  }

  // ─── UUID extraction ──────────────────────────────────────────────────

  private extractUuids(body: unknown): string[] {
    if (!body || typeof body !== 'object') return [];

    const obj = body as Record<string, any>;

    let items: unknown[] = [];

    const arraySource =
      obj?.data?.certificates ??
      obj?.data?.content ??
      obj?.data?.items ??
      obj?.content ??
      obj?.items;

    if (Array.isArray(arraySource)) {
      items = arraySource;
    } else if (Array.isArray(obj?.data)) {
      items = obj.data;
    } else if (obj?.data && typeof obj.data === 'object') {
      const values = Object.values(obj.data);
      if (
        values.length > 0 &&
        values.every((v) => v && typeof v === 'object')
      ) {
        items = values;
      }
    }

    const uuids: string[] = [];
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const it = item as Record<string, any>;

      const id =
        it.uuid ??
        it.id ??
        it.registerId ??
        it.register_id ??
        it.certificateId ??
        it.certificate_id ??
        it.docId;
      if (id && typeof id === 'string' && uuidPattern.test(id)) {
        uuids.push(id);
      }
    }

    if (uuids.length === 0 && items.length > 0) {
      const jsonStr = JSON.stringify(items);
      const globalUuidRe =
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
      let match: RegExpExecArray | null;
      while ((match = globalUuidRe.exec(jsonStr)) !== null) {
        if (!uuids.includes(match[0])) uuids.push(match[0]);
      }
    }

    return uuids;
  }

  // ─── Axios helpers ────────────────────────────────────────────────────

  private buildApiHeaders(token: string): Record<string, string> {
    return {
      Accept: 'application/json',
      Origin: SITE_URL,
      Referer: `${SITE_URL}/`,
      'User-Agent': DEFAULT_USER_AGENT,
      'x-turnstile-token': token,
    };
  }

  /**
   * Fetch the full license/permit certificates for a TIN. The registry's
   * open_source list endpoint returns the complete certificate objects in
   * `data.certificates`, so this is the single source — the old per-uuid
   * detail endpoint (open_source/{uuid}) was retired and now returns 400.
   */
  private async fetchLicenseCertificates(
    tin: string,
    token: string,
  ): Promise<LicenseDetail[]> {
    const url =
      `${API_BASE}${OPEN_SOURCE_PATH}` +
      `?tin=${encodeURIComponent(tin)}&page=0&size=50`;

    const resp = await axios.get(url, {
      headers: this.buildApiHeaders(token),
      timeout: AXIOS_TIMEOUT_MS,
    });

    const certs = resp.data?.data?.certificates;
    return Array.isArray(certs) ? certs : [];
  }
}
