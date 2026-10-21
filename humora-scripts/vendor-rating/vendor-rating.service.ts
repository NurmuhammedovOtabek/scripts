import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import axios from 'axios';
import { DataSource } from 'typeorm';

/** One supplier as the UZEX rating list gives it. */
interface UzexVendor {
  year: number | null;
  month: number | null;
  vendor_name: string | null;
  vendor_inn: string | null;
  region_name: string | null;
  total_rate: number | null;
  rate_range: number | null;
  place_range: number | null;
  rn: number | null;
  total_count: number | null;
}

/** The list comes back grouped; every group seen so far is "A". */
interface UzexRatingGroup {
  category: string | null;
  vendors: UzexVendor[] | null;
}

/** A stored row, as read back for one company. */
export interface StoredVendorRating {
  total_rate: number | string | null;
  place_range: number | null;
  rn: number | null;
  total_count: number | null;
  year: number | null;
  month: number | null;
}

/** The month's score and where it puts the company among all suppliers. */
export interface VendorRating {
  /** The source's own score, from 0 to 1. */
  score: number;
  /** Place by score; suppliers with the same score share a place. */
  place: number | null;
  /** Position in the full list. */
  rank: number | null;
  /** How many suppliers the month's list rates. */
  total: number | null;
  /** The month the scoring is for, YYYY-MM. */
  period: string | null;
}

function periodOf(
  year: number | null | undefined,
  month: number | null | undefined,
): string | null {
  return year && month ? `${year}-${String(month).padStart(2, '0')}` : null;
}

/**
 * A stored row as a reader gets it. Shared by the site route and the partner
 * profile, so the two cannot describe the same rating differently.
 */
export function toVendorRating(
  row: StoredVendorRating | null | undefined,
): VendorRating | null {
  if (!row || row.total_rate === null || row.total_rate === undefined) {
    return null;
  }
  const int = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);
  return {
    score: Number(row.total_rate),
    place: int(row.place_range),
    rank: int(row.rn),
    total: int(row.total_count),
    period: periodOf(row.year, row.month),
  };
}

/**
 * The public procurement supplier scoring UZEX publishes on xarid.uzex.uz.
 *
 * The source scores every supplier once a month and serves the whole list,
 * paged by position; it has no lookup by INN. So the list is copied in full
 * and company pages read the copy, the way construction ratings are handled.
 */
@Injectable()
export class VendorRatingService {
  private readonly logger = new Logger(VendorRatingService.name);
  private readonly URL =
    'https://xarid-api-trade.uzex.uz/Common/GetVendorsRatings';
  /** Rows per request. The source serves 1,000 without complaint. */
  private readonly PAGE = 1000;

  constructor(@InjectDataSource('flottDb') private readonly db: DataSource) {}

  /** The latest month's rating for one company, or null if it is not rated. */
  async getLatestByInn(inn: string): Promise<VendorRating | null> {
    const rows: StoredVendorRating[] = await this.db.query(
      `SELECT total_rate, place_range, rn, total_count, year, month
         FROM public.company_vendor_ratings
        WHERE inn = $1
        ORDER BY year DESC, month DESC
        LIMIT 1`,
      [inn],
    );
    return toVendorRating(rows[0]);
  }

  /**
   * Copies the whole current list. Pages until the source's own count is
   * reached, or until a page comes back empty, whichever comes first.
   */
  async syncAll(): Promise<{
    saved: number;
    total: number | null;
    period: string | null;
  }> {
    let from = 1;
    let total: number | null = null;
    let period: string | null = null;
    let saved = 0;

    for (;;) {
      const vendors = await this.fetchPage(from, from + this.PAGE - 1);
      if (vendors.length === 0) break;

      total ??= vendors[0].total_count ?? null;
      period ??= periodOf(vendors[0].year, vendors[0].month);
      saved += await this.savePage(vendors);

      from += this.PAGE;
      if (total !== null && from > total) break;
    }

    this.logger.log(
      `[vendor-rating] saved ${saved} of ${total ?? '?'} for ${period ?? '?'}`,
    );
    return { saved, total, period };
  }

  /** `To` is inclusive: From 1, To 1000 is a thousand rows. */
  private async fetchPage(from: number, to: number): Promise<UzexVendor[]> {
    const res = await axios.post<UzexRatingGroup[]>(
      this.URL,
      { From: from, To: to },
      {
        timeout: 60_000,
        // The same headers the auction client sends to this host. Without a
        // browser User-Agent the rating route answers 403 to a server.
        headers: {
          'Content-Type': 'application/json',
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
          Origin: 'https://xarid.uzex.uz',
          Referer: 'https://xarid.uzex.uz/',
        },
      },
    );
    const groups = Array.isArray(res.data) ? res.data : [];
    return groups.flatMap((g) => (Array.isArray(g?.vendors) ? g.vendors : []));
  }

  private async savePage(vendors: UzexVendor[]): Promise<number> {
    // One row per company per month. A page naming the same INN twice would
    // have the upsert touch one row twice, which Postgres refuses outright.
    const byInn = new Map<string, UzexVendor>();
    for (const v of vendors) {
      const inn = v.vendor_inn?.trim();
      if (inn && v.year && v.month && !byInn.has(inn)) byInn.set(inn, v);
    }
    const rows = [...byInn.entries()];
    if (rows.length === 0) return 0;

    await this.db.query(
      `INSERT INTO public.company_vendor_ratings
         (inn, year, month, vendor_name, region_name, total_rate, rate_range,
          place_range, rn, total_count, fetched_at)
       SELECT u.inn, u.year, u.month, u.vendor_name, u.region_name,
              u.total_rate, u.rate_range, u.place_range, u.rn, u.total_count,
              now()
         FROM unnest($1::text[], $2::int[], $3::int[], $4::text[], $5::text[],
                     $6::numeric[], $7::numeric[], $8::int[], $9::int[],
                     $10::int[])
           AS u(inn, year, month, vendor_name, region_name, total_rate,
                rate_range, place_range, rn, total_count)
       ON CONFLICT (inn, year, month) DO UPDATE SET
         vendor_name = EXCLUDED.vendor_name,
         region_name = EXCLUDED.region_name,
         total_rate  = EXCLUDED.total_rate,
         rate_range  = EXCLUDED.rate_range,
         place_range = EXCLUDED.place_range,
         rn          = EXCLUDED.rn,
         total_count = EXCLUDED.total_count,
         fetched_at  = now()`,
      [
        rows.map(([inn]) => inn),
        rows.map(([, v]) => v.year),
        rows.map(([, v]) => v.month),
        rows.map(([, v]) => v.vendor_name),
        rows.map(([, v]) => v.region_name),
        rows.map(([, v]) => v.total_rate),
        rows.map(([, v]) => v.rate_range),
        rows.map(([, v]) => v.place_range),
        rows.map(([, v]) => v.rn),
        rows.map(([, v]) => v.total_count),
      ],
    );
    return rows.length;
  }
}
