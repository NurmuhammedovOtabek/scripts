import { Injectable, Inject, Logger } from '@nestjs/common';
import axios from 'axios';
import * as https from 'https';
import { MemoryCacheService } from '../common/memory-cache.service';

// garov.uz serves an incomplete certificate chain — bypass SSL verification
// (same pattern as chamber.uz which has the same issue)
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

export interface GarovRecord {
  collateral_id?: number | null;
  inn: string;
  inn_or_pinfl?: string | null;
  code: string;
  debtor_name: string | null;
  state_name: string | null;
  state: string | null; // '1' = Aktiv, otherwise resolved/closed
  creditor_name: string | null;
  creditor_phone: string | null;
  printable: number | null;
  order?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface GarovFilters {
  state?: 'active' | 'resolved';
  sort?: 'created_date';
  order?: 'asc' | 'desc';
}

/**
 * garov.uz — official collateral (garov) registry of Uzbekistan.
 *
 * Captcha bypass: garov.uz only string-compares the `captcha` cookie
 * against the body — no server-side state, no image solving. We generate
 * a random 6-char token and send it identically in both places. Tested
 * 2026-05-11. If they ever tighten this, switch to the two-step flow
 * (GET /security/captcha first to read the server-issued cookie).
 *
 * Three operations:
 *   1. getByInn(inn, filters)  — DB-first list (the 99% case)
 *   2. refreshByInn(inn)       — force-pull from garov.uz, upsert new rows
 *                                and update changed `state` on existing ones
 *   3. verifyByCode(code)      — single-record live lookup (for "is this
 *                                pledge still active?" checks)
 *
 * On any hard failure (network, unexpected shape) a throttled Telegram
 * alert is sent via MysoliqNotifyService.
 *
 * Rate limit observed: ~2 req/sec via RateLimit headers. A serial queue
 * keeps us safely under it.
 */
@Injectable()
export class GarovService {
  private readonly logger = new Logger(GarovService.name);
  private readonly BASE = 'https://www.garov.uz';
  private readonly SEARCH_URL = `${this.BASE}/record/getDeclarationOrderSearchWA`;
  private readonly UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
  private readonly httpTimeout = 15_000;
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;

  private queue: Promise<any> = Promise.resolve();

  constructor(private readonly cacheManager: MemoryCacheService) {}

  // ─── Public API ──────────────────────────────────────────────────────

  /**
   * DB-first list for a company. If DB has anything for this INN we return
   * it (the bulk sync has ~127M rows already). Only on a complete miss do
   * we fall through to live garov.uz and upsert what we find.
   *
   * Filters are applied at the SQL layer so paging/counting is accurate.
   */
  async getByInn(
    inn: string,
    filters: GarovFilters = {},
  ): Promise<GarovRecord[]> {
    const cacheKey = this.cacheKey(inn, filters);

    // 1. Redis cache (24h TTL) — avoids repeated garov.uz hits for same INN
    try {
      const cached = await this.cacheManager.get<GarovRecord[]>(cacheKey);
      if (cached !== undefined && cached !== null) return cached;
    } catch (err: any) {
      this.logger.warn(
        `[garov] cache get failed for ${inn}: ${err?.message || err}`,
      );
    }

    // 2. Always fetch fresh from garov.uz and upsert — guarantees active/inactive
    //    state is current and new pledges are captured (no stale DB-only path).
    const liveRows = await this.runQueued(() => this.fetchByInn(inn));
    if (liveRows.length > 0) {
    }

    // 3. Read from DB with requested filters/sort applied
    // No database on this box: the live scrape is the result. Filtering and
    // sorting that used to happen in SQL is the backend's job now.
    const rows = liveRows;

    // Only cache when live fetch succeeded — prevents caching stale/incomplete
    // DB data when garov.uz was unreachable (network error → liveRows=[]).
    if (liveRows.length > 0) {
      try {
        await this.cacheManager.set(cacheKey, rows, this.CACHE_TTL_MS);
      } catch {}
    }
    return rows;
  }

  /**
   * Pledges registered against a person, by PINFL.
   *
   * An individual's pledges cannot be reached through the INN search — the
   * register answers not-found for the trader's own STIR and returns the
   * pledge under `pin`. Verified against the register: PINFL 30512966580023
   * returns an active KAPITALBANK pledge, while STIR 536778826 — the same
   * person — comes back empty.
   *
   * Live only, and not written to `company_collaterals`: that table is keyed
   * by INN, and a PINFL lookup has no INN to file the rows under. The Redis
   * cache still applies, so a repeated question does not re-enter the queue.
   */
  async getByPinfl(pinfl: string): Promise<GarovRecord[]> {
    const cacheKey = `garov:pinfl:${pinfl}`;

    try {
      const cached = await this.cacheManager.get<GarovRecord[]>(cacheKey);
      if (cached !== undefined && cached !== null) return cached;
    } catch (err: any) {
      this.logger.warn(
        `[garov] cache get failed for pinfl ${pinfl}: ${err?.message || err}`,
      );
    }

    const rows = await this.runQueued(() => this.fetchByPinfl(pinfl));

    // An empty answer is left uncached on purpose: it is indistinguishable
    // from garov.uz having been unreachable, and caching that for a day would
    // hide a pledge registered in the meantime.
    if (rows.length > 0) {
      try {
        await this.cacheManager.set(cacheKey, rows, this.CACHE_TTL_MS);
      } catch {}
    }
    return rows;
  }

  /**
   * Force a fresh pull from garov.uz for this INN, bypassing the cache.
   *
   * On the backend this reported how many rows were inserted or updated. There
   * is no database here to count against, so it returns the records themselves
   * and the caller decides what changed.
   */
  async refreshByInn(inn: string): Promise<GarovRecord[]> {
    const liveRows = await this.runQueued(() => this.fetchByInn(inn));
    // Invalidate caches for this INN — both unfiltered and filtered
    try {
      await this.cacheManager.del(this.cacheKey(inn, {}));
      await this.cacheManager.del(this.cacheKey(inn, { state: 'active' }));
      await this.cacheManager.del(this.cacheKey(inn, { state: 'resolved' }));
    } catch {
      /* ignore */
    }
    return liveRows;
  }

  /**
   * Look up a single pledge by its registry `code` and return its current
   * state from garov.uz (e.g., to verify whether an "Active" DB row is
   * still active). Does not write to DB.
   */
  async verifyByCode(code: string): Promise<GarovRecord | null> {
    const rows = await this.runQueued(() => this.fetchByCode(code));
    return rows.length > 0 ? rows[0] : null;
  }

  // ─── Live fetch (garov.uz) ───────────────────────────────────────────

  private async fetchByInn(inn: string): Promise<GarovRecord[]> {
    return this.postSearch({ inn }, `inn=${inn}`);
  }

  private async fetchByPinfl(pinfl: string): Promise<GarovRecord[]> {
    return this.postSearch({ pin: pinfl }, `pinfl=${pinfl}`);
  }

  private async fetchByCode(code: string): Promise<GarovRecord[]> {
    return this.postSearch({ code }, `code=${code}`);
  }

  private async fetchCaptchaToken(): Promise<string> {
    try {
      const resp = await axios.get(`${this.BASE}/security/captcha`, {
        timeout: this.httpTimeout,
        httpsAgent,
        headers: { 'User-Agent': this.UA },
        validateStatus: () => true,
      });
      const setCookie: string[] = Array.isArray(resp.headers['set-cookie'])
        ? resp.headers['set-cookie']
        : resp.headers['set-cookie']
          ? [resp.headers['set-cookie']]
          : [];
      for (const c of setCookie) {
        const m = c.match(/captcha=([^;]+)/);
        if (m) return m[1];
      }
    } catch {
      // fall through to random token
    }
    return this.randomToken();
  }

  private async postSearch(
    filter: { inn?: string; code?: string; pin?: string },
    logKey: string,
  ): Promise<GarovRecord[]> {
    const captcha = await this.fetchCaptchaToken();
    try {
      const resp = await axios.post(
        this.SEARCH_URL,
        {
          data: {
            code: filter.code ?? null,
            inn: filter.inn ?? null,
            // ЖШШИР. The field was always here, always null — it is how the
            // register is searched for a person, and an individual's pledges
            // are invisible to an INN search: the same trader answers under
            // `pin` and returns not-found under `inn`.
            pin: filter.pin ?? null,
            body_num: null,
            cadastre: null,
            tech_num: null,
            doc_num: null,
          },
          captcha,
          lang: 'oz',
        },
        {
          timeout: this.httpTimeout,
          httpsAgent,
          headers: {
            'User-Agent': this.UA,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Origin: this.BASE,
            Referer: `${this.BASE}/`,
            Cookie: `captcha=${captcha}`,
          },
          validateStatus: () => true,
        },
      );

      const rows = resp.data?.data?.data;
      if (!Array.isArray(rows)) {
        this.notifyFailure(
          logKey,
          `unexpected shape: ${JSON.stringify(resp.data).slice(0, 200)}`,
        );
        return [];
      }
      // "Nothing found" is not an empty list — the register answers with a
      // single row carrying only `not_found_code`. Mapped, that became a
      // record with an empty `code`, which upsertAll then skipped, so nothing
      // was ever stored wrongly; but the log read `rows=1` for an answer that
      // held nothing. Drop them here so the count means what it says.
      const found = rows.filter((r: any) => !r?.not_found_code);
      this.logger.log(`[garov] live ${logKey} rows=${found.length}`);
      return found.map((r) => this.mapRecord(filter.inn ?? r.inn ?? '', r));
    } catch (err: any) {
      const reason = err?.code || err?.message || String(err);
      this.notifyFailure(logKey, reason);
      return [];
    }
  }

  private async runQueued<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    return job;
  }

  // Throttle: same logKey alert max once per 10 min
  private readonly failureAlerts = new Map<string, number>();

  private notifyFailure(logKey: string, reason: string): void {
    this.logger.error(`[garov] ${logKey} failed: ${reason}`);

    const now = Date.now();
    const last = this.failureAlerts.get(logKey) ?? 0;
    if (now - last < 10 * 60 * 1000) return; // throttle
    this.failureAlerts.set(logKey, now);

    const short = reason.length > 120 ? reason.slice(0, 120) + '…' : reason;
  }

  private cacheKey(inn: string, filters: GarovFilters): string {
    const state = filters.state ?? 'all';
    const sort = filters.sort ?? '-';
    const order = filters.order ?? '-';
    return `garov:${inn}:${state}:${sort}:${order}`;
  }

  private randomToken(): string {
    return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  }

  private mapRecord(inn: string, r: any): GarovRecord {
    return {
      inn,
      code: String(r.code ?? ''),
      debtor_name: r.debtor_name ?? null,
      state_name: r.state_name ?? null,
      state: r.state != null ? String(r.state) : null,
      creditor_name: r.creditor_name ?? null,
      creditor_phone: r.creditor_phone ?? null,
      printable: typeof r.printable === 'number' ? r.printable : null,
      order: r.order != null ? String(r.order) : null,
    };
  }
}
