import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { TelegramAlertService } from '../common/telegram-alert.service';

/**
 * Client for the scraper box — a machine on a separate connection that runs the
 * sources production cannot.
 *
 * Some registries cap requests per source address, so spending a second address
 * buys capacity production cannot get otherwise. Others, license.gov.uz among
 * them, sit behind a browser challenge that needs a real Chrome, which
 * production does not have at all.
 *
 * The box sits on an office connection, so it is treated as best-effort: every
 * call is bounded, a failure returns null rather than throwing, and callers are
 * expected to carry on without it. It is extra capacity, never a dependency.
 */
interface RequestOptions {
  /**
   * The status the box uses for "I ran, the site behind me did not answer".
   * Logged as the source being down, kept out of the box-down alert streak.
   */
  sourceDownStatus?: number;
}

@Injectable()
export class RemoteScraperService {
  private readonly logger = new Logger(RemoteScraperService.name);

  /** A run of failures means the box is down, and that is worth one alert. */
  private failStreak = 0;
  private lastAlertAt = 0;
  private static readonly ALERT_AFTER_FAILURES = 3;
  private static readonly ALERT_COOLDOWN_MS = 30 * 60 * 1000;

  constructor(private readonly tg: TelegramAlertService) {}

  /** Configured only where the operator set it; absent means "skip this box". */
  get enabled(): boolean {
    return Boolean(process.env.SCRIPT_SERVICE_URL?.trim());
  }

  private get baseUrl(): string {
    return (process.env.SCRIPT_SERVICE_URL ?? '').replace(/\/+$/, '');
  }

  /**
   * Permits and licences for a company from license.gov.uz.
   *
   * Slow by nature, and the ceiling is set by how many permits a company holds
   * rather than by one fixed cost: the box drives a real browser and walks a
   * page at a time. A small company takes ~35s; Xalq Bank's 138 permits across
   * 14 pages took ~107s.
   *
   * The timeout is generous because a partial answer is not kept — cutting the
   * walk short loses everything collected so far, and the company would be
   * refetched from scratch on the next view. Nothing waits on this call, so
   * there is little to gain by giving up early.
   */
  async getLicenses(tin: string): Promise<any[] | null> {
    return this.get<any[]>('/litsens', { tin }, 600_000, `licenses tin=${tin}`);
  }

  /**
   * A trader's registration record from the Ministry of Justice module
   * (api.birdarcha.uz `/v1/register/open-register/search`).
   *
   * It goes through the box for the same reason licences do: the endpoint
   * answers a real browser and nothing else. The register's own front-end
   * sends the lookup as
   *
   *   POST /v1/register/open-register/search?tin=&pin=&lang=uz
   *   headers: { "captcha-response": <Cloudflare Turnstile token> }
   *
   * and the token can only be produced by Turnstile's script running against
   * sitekey `0x4AAAAAABiTbYoE7b8qg3ub` in a real browser. Calling the endpoint
   * from a server without one returns HTTP 400 "Qayta yuklashda xato" —
   * verified, not assumed.
   *
   * ⚠️ CROSS-SERVICE CONTRACT. The box must expose `GET /birdarcha?pin=…`
   * returning the register's JSON object unchanged. Renaming either side
   * silently turns every trader lookup into a null, which this client cannot
   * tell apart from a trader the register does not know.
   *
   * One record behind one challenge, so the budget is a fraction of the
   * licence walk's.
   */
  async getBirdarchaTrader(pinfl: string): Promise<any | null> {
    return this.get<any>(
      '/birdarcha',
      { pin: pinfl },
      120_000,
      `birdarcha pin=${pinfl}`,
    );
  }

  /**
   * Administrative penalties for a person, from ejarima.uz, by passport.
   *
   * Through the box because the site's form carries a **reCAPTCHA v3** token,
   * minted by `grecaptcha.execute(...)` inside the page. There is no way to
   * produce one off-browser — it is not a captcha that can be solved, it is a
   * score assigned to a real browsing session — so a server-side POST is
   * refused however faithfully the form is reproduced.
   *
   * CROSS-SERVICE CONTRACT. The box must expose
   * `GET /ejarima?serial=&number=[&html=1]` returning
   * `{ outcome, found, protocols[], unpaidCount, unpaidTotal, pendingCount }`,
   * plus `html` when asked for it.
   *
   * **`null` here never means "no penalties".** The box answers 503 when the
   * site did not run the search — its own wording is "Server vaqtincha ish
   * faoliyatida emas" — and that arrives here as the same `null` as an
   * unreachable box. A search that ran and found nothing comes back 200 with
   * `outcome: "none"`. Callers must tell those apart or they will report a
   * person with unpaid fines as clean.
   *
   * One page load and one form post. Measured on the box: about 6s warm, and
   * 22s on the first call after a restart, when Chrome still has to be
   * spawned for CDP.
   */
  async getEjarimaByPassport(
    serial: string,
    number: string,
    withHtml = false,
  ): Promise<any | null> {
    return this.get<any>(
      '/ejarima',
      { serial, number, ...(withHtml ? { html: '1' } : {}) },
      120_000,
      // The number is a person's passport and does not belong in a log line.
      `ejarima serial=${serial}`,
    );
  }

  /**
   * A company's open vacancies from ish.mehnat.uz, with each posting's page.
   *
   * Through the box for reachability, not for a browser: the API is open, but
   * mehnat's Uzbektelecom range (213.230.70.0/24) does not answer from the
   * production network, and it does from the box's office line.
   *
   * CROSS-SERVICE CONTRACT. The box must expose `GET /mehnat/vacancies?tin=`
   * returning `{ tin, rows[], details{ [id]: posting | null } }` with the
   * source's shapes unchanged; MehnatVacancyProvider parses them. A list the
   * box could not read is a 502, which arrives here as null — callers must
   * treat null as "source failed", not as "no vacancies".
   *
   * One list call plus a posting call per opening, six at a time on the box:
   * under a second for a typical employer.
   */
  async getMehnatVacancies(
    tin: string,
    timeoutMs = 11_000,
  ): Promise<{
    tin: string;
    rows: any[];
    details: Record<string, any>;
  } | null> {
    return this.get(
      '/mehnat/vacancies',
      { tin },
      timeoutMs,
      `mehnat tin=${tin}`,
      {
        // the box's "ish.mehnat.uz did not answer"
        sourceDownStatus: 502,
      },
    );
  }

  private async get<T>(
    path: string,
    params: Record<string, string>,
    timeoutMs: number,
    label: string,
    opts: RequestOptions = {},
  ): Promise<T | null> {
    if (!this.enabled) return null;
    // Ordering and de-duplication belong to the queue in front of this client
    // (see license-queue.service). This just makes the call.
    return this.request<T>(path, params, timeoutMs, label, opts);
  }

  private async request<T>(
    path: string,
    params: Record<string, string>,
    timeoutMs: number,
    label: string,
    opts: RequestOptions = {},
  ): Promise<T | null> {
    const startedAt = Date.now();
    try {
      const res = await axios.get(`${this.baseUrl}${path}`, {
        params,
        timeout: timeoutMs,
        validateStatus: () => true,
      });
      const took = Date.now() - startedAt;

      if (opts.sourceDownStatus && res.status === opts.sourceDownStatus) {
        // The box answered; the site behind it did not. Not the box being
        // down, so it neither counts toward nor resets the box alert streak.
        this.logger.warn(
          `[remote] ${label} — box reached, source did not answer (HTTP ${res.status}) in ${took}ms`,
        );
        return null;
      }

      if (res.status !== 200) {
        // A 500 here is the box saying it could not complete the lookup —
        // notably when the browser challenge never resolved. That is a failure
        // to record, not an empty result to cache.
        this.recordFailure(label, `HTTP ${res.status}`, took);
        return null;
      }

      this.failStreak = 0;
      const count = Array.isArray(res.data)
        ? res.data.length
        : Array.isArray(res.data?.rows)
          ? res.data.rows.length
          : 1;
      this.logger.log(`[remote] ${label} → ${count} row(s) in ${took}ms`);
      return res.data as T;
    } catch (err) {
      const took = Date.now() - startedAt;
      const e = err as { code?: string; message?: string };
      const timedOut =
        e?.code === 'ECONNABORTED' || /timeout/i.test(e?.message ?? '');

      if (timedOut) {
        // Distinct from an unreachable box: this one worked for the whole
        // budget and still did not finish, so everything it collected is lost.
        // Worth saying immediately rather than waiting for a third failure.
        this.alertTimeout(label, took, timeoutMs);
        this.failStreak++;
        this.logger.error(
          `[remote] ${label} TIMED OUT after ${took}ms (budget ${timeoutMs}ms) — partial work discarded`,
        );
        return null;
      }

      this.recordFailure(label, e?.message ?? String(err), took);
      return null;
    }
  }

  private alertTimeout(label: string, took: number, budget: number): void {
    if (!this.withinCooldown()) return;
    void this.tg
      .send(
        `⏱ <b>Scraper box timed out</b>\n` +
          `<code>${label}</code>\n` +
          `Ran ${Math.round(took / 1000)}s against a ${Math.round(budget / 1000)}s budget.\n\n` +
          `Whatever it had collected was discarded. If this repeats for the same ` +
          `company it is holding more records than the budget allows.`,
        { tag: 'scraper_box' },
      )
      .catch(() => undefined);
  }

  private recordFailure(label: string, reason: string, took: number): void {
    this.failStreak++;
    this.logger.warn(
      `[remote] ${label} failed after ${took}ms — ${reason} (streak=${this.failStreak})`,
    );

    if (this.failStreak < RemoteScraperService.ALERT_AFTER_FAILURES) return;
    if (!this.withinCooldown()) return;

    void this.tg
      .send(
        `⚠️ <b>Scraper box unreachable</b>\n` +
          `${this.failStreak} consecutive failures\n` +
          `Last: <code>${label}</code>\n` +
          `Reason: <code>${reason}</code>\n\n` +
          `Licence lookups fall back to the database until it returns.`,
        { tag: 'scraper_box' },
      )
      .catch(() => undefined);
  }

  /** One alert per half hour, whatever the kind — enough to notice, not spam. */
  private withinCooldown(): boolean {
    const now = Date.now();
    if (now - this.lastAlertAt < RemoteScraperService.ALERT_COOLDOWN_MS) {
      return false;
    }
    this.lastAlertAt = now;
    return true;
  }
}
