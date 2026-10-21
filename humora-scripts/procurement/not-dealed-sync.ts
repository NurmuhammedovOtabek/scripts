import { SOURCE_PAGE } from './deal-sync';
import { notDealedInsert, notDealedInsertMany } from './procurement-row';
import type { NotDealedLotFields } from './procurement.service';

/** Only what this needs, so either service can pass its own. */
export interface NotDealedDeps {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
  fetchNotDealed: (
    inn: string,
    from: number,
    count: number,
  ) => Promise<NotDealedLotFields[]>;
  logger: {
    log: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
}

/**
 * Store the lots a company put out that nobody bid on.
 *
 * One copy, called from both `OrgService` and `OrgDataService`. There were
 * two identical loops before this, and the two copies of the cache clear
 * beside them were both wrong in the same two ways for the same reason —
 * nobody edits the second one.
 *
 * **One statement, not one per row.** The buyer with the most failed lots has
 * 858, and the request that fetched all 858 was a single call taking two
 * seconds. Writing them cost 858 round trips to the database: the only part
 * of this sync that scaled with the company rather than with the work. A
 * batch gives up per-row error isolation, so a refused statement falls back
 * to writing them one at a time — one malformed lot should cost that lot,
 * not the other eight hundred.
 *
 * **Every lot, and every lot every time.** Two caps stood here before: 100
 * chosen by eye, then 2000 behind an environment variable. Both were answers
 * to a question nobody had asked — the source pages freely and a page costs
 * one request — and a cap on what gets stored is a decision to lose data on
 * the company that has the most of it. The lots are also written on every
 * pass rather than only when new, so a lot whose details changed upstream is
 * corrected instead of frozen at whatever it looked like the first time.
 */
export async function syncNotDealed(
  deps: NotDealedDeps,
  inn: string,
  failedTotal: number,
  existingSet: Set<string>,
): Promise<number> {
  let fetched = 0;
  let inserted = 0;

  for (let from = 1; from <= failedTotal; from += SOURCE_PAGE) {
    const count = Math.min(SOURCE_PAGE, failedTotal - from + 1);
    const lots = await deps.fetchNotDealed(inn, from, count);
    if (!lots.length) break;
    fetched += lots.length;
    inserted += await writePage(deps, inn, lots, existingSet);
  }

  deps.logger.log(
    `[syncDeals] ${inn} — ${fetched} failed lot(s) read of ${failedTotal} ` +
      `upstream, ${inserted} new`,
  );
  return inserted;
}

/** One page: a single statement, falling back to one row at a time. */
async function writePage(
  deps: NotDealedDeps,
  inn: string,
  lots: NotDealedLotFields[],
  existingSet: Set<string>,
): Promise<number> {
  const batch = notDealedInsertMany(inn, lots);
  if (batch) {
    try {
      const rows = (await deps.query(batch.sql, batch.params)) as
        | { inserted?: boolean }[]
        | undefined;
      for (const lot of lots) existingSet.add(lot.display_no);
      // A driver that answers with no rows is not a reason to claim none
      // were written; the count only feeds the cache clear.
      return Array.isArray(rows)
        ? rows.filter((r) => r?.inserted).length
        : lots.length;
    } catch (err) {
      deps.logger.warn(
        `[syncDeals] failed lots refused as a batch (${(err as Error).message}) — retrying one at a time`,
      );
    }
  }

  let written = 0;
  for (const lot of lots) {
    try {
      const insert = notDealedInsert(inn, lot);
      const [row] = ((await deps.query(insert.sql, insert.params)) ?? []) as {
        inserted?: boolean;
      }[];
      existingSet.add(lot.display_no);
      if (row?.inserted !== false) written++;
    } catch (err) {
      deps.logger.error(
        `[syncDeals] failed-lot INSERT error (${lot.display_no}): ${(err as Error).message}`,
      );
    }
  }
  return written;
}
