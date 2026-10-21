import {
  ContactFillService,
  scheduledFillEnabled,
} from './contact-fill.service';
import {
  StatRegistryNotFoundError,
  StatRegistryThrottledError,
} from '../stat-registry/stat-registry.service';
import type { CompanyInfoFields } from '../stat-registry/stat-registry.parser';

/**
 * Three things this has to keep straight, because each one costs something
 * different when it goes wrong: a company the register does not know (a slot
 * spent for nothing, repeatedly, if counted as a failure), a queue that is
 * full (page views waiting behind a backfill), and a contact we already hold
 * (overwritten by a second opinion from the same source).
 */
describe('ContactFillService', () => {
  const record = (over: Partial<CompanyInfoFields> = {}): CompanyInfoFields =>
    ({
      phone: '+998901112233',
      email: 'info@test.uz',
      region: 'Toshkent shahri',
      city: 'Chilonzor tumani',
      ...over,
    }) as CompanyInfoFields;

  interface Setup {
    /** STIRs the walk should find, newest first. */
    targets?: string[];
    /** What stat.uz answers per STIR. */
    answers?: Record<string, CompanyInfoFields | Error | null>;
    /** Rows the UPDATE reports as actually changed. */
    updated?: Record<string, boolean>;
    /** STIRs whose contact UPDATE the database refuses. */
    refused?: string[];
    locked?: boolean;
    /** What `yield_requested` reads — the recheck asking for the slot. */
    yieldRequested?: boolean;
  }

  function make(setup: Setup = {}) {
    const {
      targets = [],
      answers = {},
      updated = {},
      refused = [],
      locked = false,
      yieldRequested = false,
    } = setup;

    const queries: Array<{ sql: string; params: any[] }> = [];
    const db = {
      // UPDATEs answer the way TypeORM really does: [rows, rowCount]. The old
      // mock returned bare rows, which is how `.length` on the raw answer —
      // always 2 in production — passed here.
      query: jest.fn(async (sql: string, params: any[] = []) => {
        queries.push({ sql, params });
        if (sql.includes('SET run_lock_at = now()')) {
          return locked ? [[], 0] : [[{}], 1];
        }
        if (sql.includes('SELECT yield_requested')) {
          return [{ yield_requested: yieldRequested }];
        }
        if (sql.includes('FROM public.contact_fill_cursor')) {
          return [{ last_inn: null }];
        }
        if (sql.includes('SELECT ci.inn')) {
          return targets.map((inn) => ({ inn }));
        }
        if (sql.includes('UPDATE public.company_info')) {
          const inn = params[0];
          if (refused.includes(inn)) {
            throw new Error('value too long for type character varying(30)');
          }
          return updated[inn] === false
            ? [[], 0]
            : [[{ phone: params[1], email: params[2] }], 1];
        }
        return [[], 0];
      }),
    };

    const asked: string[] = [];
    const stat = {
      fetch: jest.fn(async (inn: string) => {
        asked.push(inn);
        if (!(inn in answers)) return record();
        const a = answers[inn];
        if (a instanceof Error) throw a;
        return a;
      }),
    };

    const telegram = {
      send: jest.fn<Promise<boolean>, [string]>().mockResolvedValue(true),
    };

    const service = new ContactFillService(
      db as any,
      stat as any,
      telegram as any,
    );
    return { service, db, stat, telegram, queries, asked };
  }

  it('asks the register about every recent company with no contacts', async () => {
    const { service, asked } = make({ targets: ['300000001', '300000002'] });
    const run = await service.start({}, 'test');
    await run.done;
    expect(asked).toEqual(['300000001', '300000002']);
    expect(service.status().last).toMatchObject({ asked: 2, filled: 2 });
  });

  it('fills rather than overwrites: a contact already held is kept', async () => {
    const { service, queries } = make({ targets: ['300000001'] });
    const run = await service.start({}, 'test');
    await run.done;

    const update = queries.find((q) =>
      q.sql.includes('UPDATE public.company_info'),
    )!;
    // both directions: existing value wins, and an empty answer erases nothing
    expect(update.sql).toContain(
      "phone      = COALESCE(nullif(btrim(phone), ''), $2)",
    );
    expect(update.sql).toContain('IS NULL AND $2::text IS NOT NULL');
  });

  it('counts a company the register does not know as absent, not failed', async () => {
    const { service } = make({
      targets: ['300000001'],
      answers: {
        '300000001': new StatRegistryNotFoundError('no such company'),
      },
    });
    const run = await service.start({}, 'test');
    await run.done;
    expect(service.status().last).toMatchObject({
      absent: 1,
      failed: 0,
      asked: 1,
    });
  });

  it('counts an ordinary error as failed and keeps going', async () => {
    const { service, asked } = make({
      targets: ['300000001', '300000002'],
      answers: { '300000001': new Error('gateway blew up') },
    });
    const run = await service.start({}, 'test');
    await run.done;
    expect(asked).toEqual(['300000001', '300000002']);
    expect(service.status().last).toMatchObject({ failed: 1, filled: 1 });
  });

  it('survives a record-less answer — the production crash of 2026-09-28', async () => {
    // "Cannot read properties of null (reading 'phone')" ended the whole run.
    const { service, asked, telegram } = make({
      targets: ['300000001', '300000002'],
      answers: { '300000001': null },
    });
    const run = await service.start({}, 'test');
    await run.done;
    expect(asked).toEqual(['300000001', '300000002']);
    expect(service.status().last).toMatchObject({ failed: 1, filled: 1 });
    expect(telegram.send.mock.calls[0][0]).not.toMatch(/run failed/);
  });

  it('counts a refused write as one failure and keeps going', async () => {
    const { service } = make({
      targets: ['300000001', '300000002'],
      refused: ['300000001'],
    });
    const run = await service.start({}, 'test');
    await run.done;
    expect(service.status().last).toMatchObject({ failed: 1, filled: 1 });
  });

  it('reports in English, and says a failed run is a failed run', async () => {
    const { service, telegram, stat } = make({ targets: ['300000001'] });
    stat.fetch.mockImplementation(async () => record());
    const run = await service.start({}, 'new-company scan');
    await run.done;
    const text = telegram.send.mock.calls[0][0] as string;
    expect(text).toMatch(/Contact fill \(new-company scan\)/);
    expect(text).toMatch(/Filled: 1 \(phone 1, email 1\)/);
  });

  it('stands down instead of hammering a full queue', async () => {
    jest.useFakeTimers();
    const { service, stat } = make({
      targets: ['300000001'],
      answers: { '300000001': new StatRegistryThrottledError('queue full') },
    });
    const run = await service.start({}, 'test');
    await jest.runAllTimersAsync();
    await run.done;
    jest.useRealTimers();

    // five waits, then it leaves the rest of the window to the next run
    expect(stat.fetch).toHaveBeenCalledTimes(5);
    expect(service.status().last).toMatchObject({ gaveUp: true, asked: 0 });
  });

  it('does not report a row it did not change as filled', async () => {
    const { service } = make({
      targets: ['300000001'],
      updated: { '300000001': false },
    });
    const run = await service.start({}, 'test');
    await run.done;
    expect(service.status().last).toMatchObject({ asked: 1, filled: 0 });
  });

  it('writes nothing when the register answers with no contacts at all', async () => {
    const { service, queries } = make({
      targets: ['300000001'],
      answers: {
        '300000001': record({
          phone: null,
          email: null,
          region: null,
          city: null,
        }),
      },
    });
    const run = await service.start({}, 'test');
    await run.done;
    expect(
      queries.some((q) => q.sql.includes('UPDATE public.company_info')),
    ).toBe(false);
  });

  it('walks down from the cursor without revisiting a row', async () => {
    const { service, queries } = make({ targets: ['300000001'] });
    const run = await service.start({ fromInn: '300000009' }, 'test');
    await run.done;

    const select = queries.find((q) => q.sql.includes('SELECT ci.inn'))!;
    expect(select.sql).toContain('ci.inn < $1');
    expect(select.sql).toContain('ORDER BY ci.inn DESC');
    expect(select.params).toContain('300000009');
  });

  it('stands aside when another instance holds the lock', async () => {
    const { service, stat } = make({ targets: ['300000001'], locked: true });
    const run = await service.start({}, 'test');
    await run.done;
    expect(run.started).toBe(false);
    expect(stat.fetch).not.toHaveBeenCalled();
  });

  it('releases only its own lock, never one another instance took over', async () => {
    const { service, queries } = make({ targets: [] });
    const run = await service.start({}, 'test');
    await run.done;

    const release = queries.find((q) => q.sql.includes('run_lock_at = NULL'))!;
    expect(release.sql).toContain('run_owner = $1');
    expect(release.params[0]).toMatch(/:\d+$/);
  });

  it('reports a quiet run rather than staying silent', async () => {
    const { service, telegram } = make({ targets: [] });
    const run = await service.start({}, 'test');
    await run.done;
    expect(telegram.send).toHaveBeenCalledTimes(1);
  });

  describe('riding the new-company scan', () => {
    const saved = {
      env: process.env.SERVICE_ENVIRONMENT,
      flag: process.env.CONTACT_FILL_ENABLED,
    };
    beforeEach(() => {
      process.env.SERVICE_ENVIRONMENT = 'production';
      delete process.env.CONTACT_FILL_ENABLED;
    });
    afterEach(() => {
      if (saved.env === undefined) delete process.env.SERVICE_ENVIRONMENT;
      else process.env.SERVICE_ENVIRONMENT = saved.env;
      if (saved.flag === undefined) delete process.env.CONTACT_FILL_ENABLED;
      else process.env.CONTACT_FILL_ENABLED = saved.flag;
    });

    it('does not run on dev — production only', async () => {
      process.env.SERVICE_ENVIRONMENT = 'development';
      const { service, stat } = make({ targets: ['300000005'] });
      await service.afterScan(['300000009'], 'scan');
      expect(stat.fetch).not.toHaveBeenCalled();
    });

    it('asks about the just-listed companies before walking the window', async () => {
      const { service, asked } = make({ targets: ['300000005'] });
      await service.afterScan(['300000009', '300000008'], 'scan');
      // freshest first: the cursor sits below these and would not reach them
      expect(asked).toEqual(['300000009', '300000008', '300000005']);
    });

    it('leaves the cursor on the walked half, not on a just-listed STIR', async () => {
      const { service, queries } = make({ targets: ['300000005'] });
      await service.afterScan(['300000009'], 'scan');

      const save = queries.find((q) => q.sql.includes('SET last_inn'))!;
      // 300000009 is newer than the window position; storing it would make the
      // next run skip everything between
      expect(save.params[0]).toBe('300000005');
    });

    it('still runs when the scan listed nothing', async () => {
      const { service, asked } = make({ targets: ['300000005'] });
      await service.afterScan([], 'scan');
      expect(asked).toEqual(['300000005']);
    });

    it('ignores a malformed STIR from the caller', async () => {
      const { service, asked } = make({ targets: [] });
      await service.afterScan(['nope', '12345'], 'scan');
      expect(asked).toEqual([]);
    });

    it('can be switched off without touching the scan', async () => {
      process.env.CONTACT_FILL_ENABLED = '0';
      const { service, stat } = make({ targets: ['300000005'] });
      await service.afterScan(['300000009'], 'scan');
      expect(stat.fetch).not.toHaveBeenCalled();
    });
  });

  describe('scheduledFillEnabled', () => {
    it('is on in production and off everywhere else by default', () => {
      expect(scheduledFillEnabled({ SERVICE_ENVIRONMENT: 'production' })).toBe(
        true,
      );
      expect(scheduledFillEnabled({ SERVICE_ENVIRONMENT: 'development' })).toBe(
        false,
      );
      expect(scheduledFillEnabled({})).toBe(false);
    });

    it('CONTACT_FILL_ENABLED overrides the environment both ways', () => {
      expect(
        scheduledFillEnabled({
          SERVICE_ENVIRONMENT: 'production',
          CONTACT_FILL_ENABLED: '0',
        }),
      ).toBe(false);
      expect(
        scheduledFillEnabled({
          SERVICE_ENVIRONMENT: 'development',
          CONTACT_FILL_ENABLED: '1',
        }),
      ).toBe(true);
    });
  });

  describe('twice-daily recheck', () => {
    const env = { ...process.env };
    afterEach(() => {
      process.env = { ...env };
    });

    it('asks the last three days from the top, then walks on from the cursor', async () => {
      process.env.CONTACT_FILL_ENABLED = '1';
      const { service, queries, asked } = make({
        targets: ['300000002', '300000001'],
      });
      await service.twiceDaily();

      // The recheck first: newest first, whatever the cursor says.
      expect(asked.slice(0, 2)).toEqual(['300000002', '300000001']);
      const selects = queries.filter((q) => q.sql.includes('SELECT ci.inn'));
      expect(selects[0].params[0]).toBe('3');
      expect(selects[0].sql).toContain('ci.registration_date >=');
      expect(selects[0].sql).not.toContain('ci.inn <');
      // Then the walk over every contactless company, in the same slot (user
      // decision 2026-10-19: twice a day, not after every scan).
      expect(selects.length).toBeGreaterThanOrEqual(2);
      expect(selects[1].sql).not.toContain('registration_date');
      expect(selects[1].params.at(-1)).toBe(2000);
      // The recheck itself moved no cursor; only the walk does.
      const firstWalkSelect = queries.indexOf(selects[1]);
      expect(
        queries
          .slice(0, firstWalkSelect)
          .some(
            (q) =>
              q.sql.includes('contact_fill_cursor') &&
              q.sql.includes('last_inn') &&
              q.sql.startsWith('UPDATE'),
          ),
      ).toBe(false);
    });

    it('does not run off production', async () => {
      delete process.env.CONTACT_FILL_ENABLED;
      process.env.SERVICE_ENVIRONMENT = 'development';
      const { service, asked } = make({ targets: ['300000001'] });
      await service.twiceDaily();
      expect(asked).toEqual([]);
    });
  });

  describe('every company without contacts', () => {
    it('has no date window by default, newest STIR first, 2000 at most', async () => {
      const { service, queries } = make({ targets: ['300000001'] });
      const run = await service.start({}, 'test');
      await run.done;
      const select = queries.find((q) => q.sql.includes('SELECT ci.inn'))!;
      expect(select.sql).not.toContain('registration_date');
      expect(select.sql).toContain('ORDER BY ci.inn DESC');
      // Active companies only.
      expect(select.sql).toContain('ci.activity_state = 1');
      expect(select.params.at(-1)).toBe(2000);
    });

    it('never takes more than 2000 in one run', async () => {
      const { service, queries } = make({ targets: [] });
      const run = await service.start({ limit: 5000 }, 'test');
      await run.done;
      const select = queries.find((q) => q.sql.includes('SELECT ci.inn'))!;
      expect(select.params.at(-1)).toBe(2000);
    });

    it('still narrows to recent registrations when days is given', async () => {
      const { service, queries } = make({ targets: [] });
      const run = await service.start({ days: 30 }, 'test');
      await run.done;
      const select = queries.find((q) => q.sql.includes('SELECT ci.inn'))!;
      expect(select.sql).toContain('ci.registration_date >=');
      expect(select.params[0]).toBe('30');
    });

    it('steps aside for the recheck, keeping its place', async () => {
      const targets = Array.from({ length: 45 }, (_, i) =>
        String(300000100 - i),
      );
      const { service, asked, queries } = make({
        targets,
        yieldRequested: true,
      });
      const run = await service.start({}, 'test');
      await run.done;
      // Checked after the first 20; stopped there.
      expect(asked).toHaveLength(20);
      expect(service.status().last).toMatchObject({ yielded: true });
      const cursor = queries.find(
        (q) =>
          q.sql.includes('contact_fill_cursor') &&
          q.sql.includes('SET last_inn'),
      )!;
      expect(cursor.params[0]).toBe(targets[19]);
      expect(
        queries.some(
          (q) => q.sql.includes('SET yield_requested') && q.params[0] === false,
        ),
      ).toBe(true);
    });

    it('the recheck itself does not yield', async () => {
      process.env.CONTACT_FILL_ENABLED = '1';
      const targets = Array.from({ length: 30 }, (_, i) =>
        String(300000100 - i),
      );
      const { service, asked } = make({ targets, yieldRequested: true });
      await service.twiceDaily();
      // All 30 of the recheck, not cut at 20 (the walk after it may yield).
      expect(asked.length).toBeGreaterThanOrEqual(30);
      expect(asked.slice(0, 30)).toEqual(targets);
      delete process.env.CONTACT_FILL_ENABLED;
    });
  });
});
