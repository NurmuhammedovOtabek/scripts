import { AuctionSyncService } from './auction-sync.service';

/**
 * Two things matter here. A page must be written without erasing what the
 * other endpoint already wrote, and the nightly pass must know when to stop —
 * the thin endpoint has no date filter, so "stop at the first page I already
 * hold" is the only thing keeping it from walking 219k rows every night.
 */
describe('AuctionSyncService', () => {
  const deal = (over: Record<string, unknown> = {}) =>
    ({
      deal_id: 1,
      lot_id: 10,
      lot_display_no: null,
      customer_inn: '111111111',
      customer_name: 'X',
      customer_region: null,
      provider_inn: '222222222',
      provider_name: 'Y',
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
      date_ini: '2026-09-10',
      cost: 500,
      start_cost: 900,
      status: 'Оплачен',
      region_name: null,
      district_name: null,
      ...over,
    }) as never;

  const build = (over: Record<string, any> = {}) => {
    const db = { query: jest.fn().mockResolvedValue([]), ...over.db };
    const api = {
      countDeals: jest.fn().mockResolvedValue(1000),
      countCompleted: jest.fn().mockResolvedValue(0),
      fetchDeals: jest.fn().mockResolvedValue([]),
      fetchCompleted: jest.fn().mockResolvedValue([]),
      ...over.api,
    };
    // Every nightly run ends in a Telegram message; the tests watch what it
    // says, so it is a spy rather than an empty stub.
    const telegram = {
      send: jest.fn().mockResolvedValue(undefined),
      ...over.telegram,
    };
    return {
      db,
      api,
      telegram,
      svc: new AuctionSyncService(db as never, api as never, telegram as never),
    };
  };

  /** Everything the alert said, joined — the tests assert on substrings. */
  const alertText = (telegram: { send: jest.Mock }) =>
    telegram.send.mock.calls.map((c) => String(c[0])).join('\n');

  const cursorDb = (last_from: number, finished_at: Date | null = null) => ({
    query: jest
      .fn()
      .mockImplementation((sql: string) =>
        sql.includes('auction_fill_cursor') && sql.includes('SELECT')
          ? Promise.resolve([{ last_from, rows_written: '0', finished_at }])
          : Promise.resolve([]),
      ),
  });

  describe('save', () => {
    it('writes nothing for an empty page', async () => {
      const { svc, db } = build();
      await expect(svc.save([])).resolves.toEqual({ inserted: 0, updated: 0 });
      expect(db.query).not.toHaveBeenCalled();
    });

    it('skips a row with no id to key on', async () => {
      const { svc, db } = build();
      await expect(svc.save([deal({ deal_id: 0 })])).resolves.toEqual({
        inserted: 0,
        updated: 0,
      });
      expect(db.query).not.toHaveBeenCalled();
    });

    it('upserts on deal_id, the key both endpoints agree on', async () => {
      const { svc, db } = build();
      await svc.save([deal()]);
      expect(db.query.mock.calls[0][0]).toContain('ON CONFLICT (deal_id)');
    });

    it('never blanks a column the other endpoint filled', async () => {
      const { svc, db } = build();
      await svc.save([deal()]);
      const sql = db.query.mock.calls[0][0];
      // A thin row carries no treasury columns. Without COALESCE it would
      // erase them from a row the rich endpoint had already enriched.
      expect(sql).toContain(
        'kazna_status = COALESCE(excluded.kazna_status, public.company_auction_deals.kazna_status)',
      );
      expect(sql).not.toContain('deal_id = COALESCE');
    });

    it('sends one parameter per column per row', async () => {
      const { svc, db } = build();
      await svc.save([deal({ deal_id: 1 }), deal({ deal_id: 2 })]);
      const [sql, params] = db.query.mock.calls[0];
      const columns = (sql.match(/\(([^)]*)\)/)?.[1] ?? '').split(',').length;
      expect(params).toHaveLength(columns * 2);
    });

    it('counts new rows apart from ones it already held', async () => {
      const { svc } = build({
        db: {
          query: jest
            .fn()
            .mockResolvedValue([
              { inserted: true },
              { inserted: false },
              { inserted: false },
            ]),
        },
      });
      // Reporting the page size instead read as "3 written" on a pass that
      // had found one thing.
      await expect(
        svc.save([
          deal({ deal_id: 1 }),
          deal({ deal_id: 2 }),
          deal({ deal_id: 3 }),
        ]),
      ).resolves.toEqual({ inserted: 1, updated: 2 });
    });

    it('asks Postgres which rows it actually inserted', async () => {
      const { svc, db } = build();
      await svc.save([deal()]);
      expect(db.query.mock.calls[0][0]).toContain('RETURNING (xmax = 0)');
    });
  });

  describe('increment — knowing when to stop', () => {
    const page = (ids: number[]) => ids.map((id) => deal({ deal_id: id }));

    it('stops as soon as a page is entirely familiar', async () => {
      const { svc, api } = build({
        api: { fetchDeals: jest.fn().mockResolvedValue(page([1, 2])) },
        db: {
          query: jest
            .fn()
            .mockImplementation((sql: string) =>
              sql.includes('SELECT deal_id')
                ? Promise.resolve([{ deal_id: '1' }, { deal_id: '2' }])
                : Promise.resolve([]),
            ),
        },
      });
      await svc.increment();
      // One page, then stop — not the twenty the loop would allow.
      expect(api.fetchDeals).toHaveBeenCalledTimes(1);
    });

    it('keeps going while a page still holds something new', async () => {
      const { svc, api } = build({
        api: {
          fetchDeals: jest
            .fn()
            .mockResolvedValueOnce(page([1, 2]))
            .mockResolvedValueOnce(page([3, 4]))
            .mockResolvedValue([]),
        },
      });
      await svc.increment();
      expect(api.fetchDeals).toHaveBeenCalledTimes(3);
    });

    it('asks the rich endpoint for two days, not one', async () => {
      const { svc, api } = build({
        api: { countCompleted: jest.fn().mockResolvedValue(16) },
      });
      await svc.increment();
      const range = api.countCompleted.mock.calls[0][0];
      const days = Math.round(
        (range.to.getTime() - range.from.getTime()) / 86_400_000,
      );
      // A deal recorded late yesterday is invisible to a job that only ever
      // asks about today.
      expect(days).toBe(1);
    });

    it('reads no pages from the rich endpoint when its range is empty', async () => {
      const { svc, api } = build();
      await svc.increment();
      expect(api.fetchCompleted).not.toHaveBeenCalled();
    });
  });

  describe('backfill', () => {
    it('walks from the cursor and moves it on', async () => {
      const { svc, db, api } = build({
        api: {
          countDeals: jest.fn().mockResolvedValue(1000),
          fetchDeals: jest.fn().mockResolvedValue([deal()]),
        },
        db: cursorDb(501),
      });
      const state = await svc.backfill(1);
      expect(api.fetchDeals).toHaveBeenCalledWith(501, 500);
      expect(state.from).toBe(1001);
      expect(
        db.query.mock.calls.some((c: string[]) => /last_from = \$1/.test(c[0])),
      ).toBe(true);
    });

    it('marks itself finished once past the end', async () => {
      const { svc, db } = build({
        api: { countDeals: jest.fn().mockResolvedValue(100) },
        db: cursorDb(501),
      });
      const state = await svc.backfill(1);
      expect(state.done).toBe(true);
      expect(
        db.query.mock.calls.some((c: string[]) =>
          /finished_at = now/.test(c[0]),
        ),
      ).toBe(true);
    });

    it('stops early when the endpoint runs out mid-run', async () => {
      const { svc, api } = build({
        api: {
          countDeals: jest.fn().mockResolvedValue(100000),
          fetchDeals: jest.fn().mockResolvedValue([]),
        },
        db: cursorDb(1),
      });
      await svc.backfill(10);
      expect(api.fetchDeals).toHaveBeenCalledTimes(1);
    });
  });

  describe('findByInn — the question the source cannot answer', () => {
    it('matches a company on either side of the deal', async () => {
      const { svc, db } = build({
        db: {
          query: jest
            .fn()
            .mockImplementation((sql: string) =>
              sql.includes('COUNT')
                ? Promise.resolve([{ total: 3 }])
                : Promise.resolve([{ deal_id: 1 }]),
            ),
        },
      });
      const out = await svc.findByInn('312387381');
      expect(out.total).toBe(3);
      expect(db.query.mock.calls[0][0]).toContain(
        '(customer_inn = $1 OR provider_inn = $1)',
      );
    });

    it('asks nothing at all for an empty STIR', async () => {
      const { svc, db } = build();
      await expect(svc.findByInn('')).resolves.toEqual({ rows: [], total: 0 });
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  /**
   * A company sits on one side of an auction or the other, and the source
   * cannot be asked which — the whole table is ours to filter.
   */
  describe('findByInn — filtering our own mirror', () => {
    const sqlOf = (db: { query: jest.Mock }) =>
      db.query.mock.calls.map((c) => String(c[0])).join(' ');

    it('looks at both sides when no side is named', async () => {
      const { svc, db } = build();
      await svc.findByInn('311950878');
      expect(sqlOf(db)).toContain('(customer_inn = $1 OR provider_inn = $1)');
    });

    it.each([
      ['customer', 'customer_inn = $1'],
      ['provider', 'provider_inn = $1'],
    ])('narrows to %s', async (role, expected) => {
      const { svc, db } = build();
      await svc.findByInn('311950878', 10, 0, { role: role as never });
      const sql = sqlOf(db);
      expect(sql).toContain(expected);
      expect(sql).not.toContain(' OR provider_inn');
    });

    it('adds the outcome to the side, rather than replacing it', async () => {
      const { svc, db } = build();
      await svc.findByInn('311950878', 10, 0, {
        role: 'provider',
        outcome: 'done',
      });
      const sql = sqlOf(db);
      expect(sql).toContain('provider_inn = $1');
      expect(sql).toContain('AND');
      expect(sql).toContain('COALESCE(status, kazna_status');
    });

    it('keeps LIMIT and OFFSET past the filter parameters', async () => {
      const { svc, db } = build();
      await svc.findByInn('311950878', 10, 20, { outcome: 'cancelled' });
      const [sql, params] = db.query.mock.calls[0];
      // The status words occupy $2 onward; the page has to come after them.
      const limitSlot = Number(/LIMIT \$(\d+)/.exec(sql)![1]);
      expect(limitSlot).toBeGreaterThan(1);
      expect(params[limitSlot - 1]).toBe(10);
      expect(params[limitSlot]).toBe(20);
    });

    it('counts what it lists, with the same filter', async () => {
      const { svc, db } = build();
      await svc.findByInn('311950878', 10, 0, { outcome: 'expired' });
      const [list, count] = db.query.mock.calls.map((c) => String(c[0]));
      // A count that ignored the filter would page a number nobody can reach.
      expect(count).toContain('COUNT(*)');
      for (const fragment of ['истек', 'customer_inn = $1']) {
        expect(list.includes(fragment)).toBe(count.includes(fragment));
      }
    });

    it('asks nothing for an empty STIR', async () => {
      const { svc, db } = build();
      await expect(svc.findByInn('')).resolves.toEqual({ rows: [], total: 0 });
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  describe('the nightly cron', () => {
    const withEnv = async (
      value: string | undefined,
      fn: () => Promise<void>,
      forced?: string,
    ) => {
      const beforeEnv = process.env.NODE_ENV;
      const beforeFlag = process.env.AUCTION_CRON_ENABLED;
      process.env.NODE_ENV = value;
      // Restored either way, or one test's flag leaks into the next.
      if (forced === undefined) delete process.env.AUCTION_CRON_ENABLED;
      else process.env.AUCTION_CRON_ENABLED = forced;
      try {
        await fn();
      } finally {
        process.env.NODE_ENV = beforeEnv;
        if (beforeFlag === undefined) delete process.env.AUCTION_CRON_ENABLED;
        else process.env.AUCTION_CRON_ENABLED = beforeFlag;
      }
    };

    it('does not run outside production', async () => {
      const { svc, db } = build();
      await withEnv('development', () => svc.nightly());
      // A dev container walking the catalogue helps nobody and costs the
      // source the same as a real one.
      expect(db.query).not.toHaveBeenCalled();
    });

    it('runs outside production when the flag is set', async () => {
      const runner = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([{ locked: true }]),
        release: jest.fn().mockResolvedValue(undefined),
      };
      const { svc, api } = build({
        db: { createQueryRunner: jest.fn().mockReturnValue(runner) },
      });
      // How the test environment exercises the nightly pass before it is
      // trusted in production.
      await withEnv('development', () => svc.nightly(), '1');
      expect(api.fetchDeals).toHaveBeenCalled();
    });

    it('stays put for any value other than exactly "1"', async () => {
      const { svc, db } = build();
      await withEnv('development', () => svc.nightly(), 'true');
      expect(db.query).not.toHaveBeenCalled();
    });

    it('updates the day and does not touch the backfill', async () => {
      const runner = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([{ locked: true }]),
        release: jest.fn().mockResolvedValue(undefined),
      };
      const { svc, api, db } = build({
        db: {
          createQueryRunner: jest.fn().mockReturnValue(runner),
          query: jest.fn().mockResolvedValue([]),
        },
      });
      await withEnv('production', () => svc.nightly());

      // The daily update ran…
      expect(api.fetchDeals).toHaveBeenCalled();
      // …and the historical load did not come along with it. It used to,
      // which turned a one-off first load into eleven nights of five-minute
      // runs.
      //
      // The cursor is what says so. `countDeals` used to stand in for it and
      // no longer can: the nightly message asks the source for its size, to
      // tell a finished mirror from a half-finished one.
      expect(
        db.query.mock.calls.some((c: string[]) =>
          /auction_fill_cursor/.test(c[0]),
        ),
      ).toBe(false);
    });

    it('gives way when another replica holds the lock', async () => {
      const runner = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([{ locked: false }]),
        release: jest.fn().mockResolvedValue(undefined),
      };
      const { svc, api } = build({
        db: { createQueryRunner: jest.fn().mockReturnValue(runner) },
      });
      await withEnv('production', () => svc.nightly());
      expect(api.fetchDeals).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalled();
    });

    it('releases the lock even when the run throws', async () => {
      const runner = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest
          .fn()
          .mockResolvedValueOnce([{ locked: true }])
          .mockResolvedValue([]),
        release: jest.fn().mockResolvedValue(undefined),
      };
      const { svc } = build({
        db: {
          createQueryRunner: jest.fn().mockReturnValue(runner),
          query: jest.fn().mockRejectedValue(new Error('db gone')),
        },
        api: { countCompleted: jest.fn().mockRejectedValue(new Error('down')) },
      });
      await withEnv('production', () => svc.nightly());
      const unlocked = runner.query.mock.calls.some((c: string[]) =>
        c[0].includes('pg_advisory_unlock'),
      );
      expect(unlocked).toBe(true);
      expect(runner.release).toHaveBeenCalled();
    });
  });

  /**
   * The nightly message.
   *
   * A cron that silently stops is the failure mode this whole job has: it
   * runs unattended at 21:00 and nobody looks at the container log. So the
   * night has to say something either way, and "0 new" is not enough on its
   * own — that is equally what a working night with no new auctions and a
   * job that never reached the source look like.
   */
  describe('what the nightly run reports', () => {
    const lockedRunner = () => ({
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest
        .fn()
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValue([]),
      release: jest.fn().mockResolvedValue(undefined),
    });

    const runNightly = async (over: Record<string, any> = {}) => {
      const runner = lockedRunner();
      const built = build({
        ...over,
        db: {
          createQueryRunner: jest.fn().mockReturnValue(runner),
          query: jest.fn().mockResolvedValue([{ n: 26000 }]),
          ...over.db,
        },
      });
      const before = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await built.svc.nightly();
      } finally {
        process.env.NODE_ENV = before;
      }
      return built;
    };

    it('reports a night that found something', async () => {
      const { telegram } = await runNightly({
        api: {
          countCompleted: jest.fn().mockResolvedValue(1),
          fetchCompleted: jest.fn().mockResolvedValueOnce([deal()]),
          fetchDeals: jest.fn().mockResolvedValue([]),
        },
      });
      const text = alertText(telegram);
      expect(text).toContain('Auction daily sync');
      expect(text).toContain('Pages read');
      expect(text).toContain('26000');
    });

    it('calls out a night that reached nothing, rather than calling it a success', async () => {
      // Nothing threw — but no page was read either, which is what a broken
      // source looks like from in here.
      const { telegram } = await runNightly({
        api: {
          countCompleted: jest.fn().mockResolvedValue(0),
          fetchDeals: jest.fn().mockResolvedValue([]),
        },
      });
      const text = alertText(telegram);
      expect(text).toContain('⚠️');
      expect(text).toContain('nothing came back from the source');
      expect(text).not.toContain('✅');
    });

    /**
     * The first night in the test environment looked like this: the table was
     * empty, so no page was ever familiar, the walk spent its whole 20-page
     * budget, took 129 seconds instead of eight, and reported ✅ with "10000
     * new". Every number was true and the headline was wrong — the pass had
     * not caught up, it had run out of room, and nothing said so.
     */
    it('flags a pass that ran out of pages before meeting a familiar deal', async () => {
      const page = Array.from({ length: 500 }, (_, i) =>
        deal({ deal_id: 100000 + i }),
      );
      const { telegram, api } = await runNightly({
        api: {
          countCompleted: jest.fn().mockResolvedValue(0),
          // Always new, never recognised — the stop condition never fires.
          fetchDeals: jest.fn().mockResolvedValue(page),
        },
      });
      expect(api.fetchDeals).toHaveBeenCalledTimes(20);
      const text = alertText(telegram);
      expect(text).toContain('⚠️');
      expect(text).toContain('hit the page cap');
      expect(text).toContain('backfill');
      expect(text).not.toContain('✅');
    });

    it('does not flag a pass that did meet a familiar deal', async () => {
      const { telegram } = await runNightly({
        api: {
          countCompleted: jest.fn().mockResolvedValue(0),
          fetchDeals: jest.fn().mockResolvedValue([deal({ deal_id: 7 })]),
        },
        db: {
          // The one row on the page is already ours, so the walk stops.
          query: jest
            .fn()
            .mockImplementation((sql: string) =>
              sql.includes('SELECT deal_id')
                ? Promise.resolve([{ deal_id: '7' }])
                : Promise.resolve([{ n: 26000 }]),
            ),
        },
      });
      const text = alertText(telegram);
      expect(text).toContain('✅');
      expect(text).not.toContain('hit the page cap');
    });

    it('counts an exhausted source as caught up, not as a cap', async () => {
      const { telegram } = await runNightly({
        api: {
          countCompleted: jest.fn().mockResolvedValue(0),
          fetchDeals: jest
            .fn()
            .mockResolvedValueOnce([deal({ deal_id: 7 })])
            .mockResolvedValue([]),
        },
      });
      // The source ran out before we did — there is nothing left to miss.
      expect(alertText(telegram)).not.toContain('hit the page cap');
    });

    /**
     * The state last night's run leaves behind, and the one the cap warning
     * cannot see.
     *
     * Tonight the newest slice is already ours, so the walk meets a familiar
     * page and stops: correct, fast, and green — on top of a table holding a
     * tenth of the catalogue, because a pass that always starts from the
     * newest row can never reach the years behind it. Without this the alert
     * goes quiet exactly when the backfill is still owed.
     */
    describe('a mirror that is current but not complete', () => {
      const sized = (held: number, upstream: number) => ({
        db: {
          query: jest
            .fn()
            .mockImplementation((sql: string) =>
              sql.includes('SELECT deal_id')
                ? Promise.resolve([{ deal_id: '7' }])
                : Promise.resolve([{ n: held }]),
            ),
        },
        api: {
          countCompleted: jest.fn().mockResolvedValue(0),
          countDeals: jest.fn().mockResolvedValue(upstream),
          fetchDeals: jest.fn().mockResolvedValue([deal({ deal_id: 7 })]),
        },
      });

      it('says so when the table holds a fraction of the source', async () => {
        const { telegram } = await runNightly(sized(26014, 219156));
        const text = alertText(telegram);
        expect(text).toContain('⚠️');
        expect(text).toContain('history incomplete');
        expect(text).toContain('12%');
        expect(text).toContain('backfill');
      });

      it('stays quiet once the mirror is close enough', async () => {
        const { telegram } = await runNightly(sized(219000, 219156));
        const text = alertText(telegram);
        expect(text).toContain('✅');
        expect(text).not.toContain('history incomplete');
      });

      it('does not cry wolf when our count runs slightly ahead', async () => {
        // The two sides are counted at different moments, and the rich
        // endpoint can hold a deal the thin history has not listed.
        const { telegram } = await runNightly(sized(219200, 219156));
        expect(alertText(telegram)).toContain('✅');
      });

      it('carries both numbers so the gap is legible', async () => {
        const { telegram } = await runNightly(sized(26014, 219156));
        expect(alertText(telegram)).toContain('26014 / upstream 219156');
      });

      it('still reports when the source will not give its size', async () => {
        const over = sized(26014, 0);
        over.api.countDeals = jest.fn().mockRejectedValue(new Error('down'));
        const { telegram } = await runNightly(over);
        const text = alertText(telegram);
        // Not knowing is not a reason to call the night a failure.
        expect(text).toContain('✅');
        expect(text).not.toContain('upstream');
      });
    });

    it('reports a failure with the reason', async () => {
      const { telegram } = await runNightly({
        api: {
          countCompleted: jest
            .fn()
            .mockRejectedValue(new Error('socket hang up')),
        },
      });
      const text = alertText(telegram);
      expect(text).toContain('❌');
      expect(text).toContain('socket hang up');
    });

    it('escapes an error message that would break the HTML send', async () => {
      const { telegram } = await runNightly({
        api: {
          countCompleted: jest
            .fn()
            .mockRejectedValue(new Error('bad <tag> & thing')),
        },
      });
      const text = alertText(telegram);
      expect(text).toContain('&lt;tag&gt;');
      expect(text).not.toContain('<tag>');
    });

    it('says nothing when another replica holds the lock', async () => {
      const runner = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue([{ locked: false }]),
        release: jest.fn().mockResolvedValue(undefined),
      };
      const { svc, telegram } = build({
        db: { createQueryRunner: jest.fn().mockReturnValue(runner) },
      });
      const before = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        await svc.nightly();
      } finally {
        process.env.NODE_ENV = before;
      }
      // Three replicas would otherwise send two "skipped" messages a night,
      // and an alert channel nobody reads is worse than none.
      expect(telegram.send).not.toHaveBeenCalled();
    });

    it('a dead bot token does not fail the sync', async () => {
      const { telegram } = await runNightly({
        telegram: {
          send: jest.fn().mockRejectedValue(new Error('telegram down')),
        },
        api: {
          countCompleted: jest.fn().mockResolvedValue(0),
          fetchDeals: jest.fn().mockResolvedValue([]),
        },
      });
      // Reached the send and swallowed its failure — the rows were still saved.
      expect(telegram.send).toHaveBeenCalled();
    });
  });
});
