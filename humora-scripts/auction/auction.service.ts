import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { sourceTimeIso, tashkentDay } from '../../common/tashkent-time';

/**
 * One auction deal, merged from whichever endpoint produced it.
 *
 * Every field is nullable because the two endpoints carry different halves:
 * the thin one has `cost`/`status`/`date_ini` and five years of them, the rich
 * one has the treasury columns and the lot detail but only the last eight
 * months.
 */
export interface AuctionDealFields {
  deal_id: number;
  lot_id: number | null;
  lot_display_no: string | null;

  customer_inn: string | null;
  customer_name: string | null;
  customer_region: string | null;
  provider_inn: string | null;
  provider_name: string | null;

  deal_date: string | null;
  lot_start_date: string | null;
  lot_end_date: string | null;
  deal_cost: number | null;
  currency_name: string | null;
  type_name: string | null;
  category_name: string | null;
  pcp_count: number | null;
  is_budget: boolean | null;
  kazna_status_id: number | null;
  kazna_status: string | null;
  kazna_payment_status: string | null;
  kazna_created_date: string | null;

  date_ini: string | null;
  cost: number | null;
  start_cost: number | null;
  status: string | null;
  region_name: string | null;
  district_name: string | null;
}

/** The thin endpoint pages freely; the rich one does not. */
export const AUCTION_DEALS_PAGE = 500;
export const AUCTION_COMPLETED_PAGE = 16;

/**
 * Reading auction deals out of xarid.uzex.uz.
 *
 * Four things about this API are not guessable and each cost a while:
 *
 * - **A `User-Agent` is required.** Without one every route answers
 *   `500 "Missing User-Agent header"`, which reads like the host is down.
 * - **The company filter does not work.** `provider_tin` is accepted and
 *   ignored — checked with a STIR that is certainly in the data, which came
 *   back alongside seven others. This is why the catalogue is mirrored into
 *   our own table instead of being queried per company.
 * - **`GetCompletedDeals` ignores `to`** and always returns 16 rows, so its
 *   page size is fixed and `from` is the only lever. `GetDeals` honours `to`
 *   and will hand over 500 at a time.
 * - **The date filter wants `dd.MM.yyyy HH:mm`.** An ISO date is rejected
 *   with a .NET parse error, and a date with no time is rejected the same
 *   way. Only `GetCompletedDeals` supports it.
 *
 * Both endpoints are ordered newest-first, which is what lets the nightly
 * pass stop as soon as it recognises a deal.
 */
@Injectable()
export class AuctionScriptService {
  private readonly logger = new Logger(AuctionScriptService.name);
  private readonly BASE_URL = 'https://xarid-api-auction.uzex.uz';

  /**
   * The headers the host insists on.
   *
   * `User-Agent` is not optional here, and `Origin`/`Referer` match the site
   * the API belongs to — sent because that is the request it expects to see,
   * not because it currently refuses without them.
   */
  private get headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'User-Agent':
        process.env.AUCTION_USER_AGENT ||
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
      Origin: 'https://xarid.uzex.uz',
      Referer: 'https://xarid.uzex.uz/',
    };
  }

  /**
   * `dd.MM.yyyy HH:mm` — the only shape the date filter accepts — on the
   * Tashkent calendar, which is uzex's. The process's own calendar (UTC on
   * production) put the window's edge a day early for five hours every night.
   */
  static formatDate(d: Date, endOfDay = false): string {
    const [y, m, day] = (tashkentDay(d) as string).split('-');
    const time = endOfDay ? '23:59' : '00:00';
    return `${day}.${m}.${y} ${time}`;
  }

  /**
   * A page of the thin endpoint — five years of deals, 500 at a time.
   *
   * `from` and `to` are inclusive row offsets; stepping by the page size
   * leaves no gap and no overlap (checked across consecutive pages).
   */
  async fetchDeals(
    from: number,
    count = AUCTION_DEALS_PAGE,
  ): Promise<AuctionDealFields[]> {
    const rows = await this.post('/Common/GetDeals', {
      region_ids: [],
      from,
      to: from + count - 1,
    });
    return rows.map((r) => this.mapThin(r));
  }

  /** How many the thin endpoint holds in total. */
  async countDeals(): Promise<number> {
    const [first] = await this.post('/Common/GetDeals', {
      region_ids: [],
      from: 1,
      to: 1,
    });
    return Number(first?.total_count) || 0;
  }

  /**
   * A page of the rich endpoint, optionally narrowed to a date range.
   *
   * The page is always 16 rows whatever `to` says, so only `from` moves.
   */
  async fetchCompleted(
    from: number,
    range?: { from: Date; to: Date },
  ): Promise<AuctionDealFields[]> {
    const body: Record<string, unknown> = {
      region_ids: [],
      from,
      to: from + AUCTION_COMPLETED_PAGE - 1,
    };
    if (range) {
      body.date_from = AuctionScriptService.formatDate(range.from);
      body.date_to = AuctionScriptService.formatDate(range.to, true);
    }
    const rows = await this.post('/Common/GetCompletedDeals', body);
    return rows.map((r) => this.mapRich(r));
  }

  /** How many the rich endpoint holds, for a range or altogether. */
  async countCompleted(range?: { from: Date; to: Date }): Promise<number> {
    const body: Record<string, unknown> = { region_ids: [], from: 1, to: 1 };
    if (range) {
      body.date_from = AuctionScriptService.formatDate(range.from);
      body.date_to = AuctionScriptService.formatDate(range.to, true);
    }
    const [first] = await this.post('/Common/GetCompletedDeals', body);
    return Number(first?.total_count) || 0;
  }

  private async post(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<any[]> {
    const response = await axios.post(`${this.BASE_URL}${endpoint}`, body, {
      headers: this.headers,
      timeout: 30000,
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  /** `GetDeals` — the long, thin history. */
  private mapThin(raw: any): AuctionDealFields {
    return {
      ...this.empty(),
      deal_id: num(raw.id) ?? 0,
      lot_id: num(raw.lot_id),
      customer_inn: str(raw.customer_inn),
      customer_name: str(raw.customer_name),
      provider_inn: str(raw.provider_inn),
      // `prvider_name` upstream — the typo is theirs, and reading the
      // corrected spelling would silently yield null on every row.
      provider_name: str(raw.prvider_name ?? raw.provider_name),
      date_ini: sourceTimeIso(raw.date_ini),
      cost: num(raw.cost),
      start_cost: num(raw.start_cost),
      status: str(raw.status),
      region_name: str(raw.region_name),
      district_name: str(raw.district_name),
    };
  }

  /** `GetCompletedDeals` — the recent, detailed months. */
  private mapRich(raw: any): AuctionDealFields {
    return {
      ...this.empty(),
      deal_id: num(raw.deal_id) ?? 0,
      lot_id: num(raw.lot_id),
      lot_display_no: str(raw.lot_display_no),
      customer_inn: str(raw.customer_inn),
      customer_name: str(raw.customer_name),
      customer_region: str(raw.customer_region),
      provider_inn: str(raw.provider_inn),
      provider_name: str(raw.provider_name),
      deal_date: sourceTimeIso(raw.deal_date),
      lot_start_date: sourceTimeIso(raw.lot_start_date),
      lot_end_date: sourceTimeIso(raw.lot_end_date),
      deal_cost: num(raw.deal_cost),
      start_cost: num(raw.start_cost),
      currency_name: str(raw.currency_name),
      type_name: str(raw.type_name),
      category_name: str(raw.category_name),
      pcp_count: num(raw.pcp_count),
      is_budget:
        raw.is_budget === null || raw.is_budget === undefined
          ? null
          : Boolean(raw.is_budget),
      kazna_status_id: num(raw.kazna_status_id),
      kazna_status: str(raw.kazna_status),
      kazna_payment_status: str(raw.kazna_payment_status),
      kazna_created_date: sourceTimeIso(raw.kazna_created_date),
    };
  }

  /** Every column absent, so a mapper only names what its endpoint sends. */
  private empty(): AuctionDealFields {
    return {
      deal_id: 0,
      lot_id: null,
      lot_display_no: null,
      customer_inn: null,
      customer_name: null,
      customer_region: null,
      provider_inn: null,
      provider_name: null,
      deal_date: null,
      lot_start_date: null,
      lot_end_date: null,
      deal_cost: null,
      currency_name: null,
      type_name: null,
      category_name: null,
      pcp_count: null,
      is_budget: null,
      kazna_status_id: null,
      kazna_status: null,
      kazna_payment_status: null,
      kazna_created_date: null,
      date_ini: null,
      cost: null,
      start_cost: null,
      status: null,
      region_name: null,
      district_name: null,
    };
  }
}

/** A number, or null — never `NaN`, and never `0` standing in for "absent". */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** A trimmed string, or null for the empty ones the API sends freely. */
function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}
