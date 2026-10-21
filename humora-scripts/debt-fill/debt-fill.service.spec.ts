import { DebtFillService } from './debt-fill.service';

/**
 * The two things that stop the nightly walk running more than once.
 *
 * On 2026-08-11 it ran three times over one night: ~2,100 checks that landed
 * on ~625 distinct companies, and three times the traffic to captcha-gated
 * sources the website shares a queue with. The scheduler was registering every
 * cron three times, and nothing inside this service stopped the extra calls
 * before they reached the database.
 */
describe('DebtFillService — one run at a time', () => {
  const make = (opts: { lockGranted?: boolean } = {}) => {
    const lockGranted = opts.lockGranted ?? true;
    const sql: string[] = [];

    const db = {
      query: jest.fn((q: string) => {
        sql.push(q);
        if (q.includes('RETURNING 1'))
          return Promise.resolve(lockGranted ? [1] : []);
        if (q.includes('SELECT * FROM public.debt_fill_cursor')) {
          return Promise.resolve([{ last_inn: null, completed_cycles: 0 }]);
        }
        // Every batch query answers empty, so the walk ends immediately and
        // the test does not depend on what time of day it runs.
        return Promise.resolve([]);
      }),
    };
    const tg = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new DebtFillService(
      db as any,
      { checkByInn: jest.fn() } as any,
      { checkDebtByInn: jest.fn() } as any,
      tg as any,
    );
    return { service, db, tg, sql };
  };

  /** Lets the fire-and-forget walk settle before assertions. */
  const settle = () => new Promise((r) => setImmediate(r));

  it('lets one of three simultaneous calls through', async () => {
    // The exact shape of the failure: three cron registrations firing in the
    // same tick. Before the flag was claimed synchronously, all three got past
    // it and only the row lock stood between them and a walk.
    const { service } = make();

    const results = await Promise.all([
      service.run(),
      service.run(),
      service.run(),
    ]);
    await settle();

    expect(results.map((r) => r.status).sort()).toEqual([
      'already_running',
      'already_running',
      'started',
    ]);
  });

  it('reaches the lock once, not once per caller', async () => {
    const { service, sql } = make();

    await Promise.all([service.run(), service.run(), service.run()]);
    await settle();

    expect(sql.filter((q) => q.includes('RETURNING 1'))).toHaveLength(1);
  });

  it('gives the flag back when another replica holds the lock', async () => {
    // Without this the replica reports "running" forever with nothing running,
    // and sits out every night until someone restarts it.
    const { service, tg } = make({ lockGranted: false });

    expect((await service.run()).status).toBe('locked');
    expect(tg.send).toHaveBeenCalledWith(expect.stringContaining('skipped'), {
      tag: 'debt_fill',
    });

    // The flag is free again, so a later attempt still reaches the lock.
    expect((await service.run()).status).toBe('locked');
  });

  it('takes the lock before walking, never after', async () => {
    const { service, sql } = make();
    await service.run();
    await settle();

    const lock = sql.findIndex((q) => q.includes('RETURNING 1'));
    const read = sql.findIndex((q) =>
      q.includes('SELECT * FROM public.debt_fill_cursor'),
    );
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(read).toBeGreaterThan(lock);
  });
});

/**
 * The controls, and the one question they exist to answer.
 *
 * On the night of 2026-08-19 the container restarted at 02:52 and took the
 * walk with it. Nothing said so: the finished report is sent by the walk, the
 * crash report needs a JavaScript error, and a killed process produces
 * neither. The lock stayed in the table with nobody holding it, and the state
 * could only be read with a database client in hand.
 */
describe('DebtFillService — controls and status', () => {
  const make = (cursorRow: Record<string, any> = {}) => {
    const db = {
      query: jest.fn((q: string) => {
        if (q.includes('RETURNING 1')) return Promise.resolve([1]);
        if (q.includes('SELECT * FROM public.debt_fill_cursor')) {
          return Promise.resolve([
            { last_inn: null, completed_cycles: 0, ...cursorRow },
          ]);
        }
        return Promise.resolve([]);
      }),
    };
    const tg = { send: jest.fn().mockResolvedValue(undefined) };
    const service = new DebtFillService(
      db as any,
      { checkByInn: jest.fn() } as any,
      { checkDebtByInn: jest.fn() } as any,
      tg as any,
    );
    return { service, db, tg };
  };

  it('says whether the stop caught anything', () => {
    const { service } = make();

    // The old return was a bare `{ stopped: true }`, which reads the same
    // whether it ended a walk or was shouting into an empty room.
    expect(service.stop()).toEqual({ stopped: true, wasRunning: false });

    (service as any).running = true;
    expect(service.stop()).toEqual({ stopped: true, wasRunning: true });
  });

  it('reports the database lock apart from the process flag', async () => {
    const { service } = make({
      run_owner: '68b6144ae8f7:1',
      run_lock_at: new Date(Date.now() - 3 * 3_600_000).toISOString(),
    });

    const s = await service.status();

    // This exact disagreement is the restart signature: the table still names
    // an owner, and no walk exists in this process to match it.
    expect(s.running).toBe(false);
    expect(s.lock.owner).toBe('68b6144ae8f7:1');
    expect(s.lock.stale).toBe(false);
    expect(s.lock.held_for).toBe('3h 0m');
  });

  it('calls a lock past the stale window stale', async () => {
    const { service } = make({
      run_owner: 'x:1',
      run_lock_at: new Date(Date.now() - 13 * 3_600_000).toISOString(),
    });

    // Worth reporting because it means the leftover needs no clearing — the
    // next start takes it anyway, so nobody has to reach for psql.
    expect((await service.status()).lock.stale).toBe(true);
  });

  it('announces a night that never started', async () => {
    const { service, tg } = make();
    (service as any).running = true; // a flag left standing by a killed walk

    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await service.nightly();
    } finally {
      process.env.NODE_ENV = prev;
    }

    expect(tg.send).toHaveBeenCalledWith(
      expect.stringContaining('did not start'),
      { tag: 'debt_fill' },
    );
  });
});
