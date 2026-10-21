import { SOURCE_PAGE } from './deal-sync';
import { tradeInsert } from './procurement-row';
import type { ProcurementTradeFields } from './procurement.service';

/** Only what this needs, so either service can pass its own. */
export interface TradeSyncDeps {
  query: (sql: string, params?: unknown[]) => Promise<any>;
  tradesTotal: (inn: string) => Promise<number>;
  fetchTrades: (
    inn: string,
    from: number,
    count: number,
  ) => Promise<ProcurementTradeFields[]>;
  logger: {
    log: (message: string) => void;
    error: (message: string) => void;
  };
}

export interface TradeSyncResult {
  /** Live lots this pass had never seen. */
  written: number;
  /** Live-lot rows retired because the lot has since produced a deal. */
  superseded: number;
}

/**
 * The lots a company currently has out, and the ones that have stopped being
 * current.
 *
 * Two loops used to stand here, one in each service, and both were expensive
 * in a way that did not show:
 *
 * - **The live lots were capped at a hundred.** `fetchTrades` asked for
 *   `TRADE_PAGE_SIZE + 1` on the belief that `To` was exclusive. It is not on
 *   this endpoint, so it read 101 rows and stopped, and a company with more
 *   live lots than that simply never had the rest.
 * - **Promotion cost one request per unfinished row.** Every row with
 *   `is_completed = 0` was looked up at the source by lot number to see
 *   whether it had a winner yet — and that set includes every *failed* lot,
 *   so a company with 858 of them made 858 sequential requests on every sync
 *   to re-learn that a lot which came to nothing still has.
 *
 * Neither is needed now that a pass reads the company's whole deal list: a
 * lot that found a winner arrives as a deal of its own, and the live-lot row
 * it leaves behind is retired here by a single statement.
 *
 * Only `active` rows are retired. A failed lot keeps its row even when the
 * same lot number later produced a deal — it is a record of an attempt that
 * came to nothing, and that attempt happened.
 */
export async function syncTrades(
  deps: TradeSyncDeps,
  inn: string,
): Promise<TradeSyncResult> {
  const total = await deps.tradesTotal(inn);
  let written = 0;

  for (let from = 1; from <= total; from += SOURCE_PAGE) {
    const count = Math.min(SOURCE_PAGE, total - from + 1);
    const trades = await deps.fetchTrades(inn, from, count);
    if (!trades.length) break;

    // Written every pass, not only when new: a lot's closing date, price or
    // clarification window moves while it is open, and a row that is only
    // ever inserted keeps whatever it looked like on the day it appeared.
    for (const trade of trades) {
      try {
        const insert = tradeInsert(inn, trade);
        const [row] = await deps.query(insert.sql, insert.params);
        if (row?.inserted) written++;
      } catch (err) {
        deps.logger.error(
          `[syncDeals] trade INSERT error (${trade.display_no}): ${(err as Error).message}`,
        );
      }
    }
  }

  const retired = await deps.query(
    `DELETE FROM public.company_deals a
      WHERE a.inn = $1
        AND a.deal_id IS NULL
        AND a.lot_outcome = 'active'
        AND EXISTS (
          SELECT 1 FROM public.company_deals b
           WHERE b.inn = a.inn
             AND b.lot_display_no = a.lot_display_no
             AND b.deal_id IS NOT NULL
        )
      RETURNING a.id`,
    [inn],
  );
  const superseded = Array.isArray(retired) ? retired.length : 0;

  deps.logger.log(
    `[syncDeals] ${inn} — ${total} live lot(s) upstream, ${written} new` +
      (superseded ? `, ${superseded} retired to a deal` : ''),
  );

  return { written, superseded };
}
