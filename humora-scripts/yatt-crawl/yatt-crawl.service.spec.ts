import {
  YattCrawlService,
  nextWindowEnd,
  yattCrawlEnabled,
} from './yatt-crawl.service';

// These cases are about the walk, which does not start while myorg is off
// (MYORG_REQUESTS_OFF); they run with it on. myorg-off.spec.ts covers off.
// The walk's own request to myorg is commented out (user decision
// 2026-10-13), so each case hands the walk the record myorg would have given
// (fetchRecord, stubbed in `build`).
jest.mock('../../org/myorg-failure', () => ({
  ...jest.requireActual('../../org/myorg-failure'),
  MYORG_REQUESTS_OFF: false,
}));

/**
 * The walk must keep myorg's record and soliq's bank details together, never
 * blank a stored value from an empty answer, stop for good at the end of the
 * list, and stop for the night — not skip ids — when myorg refuses or fails.
 */
describe('YattCrawlService', () => {
  type Answer = 'found' | 'missing' | 'denied' | 'fail' | 'noinn';

  const record = (id: number, inn: string | null) => ({
    id,
    inn,
    registration_date: '2020-01-01',
    entrepreneur: 'TOSHMATOV ESHMAT',
    registration_id: '1',
    certificate_number: '1',
    end_date: '3000-01-01',
    liquidation_date: null,
    suspension_date: null,
    activity_id: 205,
    activity_name: 'Savdo',
    status: 1,
    entrepreneur_ship_soato: '1726290',
    status_detail: { name_uz: 'Faol' },
    activity_detail: { name_uz: 'Savdo' },
  });

  const innOf = (id: number) => String(400000000 + id);

  const build = (opts: {
    answer: (id: number) => Answer;
    nextId?: number;
    retryIds?: number[];
    /** Ids whose registry INSERT the table refuses. */
    refuse?: number[];
    soliq?: (inn: string) => any;
  }) => {
    const writes: Array<{ sql: string; params: any[] }> = [];
    const cursor: Record<string, any> = {
      next_id: String(opts.nextId ?? 1),
      last_found_id: null,
      completed_at: null,
      stop_requested: false,
      retry_ids: (opts.retryIds ?? []).map(String),
    };
    const alerts: string[] = [];
    const asked: number[] = [];

    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: true }]),
      release: jest.fn().mockResolvedValue(undefined),
    };
    const db = {
      createQueryRunner: jest.fn(() => runner),
      query: jest.fn(async (sql: string, params: any[] = []) => {
        writes.push({ sql, params });
        if (sql.includes('SELECT next_id')) return [cursor];
        if (sql.includes('SELECT stop_requested')) return [cursor];
        if (sql.includes('SELECT completed_at')) return [cursor];
        if (sql.includes('SET next_id = $1::bigint, last_found_id')) {
          cursor.next_id = String(params[0]);
          if (params[1] != null) cursor.last_found_id = String(params[1]);
        }
        if (sql.includes('SET retry_ids')) {
          cursor.retry_ids = params[0].map(String);
          return [];
        }
        if (
          sql.includes('INSERT INTO public.individual_entrepreneurs') &&
          opts.refuse?.some((id) => params[0] === innOf(id))
        ) {
          throw new Error('value too long for type character varying(500)');
        }
        if (sql.includes('SET completed_at = CASE')) {
          if (params[0]) cursor.completed_at = new Date();
        }
        return [];
      }),
    };
    const http = { get: jest.fn() };
    const mysoliq = {
      request: jest.fn(async (_path: string, { tin }: { tin: string }) => {
        const answer = opts.soliq ? opts.soliq(tin) : {};
        if (answer instanceof Error) throw answer;
        return answer;
      }),
    };
    const telegram = {
      send: jest.fn(async (t: string) => {
        alerts.push(t);
      }),
    };
    const service = new YattCrawlService(
      db as any,
      http as any,
      mysoliq as any,
      telegram as any,
    );
    // What myorg would have answered for each id, as fetchRecord read it.
    jest
      .spyOn(service as any, 'fetchRecord')
      .mockImplementation(async (id: number) => {
        asked.push(id);
        const a = opts.answer(id);
        if (a === 'fail') return { kind: 'failed', message: 'timeout' };
        if (a === 'missing') return { kind: 'missing' };
        if (a === 'denied') return { kind: 'denied', status: 403 };
        return {
          kind: 'found',
          raw: record(id, a === 'noinn' ? null : innOf(id)),
        };
      });
    return { service, writes, cursor, alerts, asked, mysoliq, http };
  };

  const env = { ...process.env };
  beforeEach(() => {
    process.env.MYORG_BASE_URL = 'https://myorg.test';
    process.env.MYORG_BEARER_TOKEN = 'Bearer t';
    process.env.YATT_CRAWL_INTERVAL_MS = '0';
    jest.spyOn(global, 'setTimeout');
  });
  afterEach(() => {
    process.env = { ...env };
    jest.restoreAllMocks();
  });

  const registryWrites = (w: Array<{ sql: string }>) =>
    w.filter((x) =>
      x.sql.includes('INSERT INTO public.individual_entrepreneurs'),
    );

  it('asks myorg nothing for a record: its request is commented out', async () => {
    const http = { get: jest.fn() };
    const service = new YattCrawlService(
      { query: jest.fn() } as any,
      http as any,
      {} as any,
      { send: jest.fn() } as any,
    );

    await expect((service as any).fetchRecord(1)).resolves.toEqual({
      kind: 'failed',
      message: 'myorg requests are off',
    });
    expect(http.get).not.toHaveBeenCalled();
  });

  it('stores the registry half and the soliq half, moving the cursor', async () => {
    const t = build({
      answer: (id) => (id === 3 ? 'missing' : 'found'),
      soliq: (inn) => ({
        tin: inn,
        personalNum: '12345678900004',
        mfo: '00873',
        account: '20218000900000000001',
      }),
    });
    const run = await t.service.start({ limit: 5 }, 'test');
    expect(run.started).toBe(true);
    await run.done;

    expect(t.asked).toEqual([1, 2, 3, 4, 5]);
    expect(t.http.get).not.toHaveBeenCalled();
    expect(registryWrites(t.writes)).toHaveLength(4);
    const bank = t.writes.filter((w) =>
      w.sql.includes('bank_account = COALESCE($3, bank_account)'),
    );
    expect(bank).toHaveLength(4);
    expect(bank[0].params).toEqual([
      innOf(1),
      '00873',
      '20218000900000000001',
      '12345678900004',
    ]);
    // A stored PINFL is never replaced.
    expect(bank[0].sql).toContain('pinfl        = COALESCE(pinfl, $4)');
    // One soliq call per trader, nothing else from the answer.
    expect(t.mysoliq.request).toHaveBeenCalledTimes(4);
    expect(bank[0].sql).not.toContain('address');
    expect(t.cursor.next_id).toBe('6');
    expect(t.cursor.last_found_id).toBe('5');
    expect(t.alerts.at(-1)).toContain('Saved: <b>4</b>');
    expect(t.alerts.at(-1)).toContain('bank account 4, PINFL 4');
  });

  it('never blanks a bank account soliq leaves empty', async () => {
    const t = build({ answer: () => 'found', soliq: () => ({ tin: 'x' }) });
    const run = await t.service.start({ limit: 1 }, 'test');
    await run.done;
    expect(t.writes.some((w) => w.sql.includes('bank_account'))).toBe(false);
    expect(
      t.writes.some((w) => w.sql.includes('pinfl        = COALESCE(pinfl')),
    ).toBe(false);
    expect(t.alerts.at(-1)).toContain('no bank 1');
    // The register's name fills a row that has none.
    const nameFill = t.writes.find((w) => w.sql.includes('full_name IS NULL'));
    expect(nameFill?.params).toEqual([innOf(1), 'TOSHMATOV ESHMAT']);
  });

  it('continues from the saved cursor', async () => {
    const t = build({ answer: () => 'found', nextId: 500 });
    const run = await t.service.start({ limit: 2 }, 'test');
    await run.done;
    expect(t.asked).toEqual([500, 501]);
    expect(t.cursor.next_id).toBe('502');
  });

  it('stops the night on a refused token without moving past the id', async () => {
    const t = build({ answer: (id) => (id === 3 ? 'denied' : 'found') });
    const run = await t.service.start({ limit: 10 }, 'test');
    await run.done;
    expect(t.asked).toEqual([1, 2, 3]);
    expect(t.cursor.next_id).toBe('3');
    // What was found before the refusal still got its soliq half asked.
    expect(t.mysoliq.request).toHaveBeenCalledTimes(2);
    expect(t.alerts.at(-1)).toContain('not answering');
  });

  it('skips a record without a STIR', async () => {
    const t = build({ answer: () => 'noinn' });
    const run = await t.service.start({ limit: 2 }, 'test');
    await run.done;
    expect(registryWrites(t.writes)).toHaveLength(0);
    expect(t.alerts.at(-1)).toContain('no STIR 2');
  });

  it('marks the walk complete after a long run of missing ids', async () => {
    const t = build({ answer: (id) => (id <= 2 ? 'found' : 'missing') });
    const run = await t.service.start({}, 'test');
    await run.done;
    expect(t.cursor.completed_at).toBeInstanceOf(Date);
    expect(t.asked.length).toBe(2 + 3000);
    expect(t.alerts.at(-1)).toContain('reached the end');
  });

  it('does nothing at 21:00 once the walk is complete', async () => {
    process.env.YATT_CRAWL_ENABLED = '1';
    const t = build({ answer: () => 'found' });
    t.cursor.completed_at = new Date();
    await t.service.nightly();
    expect(t.asked).toEqual([]);
  });

  it('stops at the deadline', async () => {
    const t = build({ answer: () => 'found' });
    const run = await t.service.start(
      { deadline: new Date(Date.now() - 1) },
      'test',
    );
    await run.done;
    expect(t.asked).toEqual([]);
    expect(t.alerts.at(-1)).toContain('night done');
  });

  it('runs on production only unless told', () => {
    expect(yattCrawlEnabled({ SERVICE_ENVIRONMENT: 'production' })).toBe(true);
    expect(yattCrawlEnabled({ SERVICE_ENVIRONMENT: 'development' })).toBe(
      false,
    );
    expect(yattCrawlEnabled({ YATT_CRAWL_ENABLED: '1' })).toBe(true);
    expect(
      yattCrawlEnabled({
        SERVICE_ENVIRONMENT: 'production',
        YATT_CRAWL_ENABLED: '0',
      }),
    ).toBe(false);
  });

  it('ends the night at the next 06:00 Tashkent', () => {
    // 21:00 Tashkent = 16:00 UTC → 06:00 Tashkent next day = 01:00 UTC.
    expect(nextWindowEnd(new Date('2026-10-05T16:00:00Z')).toISOString()).toBe(
      '2026-10-06T01:00:00.000Z',
    );
    // Started by hand at 03:00 Tashkent → ends the same morning.
    expect(nextWindowEnd(new Date('2026-10-05T22:00:00Z')).toISOString()).toBe(
      '2026-10-06T01:00:00.000Z',
    );
  });

  it('counts soliq not answering apart and keeps walking', async () => {
    const t = build({
      answer: () => 'found',
      soliq: () => new Error('timeout'),
    });
    const run = await t.service.start({ limit: 3 }, 'test');
    await run.done;
    expect(registryWrites(t.writes)).toHaveLength(3);
    expect(t.cursor.next_id).toBe('4');
    expect(t.alerts.at(-1)).toContain('not answering 3');
  });

  it('asks myorg no more than once a second', async () => {
    process.env.YATT_CRAWL_INTERVAL_MS = '200';
    const t = build({ answer: () => 'missing' });
    const began = Date.now();
    const run = await t.service.start({ limit: 4 }, 'test');
    await run.done;
    expect(Date.now() - began).toBeGreaterThanOrEqual(4 * 200 - 20);
  });

  it('keeps the PINFL when soliq has no bank account', async () => {
    const t = build({
      answer: () => 'found',
      soliq: (inn) => ({ tin: inn, personalNum: '12345678900004' }),
    });
    const run = await t.service.start({ limit: 1 }, 'test');
    await run.done;
    const w = t.writes.find((x) => x.sql.includes('pinfl        = COALESCE'));
    expect(w?.params).toEqual([innOf(1), null, null, '12345678900004']);
    expect(t.alerts.at(-1)).toContain('PINFL 1');
  });

  it('keeps an id the table refused and asks it first the next night', async () => {
    const first = build({ answer: () => 'found', refuse: [2] });
    const run1 = await first.service.start({ limit: 3 }, 'test');
    await run1.done;
    expect(first.cursor.retry_ids).toEqual(['2']);
    expect(first.cursor.next_id).toBe('4');

    const second = build({
      answer: () => 'found',
      nextId: 4,
      retryIds: [2],
    });
    const run2 = await second.service.start({ limit: 1 }, 'test');
    await run2.done;
    // The earlier failure first, then the cursor carries on.
    expect(second.asked).toEqual([2, 4]);
    expect(second.cursor.retry_ids).toEqual([]);
    expect(second.alerts.at(-1)).toContain(
      'Earlier failures asked again: 1 · stored 1',
    );
  });
});
