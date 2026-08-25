import {
  Injectable,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
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
  type BrowserContext,
} from 'playwright';

// ─── Constants ──────────────────────────────────────────────────────────────

const API_BASE = 'https://api.licenses.uz';
const SITE_URL = 'https://license.gov.uz';
const OPEN_SOURCE_PATH = '/v1/register/open_source';

const TURNSTILE_SOLVE_TIMEOUT_MS = 25_000;
const CLICK_RESPONSE_TIMEOUT_MS = 15_000;
const AXIOS_TIMEOUT_MS = 15_000;

/**
 * Page size for the certificate list.
 *
 * Exactly what the site's own view requests. Asking for more is rejected with
 * a 400 — the API caps this and does not say so anywhere, which is why the
 * previous size of 50 failed every time it was reached.
 */
const LICENSE_PAGE_SIZE = 10;

/** Stops a malformed response paging forever. 200 x 10 = 2000 certificates. */
const MAX_LICENSE_PAGES = 200;

/** How long one extra page may take to answer. */
const PAGE_RESPONSE_TIMEOUT_MS = 45_000;

/**
 * How many challenge failures in a row before we stop asking.
 *
 * Three: one is ordinary, two is bad luck, three in a row has not once been
 * anything but the far side turning us away.
 */
const TURNSTILE_STREAK_BEFORE_BACKOFF = parseInt(
  process.env.TURNSTILE_STREAK ?? '3',
  10,
);

/**
 * How long to leave it alone once it starts refusing.
 *
 * Ten minutes. The one refusal we have measured lasted about forty-five, so
 * this does not clear it — it stops us spending forty seconds and a fresh
 * challenge every few minutes for the duration, which is what appears to keep
 * the refusal alive.
 */
const TURNSTILE_COOLDOWN_MS = parseInt(
  process.env.TURNSTILE_COOLDOWN_MS ?? String(10 * 60 * 1000),
  10,
);
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
  /** What the registry says the full count is, when it says. */
  total: number | null;
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
  /**
   * Lookups refused locally during a backoff, without asking the registry.
   *
   * Rising while `failed` holds steady is the backoff working: callers are
   * being turned away cheaply instead of each spending a challenge.
   */
  turnstileBlocked: number;
}

const RECENT_SAMPLE = 50;

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class LicenseService implements OnModuleDestroy {
  private licenseQueue: Promise<any> = Promise.resolve();

  /**
   * Epoch ms until which lookups are refused without asking the registry.
   *
   * Set after a run of challenge failures, cleared by the first success.
   */
  private blockedUntil = 0;

  /** Consecutive failures that were the challenge specifically, not the box. */
  private turnstileStreak = 0;

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
    turnstileBlocked: 0,
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
      avgMs: r.length
        ? Math.round(r.reduce((a, b) => a + b, 0) / r.length)
        : null,
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

    // The registry has been refusing us; do not go and ask again yet.
    //
    // Answering here rather than driving the browser is the whole point: each
    // attempt during a refusal costs forty seconds and, more importantly,
    // spends another challenge against an address the far side has already
    // decided to distrust. On 25 Aug it refused for forty-five minutes while
    // we kept knocking every few minutes; retrying less is the only lever we
    // have over how long that lasts.
    const waitMs = this.blockedUntil - Date.now();
    if (waitMs > 0) {
      this.stats.turnstileBlocked++;
      throw new ServiceUnavailableException({
        message:
          `Registry challenge is refusing this address — ` +
          `not retrying for another ${Math.ceil(waitMs / 1000)}s`,
        retryAfterSec: Math.ceil(waitMs / 1000),
        blockedUntil: new Date(this.blockedUntil).toISOString(),
      });
    }

    this.busy = true;
    this.stats.total++;
    this.logger.log(`▶ START TIN=${tin} (lookup #${this.stats.total})`);

    try {
      const browser = await this.ensureBrowser();
      const context = browser.contexts()[0];

      // A fresh page per lookup: the response listener and any page state must
      // not leak into the next TIN. The browser itself is deliberately reused.
      page = await context.newPage();

      const first = await this.captureTokenFromBrowser(page, tin, 1);
      const all: LicenseDetail[] = [...first.certificates];

      // The site shows 10 per page. Anything beyond that has to be walked, and
      // it has to be walked through the browser: the Turnstile token is
      // single-use, so replaying it against the API returns 400. Each
      // navigation earns a fresh one.
      if (
        first.certificates.length === LICENSE_PAGE_SIZE ||
        (first.total !== null && first.total > all.length)
      ) {
        const context = page.context();
        for (let pageNo = 2; pageNo <= MAX_LICENSE_PAGES; pageNo++) {
          if (first.total !== null && all.length >= first.total) break;

          const next = await this.fetchPage(context, tin, pageNo);
          if (next.length === 0) break;

          all.push(...next);
          if (next.length < LICENSE_PAGE_SIZE) break;
        }
      }

      if (all.length > 0) {
        // A short list that claims to be complete is the failure worth
        // catching, so say when the two disagree.
        if (first.total !== null && all.length < first.total) {
          this.logger.warn(
            `⚠ TIN=${tin} — collected ${all.length} of ${first.total} the registry reports`,
          );
        }
        this.recordOk(all.length, took());
        this.logger.log(
          `✔ DONE TIN=${tin} — ${all.length} cert(s)` +
            (first.total !== null ? ` of ${first.total}` : '') +
            ` in ${took()}ms`,
        );
        return all;
      }

      // Anything that got this far reached the registry, so whatever made it
      // refuse us has passed.
      this.turnstileStreak = 0;
      this.blockedUntil = 0;

      // No token and no response means the Turnstile challenge never resolved,
      // so the registry was never actually asked anything. Returning [] here would be
      // indistinguishable from "this company holds no licences", and a caller
      // that caches it would store a false negative it never retries — the
      // lookup fails often enough (roughly one in three under test) for that to
      // poison the data. Fail loudly so the caller can try again later.
      //
      // Thrown rather than recorded here: the catch below is the single place
      // that counts a failure, so the stats stay consistent.
      throw new Error(
        'Turnstile token not obtained — the lookup never reached the registry',
      );
    } catch (err) {
      // Only tear Chrome down when it actually died. A lookup that merely
      // failed to get a token must not cost the next caller a fresh spawn.
      const alive = this.browser?.isConnected() ?? false;
      if (this.browser && !alive) {
        this.logger.error(
          'Chrome died mid-lookup — disposing so the next call respawns',
        );
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
      this.logger.log(
        `Chrome spawned (PID ${this.chromeProc.pid}) — spawn #${this.stats.chromeSpawns}`,
      );

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

  /**
   * One further page of certificates.
   *
   * Deliberately not reusing the first page's tab. Attaching another response
   * listener to it each time stacks them up, and every listener re-collects
   * every response — by page twelve the same records had been counted a dozen
   * times. A tab per page keeps exactly one listener alive.
   *
   * It also waits for the registry's own answer rather than for the network to
   * fall idle. Idle took ~30s a page; the response arrives in a fraction of
   * that, and it is the only thing being waited on.
   */
  private async fetchPage(
    context: BrowserContext,
    tin: string,
    pageNo: number,
  ): Promise<LicenseDetail[]> {
    const tab = await context.newPage();
    const certs: LicenseDetail[] = [];

    try {
      const answered = tab
        .waitForResponse(
          (r) => r.url().includes('open_source?tin=') && r.status() === 200,
          { timeout: PAGE_RESPONSE_TIMEOUT_MS },
        )
        .catch(() => null);

      await tab.goto(
        `${SITE_URL}/registry?filter[tin]=${encodeURIComponent(tin)}&page=${pageNo}`,
        { waitUntil: 'domcontentloaded', timeout: 30_000 },
      );

      const resp = await answered;
      if (!resp) {
        this.logger.warn(`TIN=${tin} page ${pageNo} — no registry response`);
        return certs;
      }

      const body = await resp.json().catch(() => null);
      const list = body?.data?.certificates;
      if (Array.isArray(list)) certs.push(...list);
      this.logger.log(`TIN=${tin} page ${pageNo} — ${certs.length} cert(s)`);
      return certs;
    } finally {
      await tab.close().catch(() => {});
    }
  }

  // ─── Token capture ────────────────────────────────────────────────────

  private async captureTokenFromBrowser(
    page: Page,
    tin: string,
    pageNo = 1,
  ): Promise<CapturedTokenData> {
    const collectedUuids = new Set<string>();
    const collectedCertificates: LicenseDetail[] = [];
    let capturedToken: string | null = null;
    let reportedTotal: number | null = null;

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

        // The exact query the site itself sends is the only reliable spec for
        // this API: it is undocumented and rejects guessed parameters with 400.
        if (url.includes('open_source')) {
          this.logger.debug(`registry request: ${url}`);
        }

        if (url.includes('open_source') && status === 200) {
          const body = await resp.json().catch(() => null);
          if (body) {
            const certs = body?.data?.certificates;
            if (Array.isArray(certs) && certs.length > 0) {
              for (const c of certs) collectedCertificates.push(c);
              this.logger.log(
                `captured ${certs.length} certificate(s) from response`,
              );
            }
            // How many the registry says exist in total, so the caller knows
            // whether this page is the whole answer.
            const t =
              body?.data?.total_items ??
              body?.data?.total ??
              body?.data?.totalCount;
            if (typeof t === 'number') reportedTotal = t;
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

    // The site's own page number is 1-based; the API it calls underneath is
    // 0-based. Driving it through the UI means each page arrives with its own
    // Turnstile token, which is what makes paging possible at all — the token
    // is single-use, so replaying it against the API returns 400.
    this.logger.log(`navigating to registry for TIN=${tin} (page ${pageNo})`);
    const navAt = Date.now();
    await page.goto(
      `${SITE_URL}/registry?filter[tin]=${encodeURIComponent(tin)}&page=${pageNo}`,
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
        total: reportedTotal,
      };
    }

    if (token) {
      return {
        token,
        uuids: [],
        certificates: collectedCertificates,
        total: reportedTotal,
      };
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
            total: reportedTotal,
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
  /**
   * Every certificate for a company, paging until the registry runs out.
   *
   * A single page was not enough: the count is unbounded in practice, and a
   * caller storing a truncated list has no way to tell it is short. The loop
   * stops on an empty page, on the reported total being reached, or at
   * MAX_PAGES — and if that cap is what stopped it, the log says so instead of
   * letting a partial answer look complete.
   */
  private async fetchLicenseCertificates(
    tin: string,
    token: string,
  ): Promise<LicenseDetail[]> {
    const all: LicenseDetail[] = [];
    let reportedTotal: number | null = null;

    for (let page = 0; page < MAX_LICENSE_PAGES; page++) {
      const url =
        `${API_BASE}${OPEN_SOURCE_PATH}` +
        `?tin=${encodeURIComponent(tin)}&page=${page}&size=${LICENSE_PAGE_SIZE}`;

      const resp = await axios.get(url, {
        headers: this.buildApiHeaders(token),
        timeout: AXIOS_TIMEOUT_MS,
      });

      const body = resp.data?.data;
      const certs = body?.certificates;
      if (!Array.isArray(certs) || certs.length === 0) break;

      all.push(...certs);

      // The registry names this inconsistently across endpoints, so take
      // whichever it sends and treat a missing total as "keep going".
      const total = body?.total_items ?? body?.total ?? body?.totalCount;
      if (typeof total === 'number') reportedTotal = total;

      if (certs.length < LICENSE_PAGE_SIZE) break;
      if (reportedTotal !== null && all.length >= reportedTotal) break;
    }

    if (all.length === MAX_LICENSE_PAGES * LICENSE_PAGE_SIZE) {
      this.logger.warn(
        `TIN=${tin} — hit the ${MAX_LICENSE_PAGES}-page cap at ${all.length} certificates; ` +
          `the list may be incomplete`,
      );
    } else if (reportedTotal !== null && all.length < reportedTotal) {
      this.logger.warn(
        `TIN=${tin} — collected ${all.length} of ${reportedTotal} certificates the registry reports`,
      );
    }

    return all;
  }
}
