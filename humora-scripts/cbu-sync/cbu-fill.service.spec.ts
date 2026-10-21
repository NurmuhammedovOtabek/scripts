import { CbuFillService } from './cbu-fill.service';

// Direct instantiation with mocked deps — no Nest DI needed. Covers the two new
// behaviours: the CBU_SYNC_DISABLED nightly pause and the residual backfill.
describe('CbuFillService — residual backfill & pause flag', () => {
  let db: { query: jest.Mock; transaction: jest.Mock };
  let api: { getCompanyInfo: jest.Mock };
  let tg: { send: jest.Mock };
  let service: CbuFillService;

  const RESIDUAL_MARKER = 'NOT EXISTS';

  beforeEach(() => {
    db = { query: jest.fn().mockResolvedValue([]), transaction: jest.fn() };
    // loadResidualTargets runs its query inside a transaction — run the callback
    // with a manager that delegates to the same db.query mock.
    db.transaction.mockImplementation((cb: any) => cb({ query: db.query }));
    api = { getCompanyInfo: jest.fn() };
    tg = { send: jest.fn().mockResolvedValue(undefined) };
    service = new CbuFillService(db as any, api as any, tg as any);
  });

  // ─── CBU_SYNC_DISABLED pause ──────────────────────────────────────────────

  describe('startNightly (CBU_SYNC_DISABLED)', () => {
    const orig = {
      NODE_ENV: process.env.NODE_ENV,
      CBU_SYNC_DISABLED: process.env.CBU_SYNC_DISABLED,
    };
    afterEach(() => {
      process.env.NODE_ENV = orig.NODE_ENV;
      process.env.CBU_SYNC_DISABLED = orig.CBU_SYNC_DISABLED;
    });

    it('skips the sync when CBU_SYNC_DISABLED is set', async () => {
      process.env.NODE_ENV = 'production';
      process.env.CBU_SYNC_DISABLED = 'true';
      const start = jest.spyOn(service, 'start').mockResolvedValue({} as any);

      await service.startNightly();

      expect(start).not.toHaveBeenCalled();
    });

    it('runs the sync when the flag is unset', async () => {
      process.env.NODE_ENV = 'production';
      process.env.CBU_SYNC_DISABLED = 'false';
      const start = jest.spyOn(service, 'start').mockResolvedValue({} as any);

      await service.startNightly();

      expect(start).toHaveBeenCalledTimes(1);
    });
  });

  // ─── startResidual guard ──────────────────────────────────────────────────

  describe('startResidual', () => {
    it('refuses to start while another run is in progress', async () => {
      (service as any).isRunning = true;
      expect(await service.startResidual()).toEqual({
        status: 'already_running',
      });
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  // ─── residualLoop ─────────────────────────────────────────────────────────

  describe('residualLoop', () => {
    it('queries the missing-relations set and runs processRow for each target', async () => {
      db.query.mockImplementation((sql: string) =>
        sql.includes(RESIDUAL_MARKER)
          ? Promise.resolve([
              { id: 1, inn: '111111111' },
              { id: 2, inn: '222222222' },
            ])
          : Promise.resolve([]),
      );
      // No CBU data → the fast skip path, no DB transaction needed.
      api.getCompanyInfo.mockResolvedValue({
        success: false,
        data: null,
        error: { message: 'no data' },
      });

      (service as any).isRunning = true;
      (service as any).rps = 1000; // keep the inter-row sleep at ~1ms
      await (service as any).residualLoop();

      // Both INNs were fetched via the same processRow path.
      expect(api.getCompanyInfo).toHaveBeenCalledTimes(2);
      expect(api.getCompanyInfo).toHaveBeenCalledWith('111111111');
      expect(api.getCompanyInfo).toHaveBeenCalledWith('222222222');

      // The live NOT EXISTS query drove the target list.
      expect(
        db.query.mock.calls.some(([sql]) =>
          String(sql).includes(RESIDUAL_MARKER),
        ),
      ).toBe(true);

      // Start + completion alerts fired.
      const msgs = tg.send.mock.calls.map(([m]) => String(m));
      expect(msgs.some((m) => m.includes('RESIDUAL backfill started'))).toBe(
        true,
      );
      expect(msgs.some((m) => m.includes('RESIDUAL complete'))).toBe(true);

      // Live status reflects the finished run.
      const status = service.getResidualStatus();
      expect(status.total).toBe(2);
      expect(status.processed).toBe(2);
      expect(status.skipped).toBe(2);
      expect(status.running).toBe(false);
      expect(status.finishedAt).toEqual(expect.any(String));
    });

    it('stops early when the run is cancelled mid-way', async () => {
      db.query.mockImplementation((sql: string) =>
        sql.includes(RESIDUAL_MARKER)
          ? Promise.resolve([
              { id: 1, inn: '111111111' },
              { id: 2, inn: '222222222' },
            ])
          : Promise.resolve([]),
      );
      api.getCompanyInfo.mockImplementation(() => {
        // Cancel after the first fetch so the loop exits before the 2nd target.
        (service as any).isRunning = false;
        return Promise.resolve({ success: false, data: null, error: null });
      });

      (service as any).isRunning = true;
      (service as any).rps = 1000;
      await (service as any).residualLoop();

      expect(api.getCompanyInfo).toHaveBeenCalledTimes(1);
      const msgs = tg.send.mock.calls.map(([m]) => String(m));
      expect(msgs.some((m) => m.includes('RESIDUAL stopped'))).toBe(true);
    });
  });

  // ─── dedupeByKey (guards uq_company_relations_edge) ───────────────────────

  describe('dedupeByKey', () => {
    it('keeps the first item per key and drops later duplicates', () => {
      const items = [
        { key: 'p1|founder', v: 1 },
        { key: 'p2|founder', v: 2 },
        { key: 'p1|founder', v: 3 }, // same owner+role listed twice by CBU
      ];
      const out = (service as any).dedupeByKey(items);
      expect(out).toEqual([
        { key: 'p1|founder', v: 1 },
        { key: 'p2|founder', v: 2 },
      ]);
    });

    it('returns an empty array unchanged', () => {
      expect((service as any).dedupeByKey([])).toEqual([]);
    });
  });
});

// company_relations was only ever written by the nightly cron, which has not
// been running: all 1,417,346 rows still carry updated_at = created_at. The
// live company sync already holds a fresh CBU payload, so it reconciles the
// graph off that instead of waiting for a batch that never comes.
describe('syncGraphLive', () => {
  let db: any;
  let service: CbuFillService;

  beforeEach(() => {
    db = { query: jest.fn().mockResolvedValue([]), transaction: jest.fn() };
    db.transaction.mockImplementation((cb: any) => cb({ query: db.query }));
    service = new CbuFillService(
      db as any,
      { getCompanyInfo: jest.fn() } as any,
      { send: jest.fn() } as any,
    );
  });

  it('runs the same reconcile the nightly batch runs, in one transaction', async () => {
    const syncGraph = jest
      .spyOn(service as any, 'syncGraph')
      .mockResolvedValue(undefined);
    const data = { company: { name: 'X' }, director: null, founders: [] };

    await service.syncGraphLive('311806912', data as any);

    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(syncGraph).toHaveBeenCalledTimes(1);
    const [, inn, passed] = syncGraph.mock.calls[0];
    expect(inn).toBe('311806912');
    expect(passed).toBe(data);
  });

  // OrgService caches the relations graph per id and depth for 30 minutes
  // and never dropped it, so a company opened for the first time stayed off
  // its founder's "+" graph until the cache expired.
  it('drops the cached graph of the company and every owner whose edge changed', async () => {
    const cache = { mdel: jest.fn().mockResolvedValue(undefined) };
    service = new CbuFillService(
      db as any,
      { getCompanyInfo: jest.fn() } as any,
      { send: jest.fn() } as any,
      cache as any,
    );
    jest.spyOn(service as any, 'syncGraph').mockResolvedValue(['owner-1']);

    await service.syncGraphLive('311806912', {} as any);

    expect(cache.mdel).toHaveBeenCalledTimes(1);
    const keys: string[] = cache.mdel.mock.calls[0][0];
    expect(keys).toEqual(
      expect.arrayContaining([
        'org:relations:311806912:1',
        'org:relations:311806912:6',
        'org:relations:owner-1:1',
        'org:connections:cbu:owner-1',
        'org:connections:owner-1',
      ]),
    );
  });

  it('leaves the cache alone when the reconcile changed nothing', async () => {
    const cache = { mdel: jest.fn() };
    service = new CbuFillService(
      db as any,
      { getCompanyInfo: jest.fn() } as any,
      { send: jest.fn() } as any,
      cache as any,
    );
    jest.spyOn(service as any, 'syncGraph').mockResolvedValue([]);

    await service.syncGraphLive('311806912', {} as any);

    expect(cache.mdel).not.toHaveBeenCalled();
  });

  // It is fired and forgotten from the request path, so the caller has to be
  // able to catch — a swallowed error here would hide a broken graph forever.
  it('rejects rather than swallowing a failure', async () => {
    jest
      .spyOn(service as any, 'syncGraph')
      .mockRejectedValue(new Error('deadlock detected'));

    await expect(service.syncGraphLive('311806912', {} as any)).rejects.toThrow(
      'deadlock detected',
    );
  });

  it('does not care whether a sweep is currently running', async () => {
    (service as any).isRunning = true;
    jest.spyOn(service as any, 'syncGraph').mockResolvedValue(undefined);
    await expect(
      service.syncGraphLive('311806912', {} as any),
    ).resolves.toBeUndefined();
  });
});

// syncAddresses already refuses to wipe a company's addresses to empty. The
// graph had no such guard, which mattered little at one batch run a night and
// matters a lot now that a profile view triggers it.
describe('syncGraph — empty CBU payload', () => {
  let db: any;
  let m: any;
  let service: CbuFillService;

  const run = (data: any) => (service as any).syncGraph(m, '311806912', data);

  beforeEach(() => {
    db = { query: jest.fn().mockResolvedValue([]), transaction: jest.fn() };
    m = { query: jest.fn().mockResolvedValue([]) };
    db.transaction.mockImplementation((cb: any) => cb(m));
    service = new CbuFillService(
      db as any,
      { getCompanyInfo: jest.fn() } as any,
      { send: jest.fn() } as any,
    );
  });

  it('keeps the stored graph when CBU returns no director and no founders', async () => {
    m.query.mockResolvedValue([{ any_rows: true }]);
    const founders = jest.spyOn(service as any, 'reconcileFounders');
    const edges = jest.spyOn(service as any, 'reconcileEdges');

    await run({ company: { name: 'X' }, director: null, founders: [] });

    expect(founders).not.toHaveBeenCalled();
    expect(edges).not.toHaveBeenCalled();
  });

  it('still reconciles an empty payload for a company we hold nothing for', async () => {
    m.query.mockResolvedValue([{ any_rows: false }]);
    const founders = jest
      .spyOn(service as any, 'reconcileFounders')
      .mockResolvedValue(undefined);
    const edges = jest
      .spyOn(service as any, 'reconcileEdges')
      .mockResolvedValue(undefined);

    await run({ company: { name: 'X' }, director: null, founders: [] });

    expect(founders).toHaveBeenCalled();
    expect(edges).toHaveBeenCalled();
  });

  it('never consults the guard when the payload has something to write', async () => {
    jest
      .spyOn(service as any, 'upsertPerson')
      .mockResolvedValue('11111111-1111-1111-1111-111111111111');
    const founders = jest
      .spyOn(service as any, 'reconcileFounders')
      .mockResolvedValue(undefined);
    const edges = jest
      .spyOn(service as any, 'reconcileEdges')
      .mockResolvedValue(undefined);

    await run({
      company: { name: 'X' },
      director: { pinfl: '123', lastName: 'A', firstName: 'B' },
      founders: [],
    });

    expect(edges).toHaveBeenCalled();
    const guardAsked = m.query.mock.calls.some((c: any[]) =>
      String(c[0]).includes('any_rows'),
    );
    expect(guardAsked).toBe(false);
    expect(founders).toHaveBeenCalled();
  });
});

describe('what a CBU refresh replaces is kept (company_change_log)', () => {
  const service = new CbuFillService({} as any, {} as any, {} as any) as any;
  const logged = (m: { query: jest.Mock }) =>
    m.query.mock.calls.filter((c) =>
      String(c[0]).includes('company_change_log'),
    );

  it('keeps a founder CBU no longer lists, whole', async () => {
    const gone = {
      id: 5,
      person_uuid: 'uuid-1',
      founder_inn: null,
      founder_name: 'TOSHMATOV ESHMAT',
      share_pct: 100,
      share_sum: 1000,
    };
    const m = {
      query: jest.fn(async (sql: string) =>
        sql.includes('SELECT * FROM public.company_founders') ? [gone] : [],
      ),
    };

    await service.reconcileFounders(m, '300000001', []);

    const [row] = logged(m);
    expect(String(row[0])).toContain("'removed'");
    expect(JSON.parse(row[1][3])).toMatchObject({
      founder_name: 'TOSHMATOV ESHMAT',
      share_pct: 100,
    });
    const order = m.query.mock.calls.map((c) => String(c[0]));
    expect(
      order.findIndex((q) => q.includes('company_change_log')),
    ).toBeLessThan(order.findIndex((q) => q.includes('DELETE')));
  });

  it("keeps a founder's previous share", async () => {
    const ex = {
      id: 5,
      person_uuid: 'uuid-1',
      founder_inn: null,
      founder_name: 'TOSHMATOV ESHMAT',
      share_pct: 100,
      share_sum: 1000,
    };
    const m = {
      query: jest.fn(async (sql: string) =>
        sql.includes('SELECT * FROM public.company_founders') ? [ex] : [],
      ),
    };

    await service.reconcileFounders(m, '300000001', [
      {
        key: 'p:uuid-1',
        founder_type: 'individual',
        person_uuid: 'uuid-1',
        founder_inn: null,
        founder_name: 'TOSHMATOV ESHMAT',
        share_pct: 60,
        share_sum: 600,
        reg_country: null,
        individual_id: null,
      },
    ]);

    const fields = logged(m).flatMap((c) =>
      c[1].filter((_: unknown, i: number) => i % 7 === 3),
    );
    expect(fields).toEqual(['share_pct', 'share_sum']);
  });

  it('keeps a former director edge', async () => {
    const edge = {
      id: 9,
      owner_id: 'p:uuid-2',
      role: 'director',
      owner_name: 'ESHMATOV TOSHMAT',
    };
    const m = {
      query: jest.fn(async (sql: string) =>
        sql.includes('SELECT * FROM public.company_relations') ? [edge] : [],
      ),
    };

    await service.reconcileEdges(m, '300000001', 'NAMUNA', []);

    const [row] = logged(m);
    expect(row[1][2]).toBe('p:uuid-2|director');
  });
});

describe('persistCompanyAddresses — a dropped address is kept', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { persistCompanyAddresses } = require('./cbu-address.util');
  const billing = {
    countryCode: '860',
    soato: '1726266',
    streetName: 'Namuna',
    house: '1',
  };

  it('logs an address CBU no longer lists, not one it still does', async () => {
    const storedSame = {
      address_type: 'billing',
      country_code: '860',
      soato: '1726266',
      street_name: 'Namuna',
      house: '1',
    };
    const storedGone = {
      address_type: 'shipping',
      country_code: '860',
      street_name: 'Eski',
      house: '7',
    };
    const exec = {
      query: jest.fn<Promise<unknown[]>, [string, unknown[]?]>(async (sql) =>
        sql.startsWith('SELECT') ? [storedSame, storedGone] : [],
      ),
    };

    await persistCompanyAddresses(exec, '300000001', {
      companyBillingAddress: billing,
    });

    const logs = exec.query.mock.calls.filter((c) =>
      String(c[0]).includes('company_change_log'),
    );
    expect(logs).toHaveLength(1);
    expect(JSON.parse(String(logs[0][1]?.[3])).street_name).toBe('Eski');
  });
});
