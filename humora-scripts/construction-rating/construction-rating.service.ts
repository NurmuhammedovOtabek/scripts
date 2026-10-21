import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import axios from 'axios';
import { DataSource } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';

// type_name — DB'ga yoziladigan ingliz tilidagi turg'un kalitlar.
// API esa o'zining o'zbekcha kalitlarini ishlatadi (umum/yol/mel/loyiha) —
// ulardan TYPE_MAP orqali type ID ga o'tkaziladi.
const TYPE_NAMES: Record<number, string> = {
  0: 'general', // umumqurilish — general construction
  1: 'road', // yo'l — road construction
  2: 'irrigation', // meliorasiya — irrigation
  3: 'design', // loyiha-qidiruv — design / project survey
  4: 'developer', // developer — only per company, from check-inn; no list
};

interface ApiItem {
  inn: string;
  name: string;
  sumbal: number | null;
  rating: string | null;
  viloyat_name: string | null;
  status: number | null;
  logo_url: string | null;
  type: number;
  object_type: number | null;
  show_licence_message: boolean;
  rank: number | null;
}

interface ApiListResponse {
  success: boolean;
  data?: {
    currentPage: number;
    total: number;
    perPage: number;
    data: ApiItem[];
  };
  errors?: Array<{ errorMsg: string; errorCode: number }>;
}

export interface ApiCheckInnResponse {
  success: boolean;
  data?: {
    umum: {
      hasData: boolean;
      name?: string;
      reyting?: string;
      message?: string;
    };
    yol: {
      hasData: boolean;
      name?: string;
      reyting?: string;
      message?: string;
    };
    mel: {
      hasData: boolean;
      name?: string;
      reyting?: string;
      message?: string;
    };
    loyiha: {
      hasData: boolean;
      name?: string;
      reyting?: string;
      message?: string;
    };
    developer: {
      hasData: boolean;
      name?: string;
      reyting?: string;
      message?: string;
    };
  };
  errors?: Array<{ errorMsg: string; errorCode: number }>;
}

export interface ConstructionRatingRow {
  inn: string;
  type: number;
  type_name: string | null;
  name: string | null;
  rating: string | null;
  sumbal: number | null;
  rank: number | null;
  status: number | null;
  viloyat_name: string | null;
  object_type: number | null;
}

/**
 * Construction company rating from reyting.mc.uz.
 *
 * Two endpoints used:
 *  1. List (bulk):  GET /api/v2/category/all?type=0..3&page=N&perPage=N
 *     — paginated list per category, ~22k total companies
 *  2. Check INN:    GET /api/v1/statistic/check-inn/{INN}
 *     — full per-company breakdown including a 5th category ("developer")
 *
 * Sync strategy: bulk-fetch all 4 list types into company_construction_rating.
 * Per-INN check is available via getByInnFresh() but normally we read from DB.
 */
@Injectable()
export class ConstructionRatingService {
  private readonly logger = new Logger(ConstructionRatingService.name);
  private readonly baseV1 = 'https://japi-reyting.mc.uz/api/v1';
  private readonly baseV2 = 'https://japi-reyting.mc.uz/api/v2';
  private readonly perPage = 200;
  private readonly httpTimeout = 20000;
  /** Cache TTL: 20 hours (in milliseconds). */
  private readonly CACHE_TTL_MS = 20 * 60 * 60 * 1000;

  constructor(
    @InjectDataSource('flottDb') private readonly remoteDb: DataSource,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  // ─── DB read with cache + live fallback ──────────────────────────

  /**
   * Returns all categories the given INN is rated in.
   *
   * Lookup order:
   *   1. Redis cache (20h TTL) — hot path; skips both API and DB
   *   2. Live API (check-inn) — ALWAYS called when cache misses (rating
   *      can change daily; we want fresh data each cache window).
   *      Result is upserted into DB so periodic syncs aren't lost,
   *      and the merged DB row is returned (preserving sumbal/rank
   *      from the bulk-sync list endpoint).
   *   3. DB fallback — only used if live API fails.
   *
   * Empty results are cached too, to prevent repeated API hits for
   * companies that simply aren't in the rating system.
   */
  async getByInn(inn: string): Promise<ConstructionRatingRow[]> {
    const cacheKey = `construction-rating:${inn}`;

    // 1. Cache hit — fastest path
    try {
      const cached =
        await this.cacheManager.get<ConstructionRatingRow[]>(cacheKey);
      if (cached !== undefined && cached !== null) return cached;
    } catch (err: any) {
      this.logger.warn(`cache get failed for ${inn}: ${err?.message || err}`);
    }

    // 2. Always live-fetch on cache miss (rating may have changed since last sync).
    //    Live upsert only updates name+rating — sumbal/rank/viloyat from sync are preserved.
    let rows: ConstructionRatingRow[] = [];
    let liveOk = false;
    try {
      rows = await this.fetchAndStoreLive(inn);
      liveOk = true;
    } catch (err: any) {
      this.logger.warn(
        `live API failed for ${inn}, falling back to DB: ${err?.message || err}`,
      );
    }

    // 3. DB fallback when live API failed
    if (!liveOk) {
      rows = await this.queryDbByInn(inn);
    }

    // Cache the result (including empty array) for 20h
    try {
      await this.cacheManager.set(cacheKey, rows, this.CACHE_TTL_MS);
    } catch (err: any) {
      this.logger.warn(`cache set failed for ${inn}: ${err?.message || err}`);
    }

    return rows;
  }

  private async queryDbByInn(inn: string): Promise<ConstructionRatingRow[]> {
    return this.remoteDb.query(
      `SELECT inn, type, type_name, name, rating, sumbal, rank, status,
              viloyat_name, object_type
         FROM public.company_construction_rating
        WHERE inn = $1
        ORDER BY type ASC`,
      [inn],
    );
  }

  /**
   * Live fetch from check-inn API, parse, upsert ONLY name+rating
   * (preserving sumbal/rank/viloyat from previous bulk syncs),
   * then re-read from DB so the response includes the full merged row.
   *
   * Returns array (one row per rated category), or [] if not rated.
   * Throws on network/HTTP failure so caller can fall back to DB.
   */
  private async fetchAndStoreLive(
    inn: string,
  ): Promise<ConstructionRatingRow[]> {
    const apiResp = await this.getByInnFresh(inn);
    if (apiResp == null) {
      throw new Error('check-inn returned null');
    }
    // success=false is a normal "not rated" response, not an error
    if (!apiResp.success || !apiResp.data) return [];

    const TYPE_MAP: Record<string, number> = {
      umum: 0,
      yol: 1,
      mel: 2,
      loyiha: 3,
      developer: 4,
    };
    let savedCount = 0;

    for (const [key, val] of Object.entries(apiResp.data)) {
      if (!(key in TYPE_MAP)) continue; // a category we do not know
      if (!val?.hasData) continue;

      const type = TYPE_MAP[key];
      try {
        await this.upsertFromLive({
          inn,
          type,
          name: val.name || null,
          rating: val.reyting || null,
          rawCategory: val,
        });
        savedCount++;
      } catch (err: any) {
        this.logger.warn(
          `live upsert failed inn=${inn} type=${type}: ${err?.message || err}`,
        );
      }
    }

    if (savedCount > 0) {
      this.logger.log(
        `[ConstructionRating] live ${inn} — refreshed ${savedCount} categories`,
      );
    }

    // Re-read from DB: returns full rows including sumbal/rank/viloyat
    // preserved from earlier bulk-sync runs.
    return this.queryDbByInn(inn);
  }

  /**
   * Upsert only the fields available from the check-inn API
   * (name + rating). Other columns (sumbal, rank, viloyat_name,
   * object_type, status) are NOT touched, so values from the
   * bulk list-endpoint sync remain intact.
   */
  private async upsertFromLive(payload: {
    inn: string;
    type: number;
    name: string | null;
    rating: string | null;
    rawCategory: unknown;
  }): Promise<void> {
    await this.remoteDb.query(
      `INSERT INTO public.company_construction_rating
        (inn, type, type_name, name, rating, raw, fetched_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now(), now(), now())
       ON CONFLICT (inn, type) DO UPDATE SET
         name       = EXCLUDED.name,
         rating     = EXCLUDED.rating,
         type_name  = EXCLUDED.type_name,
         raw        = COALESCE(public.company_construction_rating.raw, '{}'::jsonb)
                      || jsonb_build_object('check_inn', EXCLUDED.raw),
         fetched_at = now(),
         updated_at = now()`,
      [
        payload.inn,
        payload.type,
        TYPE_NAMES[payload.type] || null,
        payload.name,
        payload.rating,
        JSON.stringify(payload.rawCategory ?? {}),
      ],
    );
  }

  // ─── API fetch ───────────────────────────────────────────────────

  /** Live per-INN lookup against /api/v1/statistic/check-inn (no DB write). */
  async getByInnFresh(inn: string): Promise<ApiCheckInnResponse | null> {
    try {
      const res = await axios.get<ApiCheckInnResponse>(
        `${this.baseV1}/statistic/check-inn/${inn}`,
        {
          timeout: this.httpTimeout,
          headers: { Accept: 'application/json' },
          validateStatus: () => true,
        },
      );
      return res.data || null;
    } catch (err: any) {
      this.logger.warn(`check-inn ${inn} failed: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * Sync all 4 categories (umum / yol / mel / loyiha) into DB.
   * Iterates pages until total is reached. Upserts per row.
   *
   * Returns counts per category.
   */
  async syncAll(): Promise<{
    saved: number;
    perType: Record<number, number>;
    failed: number;
  }> {
    const perType: Record<number, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
    let totalSaved = 0;
    let totalFailed = 0;

    for (const type of [0, 1, 2, 3]) {
      const result = await this.syncType(type);
      perType[type] = result.saved;
      totalSaved += result.saved;
      totalFailed += result.failed;
      this.logger.log(
        `[ConstructionRating] type=${type} (${TYPE_NAMES[type]}) saved=${result.saved} failed=${result.failed}`,
      );
    }

    this.logger.log(
      `[ConstructionRating] sync complete — saved=${totalSaved} failed=${totalFailed}`,
    );
    return { saved: totalSaved, perType, failed: totalFailed };
  }

  /** Sync a single category type. */
  async syncType(
    type: number,
  ): Promise<{ saved: number; failed: number; total: number }> {
    let page = 1;
    let saved = 0;
    let failed = 0;
    let grandTotal = 0;

    while (true) {
      const url = `${this.baseV2}/category/all?type=${type}&page=${page}&perPage=${this.perPage}`;
      let response: { data?: ApiListResponse } | null = null;
      try {
        response = await axios.get<ApiListResponse>(url, {
          timeout: this.httpTimeout,
          headers: { Accept: 'application/json' },
          validateStatus: () => true,
        });
      } catch (err: any) {
        this.logger.error(
          `type=${type} page=${page} HTTP error: ${err?.message || err}`,
        );
        failed++;
        // Wait briefly and retry once
        await new Promise((r) => setTimeout(r, 2000));
        try {
          response = await axios.get<ApiListResponse>(url, {
            timeout: this.httpTimeout,
            headers: { Accept: 'application/json' },
            validateStatus: () => true,
          });
        } catch (err2: any) {
          this.logger.error(
            `type=${type} page=${page} retry error: ${err2?.message || err2}`,
          );
          break;
        }
      }

      const result = response?.data;
      if (!result?.success) {
        this.logger.warn(
          `type=${type} page=${page} not success: ${JSON.stringify(result?.errors || [])}`,
        );
        break;
      }

      const items = result.data?.data || [];
      grandTotal = result.data?.total || 0;

      if (items.length === 0) break;

      for (const item of items) {
        try {
          await this.upsert(item);
          saved++;
        } catch (err: any) {
          this.logger.warn(
            `upsert failed inn=${item.inn} type=${item.type}: ${err?.message || err}`,
          );
          failed++;
        }
      }

      // pagination check
      if (page * this.perPage >= grandTotal) break;
      page++;
    }

    return { saved, failed, total: grandTotal };
  }

  private async upsert(item: ApiItem): Promise<void> {
    if (!item?.inn || item.type == null) return;

    await this.remoteDb.query(
      `INSERT INTO public.company_construction_rating
        (inn, type, type_name, name, rating, sumbal, rank, status,
         viloyat_name, object_type, raw, fetched_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now(), now())
       ON CONFLICT (inn, type) DO UPDATE SET
         type_name    = EXCLUDED.type_name,
         name         = EXCLUDED.name,
         rating       = EXCLUDED.rating,
         sumbal       = EXCLUDED.sumbal,
         rank         = EXCLUDED.rank,
         status       = EXCLUDED.status,
         viloyat_name = EXCLUDED.viloyat_name,
         object_type  = EXCLUDED.object_type,
         raw          = EXCLUDED.raw,
         fetched_at   = now(),
         updated_at   = now()`,
      [
        item.inn,
        item.type,
        TYPE_NAMES[item.type] || null,
        item.name || null,
        item.rating || null,
        item.sumbal ?? null,
        item.rank ?? null,
        item.status ?? null,
        item.viloyat_name || null,
        item.object_type ?? null,
        JSON.stringify(item),
      ],
    );
  }
}
