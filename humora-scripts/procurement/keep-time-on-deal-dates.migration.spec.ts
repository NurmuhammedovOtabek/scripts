import { Logger } from '@nestjs/common';
import { KeepTimeOnDealDates1789500000000 } from '../../migrations/1789500000000-KeepTimeOnDealDates';

/**
 * The migration that gives `deal_date` and the lot dates their time back.
 *
 * It runs at boot against a table every company page reads, so what it must
 * never do matters as much as what it does: touch a column that already holds
 * a time, move the day a row has been showing, or throw.
 *
 * Kept beside the procurement code rather than in `src/migrations`, whose
 * files are loaded as migrations.
 */
describe('KeepTimeOnDealDates migration', () => {
  const run = async (
    dateColumns: string[],
    alter?: () => Promise<unknown>,
  ): Promise<string[]> => {
    const sql: string[] = [];
    const queryRunner = {
      query: jest.fn(async (q: string) => {
        sql.push(q);
        if (q.includes('information_schema.columns')) {
          return dateColumns.map((column_name) => ({ column_name }));
        }
        if (q.startsWith('ALTER TABLE') && alter) return alter();
        return [];
      }),
    };
    await new KeepTimeOnDealDates1789500000000().up(queryRunner as any);
    return sql;
  };

  const alterOf = (sql: string[]) =>
    sql.filter((q) => q.startsWith('ALTER TABLE'));

  it('leaves a table whose dates already carry a time alone', async () => {
    const sql = await run([]);
    expect(sql).toHaveLength(1);
    expect(alterOf(sql)).toEqual([]);
  });

  it('converts only the columns still stored as date, in one statement', async () => {
    const alters = alterOf(await run(['deal_date', 'lot_end_date']));
    expect(alters).toHaveLength(1);
    expect(alters[0]).toContain('ALTER COLUMN deal_date TYPE timestamptz');
    expect(alters[0]).toContain('ALTER COLUMN lot_end_date TYPE timestamptz');
    expect(alters[0]).not.toContain('lot_start_date');
  });

  /**
   * A day stored as `date` has been served as midnight UTC. Converting it in
   * the session's own zone would move it — to 19:00 the evening before, under
   * Asia/Tashkent — and every page reading the date part would show the
   * previous day.
   */
  it('pins a stored day to midnight UTC, whatever the session zone', async () => {
    const [alter] = alterOf(await run(['deal_date']));
    expect(alter).toContain("USING (deal_date::timestamp AT TIME ZONE 'UTC')");
  });

  it('bounds the wait for the lock and the rewrite, and puts both back', async () => {
    const sql = await run(['deal_date']);
    const at = sql.findIndex((q) => q.startsWith('ALTER TABLE'));
    expect(sql.slice(1, at)).toEqual([
      "SET lock_timeout = '10s'",
      "SET statement_timeout = '5min'",
    ]);
    expect(sql.slice(at + 1)).toEqual([
      'RESET lock_timeout',
      'RESET statement_timeout',
    ]);
  });

  /**
   * A migration that throws keeps the container from starting. Dates without
   * their time for another day is the smaller failure.
   */
  it('logs a refused ALTER instead of throwing, and still resets', async () => {
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const sql = await run(['deal_date'], () =>
        Promise.reject(new Error('canceling statement due to lock timeout')),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('lock timeout'),
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('ALTER TABLE public.company_deals'),
      );
      expect(sql.slice(-2)).toEqual([
        'RESET lock_timeout',
        'RESET statement_timeout',
      ]);
    } finally {
      warn.mockRestore();
    }
  });
});
