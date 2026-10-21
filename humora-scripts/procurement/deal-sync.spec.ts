import {
  SOURCE_PAGE,
  claimSync,
  dealFetchWindows,
  enrichedDealCount,
  releaseSync,
  upsertDeals,
} from './deal-sync';
import { dealInsert } from './procurement-row';
import type { ProcurementDealFields } from './procurement.service';

const deal = (
  over: Partial<ProcurementDealFields> = {},
): ProcurementDealFields =>
  ({
    deal_id: 55,
    display_no: '26120012509360',
    deal_date: '2026-09-10T00:00:00',
    deal_cost: 9000000000,
    start_cost: 10258639104,
    currency_name: 'Сум',
    participants_count: 4,
    customer_name: 'Xaridor',
    customer_inn: '203366731',
    provider_name: 'Yetkazuvchi',
    provider_inn: '312387381',
    contract_file_path: '/files/2026/shartnoma.pdf',
    ...over,
  }) as ProcurementDealFields;

const build = (rows: unknown[] = [{ id: 1, inserted: true }]) => {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const logs: string[] = [];
  const deps = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return rows;
    }),
    logger: {
      log: (m: string) => logs.push(`LOG ${m}`),
      error: (m: string) => logs.push(`ERROR ${m}`),
    },
  };
  return { deps, queries, logs };
};

/**
 * The fix for rows that were written before the response grew its columns.
 *
 * `insertDeal` returned early on a lot it already held, so a deal stored
 * before the contract and treasury fields existed kept its NULLs for good —
 * 4 of 84 rows on 203366731 had a contract path, 0 of 9 on 206268051. The
 * document button the whole feature exists for did not appear, and looked
 * from the outside like "this deal has no contract".
 */
describe('upsertDeals', () => {
  it('writes a deal it has never seen', async () => {
    const { deps, queries } = build([{ id: 7, inserted: true }]);
    const r = await upsertDeals(deps, '203366731', [deal()], new Set());
    expect(r).toMatchObject({ inserted: 1, enriched: 0, ids: [7] });
    expect(queries[0].sql).toContain(
      'ON CONFLICT (inn, lot_display_no, deal_id, trade_id)',
    );
  });

  it('enriches one it already holds instead of skipping it', async () => {
    // `xmax = 0` is false for a row this statement updated rather than wrote.
    const { deps } = build([{ id: 7, inserted: false }]);
    const held = new Set(['26120012509360']);
    const r = await upsertDeals(deps, '203366731', [deal()], held);
    expect(r).toMatchObject({ inserted: 0, enriched: 1 });
  });

  it('mirrors the paperwork of an enriched row too', async () => {
    const { deps } = build([{ id: 7, inserted: false }]);
    const r = await upsertDeals(deps, '203366731', [deal()], new Set());
    // A contract path that arrived only just now has never been fetched.
    expect(r.ids).toEqual([7]);
  });

  it('keeps going when one row is refused', async () => {
    const deps = {
      query: jest.fn(async (_sql: string, params?: unknown[]) => {
        if ((params ?? []).includes('bad')) throw new Error('value too long');
        return [{ id: 1, inserted: true }];
      }),
      logger: { log: jest.fn(), error: jest.fn() },
    };
    const r = await upsertDeals(
      deps,
      '203366731',
      [deal(), deal({ display_no: 'bad' }), deal({ display_no: 'c' })],
      new Set(),
    );
    // One malformed deal should cost that deal, not the page.
    expect(r.inserted).toBe(2);
    expect(deps.logger.error).toHaveBeenCalledTimes(1);
  });

  it('does not claim a row it failed to write', async () => {
    const deps = {
      query: jest.fn().mockRejectedValue(new Error('nope')),
      logger: { log: jest.fn(), error: jest.fn() },
    };
    const seen = new Set<string>();
    await upsertDeals(deps, '203366731', [deal()], seen);
    // Marking it seen would stop a later pass retrying it.
    expect(seen.size).toBe(0);
  });
});

/**
 * Fifty rows and stop was the old rule, and it made completeness depend on
 * how often somebody clicked: a sync may run once per company per ten hours,
 * so 679 deals needed fourteen visits — nearly six days — while the page
 * showed 78 of 682 and looked simply wrong.
 *
 * Measured against the source on 2026-09-12: `DealsList` answered for the
 * whole 679-deal company in 1.96s. The cap was never sparing the source.
 */
describe('dealFetchWindows', () => {
  it('covers the whole list in one pass', () => {
    const w = dealFetchWindows(679, 0);
    expect(w).toHaveLength(2);
    expect(w[0]).toEqual({ from: 1, count: SOURCE_PAGE });
    expect(w[1]).toEqual({ from: 501, count: 179 });
  });

  it('asks for nothing once the list is held', () => {
    // The steady state, and the reason a returning visitor is cheap.
    expect(dealFetchWindows(679, 679)).toEqual([]);
    expect(dealFetchWindows(679, 700)).toEqual([]);
  });

  it('reads the list again when deals appear upstream', () => {
    // 679 held, 681 upstream: the two new ones are at the top, and the read
    // that finds them is the same read that repairs anything else missing.
    expect(dealFetchWindows(681, 679)).toHaveLength(2);
  });

  /**
   * The old walk read from `held + 1`, which is only correct if every gap is
   * at the end of the list. Two kinds of gap are not: a row the column
   * refused (a 134-character treasury status, before the widening) sits where
   * its deal sits, and a trade promoted to a deal by the active-tender update
   * carries no `enriched_at` at all — 14 of 290 on 203195074.
   */
  it('starts at the top, not at the count of what is held', () => {
    expect(dealFetchWindows(600, 599)[0].from).toBe(1);
  });

  it('never asks past the end of the list', () => {
    const w = dealFetchWindows(1200, 0);
    const last = w[w.length - 1];
    expect(last.from + last.count - 1).toBe(1200);
    expect(w.reduce((n, x) => n + x.count, 0)).toBe(1200);
  });

  it('takes a single page when that is the whole company', () => {
    expect(dealFetchWindows(3, 0)).toEqual([{ from: 1, count: 3 }]);
  });

  it('reads nothing for a company the source has never heard of', () => {
    expect(dealFetchWindows(0, 0)).toEqual([]);
  });
});

/**
 * One page view fires several deals requests — the tab, then each filter —
 * and each used to start its own sync, because the Redis key that guards
 * this is written at the *end* of the run. The log showed five concurrent
 * passes on one STIR, three of them reading the identical window.
 */
describe('claimSync', () => {
  afterEach(() => {
    // The claim is module state; a test that leaves one held breaks the next.
    releaseSync('203195074');
    releaseSync('203366731');
  });

  it('lets the first caller through', () => {
    expect(claimSync('203195074')).toBe(true);
  });

  it('turns the second one away while the first still holds it', () => {
    claimSync('203195074');
    expect(claimSync('203195074')).toBe(false);
    expect(claimSync('203195074')).toBe(false);
  });

  it('lets the next one in once it is released', () => {
    claimSync('203195074');
    releaseSync('203195074');
    expect(claimSync('203195074')).toBe(true);
  });

  it('holds one company without holding another', () => {
    claimSync('203195074');
    expect(claimSync('203366731')).toBe(true);
  });

  it('claims with no await in the way', () => {
    // The whole point: an asynchronous check reopens the gap it closes.
    // Ten callers in one tick, exactly one winner.
    const wins = Array.from({ length: 10 }, () => claimSync('203195074'));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });

  it('releasing something never claimed is harmless', () => {
    expect(() => releaseSync('999999999')).not.toThrow();
  });
});

/**
 * Counted per side, because the two lists are separate upstream. One mixed
 * count let a supplier with seven hundred sales call itself complete while
 * holding none of its five purchases: 705 >= 5.
 */
describe('enrichedDealCount', () => {
  it('counts the rows that have been through the mapper', async () => {
    const { deps, queries } = build([{ enriched: 50 }]);
    await expect(
      enrichedDealCount(deps, '203366731', 'customer'),
    ).resolves.toBe(50);
    expect(queries[0].sql).toContain('enriched_at IS NOT NULL');
  });

  it('counts the side it was asked about', async () => {
    const { deps, queries } = build([{ enriched: 3 }]);
    await expect(
      enrichedDealCount(deps, '203366731', 'customer'),
    ).resolves.toBe(3);
    expect(queries[0].sql).toContain('customer_inn = $1');
    expect(queries[0].sql).not.toContain('provider_inn = $1');

    const other = build([{ enriched: 3 }]);
    await enrichedDealCount(other.deps, '203366731', 'provider');
    expect(other.queries[0].sql).toContain('provider_inn = $1');
  });

  it('reads zero when the row comes back empty', async () => {
    const { deps } = build([]);
    await expect(
      enrichedDealCount(deps, '203366731', 'customer'),
    ).resolves.toBe(0);
  });
});

describe('dealInsert — what a second write does', () => {
  const sql = dealInsert('203366731', deal()).sql;

  it('fills a gap without blanking what is already set', () => {
    expect(sql).toContain(
      'contract_file_path = COALESCE(excluded.contract_file_path, public.company_deals.contract_file_path)',
    );
    expect(sql).toContain(
      'kazna_status_name = COALESCE(excluded.kazna_status_name, public.company_deals.kazna_status_name)',
    );
  });

  it('records that the row has been through the mapper', () => {
    // The one thing the data cannot say for itself.
    expect(sql).toContain('enriched_at = now()');
  });

  /**
   * It used to be in the `DO UPDATE` alone, so a row written for the first
   * time — straight from the current mapper, by definition — was stored with
   * the marker NULL and counted as never enriched. One pass on 203195074
   * wrote 337 deals and the enriched count moved by 53; the sync could never
   * see itself finish, because finishing is measured by that count.
   */
  it('marks a row it has just written, not only one it updated', () => {
    const columns = sql.slice(0, sql.indexOf('VALUES'));
    expect(columns).toContain('enriched_at');
    expect(sql.slice(0, sql.indexOf('ON CONFLICT'))).toContain('now()');
  });

  it('assigns the marker exactly once on conflict', () => {
    // Twice in one SET is a Postgres error, not a harmless repeat.
    const set = sql.slice(sql.indexOf('DO UPDATE SET'));
    expect(set.match(/enriched_at = now\(\)/g)).toHaveLength(1);
  });

  it('does not try to update its own conflict target', () => {
    // Anchored: `customer_inn = COALESCE` and `provider_inn = COALESCE` are
    // both legitimate and both end in the same six characters.
    expect(sql).not.toMatch(/(?:SET|,)\s+inn = COALESCE/);
    expect(sql).not.toMatch(/(?:SET|,)\s+lot_display_no = COALESCE/);
    expect(sql).not.toMatch(/(?:SET|,)\s+deal_id = COALESCE/);
    expect(sql).not.toMatch(/(?:SET|,)\s+trade_id = COALESCE/);
  });

  /**
   * A lot whose first contract fell through is awarded again, and both deals
   * come back under the one lot number — 55 such lots on 203195074, every
   * one naming a different supplier. Keyed on the lot alone, the second
   * overwrote the first.
   */
  it('keys a deal by its own id, so one lot may hold two', () => {
    const first = dealInsert('203195074', deal({ deal_id: 158330 })).params;
    const second = dealInsert('203195074', deal({ deal_id: 174574 })).params;
    expect(first).not.toEqual(second);
    expect(sql).toContain(
      'ON CONFLICT (inn, lot_display_no, deal_id, trade_id)',
    );
  });

  it('sets is_completed outright, so a trade that won becomes a deal', () => {
    // COALESCE on a literal would leave a completed deal claiming
    // `is_completed = 0` because the trade row got there first.
    expect(sql).toContain('is_completed = 1');
    expect(sql).not.toContain('is_completed = COALESCE');
  });

  it('says whether the row was written or updated', () => {
    expect(sql).toContain('RETURNING id, (xmax = 0) AS inserted');
  });
});
