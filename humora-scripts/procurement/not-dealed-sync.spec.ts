import { syncNotDealed, NotDealedDeps } from './not-dealed-sync';
import { notDealedInsertMany } from './procurement-row';
import type { NotDealedLotFields } from './procurement.service';

const lot = (n: number): NotDealedLotFields =>
  ({
    trade_id: n,
    display_no: `2612001250${String(n).padStart(4, '0')}`,
    category_name: 'Kategoriya',
    customer_inn: '203195074',
    customer_name: 'Xaridor',
    start_cost: 1000 + n,
    start_date: '2024-01-01T00:00:00',
    end_date: '2024-01-10T00:00:00',
    participants_count: 0,
    is_local_manufacturs: null,
    status_id: 4,
    status_name: 'Торг не состоялся',
  }) as NotDealedLotFields;

const build = (over: Partial<NotDealedDeps> = {}) => {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const logs: string[] = [];
  const deps: NotDealedDeps = {
    // `INSERT ... RETURNING (xmax = 0)` answers with one row per row
    // processed, which is what the caller counts.
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      const tuples = (sql.match(/\(\$/g) ?? []).length;
      return Array.from({ length: tuples }, () => ({ inserted: true }));
    }),
    fetchNotDealed: jest.fn(async () => [lot(1), lot(2), lot(3)]),
    logger: {
      log: (m) => logs.push(`LOG ${m}`),
      warn: (m) => logs.push(`WARN ${m}`),
      error: (m) => logs.push(`ERROR ${m}`),
    },
    ...over,
  };
  return { deps, queries, logs };
};

describe('syncNotDealed', () => {
  const clean = () => new Set<string>();

  /**
   * The buyer with the most failed lots has 858 and the request that fetched
   * all 858 was a single call. Writing them cost 858 round trips — the one
   * part of this sync that scaled with the company rather than with the work.
   */
  it('writes the whole page in one statement', async () => {
    const { deps, queries } = build();
    await expect(syncNotDealed(deps, '203195074', 3, clean())).resolves.toBe(3);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/^INSERT INTO public\.company_deals/);
    // Three tuples, one statement.
    expect(queries[0].sql.match(/\(\$/g)).toHaveLength(3);
  });

  /**
   * Lots already held used to be filtered out before the write, so a lot
   * whose details moved upstream stayed frozen at whatever it looked like
   * the day it was first seen. They are all written now; the count of new
   * ones comes from the statement instead.
   */
  it('writes the lots it already holds too', async () => {
    const { deps, queries } = build();
    const held = new Set([lot(1).display_no, lot(2).display_no]);
    await syncNotDealed(deps, '203195074', 3, held);
    expect(queries[0].sql.match(/\(\$/g)).toHaveLength(3);
  });

  it('counts as new only what the statement inserted', async () => {
    const rows = [{ inserted: true }, { inserted: false }, { inserted: false }];
    const { deps } = build({ query: jest.fn(async () => rows) });
    await expect(syncNotDealed(deps, '203195074', 3, clean())).resolves.toBe(1);
  });

  it('asks for nothing when the source says there are none', async () => {
    const { deps, queries } = build();
    await expect(syncNotDealed(deps, '203195074', 0, clean())).resolves.toBe(0);
    expect(queries).toHaveLength(0);
    expect(deps.fetchNotDealed).not.toHaveBeenCalled();
  });

  it('remembers what it wrote, so a second pass does not rewrite it', async () => {
    const { deps } = build();
    const seen = clean();
    await syncNotDealed(deps, '203195074', 3, seen);
    expect(seen.size).toBe(3);
  });

  /**
   * A batch trades per-row error isolation for speed. One malformed lot
   * should cost that lot, not the other eight hundred.
   */
  describe('when the batch is refused', () => {
    it('falls back to one row at a time', async () => {
      const seen: string[] = [];
      const query = jest.fn(async (sql: string) => {
        seen.push(sql);
        // Only the multi-row statement fails; the single-row retries work.
        if ((sql.match(/\(\$/g) ?? []).length > 1) {
          throw new Error('value too long for type character varying(16)');
        }
        return [];
      });
      const { deps } = build({ query });
      await expect(syncNotDealed(deps, '203195074', 3, clean())).resolves.toBe(
        3,
      );
      // The refused batch, then three single-row inserts.
      expect(seen).toHaveLength(4);
    });

    it('keeps the rows that are fine when one of them is not', async () => {
      const bad = lot(2).display_no;
      const query = jest.fn(async (sql: string, params?: unknown[]) => {
        const many = (sql.match(/\(\$/g) ?? []).length > 1;
        if (many) throw new Error('batch refused');
        if ((params ?? []).includes(bad)) throw new Error('bad row');
        return [];
      });
      const { deps } = build({ query });
      await expect(syncNotDealed(deps, '203195074', 3, clean())).resolves.toBe(
        2,
      );
    });

    it('does not claim the lot it failed to write', async () => {
      const bad = lot(2).display_no;
      const query = jest.fn(async (sql: string, params?: unknown[]) => {
        if ((sql.match(/\(\$/g) ?? []).length > 1) throw new Error('refused');
        if ((params ?? []).includes(bad)) throw new Error('bad row');
        return [];
      });
      const seen = clean();
      await syncNotDealed(build({ query }).deps, '203195074', 3, seen);
      // Marking it seen would mean it is never retried on a later pass.
      expect(seen.has(bad)).toBe(false);
    });
  });

  /**
   * There is no cap any more. Two stood here — 100 chosen by eye, then 2000
   * behind an environment variable — and a cap on what gets stored is a
   * decision to lose data on the company that has the most of it. The source
   * pages freely, so the pages are simply walked.
   */
  describe('no cap, only pages', () => {
    it('walks every page of a company with more than one', async () => {
      const { deps } = build();
      await syncNotDealed(deps, '203195074', 1200, clean());
      expect(deps.fetchNotDealed).toHaveBeenCalledTimes(3);
      expect(deps.fetchNotDealed).toHaveBeenNthCalledWith(
        1,
        '203195074',
        1,
        500,
      );
      expect(deps.fetchNotDealed).toHaveBeenNthCalledWith(
        2,
        '203195074',
        501,
        500,
      );
      // The last page asks only for what is left.
      expect(deps.fetchNotDealed).toHaveBeenNthCalledWith(
        3,
        '203195074',
        1001,
        200,
      );
    });

    it('asks for the real total when it fits in one page', async () => {
      const { deps } = build();
      await syncNotDealed(deps, '203195074', 3, clean());
      expect(deps.fetchNotDealed).toHaveBeenCalledWith('203195074', 1, 3);
    });

    it('stops early when a page comes back empty', async () => {
      // The source disagreeing with its own count is not a reason to keep
      // asking it the same question twelve more times.
      const fetchNotDealed = jest.fn(async () => []);
      const { deps } = build({ fetchNotDealed });
      await syncNotDealed(deps, '203195074', 5000, clean());
      expect(fetchNotDealed).toHaveBeenCalledTimes(1);
    });

    it('says how much it read against what the source claims', async () => {
      const { deps, logs } = build();
      await syncNotDealed(deps, '203195074', 3, clean());
      const line = logs.find((l) => l.includes('failed lot'));
      expect(line).toContain('3');
    });
  });
});

describe('notDealedInsertMany', () => {
  it('is null for an empty list, not an INSERT with no rows', () => {
    // `INSERT INTO t (cols) VALUES` is a syntax error, not a no-op.
    expect(notDealedInsertMany('203195074', [])).toBeNull();
  });

  it('names the same columns as the single-row builder', () => {
    const many = notDealedInsertMany('203195074', [lot(1)])!;
    const columns = many.sql.slice(
      many.sql.indexOf('(') + 1,
      many.sql.indexOf(')'),
    );
    expect(columns).toContain('lot_outcome');
    expect(columns).toContain('lot_status_name');
    expect(columns).toContain('is_completed');
  });

  it('sends one parameter per column per row', () => {
    const one = notDealedInsertMany('203195074', [lot(1)])!;
    const three = notDealedInsertMany('203195074', [lot(1), lot(2), lot(3)])!;
    expect(three.params).toHaveLength(one.params.length * 3);
  });

  it('keeps is_completed fixed rather than parameterised', () => {
    const many = notDealedInsertMany('203195074', [lot(1)])!;
    // It is what the column means here, not something a lot carries — the
    // tuple ends with the literal, and no parameter stands for it.
    expect(many.sql).toMatch(/, 0\) ON CONFLICT/);
    expect(many.params).not.toContain(0);
  });

  it('enriches a lot it already holds rather than refusing the batch', () => {
    const many = notDealedInsertMany('203195074', [lot(1)])!;
    // One lot already in the table used to reject all 858 beside it.
    expect(many.sql).toContain(
      'ON CONFLICT (inn, lot_display_no, deal_id, trade_id) DO UPDATE',
    );
    expect(many.sql).toContain(
      'lot_status_name = COALESCE(excluded.lot_status_name',
    );
  });
});
