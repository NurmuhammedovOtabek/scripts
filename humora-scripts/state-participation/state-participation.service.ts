import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import axios from 'axios';

export interface StateParticipation {
  inn: string;
  share_percent: number | null; // 0-100, null = not in registry (private company)
  superior_organization: string | null;
}

/**
 * data.egov.uz dataset 6110bec8db32b99538e08167 —
 * "Davlat ishtirokidagi korxonalar ro'yxati"
 *
 * Lookup order:
 *   1. Redis cache (24h)
 *   2. Live data.egov.uz API (POST /apiClient/Main/GetMainData)
 *   3. DB fallback (company_info.state_share_percent)
 *
 * The dataset has ~3000 companies. INNs not present → share=0 (private).
 */
@Injectable()
export class StateParticipationService {
  private readonly logger = new Logger(StateParticipationService.name);
  private readonly GUID_ID = '6110bec8db32b99538e08167';
  private readonly API_URL = `https://data.egov.uz/apiClient/Main/GetMainData?GuidId=${this.GUID_ID}`;
  private readonly CACHE_TTL_MS = 24 * 60 * 60 * 1000;
  private readonly httpTimeout = 15_000;

  constructor(
    @InjectDataSource('flottDb') private readonly remoteDb: DataSource,
    @Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
  ) {}

  /**
   * Fetches the entire "Davlat ishtirokidagi korxonalar" dataset in one
   * request (all ~1852 rows), then bulk-UPDATEs company_info for every
   * matched INN.  Only touches state_share_percent and superior_organization
   * — other columns are not overwritten.
   *
   * Returns { fetched, updated } counts.
   */
  async bulkSyncAll(): Promise<{ fetched: number; updated: number }> {
    this.logger.log('[state-participation-bulk] fetching all records...');

    const resp = await axios.post(
      this.API_URL,
      { guidId: this.GUID_ID, fields: {}, limit: 5000, offset: 0 },
      {
        timeout: 30_000,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        validateStatus: () => true,
      },
    );

    const rows: any[] = resp.data?.result?.data ?? [];
    this.logger.log(
      `[state-participation-bulk] ${rows.length} records received`,
    );

    if (rows.length === 0) {
      throw new Error('data.egov.uz returned 0 rows — API may be down');
    }

    // Parse each row into { inn, share_percent, superior_organization }
    const records: StateParticipation[] = rows
      .map((row) => {
        const cols = row.tableColumn || {};
        const inn = (cols.STIR?.data ?? cols.STIR?.default ?? '').trim();
        if (!inn) return null;
        const share = this.parseNumber(
          cols.davlatulushi?.data ?? cols.davlatulushi?.default,
        );
        const superior = (cols.yuqoritashkilot?.data ??
          cols.yuqoritashkilot?.default ??
          null) as string | null;
        return {
          inn,
          share_percent: share,
          superior_organization: superior?.trim() || null,
        };
      })
      .filter(Boolean) as StateParticipation[];

    if (records.length === 0) {
      throw new Error(
        'Parsed 0 valid records — tableColumn structure may have changed',
      );
    }

    // Build bulk UPDATE via VALUES list
    const tuples: string[] = [];
    const params: any[] = [];
    let p = 1;
    for (const r of records) {
      tuples.push(`($${p++}::text, $${p++}::numeric, $${p++}::text)`);
      params.push(r.inn, r.share_percent, r.superior_organization);
    }

    const result = await this.remoteDb.query(
      `UPDATE public.company_info ci
          SET state_share_percent   = v.share::numeric,
              superior_organization = v.sup,
              updated_at            = now()
         FROM (VALUES ${tuples.join(', ')})
              AS v(inn, share, sup)
        WHERE ci.inn = v.inn`,
      params,
    );

    const updated = result[1] ?? 0;
    this.logger.log(
      `[state-participation-bulk] done — fetched=${records.length} updated=${updated}`,
    );
    return { fetched: records.length, updated };
  }

  async getByInn(inn: string): Promise<StateParticipation> {
    const cacheKey = `state-participation:${inn}`;

    // 1. Cache
    try {
      const cached = await this.cacheManager.get<StateParticipation>(cacheKey);
      if (cached !== undefined && cached !== null) return cached;
    } catch (err: any) {
      this.logger.warn(`cache get failed for ${inn}: ${err?.message || err}`);
    }

    // 2. Live API + DB upsert
    let result: StateParticipation;
    try {
      result = await this.fetchAndStore(inn);
    } catch (err: any) {
      this.logger.warn(
        `live API failed for ${inn}, falling back to DB: ${err?.message || err}`,
      );
      result = await this.queryDb(inn);
    }

    // Cache result (including 0% rows — most companies aren't state-participated)
    try {
      await this.cacheManager.set(cacheKey, result, this.CACHE_TTL_MS);
    } catch (err: any) {
      this.logger.warn(`cache set failed for ${inn}: ${err?.message || err}`);
    }

    return result;
  }

  private async fetchAndStore(inn: string): Promise<StateParticipation> {
    const body = {
      guidId: this.GUID_ID,
      fields: { STIR: inn },
      limit: 1,
      offset: 0,
    };

    const resp = await axios.post(this.API_URL, body, {
      timeout: this.httpTimeout,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      validateStatus: () => true,
    });

    const rows = resp.data?.result?.data;
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;

    let result: StateParticipation;
    if (!row) {
      // Not in state-participation registry — private company
      result = { inn, share_percent: 0, superior_organization: null };
    } else {
      const cols = row.tableColumn || {};
      const sharePercent = this.parseNumber(
        cols.davlatulushi?.data ?? cols.davlatulushi?.default,
      );
      const superior = (cols.yuqoritashkilot?.data ??
        cols.yuqoritashkilot?.default ??
        null) as string | null;
      result = {
        inn,
        share_percent: sharePercent,
        superior_organization: superior?.trim() || null,
      };
    }

    await this.upsert(result);
    this.logger.log(
      `[state-participation] ${inn} share=${result.share_percent}% sup="${result.superior_organization ?? '-'}"`,
    );
    return result;
  }

  /**
   * Update the 2 columns on `company_info`. We only UPDATE — never INSERT —
   * because the parent row is owned by the company-sync flow. If the row
   * doesn't exist yet, we silently skip; the next entity sync will create it
   * and the next state-participation lookup will populate the columns.
   */
  private async upsert(sp: StateParticipation): Promise<void> {
    try {
      await this.remoteDb.query(
        `UPDATE public.company_info
            SET state_share_percent   = $1,
                superior_organization = $2
          WHERE inn = $3`,
        [sp.share_percent, sp.superior_organization, sp.inn],
      );
    } catch (err: any) {
      this.logger.error(
        `[state-participation] DB update failed for ${sp.inn}: ${err?.message ?? err}`,
      );
    }
  }

  private async queryDb(inn: string): Promise<StateParticipation> {
    try {
      const rows = await this.remoteDb.query(
        `SELECT state_share_percent, superior_organization
           FROM public.company_info
          WHERE inn = $1
          LIMIT 1`,
        [inn],
      );
      if (rows && rows.length > 0) {
        const r = rows[0];
        return {
          inn,
          share_percent:
            r.state_share_percent === null
              ? null
              : Number(r.state_share_percent),
          superior_organization: r.superior_organization ?? null,
        };
      }
    } catch (err: any) {
      this.logger.warn(`DB read failed for ${inn}: ${err?.message ?? err}`);
    }
    return { inn, share_percent: null, superior_organization: null };
  }

  private parseNumber(raw: unknown): number | null {
    if (raw == null) return null;
    const n = parseFloat(String(raw).replace(',', '.'));
    return isNaN(n) ? null : n;
  }
}
