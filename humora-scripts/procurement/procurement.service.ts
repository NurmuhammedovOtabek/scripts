import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { parseSourceDay, sourceTimeIso } from '../../common/tashkent-time';

export interface ProcurementDealFields {
  deal_id: number;
  display_no: string;
  deal_date: string | null;
  start_cost: number | null;
  deal_cost: number | null;
  currency_name: string | null;
  participants_count: number | null;
  customer_name: string;
  customer_inn: string;
  provider_name: string;
  provider_inn: string;
  deal_status_name: string | null;
  category_name: string | null;

  // Everything below arrives on the same response and used to be discarded.
  /** The trade this deal came out of — the link back to the lot. */
  trade_id: number | null;
  customer_type_name: string | null;
  proposal_status_name: string | null;
  /** The contract signed off the back of the deal, and how it was settled. */
  deal_contract_date: string | null;
  deal_contract_status_name: string | null;
  deal_contract_kazna_status_name: string | null;
  deal_contract_kazna_status_id: number | null;
  /** Procurement policy: was the winner a local manufacturer. */
  is_local_manufacturs: boolean | null;
  beneficiary: string | null;
  founder: string | null;
  /** The contract document itself. Named `sizes` upstream, for one file. */
  contract_file_name: string | null;
  contract_file_path: string | null;
  contract_file_ext: string | null;
  contract_file_size: number | null;
  contract_file_date: string | null;
  /** The additional protocol, when one was drawn up. */
  protocol_file_name: string | null;
  protocol_file_path: string | null;
  protocol_file_ext: string | null;
  /** Kilobytes — the protocol's size is reported in KB, the contract's in bytes. */
  protocol_file_size_kb: number | null;
  protocol_file_date: string | null;
}

export interface ProcurementTradeFields {
  id: number;
  display_no: string;
  name: string;
  start_date: string | null;
  end_date: string | null;
  cost: number | null;
  seller_name: string;
  seller_tin: string;
  region_name: string | null;
  district_name: string | null;
  currency_name: string | null;
  category_name: string | null;
  /** Deadline for asking the customer to clarify the lot. */
  clarific_date: string | null;
  seller_id: number | null;
}

/**
 * A lot that was put out and came to nothing.
 *
 * Only a customer — there is no provider, because nobody won.
 */
export interface NotDealedLotFields {
  trade_id: number | null;
  display_no: string;
  start_date: string | null;
  end_date: string | null;
  category_name: string | null;
  start_cost: number | null;
  participants_count: number | null;
  customer_name: string | null;
  customer_inn: string | null;
  is_local_manufacturs: boolean | null;
  status_id: number | null;
  status_name: string | null;
}

/**
 * "Прямые закупки" — direct (non-tender) procurement contracts.
 * A company can appear on either side: `customer` (buys) or `provider` (sells).
 */
export interface DirectPurchaseFields {
  purchase_id: number;
  display_id: string;
  contract_num: string | null;
  contract_date: string | null;
  contract_sum: number | null;
  currency_name: string | null;
  category_name: string | null;
  typ_direct_purchase_name: string | null;
  decree_name: string | null;
  customer_name: string | null;
  customer_inn: string | null;
  customer_type: string | null;
  provider_name: string | null;
  provider_inn: string | null;
  status_name: string | null;
  date_ini: string | null;
  has_discussion_protocol: number | null;
  messages_count: number | null;
}

@Injectable()
export class ProcurementScriptService {
  private readonly logger = new Logger(ProcurementScriptService.name);
  private readonly BASE_URL = 'https://apietender.uzex.uz/api/common';
  private readonly DIRECT_URL = 'https://xarid-api-purchase.uzex.uz';

  /** DealsList dan total_count olish (buyurtmachi sifatida) */
  async getDealsTotalCount(inn: string): Promise<number> {
    const data = await this.postApi('DealsList', {
      TypeId: 1,
      From: 1,
      To: 2,
      System_Id: 0,
      CustomerTin: inn,
    });
    return data[0]?.total_count || 0;
  }

  /** DealsList dan total_count olish (yetkazib beruvchi sifatida) */
  async getDealsTotalCountAsProvider(inn: string): Promise<number> {
    const data = await this.postApi('DealsList', {
      TypeId: 1,
      From: 1,
      To: 2,
      System_Id: 0,
      ProviderTin: inn,
    });
    return data[0]?.total_count || 0;
  }

  /**
   * The API's `To` is exclusive — `From: 1, To: 3` returns two rows, and
   * `From: 1, To: 1` returns none. Every range here is built as
   * `To = From + howMany` for that reason; `- 1` silently dropped the last row
   * of every page and the whole of a single-row page.
   */
  private readonly TRADE_PAGE_SIZE = 100;

  /** DealsList dan yangi deallarni olish (buyurtmachi sifatida) */
  async fetchDeals(
    inn: string,
    from: number,
    count: number,
  ): Promise<ProcurementDealFields[]> {
    this.logger.log(
      `etender DealsList customer: INN=${inn}, from=${from}, count=${count}`,
    );
    const data = await this.postApi('DealsList', {
      TypeId: 1,
      From: from,
      To: from + count,
      System_Id: 0,
      CustomerTin: inn,
    });
    return data.map((item: any) => this.mapDeal(item));
  }

  /** DealsList dan yangi deallarni olish (yetkazib beruvchi sifatida) */
  async fetchDealsAsProvider(
    inn: string,
    from: number,
    count: number,
  ): Promise<ProcurementDealFields[]> {
    this.logger.log(
      `etender DealsList provider: INN=${inn}, from=${from}, count=${count}`,
    );
    const data = await this.postApi('DealsList', {
      TypeId: 1,
      From: from,
      To: from + count,
      System_Id: 0,
      ProviderTin: inn,
    });
    return data.map((item: any) => this.mapDeal(item));
  }

  /**
   * This company's deals on one lot.
   *
   * For asking again about deals already held, whose contract or protocol is
   * attached upstream after the deal. `Keyword` finds the lot, and the STIR
   * narrows it to this company's side — which is also what makes it fast:
   * ~0.15s with the STIR against ~0.7s without. A lot can hold more than one
   * deal, so every row is returned. `To` is exclusive on `DealsList`, so 11
   * asks for ten.
   */
  async fetchDealsOfLot(
    inn: string,
    displayNo: string,
    side: 'customer' | 'provider',
  ): Promise<ProcurementDealFields[]> {
    this.logger.log(
      `etender DealsList lot: INN=${inn}, ${side}, lot=${displayNo}`,
    );
    const data = await this.postApi('DealsList', {
      TypeId: 1,
      From: 1,
      To: 11,
      System_Id: 0,
      Keyword: displayNo,
      ...(side === 'customer' ? { CustomerTin: inn } : { ProviderTin: inn }),
    });
    return data.map((item: any) => this.mapDeal(item));
  }

  /**
   * One page of a company's live lots.
   *
   * `To` is **inclusive** here, unlike `DealsList` — checked against the
   * source: `From: 1, To: 3` returns three rows on `TradeList` and
   * `NotDealedList`, and two on `DealsList`. The old call asked for
   * `TRADE_PAGE_SIZE + 1` believing it exclusive, so it read 101 rows and
   * stopped: a company with more live lots than that had the rest silently
   * dropped.
   */
  async fetchTrades(
    inn: string,
    from = 1,
    count = this.TRADE_PAGE_SIZE,
  ): Promise<ProcurementTradeFields[]> {
    this.logger.log(`etender TradeList: INN=${inn}, from=${from}, ${count}`);
    const data = await this.postApi('TradeList', {
      TypeId: 1,
      From: from,
      To: from + count - 1,
      System_Id: 0,
      CustomerTin: inn,
    });
    return data.map((item: any) => this.mapTrade(item));
  }

  /** How many live lots this company has. */
  async getTradesTotalCount(inn: string): Promise<number> {
    const data = await this.postApi('TradeList', {
      TypeId: 1,
      From: 1,
      To: 1,
      System_Id: 0,
      CustomerTin: inn,
    });
    return Number(data[0]?.total_count) || 0;
  }

  // ─── Direct Purchases (Прямые закупки) ────────────────────────────────

  /**
   * Fetch a page of direct-purchase contracts where the given INN appears
   * as either customer (`role: 'customer'`) or provider (`role: 'provider'`).
   *
   * The range is its own thing again: `from: 1, to: 5` returns **six** rows,
   * `from: 5, to: 10` returns seven, `from: 1, to: 277` returns 278. So this
   * endpoint answers `to - from + 2` rows, capped at the total — measured on
   * 203195074, which has 278 as customer. Asking for `to: total` returns the
   * whole list, which is what the caller does rather than paging: the order
   * is not stable between requests (`from: 1, to: 5` and `from: 1, to: 277`
   * start on different rows), so a paged read could miss rows outright.
   */
  async fetchDirectPurchases(
    inn: string,
    role: 'customer' | 'provider',
    from = 1,
    to = 100,
  ): Promise<DirectPurchaseFields[]> {
    this.logger.log(
      `etender DirectPurchases: INN=${inn} role=${role} from=${from} to=${to}`,
    );
    const data = await this.postDirect(inn, role, from, to);
    return data.map((item: any) => this.mapDirectPurchase(item));
  }

  /** One request, before anything is made of the rows. */
  private async postDirect(
    inn: string,
    role: 'customer' | 'provider',
    from: number,
    to: number,
  ): Promise<any[]> {
    const body = {
      region_ids: [],
      Is_On_Discussion: 0,
      from,
      to,
      provider_tin: role === 'provider' ? inn : '',
      tin: role === 'customer' ? inn : '',
    };

    const response = await axios.post(
      `${this.DIRECT_URL}/Common/GetDirectPurchases`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://xarid.uzex.uz',
          Referer: 'https://xarid.uzex.uz/',
        },
        timeout: 15000,
      },
    );
    return Array.isArray(response.data) ? response.data : [];
  }

  /**
   * How many direct purchases this company has under that role.
   *
   * **Read from the raw row, not from a mapped one.** `mapDirectPurchase`
   * keeps the eighteen fields the table stores and `total_count` is not among
   * them, so reading it off the mapper's output was always `undefined` — and
   * the `?? page.length` beside it turned that into "three", the size of the
   * probe. Nothing noticed while the caller asked for rows 1..500 regardless;
   * the moment it started trusting this number, a company with 278 purchases
   * synced eight of them.
   */
  async getDirectPurchasesTotalCount(
    inn: string,
    role: 'customer' | 'provider',
  ): Promise<number> {
    const data = await this.postDirect(inn, role, 1, 1);
    const total = Number(data[0]?.total_count);
    if (Number.isFinite(total) && total > 0) return total;
    // No total and yet rows came back: better to fetch what we can see than
    // to call the company empty.
    if (data.length) {
      this.logger.warn(
        `DirectPurchases: INN=${inn} role=${role} — no total_count in the ` +
          `response, falling back to ${data.length}`,
      );
      return data.length;
    }
    return 0;
  }

  /**
   * Fetch one of etender's own files by the path a deal carries.
   *
   * The path is not a URL. `/files/2026/9/8/….pdf` answers 404 on the API host
   * and returns the SPA's HTML on the web host; the only thing that serves the
   * bytes is this endpoint, with the path in the **query string of a POST** —
   * not in the body, which is what the shape of the call makes you expect.
   *
   * No credentials, referer or user-agent are required; verified against the
   * live host. Returns null rather than throwing, because a missing document
   * must not fail the sync that found it.
   */
  async downloadFile(
    path: string,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    if (!path) return null;
    try {
      const response = await axios.post(
        `${this.BASE_URL}/DownloadFile`,
        undefined,
        {
          params: { path },
          responseType: 'arraybuffer',
          timeout: 30000,
          // The request carries no body, and the endpoint answers 415 to the
          // `application/x-www-form-urlencoded` axios adds by default for a
          // POST. `null` here omits the header entirely, which is what the
          // site's own call does.
          headers: { 'Content-Type': null },
        },
      );
      const body = Buffer.from(response.data);
      if (!body.length) return null;
      return {
        body,
        contentType:
          response.headers['content-type'] || 'application/octet-stream',
      };
    } catch (err) {
      this.logger.warn(
        `[etender] DownloadFile ${path} olinmadi: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Lots one company put out that came to nothing.
   *
   * Unlike the auction API, this one's company filter works: `CustomerTin`
   * takes 56k rows down to the few hundred that belong to the caller, checked
   * against a STIR known to be in the data. So these are fetched per company
   * on demand like the deals beside them, with no catalogue to mirror.
   *
   * **`To` is inclusive here**, unlike `DealsList` on the same API where it
   * is exclusive: `From: 1, To: 3` returns three rows from this endpoint and
   * two from that one. Pages therefore step `From = previous To + 1`, which
   * was checked for overlap rather than assumed.
   */
  async fetchNotDealed(
    inn: string,
    from: number,
    count: number,
  ): Promise<NotDealedLotFields[]> {
    this.logger.log(
      `etender NotDealedList: INN=${inn}, from=${from}, count=${count}`,
    );
    const data = await this.postApi('NotDealedList', {
      From: from,
      To: from + count - 1,
      System_Id: 0,
      CustomerTin: inn,
    });
    return data.map((item: any) => this.mapNotDealed(item));
  }

  /** How many failed lots this company has. */
  async getNotDealedTotalCount(inn: string): Promise<number> {
    const data = await this.postApi('NotDealedList', {
      From: 1,
      To: 1,
      System_Id: 0,
      CustomerTin: inn,
    });
    return Number(data[0]?.total_count) || 0;
  }

  private mapNotDealed(raw: any): NotDealedLotFields {
    return {
      trade_id: num(raw.trade_id),
      display_no: String(raw.display_no || ''),
      start_date: sourceTimeIso(raw.start_date),
      end_date: sourceTimeIso(raw.end_date),
      category_name: raw.category_name?.trim() || null,
      start_cost: num(raw.start_cost),
      participants_count: num(raw.participants_count),
      customer_name: raw.customer_name || null,
      customer_inn: raw.customer_inn || null,
      is_local_manufacturs:
        raw.is_local_manufacturs === null ||
        raw.is_local_manufacturs === undefined
          ? null
          : Boolean(raw.is_local_manufacturs),
      status_id: num(raw.status_id),
      status_name: raw.status_name || null,
    };
  }

  private async postApi(endpoint: string, body: any): Promise<any[]> {
    const response = await axios.post(`${this.BASE_URL}/${endpoint}`, body, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 15000,
    });
    return Array.isArray(response.data) ? response.data : [];
  }

  private mapDeal(raw: any): ProcurementDealFields {
    return {
      deal_id: raw.deal_id,
      display_no: String(raw.display_no || ''),
      deal_date: sourceTimeIso(raw.deal_date),
      start_cost: raw.start_cost ?? null,
      deal_cost: raw.deal_cost ?? null,
      currency_name: raw.currency_name || null,
      participants_count: raw.participants_count ?? null,
      customer_name: raw.customer_name || '',
      customer_inn: raw.customer_inn || '',
      provider_name: raw.provider_name || '',
      provider_inn: raw.provider_inn || '',
      deal_status_name: raw.deal_status_name || null,
      category_name: raw.category_name || null,

      trade_id: num(raw.trade_id),
      customer_type_name: raw.customer_type_name || null,
      proposal_status_name: raw.proposal_status_name || null,
      // The one `dd.MM.yyyy` field in an otherwise ISO response. Handed to
      // Postgres as text it was read under DateStyle MDY — `25.08.2026`
      // rejected as month 25, `08.09.2026` accepted as the 9th of August.
      deal_contract_date: sourceTimeIso(raw.deal_contract_date),
      deal_contract_status_name: raw.deal_contract_status_name || null,
      deal_contract_kazna_status_name:
        raw.deal_contract_kazna_status_name || null,
      deal_contract_kazna_status_id: num(raw.deal_contract_kazna_status_id),
      // Upstream sends 0/1 rather than a boolean, and leaves it out entirely
      // on older rows — which is a third state, not a false.
      is_local_manufacturs:
        raw.is_local_manufacturs === null ||
        raw.is_local_manufacturs === undefined
          ? null
          : Boolean(raw.is_local_manufacturs),
      beneficiary: raw.beneficiary || null,
      founder: raw.founder || null,

      contract_file_name: raw.contract_file_name || null,
      contract_file_path: raw.contract_file_path || null,
      contract_file_ext: raw.contract_file_ext || null,
      contract_file_size: num(raw.contract_file_sizes),
      contract_file_date: sourceTimeIso(raw.contract_file_date),

      protocol_file_name: raw.additional_protocol_file_name || null,
      protocol_file_path: raw.additional_protocol_file_path || null,
      protocol_file_ext: raw.additional_protocol_file_ext || null,
      // Verified against the files themselves: `contract_file_sizes` is a
      // byte count and `additional_protocol_file_sizes` is a KB count, in the
      // same response. Kept in the unit it arrives in, and named for it.
      protocol_file_size_kb: num(raw.additional_protocol_file_sizes),
      protocol_file_date: sourceTimeIso(raw.additional_protocol_file_date),
    };
  }

  private mapDirectPurchase(raw: any): DirectPurchaseFields {
    return {
      purchase_id: raw.id,
      display_id: String(raw.display_id || ''),
      contract_num: raw.contract_num || null,
      contract_date: directPurchaseDay(raw.contract_date),
      contract_sum: raw.contract_sum ?? null,
      currency_name: raw.currency_name || null,
      category_name: raw.category_name || null,
      typ_direct_purchase_name: raw.typ_direct_purchase_name || null,
      decree_name: raw.decree_name || null,
      customer_name: raw.customer_name || null,
      customer_inn: raw.customer_inn || null,
      customer_type: raw.customer_type || null,
      provider_name: raw.provider_name || null,
      provider_inn: raw.provider_inn || null,
      status_name: raw.status_name || null,
      date_ini: raw.date_ini || null,
      has_discussion_protocol: raw.has_discussion_protocol ?? null,
      messages_count: raw.messages_count ?? null,
    };
  }

  private mapTrade(raw: any): ProcurementTradeFields {
    return {
      id: raw.id,
      display_no: String(raw.display_no || ''),
      name: raw.name || '',
      start_date: sourceTimeIso(raw.start_date),
      end_date: sourceTimeIso(raw.end_date),
      cost: raw.cost ?? null,
      seller_name: raw.seller_name || '',
      seller_tin: raw.seller_tin || '',
      region_name: raw.region_name || null,
      district_name: raw.district_name || null,
      currency_name: raw.currency_name || null,
      category_name: raw.category_name || null,
      clarific_date: sourceTimeIso(raw.clarific_date),
      seller_id: num(raw.seller_id),
    };
  }
}

/**
 * A number, or null — never `NaN` and never `0` standing in for "absent".
 *
 * The API sends numeric fields as numbers, as digit strings, and as empty
 * strings for "no value", all in the same response. `Number('')` is 0, which
 * would turn a missing file size into a file of zero bytes.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The direct-purchase API writes its dates month first — `date_ini` is
 * "02/25/2026 16:55:41" (OrgService.parseUsDate) — so a slash date here is
 * US order. Read day first, "02/03/2026" became 2 March and "02/25/2026" no
 * date at all. Any other shape goes through parseSourceDay.
 */
export function directPurchaseDay(value: unknown): string | null {
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s|$)/.exec(
    String(value ?? '').trim(),
  );
  if (us) {
    const [, month, day, year] = us;
    return parseSourceDay(
      `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`,
    );
  }
  return parseSourceDay(value);
}
