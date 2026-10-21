import { syncTrades, TradeSyncDeps } from './trade-sync';
import type { ProcurementTradeFields } from './procurement.service';

const trade = (n: number): ProcurementTradeFields =>
  ({
    id: 500000 + n,
    display_no: `2612001${String(500000 + n)}`,
    name: 'Lot',
    start_date: '2026-09-01T00:00:00',
    end_date: '2026-09-20T00:00:00',
    cost: 1000 + n,
    seller_name: 'Xaridor',
    seller_tin: '203366731',
    region_name: 'Toshkent',
    district_name: null,
    currency_name: 'Sum',
    category_name: 'Kategoriya',
    clarific_date: null,
    seller_id: 42,
  }) as ProcurementTradeFields;

type Rows = (sql: string, params?: unknown[]) => unknown[];

const defaultRows: Rows = (sql) =>
  sql.startsWith('DELETE') ? [] : [{ id: 1, inserted: true }];

const build = (over: Partial<TradeSyncDeps> = {}, rows: Rows = defaultRows) => {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const logs: string[] = [];
  const deps: TradeSyncDeps = {
    // Recording stays in one place, so a test that changes what the database
    // answers does not quietly stop recording what it was asked.
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return rows(sql, params);
    }),
    tradesTotal: jest.fn(async () => 3),
    fetchTrades: jest.fn(async () => [trade(1), trade(2), trade(3)]),
    logger: {
      log: (m) => logs.push(`LOG ${m}`),
      error: (m) => logs.push(`ERROR ${m}`),
    },
    ...over,
  };
  return { deps, queries, logs };
};

const inserts = (queries: { sql: string }[]) =>
  queries.filter((q) => q.sql.startsWith('INSERT'));

describe('syncTrades', () => {
  it('writes every live lot the source has', async () => {
    const { deps, queries } = build();
    await expect(syncTrades(deps, '203366731')).resolves.toMatchObject({
      written: 3,
    });
    expect(inserts(queries)).toHaveLength(3);
  });

  /**
   * `fetchTrades` asked for `TRADE_PAGE_SIZE + 1` believing `To` exclusive.
   * It is not on this endpoint, so the call read 101 rows and stopped — a
   * company with more live lots than that never had the rest.
   */
  it('pages rather than stopping at the first hundred', async () => {
    const { deps } = build({ tradesTotal: jest.fn(async () => 1200) });
    await syncTrades(deps, '203366731');
    expect(deps.fetchTrades).toHaveBeenCalledTimes(3);
    expect(deps.fetchTrades).toHaveBeenNthCalledWith(1, '203366731', 1, 500);
    expect(deps.fetchTrades).toHaveBeenNthCalledWith(3, '203366731', 1001, 200);
  });

  it('asks for nothing when the company has no live lots', async () => {
    const { deps, queries } = build({ tradesTotal: jest.fn(async () => 0) });
    await syncTrades(deps, '203366731');
    expect(deps.fetchTrades).not.toHaveBeenCalled();
    // The retiring statement still runs: a lot may have become a deal since.
    expect(inserts(queries)).toHaveLength(0);
  });

  it('stops early when a page comes back empty', async () => {
    const fetchTrades = jest.fn(async () => []);
    const { deps } = build({
      tradesTotal: jest.fn(async () => 5000),
      fetchTrades,
    });
    await syncTrades(deps, '203366731');
    expect(fetchTrades).toHaveBeenCalledTimes(1);
  });

  /**
   * Written every pass, not only when new: a lot's closing date, price and
   * clarification window move while it is open, and the old loop skipped any
   * lot number already in the table.
   */
  it('writes a lot it already holds, so an open lot stays current', async () => {
    const { deps, queries } = build({}, (sql) =>
      sql.startsWith('DELETE') ? [] : [{ id: 1, inserted: false }],
    );
    const r = await syncTrades(deps, '203366731');
    expect(inserts(queries)).toHaveLength(3);
    // Nothing new, but all three were written.
    expect(r.written).toBe(0);
  });

  it('keeps going when one lot is refused', async () => {
    const { deps, logs } = build({}, (sql, params) => {
      if ((params ?? []).includes(trade(2).display_no)) {
        throw new Error('value too long');
      }
      return defaultRows(sql, params);
    });
    const r = await syncTrades(deps, '203366731');
    expect(r.written).toBe(2);
    expect(logs.filter((l) => l.startsWith('ERROR'))).toHaveLength(1);
  });
});

/**
 * A lot that found a winner arrives as a deal of its own now that the key
 * carries `deal_id`, so the live-lot row it leaves behind has to go — or the
 * company shows an open tender that closed months ago beside the contract it
 * produced.
 */
describe('retiring a lot that became a deal', () => {
  const retiring = (queries: { sql: string; params?: unknown[] }[]) =>
    queries.find((q) => q.sql.startsWith('DELETE'))!;

  it('runs once, at the end', async () => {
    const { deps, queries } = build();
    await syncTrades(deps, '203366731');
    expect(queries.filter((q) => q.sql.startsWith('DELETE'))).toHaveLength(1);
    expect(queries[queries.length - 1].sql.startsWith('DELETE')).toBe(true);
  });

  it('touches only this company', async () => {
    const { deps, queries } = build();
    await syncTrades(deps, '203366731');
    expect(retiring(queries).params).toEqual(['203366731']);
    expect(retiring(queries).sql).toContain('a.inn = $1');
  });

  it('retires only live lots, and only ones with a deal behind them', async () => {
    const { deps, queries } = build();
    await syncTrades(deps, '203366731');
    const sql = retiring(queries).sql;
    // A failed lot keeps its row even when the same number later produced a
    // deal: it is the record of an attempt that came to nothing.
    expect(sql).toContain("a.lot_outcome = 'active'");
    expect(sql).toContain('a.deal_id IS NULL');
    expect(sql).toContain('b.deal_id IS NOT NULL');
    expect(sql).toContain('b.lot_display_no = a.lot_display_no');
  });

  it('reports how many it retired', async () => {
    const { deps, logs } = build({}, (sql) =>
      sql.startsWith('DELETE')
        ? [{ id: 1 }, { id: 2 }]
        : [{ id: 1, inserted: true }],
    );
    const r = await syncTrades(deps, '203366731');
    expect(r.superseded).toBe(2);
    expect(logs.some((l) => l.includes('2 retired to a deal'))).toBe(true);
  });

  it('says nothing when there was nothing to retire', async () => {
    const { deps, logs } = build();
    await syncTrades(deps, '203366731');
    expect(logs.some((l) => l.includes('retired'))).toBe(false);
  });
});
