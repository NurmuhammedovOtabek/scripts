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
import {
  parsePassportPage,
  type EjarimaPassportResult,
} from './ejarima.parse';

/**
 * Unpaid administrative penalties for a person, from ejarima.uz, by passport.
 *
 * Driven through a real browser for one reason: the form carries a
 * **reCAPTCHA v3** token and there is no way to produce one off-browser.
 * `grecaptcha.ready(...)` runs on page load and fills three hidden inputs, one
 * per tab — ours is `#recaptcha-password`, from
 * `grecaptcha.execute(<sitekey>, { action: 'password' })`.
 *
 * Three things about this page cost time to find and are not guessable from
 * the markup:
 *
 * - **The token is not there when the page is.** `#recaptcha-password` is
 *   empty at `domcontentloaded` and fills a second or two later, once
 *   reCAPTCHA's own script has loaded and scored the session. Submitting
 *   before then sends an empty token. So the wait below is on the field having
 *   a value, not on the network going quiet.
 * - **v3 tokens expire in about two minutes**, and this one is minted at page
 *   load rather than at submit. The page is therefore loaded per lookup and
 *   submitted straight away; a browser left open on a stale form would be
 *   refused with no visible reason.
 * - **One page hosts four forms** — the public search plus the three admin
 *   tabs (`/passport`, `/hosrakam`, `/serial`) — with `#serial` and `#number`
 *   belonging to the passport one. `/oz/search-admin/passport` redirects to
 *   `/oz/search-admin` on a GET, so the form is selected by its action rather
 *   than by index.
 *
 * What comes back is read by `parsePassportPage`, which is deliberately a
 * separate, pure function: see the note there about never reading a failure
 * as "no fines".
 */

const PAGE_URL = 'https://www.ejarima.uz/oz/search-admin';
const FORM_ACTION_SUFFIX = '/search-admin/passport';
const CDP_PORT = 19222;
const IS_WINDOWS = process.platform === 'win32';
const NAV_TIMEOUT_MS = 45_000;
/** How long to wait for reCAPTCHA to score the session and fill the field. */
const TOKEN_TIMEOUT_MS = 20_000;
/** How long to wait for the results page after submitting. */
const RESULT_TIMEOUT_MS = 60_000;

export interface EjarimaLookup extends EjarimaPassportResult {
  tookMs: number;
  /** The page as it arrived. Present only when asked for — it is ~300KB. */
  html?: string;
}

/** `AA` — two letters. The site's own field is `maxlength=2`. */
const SERIAL_SHAPE = /^[A-Z]{2}$/;
/** Seven digits, per the site's `maxlength=7` and its own `QW1234567` hint. */
const NUMBER_SHAPE = /^\d{7}$/;

@Injectable()
export class EjarimaService {
  private readonly logger = new Logger(EjarimaService.name);
  private browser: Browser | null = null;
  private chromeProc: ChildProcess | null = null;

  /**
   * One lookup at a time.
   *
   * reCAPTCHA v3 scores the *session*, not the request, and a session firing
   * several scored actions at once is what a script looks like. Serialising
   * costs a few seconds per queued caller and keeps the score where a form
   * submission is accepted without an interactive challenge — which, on v3,
   * we would have no way to answer.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private stats = {
    total: 0,
    found: 0,
    none: 0,
    failed: 0,
    tokenLost: 0,
  };

  getStats() {
    return { ...this.stats };
  }

  /**
   * @param withHtml also return the page as it arrived. Off by default: the
   * results page is around 300KB and most callers want the parsed rows.
   */
  async getByPassport(
    serial: string,
    number: string,
    withHtml = false,
  ): Promise<EjarimaLookup> {
    const s = String(serial ?? '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
    const n = String(number ?? '').replace(/\D/g, '');

    // Checked here rather than at the site, because a malformed passport
    // costs a page load, a reCAPTCHA score and a place in the queue to learn
    // the same thing.
    if (!SERIAL_SHAPE.test(s) || !NUMBER_SHAPE.test(n)) {
      throw new ServiceUnavailableException(
        'passport must be two letters and seven digits (AA1234567)',
      );
    }

    // No `NetworkGate` here yet, deliberately. The other scrapers wrap their
    // network work in it so an IP rotation can take the connection for a
    // moment, but the gate and the rotation are still unlanded work — and a
    // gate with nothing rotating behind it is a no-op. Keeping this service
    // self-contained means it can ship on its own. When the gate lands, this
    // becomes `this.gate.runShared(() => this.lookup(...))` and nothing else
    // changes.
    const run = this.queue.then(() => this.lookup(s, n, withHtml));
    this.queue = run.catch(() => {});
    return run;
  }

  private async lookup(
    serial: string,
    number: string,
    withHtml: boolean,
  ): Promise<EjarimaLookup> {
    const startedAt = Date.now();
    const took = () => Date.now() - startedAt;
    this.stats.total++;
    // The number is a person's passport, so it is not written to the log. The
    // series alone identifies nobody and is useful when a whole series starts
    // failing.
    const tag = `${serial}·******${number.slice(-1)}`;
    this.logger.log(`▶ START ${tag} (lookup #${this.stats.total})`);

    let page: Page | null = null;
    try {
      const browser = await this.ensureBrowser();
      const context = browser.contexts()[0] ?? (await browser.newContext());
      // A fresh page per lookup: the previous one holds a spent token and the
      // previous person's results.
      page = await context.newPage();

      await page.goto(PAGE_URL, {
        waitUntil: 'domcontentloaded',
        timeout: NAV_TIMEOUT_MS,
      });

      await this.waitForToken(page);
      const html = await this.submit(page, serial, number);

      const result = parsePassportPage(html, serial, number);

      if (result.outcome === 'unavailable') {
        // The page came back without the results header, which the site
        // prints for a search that ran whether or not it found anything. So
        // the search did not run — its own wording for this is "Server
        // vaqtincha ish faoliyatida emas". Answering `none` here would record
        // a person with unpaid fines as clean, so this is a failure.
        this.stats.failed++;
        this.logger.error(
          `✖ ${tag} — the site did not answer the search after ${took()}ms` +
            (result.message ? ` — "${result.message}"` : ''),
        );
        throw new ServiceUnavailableException(
          result.message || 'ejarima.uz did not run the search',
        );
      }

      if (result.outcome === 'found') this.stats.found++;
      else this.stats.none++;

      this.logger.log(
        `✔ DONE ${tag} — ${result.protocols.length} protocol(s), ` +
          `${result.unpaidCount} unpaid in ${took()}ms`,
      );

      return { ...result, tookMs: took(), ...(withHtml ? { html } : {}) };
    } catch (err) {
      if (!(err instanceof ServiceUnavailableException)) {
        this.stats.failed++;
        this.logger.error(`✖ ${tag} failed after ${took()}ms — ${err}`);
      }
      throw err;
    } finally {
      await page?.close().catch(() => undefined);
    }
  }

  /**
   * Waits for reCAPTCHA to fill the passport tab's hidden input.
   *
   * Polled rather than awaited on a network event, because nothing observable
   * marks the moment: the token arrives from a promise inside the page's own
   * `grecaptcha.ready` callback, after requests that also serve the other two
   * tabs. The field having a value is the only reliable signal.
   */
  private async waitForToken(page: Page): Promise<void> {
    try {
      await page.waitForFunction(
        () => {
          const el = document.getElementById(
            'recaptcha-password',
          ) as HTMLInputElement | null;
          return !!el && el.value.length > 50;
        },
        undefined,
        { timeout: TOKEN_TIMEOUT_MS },
      );
    } catch {
      this.stats.tokenLost++;
      throw new ServiceUnavailableException(
        'reCAPTCHA did not issue a token — the site would refuse the search',
      );
    }
  }

  /**
   * Fills the passport form and submits it, returning the page that comes
   * back.
   *
   * The form is submitted directly rather than by clicking, because the page's
   * submit button carries a jQuery handler that only shows a preloader, and
   * the three tabs share a button shape. Navigation is awaited explicitly:
   * this is a plain POST that replaces the document, not an XHR.
   */
  private async submit(
    page: Page,
    serial: string,
    number: string,
  ): Promise<string> {
    await page.fill('#serial', serial);
    await page.fill('#number', number);

    await Promise.all([
      page.waitForNavigation({
        waitUntil: 'domcontentloaded',
        timeout: RESULT_TIMEOUT_MS,
      }),
      page.evaluate((suffix) => {
        const form = document.querySelector<HTMLFormElement>(
          `form[action$="${suffix}"]`,
        );
        if (!form) throw new Error('passport form not found on the page');
        form.submit();
      }, FORM_ACTION_SUFFIX),
    ]);

    return page.content();
  }

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
      // The same profile directory as the other browser-driven scrapers, on
      // purpose: they share one Chrome over one CDP port, and a second profile
      // would mean a second browser competing for the same egress.
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
