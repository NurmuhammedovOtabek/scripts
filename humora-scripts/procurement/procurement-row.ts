import type {
  NotDealedLotFields,
  ProcurementDealFields,
  ProcurementTradeFields,
} from './procurement.service';

/**
 * How a procurement row is written to `company_deals`, in one place.
 *
 * The two INSERT statements this replaces were byte-identical copies living in
 * `org.service.ts` and `org-data.service.ts` — four sites for two statements.
 * That is why the etender response had been growing for a while and the row
 * had not: adding a field meant editing the same SQL four times and getting
 * the parameter positions right in each, so nobody did.
 *
 * These build the statement and its parameters together, which is the part
 * that was easy to get out of step by hand.
 */

export interface InsertQuery {
  sql: string;
  params: unknown[];
}

/** What became of a lot. Stored in words; `is_completed` stays a boolean. */
export type LotOutcome = 'deal' | 'active' | 'not_dealed';

/** Every LotOutcome, for validating a filter that names one. */
export const LOT_OUTCOMES: readonly LotOutcome[] = [
  'deal',
  'active',
  'not_dealed',
];

/**
 * Columns written as literals rather than parameters.
 *
 * `is_completed` is what the row kind means, not something the source sends:
 * a deal completed, a trade and a failed lot did not.
 *
 * **`enriched_at` belongs to the INSERT, not only to the conflict clause.**
 * It was in the `DO UPDATE` alone, so a row written for the first time — by
 * definition straight from the current mapper — was stored with the marker
 * NULL and counted for ever after as "never enriched". Measured on 203195074:
 * one pass wrote 337 deals and updated 342, and the enriched count moved by
 * 53. Everything downstream reads that count to decide what is still missing,
 * so the sync could never see itself finish.
 *
 * A lot keeps no marker: `enriched_at` says a row has been through the *deal*
 * mapper, and a trade or a failed lot has not.
 */
const DEAL_FIXED = { is_completed: '1', enriched_at: 'now()' } as const;
const LOT_FIXED = { is_completed: '0' } as const;

/** Columns and values as one list, so the two can never drift apart. */
function build(
  table: string,
  columns: Record<string, unknown>,
  fixed: Record<string, string>,
  /** `ON CONFLICT` body, for the row kinds that can be written twice. */
  onConflict?: string,
): InsertQuery {
  const names = Object.keys(columns);
  const placeholders = names.map((_, i) => `$${i + 1}`);
  const fixedNames = Object.keys(fixed);

  return {
    sql:
      `INSERT INTO ${table} (${[...names, ...fixedNames].join(', ')}) ` +
      `VALUES (${[...placeholders, ...fixedNames.map((n) => fixed[n])].join(', ')}) ` +
      (onConflict ? `${onConflict} ` : '') +
      // The caller needs the id to mirror the row's documents afterwards, and
      // `xmax = 0` to tell a new row from one it has just enriched.
      `RETURNING id, (xmax = 0) AS inserted`,
    params: names.map((n) => columns[n]),
  };
}

/** The columns of the unique index, and so the columns nothing may SET. */
const CONFLICT_TARGET = ['inn', 'lot_display_no', 'deal_id', 'trade_id'];

/**
 * Enrich on conflict instead of failing or doing nothing.
 *
 * `COALESCE(excluded.x, company_deals.x)` throughout, for the same reason the
 * auction table does it: a second write must be able to fill a gap, never to
 * blank a value that is already there. The response has grown columns twice
 * now, and every deal stored before each growth kept its NULLs because
 * `insertDeal` returned early on a lot it already held.
 *
 * `enriched_at` is set unconditionally, and it rides in with the fixed
 * columns so the INSERT carries it too — it records that the row has been
 * through the current mapper, which is the one thing that cannot be inferred
 * from the data. A NULL contract path means "no file" or "never asked", and
 * only this column tells them apart.
 *
 * `inn`, `lot_display_no` and `deal_id` are not in the list: together they
 * are the conflict target.
 *
 * **`deal_id` is part of it because a lot can hold more than one deal.** A
 * lot whose first contract falls through is put out again, and the source
 * lists both awards under the one lot number — 203195074 returns 679 deals
 * for 624 distinct lots, and all 55 repeats name a *different* supplier. The
 * key was `(inn, lot_display_no)` until 2026-09-12, so the second contract
 * overwrote the first and one of the two counterparties simply vanished.
 *
 * A trade and a failed lot carry no `deal_id`, and the index is declared
 * `NULLS NOT DISTINCT` so those still collapse onto one row per lot: a lot
 * put out, then failing, is one row that changes its `lot_outcome`, exactly
 * as before. What it no longer does is collide with the deal that lot
 * eventually produced.
 *
 * **`trade_id` is in the key because the lot number can be missing.** The
 * source leaves `display_no` null on older lots — 18 of 201055108's 132
 * failed lots, all from 2021 — and every one of them keyed on the same empty
 * string, so 132 lots upstream were 115 rows here. `trade_id` is what the
 * source itself uses to tell them apart, and it is set on all 132.
 *
 * The fixed columns are assigned outright rather than COALESCEd, and that
 * matters for one case: a lot moves through states. A trade that attracts a
 * winner is written again as a deal, and `lot_outcome` would change while
 * `is_completed` — a literal, not a parameter — stayed at 0. The row would
 * claim to be a completed deal that never completed.
 */
function enrichOnConflict(
  columns: string[],
  fixed: Record<string, string>,
): string {
  const updates = columns
    .filter((c) => !CONFLICT_TARGET.includes(c))
    .map((c) => `${c} = COALESCE(excluded.${c}, public.company_deals.${c})`)
    .concat(Object.entries(fixed).map(([name, value]) => `${name} = ${value}`))
    .join(', ');
  return (
    `ON CONFLICT (${CONFLICT_TARGET.join(', ')}) DO UPDATE SET ` +
    `${updates}, updated_at = now()`
  );
}

/**
 * A completed deal — `is_completed = 1`.
 *
 * `pcp_count` is written as text because the column is text; it holds the
 * participant count, and an empty string is what the old code stored for
 * "unknown" rather than a null.
 */
export function dealInsert(
  inn: string,
  deal: ProcurementDealFields,
): InsertQuery {
  const columns = dealColumns(inn, deal);
  return build(
    'public.company_deals',
    columns,
    DEAL_FIXED,
    enrichOnConflict(Object.keys(columns), DEAL_FIXED),
  );
}

/** The columns of a completed deal, named once. */
function dealColumns(
  inn: string,
  deal: ProcurementDealFields,
): Record<string, unknown> {
  return {
    inn,
    deal_id: deal.deal_id,
    lot_display_no: deal.display_no,
    category_name: deal.category_name,
    customer_inn: deal.customer_inn,
    customer_name: deal.customer_name,
    provider_inn: deal.provider_inn,
    provider_name: deal.provider_name,
    deal_cost: deal.deal_cost,
    start_cost: deal.start_cost,
    currency_name: deal.currency_name,
    deal_date: deal.deal_date,
    pcp_count: String(deal.participants_count || ''),
    lot_outcome: 'deal' satisfies LotOutcome,

    trade_id: deal.trade_id,
    customer_type_name: deal.customer_type_name,
    deal_status_name: deal.deal_status_name,
    proposal_status_name: deal.proposal_status_name,
    deal_contract_date: deal.deal_contract_date,
    deal_contract_status_name: deal.deal_contract_status_name,
    // `kazna_status` is a bigint that has been on this table all along,
    // unfilled: it takes the treasury status *id*. The word that goes with
    // it had nowhere to live until now.
    kazna_status: deal.deal_contract_kazna_status_id,
    kazna_status_name: deal.deal_contract_kazna_status_name,
    is_local_manufacturs: deal.is_local_manufacturs,
    beneficiary: deal.beneficiary,
    founder: deal.founder,

    contract_file_name: deal.contract_file_name,
    contract_file_path: deal.contract_file_path,
    contract_file_ext: deal.contract_file_ext,
    contract_file_size: deal.contract_file_size,
    contract_file_date: deal.contract_file_date,

    protocol_file_name: deal.protocol_file_name,
    protocol_file_path: deal.protocol_file_path,
    protocol_file_ext: deal.protocol_file_ext,
    protocol_file_size_kb: deal.protocol_file_size_kb,
    protocol_file_date: deal.protocol_file_date,
  };
}

/**
 * An active trade — `is_completed = 0`.
 *
 * A trade is a lot still open for offers, so it has a seller rather than a
 * provider, and the lot's own name goes to `product_name`.
 */
export function tradeInsert(
  inn: string,
  trade: ProcurementTradeFields,
): InsertQuery {
  const columns: Record<string, unknown> = {
    inn,
    lot_display_no: trade.display_no,
    category_name: trade.category_name,
    customer_inn: trade.seller_tin,
    customer_name: trade.seller_name,
    start_cost: trade.cost,
    currency_name: trade.currency_name,
    lot_start_date: trade.start_date,
    lot_end_date: trade.end_date,
    product_name: trade.name,

    clarific_date: trade.clarific_date,
    seller_id: trade.seller_id,
    // TradeList calls it `id`, DealsList and NotDealedList call the same
    // number `trade_id`, and every lot number ends with it (checked across
    // 2626 stored rows). It is the lot's identity, and part of the key.
    trade_id: trade.id,
    customer_region: trade.region_name,
    lot_outcome: 'active' satisfies LotOutcome,
  };
  return build(
    'public.company_deals',
    columns,
    LOT_FIXED,
    enrichOnConflict(Object.keys(columns), LOT_FIXED),
  );
}

/**
 * A lot that was put out and came to nothing.
 *
 * Filed as `is_completed = 0` because it never completed, and told apart
 * from a live trade by `lot_outcome`. There is no provider: the whole point
 * of the row is that nobody won it.
 */
export function notDealedInsert(
  inn: string,
  lot: NotDealedLotFields,
): InsertQuery {
  const columns = notDealedColumns(inn, lot);
  return build(
    'public.company_deals',
    columns,
    LOT_FIXED,
    enrichOnConflict(Object.keys(columns), LOT_FIXED),
  );
}

/**
 * The columns of a failed lot, named once.
 *
 * Both the single-row and the many-row builder read this. A second list
 * beside it is exactly how the four INSERTs this file replaced drifted apart.
 */
function notDealedColumns(
  inn: string,
  lot: NotDealedLotFields,
): Record<string, unknown> {
  return {
    inn,
    trade_id: lot.trade_id,
    lot_display_no: lot.display_no,
    category_name: lot.category_name,
    customer_inn: lot.customer_inn,
    customer_name: lot.customer_name,
    start_cost: lot.start_cost,
    lot_start_date: lot.start_date,
    lot_end_date: lot.end_date,
    pcp_count: String(lot.participants_count ?? ''),
    is_local_manufacturs: lot.is_local_manufacturs,
    lot_status_id: lot.status_id,
    lot_status_name: lot.status_name,
    lot_outcome: 'not_dealed' satisfies LotOutcome,
  };
}

/**
 * Every failed lot in one statement.
 *
 * The loop this replaces ran `await query(insert)` per row, so a buyer with
 * 858 of them spent 858 round trips to the database — the one part of this
 * sync that scaled with the company rather than with the work. The request
 * that fetched all 858 was a single call and took two seconds; writing them
 * should not cost more than reading them.
 *
 * Returns null for an empty list rather than an INSERT with no rows, which
 * is a syntax error rather than a no-op.
 */
export function notDealedInsertMany(
  inn: string,
  lots: NotDealedLotFields[],
): InsertQuery | null {
  if (!lots.length) return null;

  const names = Object.keys(notDealedColumns(inn, lots[0]));
  const params: unknown[] = [];
  const tuples = lots.map((lot) => {
    const columns = notDealedColumns(inn, lot);
    const slots = names.map((n) => {
      params.push(columns[n]);
      return `$${params.length}`;
    });
    // `is_completed` is fixed rather than parameterised, as in the single-row
    // builder — it is what the column means here, not something a lot carries.
    return `(${[...slots, '0'].join(', ')})`;
  });

  return {
    sql:
      `INSERT INTO public.company_deals (${[...names, 'is_completed'].join(', ')}) ` +
      `VALUES ${tuples.join(', ')} ` +
      // Without this one lot already in the table refuses the whole batch,
      // and the fallback would rewrite eight hundred rows one at a time for
      // a row that was never the problem.
      `${enrichOnConflict(names, LOT_FIXED)} ` +
      // Every lot is written every pass, so the caller cannot tell from the
      // row count how many were new. `xmax = 0` is true only of a row this
      // statement inserted.
      `RETURNING (xmax = 0) AS inserted`,
    params,
  };
}
