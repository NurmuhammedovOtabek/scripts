import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import axios from 'axios';

/** The open register that copies IT Park's residents list once a day. */
const RESIDENTS_REGISTER = 'itpark_resident';
/** A copy older than this is not an answer: the daily read keeps failing. */
const RESIDENTS_FRESH_DAYS = 3;

@Injectable()
export class ItparkScriptService {
  private readonly logger = new Logger(ItparkScriptService.name);

  constructor(@InjectDataSource('flottDb') private readonly db: DataSource) {}

  /**
   * Fetches the full IT Park residents page once, extracts all INNs, then:
   *   1. UPDATE company_info SET itpark = true  WHERE inn = ANY(itpark_inns)
   *   2. UPDATE company_info SET itpark = false WHERE itpark IS DISTINCT FROM false
   *                                                AND inn != ALL(itpark_inns)
   * Returns counts of how many rows were marked true / reset to false.
   */
  async bulkSyncAll(): Promise<{
    marked: number;
    reset: number;
    innCount: number;
  }> {
    this.logger.log('[itpark-bulk] fetching residents page...');

    const response = await axios.get(
      'https://www.it-park.uz/uz/itpark/residents/itpark-residents',
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
          Accept: 'text/html',
        },
        timeout: 30000,
      },
    );

    const html: string = response.data;

    // Extract INNs from data attributes — same pattern as checkResident().
    // Using attribute-targeted regex avoids matching unrelated 9-digit numbers
    // (CSS ids, JS vars, timestamps) that appear elsewhere in the HTML.
    const inns = new Set<string>();
    const re = /data-val="inn"[^>]*>(\d{9})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null) {
      inns.add(m[1]);
    }
    // Fallback: if page structure changed and attribute pattern finds nothing,
    // try loose word-boundary pattern as a safety net.
    if (inns.size === 0) {
      const fallback = /\b(\d{9})\b/g;
      while ((m = fallback.exec(html)) !== null) inns.add(m[1]);
      if (inns.size > 0) {
        this.logger.warn(
          '[itpark-bulk] fell back to loose regex — page structure may have changed',
        );
      }
    }

    const innArr = [...inns];
    this.logger.log(`[itpark-bulk] ${innArr.length} unique INNs extracted`);

    if (innArr.length === 0) {
      throw new Error(
        'No INNs found on IT Park page — page structure may have changed',
      );
    }

    // 1. Mark IT Park members
    const markResult = await this.db.query(
      `UPDATE public.company_info
          SET itpark = true, updated_at = now()
        WHERE inn = ANY($1::text[])
          AND itpark IS DISTINCT FROM true`,
      [innArr],
    );
    const marked = markResult[1] ?? 0;

    // 2. Reset companies that were previously true but are no longer in the list
    const resetResult = await this.db.query(
      `UPDATE public.company_info
          SET itpark = false, updated_at = now()
        WHERE itpark = true
          AND inn != ALL($1::text[])`,
      [innArr],
    );
    const reset = resetResult[1] ?? 0;

    this.logger.log(`[itpark-bulk] done — marked=${marked} reset=${reset}`);
    return { marked, reset, innCount: innArr.length };
  }

  /**
   * true = resident, false = confirmed not a resident, **null = we could not
   * tell**.
   *
   * The distinction matters because the caller writes this straight into
   * `company_info.itpark`. Returning false when it-park.uz was unreachable
   * used to strip the IT Park mark off every resident whose page happened to
   * be opened during the outage, and record "IT Park: Ha → Yo'q" in their
   * history — a change that never happened. null means "unknown", and the
   * caller keeps whatever the database already holds.
   *
   * Answered from our copy of the residents list (the open register
   * `itpark_resident`, read once a day — user decision 2026-10-15), not
   * it-park.uz: the page is ~5 MB, and every company page opened downloaded
   * it whole.
   */
  async checkResident(inn: string): Promise<boolean | null> {
    return (await this.residency(inn)).resident;
  }

  /**
   * Whether the residents list holds the company, and since when (the day
   * IT Park lists it under). Both null when the list was never read, or not
   * in the last {@link RESIDENTS_FRESH_DAYS} days (the daily read failing):
   * an old copy is not an answer.
   */
  async residency(
    inn: string,
  ): Promise<{ resident: boolean | null; since: string | null }> {
    const unknown = { resident: null, since: null };
    try {
      const rows = await this.db.query(
        `SELECT e.fields->>'registered_on' AS since, e.inn IS NOT NULL AS listed
           FROM public.registry_sources s
           LEFT JOIN public.company_registry_entries e
             ON e.source = s.code AND e.inn = $1 AND e.delisted_at IS NULL
          WHERE s.code = $2
            AND s.last_ok_at > now() - make_interval(days => $3)
          LIMIT 1`,
        [inn, RESIDENTS_REGISTER, RESIDENTS_FRESH_DAYS],
      );
      const row = Array.isArray(rows) ? rows[0] : undefined;
      if (!row) {
        this.logger.warn(
          `it-park: INN=${inn} — residents list not read in the last ${RESIDENTS_FRESH_DAYS} days, left unknown`,
        );
        return unknown;
      }
      return {
        resident: row.listed === true,
        since: row.listed === true ? (row.since ?? null) : null,
      };
    } catch (err) {
      this.logger.warn(
        `it-park: INN=${inn} — residents list could not be read: ${(err as Error).message}`,
      );
      return unknown;
    }
  }
}
