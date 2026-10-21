import { dealInsert } from './procurement-row';
import type { ProcurementDealFields } from './procurement.service';

/**
 * How many deals one request may ask the source for.
 *
 * This is a transport limit, not a budget. It used to be 50 and it used to
 * mean "as much of this company as one visit is allowed to fetch", which was
 * the wrong idea twice over:
 *
 * - **The source does not need it.** `DealsList` served a 679-deal company in
 *   one answer in 1.96s (668KB per 500 rows, measured 2026-09-12). The cap was
 *   not sparing the source anything; it was only holding our own writes back.
 * - **It made completeness a matter of how often somebody clicked.** A sync
 *   may run once per company per ten hours (the Redis key), so 50 rows a pass
 *   meant fourteen passes — nearly six days of daily visits — before a big
 *   buyer's deals were all stored. In the meantime the page showed 78 of 682
 *   and looked simply wrong to the reader.
 *
 * So a sync now finishes the company. The page size survives only to bound
 * one response: a ministry with tens of thousands of deals should not arrive
 * as a single multi-megabyte body under a 15s timeout.
 */
export const SOURCE_PAGE = 500;

/**
 * Companies being synced right now, in this process.
 *
 * The Redis key that guards this is checked at the start of the sync and
 * written at the end, so the gap between them is the whole sync — every
 * request arriving in that window sees no lock and starts its own. Opening
 * one company page fires several deals requests (the tab, then each filter),
 * and the log showed five concurrent passes on one STIR reading the same
 * window: `27 row(s) not enriched, reading 1+10 and 152+50`, three times
 * over.
 *
 * Nothing was corrupted — the unique index turned the duplicate writes into
 * upserts — but it was five times the source traffic and five times the
 * writes for one page view.
 *
 * A Set rather than a Redis round trip, because the check and the claim have
 * to happen with no `await` between them; anything asynchronous reopens the
 * same gap. It is per-process, so it does not coordinate replicas — the
 * Redis key still does that, at its own granularity. This closes the case
 * that actually happens: one container, one reader, several requests.
 */
const inFlight = new Set<string>();

/** Claim a company, or say somebody already has it. */
export function claimSync(inn: string): boolean {
  if (inFlight.has(inn)) return false;
  inFlight.add(inn);
  return true;
}

/** Always from a `finally` — a sync that throws must not hold the claim. */
export function releaseSync(inn: string): void {
  inFlight.delete(inn);
}

export interface DealSyncDeps {
  query: (sql: string, params?: unknown[]) => Promise<any>;
  logger: {
    log: (message: string) => void;
    error: (message: string) => void;
  };
}

export interface UpsertResult {
  inserted: number;
  /** Rows already held that this pass filled gaps in. */
  enriched: number;
  /** Every row touched, so its paperwork can be mirrored after. */
  ids: number[];
}

/** Which side of the deal this company was on. */
export type DealSide = 'customer' | 'provider';

/** Which slice of the source to ask for. */
export interface FetchWindow {
  from: number;
  count: number;
}

/**
 * Which slices of the source to read to finish this company, or none.
 *
 * `held` is how many of this side's deals we have already carried through the
 * mapper. If that is the whole list, there is nothing to do — the common
 * case, and the one that keeps a returning visitor cheap. Otherwise the list
 * is read from the top, in pages, until it is covered.
 *
 * **From the top, not from `held + 1`.** The old walk treated the count as an
 * offset, which is only true if every gap is at the end. Gaps are not: a row
 * the column refused (a treasury status of 134 characters, before the widening)
 * sits wherever its deal sits, and a row that became a deal through the active
 * -tender update carries no `enriched_at` at all — 14 of 290 on 203195074.
 * Reading positionally from the count stepped straight over both.
 *
 * Reading it all costs two requests for a company of this size, and only
 * while something is genuinely missing. Once the list is held, this returns
 * nothing at all.
 *
 * **`apiCount` counts deals and `held` counts lots, and on some companies
 * those differ.** A lot whose first contract fell through is awarded again,
 * and the source lists both deals under the one lot number: 203195074 returns
 * 679 rows for 624 distinct lots, every one of the 55 repeats naming a
 * different supplier. `UNIQUE (inn, lot_display_no)` keeps one row, so `held`
 * stops 55 short and this asks for the list again on the next visit — two
 * requests every ten hours, since the Redis key paces it. That is the cheap
 * half of the problem. The expensive half is that the second contract is not
 * stored at all, and fixing that means keying deals by `deal_id` rather than
 * by lot.
 */
export function dealFetchWindows(
  apiCount: number,
  held: number,
  page = SOURCE_PAGE,
): FetchWindow[] {
  if (apiCount <= 0 || held >= apiCount) return [];

  const windows: FetchWindow[] = [];
  for (let from = 1; from <= apiCount; from += page) {
    windows.push({ from, count: Math.min(page, apiCount - from + 1) });
  }
  return windows;
}

/**
 * Rows of one side already carried through the mapper.
 *
 * Counted per side because the two lists are separate upstream and a company
 * can be big on one and absent from the other. A single mixed count let a
 * supplier with seven hundred sales report itself complete while holding none
 * of its five purchases: 705 ≥ 5.
 *
 * `enriched_at` is what makes this answerable at all. A deal genuinely may
 * have no contract file, so a NULL there means "nothing to store" or "never
 * asked" and only the marker tells them apart.
 */
export async function enrichedDealCount(
  deps: DealSyncDeps,
  inn: string,
  side: DealSide,
): Promise<number> {
  const column = side === 'customer' ? 'customer_inn' : 'provider_inn';
  const [row] = await deps.query(
    `SELECT COUNT(*)::int AS enriched FROM public.company_deals
      WHERE inn = $1 AND is_completed = 1 AND enriched_at IS NOT NULL
        AND ${column} = $1`,
    [inn],
  );
  return row?.enriched ?? 0;
}

/**
 * Write each deal, filling gaps in the ones already held.
 *
 * This used to return early on a lot already in the table, which is why every
 * deal stored before the response grew its columns kept its NULLs: the row
 * was there, so it was never looked at again. `dealInsert` now carries
 * `ON CONFLICT … DO UPDATE` with `COALESCE`, so a second write fills what is
 * missing and leaves what is set alone.
 *
 * One failed row costs that row. These are written one at a time rather than
 * as a batch precisely so a single malformed deal — a date the column will
 * not take, a name past its length — cannot take the other forty-nine with it.
 */
export async function upsertDeals(
  deps: DealSyncDeps,
  inn: string,
  deals: ProcurementDealFields[],
  existingSet: Set<string>,
): Promise<UpsertResult> {
  const result: UpsertResult = { inserted: 0, enriched: 0, ids: [] };

  for (const deal of deals) {
    try {
      const insert = dealInsert(inn, deal);
      const [written] = await deps.query(insert.sql, insert.params);
      // An enriched row is mirrored too: a contract path that arrived only
      // just now has never been fetched.
      if (written?.id) result.ids.push(written.id);
      existingSet.add(deal.display_no);
      if (written?.inserted) {
        result.inserted++;
        deps.logger.log(`[syncDeals] ✅ INSERT: ${deal.display_no}`);
      } else {
        result.enriched++;
      }
    } catch (err) {
      deps.logger.error(
        `[syncDeals] INSERT error (${deal.display_no}): ${(err as Error).message}`,
      );
    }
  }

  return result;
}

/**
 * How far back a held deal is asked about again for its documents.
 *
 * A contract or protocol is attached upstream after the deal, not with it.
 * Measured over 1,051 contracts: median 16 days after the deal, 90% within
 * 53, 99% within 218. So a deal stored without one may simply be early. Past a
 * year almost nothing more arrives, and 203195074 alone holds 181 older deals
 * that never got a contract — asking about those every ten hours would be 181
 * requests for nothing. They are not forgotten either: the whole list is read
 * again whenever the company gains a deal.
 */
export const DOCUMENT_RECHECK_DAYS = 365;

export interface DocumentRecheck extends UpsertResult {
  /** Lots asked about, one request each. */
  asked: number;
  /** Held deals that now have the contract or protocol they were missing. */
  filled: number;
}

/**
 * Ask again about recent deals still missing a contract or protocol.
 *
 * `dealFetchWindows` reads nothing once every deal is held, which is right for
 * the list and wrong for the paperwork: a deal stored the week it closed keeps
 * `contract_file_path` NULL until the list is read again, and that happens only
 * when the company gains a deal. Deal 174419 of 203195074 is stored without a
 * contract that the source has had since, and nothing would have asked.
 *
 * By lot rather than by reading the list again: these are a handful — 11 deals
 * on 203195074 inside ninety days, 34 inside a year — against a list of 679.
 * A lot that will not answer costs that lot only.
 */
export async function recheckDealDocuments(
  deps: DealSyncDeps,
  inn: string,
  sides: readonly DealSide[],
  fetchLot: (
    displayNo: string,
    side: DealSide,
  ) => Promise<ProcurementDealFields[]>,
  existingSet: Set<string>,
): Promise<DocumentRecheck> {
  const result: DocumentRecheck = {
    inserted: 0,
    enriched: 0,
    ids: [],
    asked: 0,
    filled: 0,
  };

  for (const side of sides) {
    const column = side === 'customer' ? 'customer_inn' : 'provider_inn';
    const missing: {
      deal_id: string | number;
      lot_display_no: string;
      no_contract: boolean;
      no_protocol: boolean;
    }[] = await deps.query(
      `SELECT deal_id, lot_display_no,
              contract_file_path IS NULL AS no_contract,
              protocol_file_path IS NULL AS no_protocol
         FROM public.company_deals
        WHERE inn = $1 AND ${column} = $1
          AND lot_outcome = 'deal'
          AND (contract_file_path IS NULL OR protocol_file_path IS NULL)
          AND deal_date >= now() - make_interval(days => $2)
          AND lot_display_no <> ''
        ORDER BY deal_date DESC`,
      [inn, DOCUMENT_RECHECK_DAYS],
    );

    const byLot = new Map<string, typeof missing>();
    for (const row of missing) {
      const lot = String(row.lot_display_no);
      byLot.set(lot, [...(byLot.get(lot) ?? []), row]);
    }

    let asked = 0;
    let filled = 0;
    for (const [lot, held] of byLot) {
      asked++;
      let deals: ProcurementDealFields[];
      try {
        deals = await fetchLot(lot, side);
      } catch (err) {
        deps.logger.error(
          `[syncDeals] ${inn} — documents for lot ${lot} not fetched: ${(err as Error).message}`,
        );
        continue;
      }
      for (const row of held) {
        const fresh = deals.find(
          (d) => String(d.deal_id) === String(row.deal_id),
        );
        if (
          fresh &&
          ((row.no_contract && fresh.contract_file_path) ||
            (row.no_protocol && fresh.protocol_file_path))
        ) {
          filled++;
        }
      }
      const written = await upsertDeals(deps, inn, deals, existingSet);
      result.inserted += written.inserted;
      result.enriched += written.enriched;
      result.ids.push(...written.ids);
    }

    if (asked > 0) {
      deps.logger.log(
        `[syncDeals] ${inn} — ${side}: asked about ${asked} lot(s) missing a document, ${filled} deal(s) now have one`,
      );
    }
    result.asked += asked;
    result.filled += filled;
  }

  return result;
}
