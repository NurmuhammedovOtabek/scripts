import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, type Browser, type Page } from 'playwright';

/**
 * The Ministry of Justice registration register (birdarcha), driven through a
 * real browser.
 *
 * Same shape of problem as license.gov.uz, and — as it turns out — the same
 * vendor: both expose `/v1/register/...` on an `api.*` host and gate it with
 * Cloudflare Turnstile. The register's own front-end sends
 *
 *   POST https://api.birdarcha.uz/v1/register/open-register/search?tin=&pin=&lang=uz
 *   headers: { "captcha-response": <Turnstile token> }
 *
 * and a server without that header gets HTTP 400 "Qayta yuklashda xato".
 *
 * The page attaches that header itself once its own submit handler runs, so
 * nothing here has to wait for or read a token — checked on the wire: a click
 * on the register's button sends the search with an 816-character
 * `captcha-response` already in place. There is no token in the DOM to read
 * either; this site drives Turnstile programmatically, with no widget and no
 * `cf-turnstile-response` input.
 *
 * Unlike the licence walk, nothing here is replayed against the API with a
 * captured token. There is exactly one record per lookup and the token is
 * single-use, so the cheaper and more robust move is to let the page make its
 * own request and read the response off the wire. That also means this service
 * never has to know the API's parameter spelling — the page is the spec.
 */

const SITE_URL = 'https://new.birdarcha.uz';
const API_HOST = 'api.birdarcha.uz';
const API_MARKER = 'open-register';
const CDP_PORT = 19222;
const IS_WINDOWS = process.platform === 'win32';
const NAV_TIMEOUT_MS = 45_000;
const RESPONSE_TIMEOUT_MS = 60_000;

/** What the register's own request came to, as seen on the wire. */
type RegisterAnswer =
  | { kind: 'body'; body: Record<string, unknown> }
  /** It answered, and there is no such trader. */
  | { kind: 'absent' }
  /** It never answered inside the budget. */
  | { kind: 'silent' };

export interface BirdarchaLookup {
  pinfl: string;
  found: boolean;
  data: Record<string, unknown> | null;
  tookMs: number;
}

@Injectable()
export class BirdarchaService {
  private readonly logger = new Logger(BirdarchaService.name);
  private browser: Browser | null = null;
  private chromeProc: ChildProcess | null = null;

  /**
   * One lookup at a time.
   *
   * Not for politeness: two pages racing on the same Chrome each raise their
   * own challenge, and the register starts refusing an address that asks for
   * several at once — which is how the licence side learned to serialise.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private stats = {
    total: 0,
    ok: 0,
    notFound: 0,
    failed: 0,
    challengeLost: 0,
  };

  getStats() {
    return { ...this.stats };
  }

  async getTraderByPinfl(pinfl: string): Promise<BirdarchaLookup> {
    if (!/^\d{14}$/.test(String(pinfl || ''))) {
      throw new ServiceUnavailableException('PINFL must be 14 digits');
    }
    const run = this.queue.then(() => this.lookup(pinfl));
    this.queue = run.catch(() => {});
    return run;
  }

  private async lookup(pinfl: string): Promise<BirdarchaLookup> {
    const startedAt = Date.now();
    const took = () => Date.now() - startedAt;
    this.stats.total++;
    this.logger.log(`▶ START pin=${pinfl} (lookup #${this.stats.total})`);

    let page: Page | null = null;
    try {
      const browser = await this.ensureBrowser();
      const context = browser.contexts()[0] ?? (await browser.newContext());
      // A fresh page per lookup so the response listener cannot leak into the
      // next PINFL; the browser itself is deliberately reused.
      page = await context.newPage();

      const answer = this.waitForRegisterResponse(page);

      // The query string is not enough. It looks like it should be — the page
      // puts `?pin=` in the URL after a search — but that is the SPA writing
      // history, not reading it: navigating straight to `?pin=…` renders the
      // empty form and never calls the API. Measured, not assumed: a run that
      // only navigated sat for the full sixty-second budget and timed out.
      // So the form gets filled and submitted like a person would.
      await page.goto(`${SITE_URL}/check-register`, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });

      await this.submitSearch(page, pinfl);

      const answered = await answer;

      if (answered.kind === 'absent') {
        this.stats.notFound++;
        this.logger.log(
          `○ pin=${pinfl} — register has no such trader (${took()}ms)`,
        );
        return { pinfl, found: false, data: null, tookMs: took() };
      }

      if (answered.kind === 'silent') {
        // The register never answered: the challenge did not resolve, or the
        // page changed and no longer searches from the query string. Either
        // way this is our failure, not a statement about the person — and the
        // caller must not store it as "no such trader".
        this.stats.challengeLost++;
        this.logger.error(
          `✖ pin=${pinfl} — no register response in ${took()}ms (challenge lost?)`,
        );
        throw new ServiceUnavailableException(
          'Register did not answer — Turnstile challenge likely unresolved',
        );
      }

      const data = this.unwrap(answered.body);
      if (!data) {
        this.stats.notFound++;
        this.logger.log(
          `○ pin=${pinfl} — register has no such trader (${took()}ms)`,
        );
        return { pinfl, found: false, data: null, tookMs: took() };
      }

      this.stats.ok++;
      this.logger.log(`✔ DONE pin=${pinfl} in ${took()}ms`);
      return { pinfl, found: true, data, tookMs: took() };
    } catch (err) {
      if (!(err instanceof ServiceUnavailableException)) {
        this.stats.failed++;
        this.logger.error(`✖ pin=${pinfl} failed after ${took()}ms — ${err}`);
      }
      throw err;
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  /**
   * Types the PINFL into the register's own form and submits it.
   *
   * The form offers two boxes, STIR and JSHSHIR, and this fills the second.
   * Submitting is what makes the page ask Turnstile for a token, so there is
   * no way to shortcut it — the challenge is bound to the interaction, not to
   * the page load.
   *
   * The placeholder is the selector because it is the one thing on this form
   * that is not a generated class name: the inputs carry no id, no name, and
   * a hashed CSS module class that changes on every deploy.
   */
  private async submitSearch(page: Page, pinfl: string): Promise<void> {
    const field = page.getByPlaceholder('JSHSHIR').first();
    await field.waitFor({ state: 'visible', timeout: 20_000 });
    await field.fill(pinfl);

    // Enter first: it needs no button to still be where it was last week.
    // The explicit click is the fallback for a form that ignores Enter.
    await field.press('Enter').catch(() => undefined);

    const submit = page.locator('button[type="submit"]').first();
    if (await submit.isVisible().catch(() => false)) {
      await submit.click({ timeout: 10_000 }).catch(() => undefined);
    }
  }

  /**
   * Resolves with the register's JSON, or null if it never answered.
   *
   * Listening for the page's own request rather than replaying a captured
   * token: the token is single-use, so a replay would earn a 400 and the
   * second attempt would need another challenge anyway.
   */
  private waitForRegisterResponse(page: Page): Promise<RegisterAnswer> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ kind: 'silent' }),
        RESPONSE_TIMEOUT_MS,
      );
      const settle = (a: RegisterAnswer) => {
        clearTimeout(timer);
        resolve(a);
      };

      page.on('response', (resp) => {
        const url = resp.url();
        if (!url.includes(API_HOST) || !url.includes(API_MARKER)) return;

        const status = resp.status();

        if (status === 200) {
          void resp
            .json()
            .then((body) =>
              settle({ kind: 'body', body: body as Record<string, unknown> }),
            )
            .catch(() => undefined);
          return;
        }

        // 400 is how this register says "no such trader".
        //
        // Not a guess: the body of one reads
        //   {"status":-1,"message":{"type":"ERROR","message":{"uz":"Ma`lumot
        //    topilmadi","en":"NO_CONTENT"}}}
        // for a PINFL that simply is not registered, with a valid 816-character
        // captcha token attached. Reading it as a broken challenge cost the
        // caller a sixty-second wait and then told them the register was
        // unreachable, when it had answered in three seconds.
        if (status === 400) {
          void resp
            .text()
            .then((text) => {
              if (/NO_CONTENT|topilmadi|topilmadi|не найдена/i.test(text)) {
                settle({ kind: 'absent' });
              } else {
                // Some other 400 — a real rejection, worth seeing.
                this.logger.warn(
                  `register rejected the search: ${text.slice(0, 200)}`,
                );
              }
            })
            .catch(() => undefined);
          return;
        }

        // 429/403 is the register refusing the address, which looks identical
        // from the caller's side unless it is said here.
        this.logger.warn(
          `register answered HTTP ${status} on ${url.split('?')[0]}`,
        );
      });
    });
  }

  /**
   * The register answers with the record itself, but wraps it in an array or
   * a `data` envelope depending on the route. Unwrapping here keeps that
   * detail out of the consumer, which only ever wants one trader.
   *
   * An envelope carrying `status`/`message` and no record is the register's
   * error shape, and must read as "not found" rather than as a record.
   */
  private unwrap(body: unknown): Record<string, unknown> | null {
    if (Array.isArray(body)) {
      return (body[0] as Record<string, unknown>) ?? null;
    }
    if (!body || typeof body !== 'object') return null;

    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.data)) {
      return (obj.data[0] as Record<string, unknown>) ?? null;
    }
    if (obj.data && typeof obj.data === 'object') {
      return obj.data as Record<string, unknown>;
    }
    // A bare record identifies itself by carrying the person, not a status.
    if (obj.pin || obj.certificate_number || obj.full_name) return obj;
    return null;
  }

  // ─── Browser ───────────────────────────────────────────────────────────

  /**
   * Connects to the Chrome the box already runs.
   *
   * Deliberately the same CDP port the licence service uses: that Chrome is up
   * around the clock on this machine, and a second one would double the memory
   * for no gain. Whichever service asks first spawns it; the other attaches.
   */
  private async ensureBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    this.browser = null;

    if (!(await this.isCdpUp())) {
      const chromePath = this.findChromePath();
      if (!chromePath) {
        throw new ServiceUnavailableException(
          'Google Chrome not found on this machine',
        );
      }
      const userDataDir = path.join(os.tmpdir(), 'license-cdp-chrome');
      const args = [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-popup-blocking',
      ];
      if (!IS_WINDOWS) {
        args.push(
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
        );
      }
      args.push('about:blank');

      this.logger.log('spawning Chrome for CDP');
      this.chromeProc = spawn(chromePath, args, {
        detached: true,
        stdio: 'ignore',
      });
      this.chromeProc.unref();

      for (let i = 0; i < 20 && !(await this.isCdpUp()); i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    this.browser = await chromium.connectOverCDP(
      `http://localhost:${CDP_PORT}`,
    );
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

  private findChromePath(): string | null {
    const candidates = IS_WINDOWS
      ? [
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : [
          '/usr/bin/google-chrome',
          '/usr/bin/google-chrome-stable',
          '/usr/bin/chromium-browser',
          '/usr/bin/chromium',
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        ];
    return candidates.find((p) => fs.existsSync(p)) ?? null;
  }
}
