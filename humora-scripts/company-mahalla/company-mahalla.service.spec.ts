import { CompanyMahallaService, RunReport } from './company-mahalla.service';

describe('CompanyMahallaService', () => {
  let db: { query: jest.Mock; createQueryRunner: jest.Mock };
  let telegram: { send: jest.Mock; deliver: jest.Mock };
  let banks: { run: jest.Mock };
  let nsMap: { run: jest.Mock; started: jest.Mock };
  let oked: { run: jest.Mock };
  let accreditation: { run: jest.Mock };
  let postcodeWatch: { run: jest.Mock };
  let registries: { weekly: jest.Mock };
  let weeklyLock: { locked: boolean; runner: any };
  let service: CompanyMahallaService;
  const env = { ...process.env };

  beforeEach(() => {
    db = {
      query: jest.fn(async (sql: string) =>
        /SELECT initialized_at/.test(sql) ? [{ initialized_at: null }] : [],
      ),
      createQueryRunner: jest.fn(() => weeklyLock.runner),
    };
    weeklyLock = { locked: true, runner: null };
    weeklyLock.runner = {
      connect: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) =>
        /pg_try_advisory_lock/.test(sql) ? [{ locked: weeklyLock.locked }] : [],
      ),
    };
    telegram = {
      send: jest.fn().mockResolvedValue(true),
      deliver: jest.fn().mockResolvedValue(true),
    };
    banks = { run: jest.fn().mockResolvedValue(null) };
    nsMap = {
      run: jest.fn().mockResolvedValue(null),
      started: jest.fn().mockResolvedValue(true),
    };
    oked = { run: jest.fn().mockResolvedValue(null) };
    accreditation = { run: jest.fn().mockResolvedValue(null) };
    postcodeWatch = { run: jest.fn().mockResolvedValue(null) };
    registries = { weekly: jest.fn().mockResolvedValue(null) };
    service = new CompanyMahallaService(
      db as any,
      telegram as any,
      banks as any,
      nsMap as any,
      oked as any,
      accreditation as any,
      postcodeWatch as any,
      registries as any,
    );
  });

  afterEach(() => {
    process.env = { ...env };
    jest.useRealTimers();
  });

  const jobRuns = () =>
    db.query.mock.calls.filter(([sql]) =>
      /INSERT INTO public\.job_runs/.test(String(sql)),
    );
  const settle = () => new Promise((r) => setImmediate(r));

  describe('a live batch that fails', () => {
    it('is tried again, and reported only once it is given up on', async () => {
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
      const s = service as any;
      const err = new Error('connection terminated');

      await s.liveFailed(['300000001'], err);
      expect(s.pending.has('300000001')).toBe(false);
      jest.advanceTimersByTime(30_000);
      expect(s.pending.has('300000001')).toBe(true);
      s.pending.clear();
      expect(jobRuns()).toHaveLength(0);
      expect(telegram.deliver).not.toHaveBeenCalled();

      await s.liveFailed(['300000001'], err);
      await s.liveFailed(['300000001'], err);
      await settle();

      expect(telegram.deliver).toHaveBeenCalledTimes(1);
      expect(telegram.deliver.mock.calls[0][0]).toMatch(/live refresh failed/);
      expect(telegram.deliver.mock.calls[0][0]).toMatch(
        /connection terminated/,
      );
      const [row] = jobRuns();
      expect(row[1][0]).toBe('company_mahalla_live');
      expect(row[1][5]).toBe(false);
      // Counted for the weekly report too.
      expect(
        db.query.mock.calls.some(([sql]) =>
          /live_failed\s*=\s*live_failed \+/.test(String(sql)),
        ),
      ).toBe(true);
    });

    it('messages Telegram at most once an hour, and records every time', async () => {
      const s = service as any;
      for (let i = 0; i < 3; i++)
        await s.liveFailed(['300000001'], new Error('x'));
      for (let i = 0; i < 3; i++)
        await s.liveFailed(['300000002'], new Error('x'));
      await settle();
      expect(telegram.deliver).toHaveBeenCalledTimes(1);
      expect(jobRuns()).toHaveLength(2);
    });
  });

  describe('the weekly run', () => {
    it('syncs the bank registry first, even before the mahalla fill has started', async () => {
      process.env.BANK_REGISTRY_SYNC_ENABLED = '1';
      const start = jest.spyOn(service, 'start');
      await service.weekly();
      expect(banks.run).toHaveBeenCalledWith({}, 'weekly');
      // Not initialized: the mahalla part waits for the first manual run.
      expect(start).not.toHaveBeenCalled();
    });

    it('still runs the mahalla part when the bank sync fails', async () => {
      process.env.BANK_REGISTRY_SYNC_ENABLED = '1';
      banks.run.mockRejectedValue(new Error('cs.egov.uz down'));
      db.query.mockImplementation(async (sql: string) =>
        /SELECT initialized_at/.test(sql)
          ? [{ initialized_at: new Date() }]
          : [],
      );
      const start = jest.spyOn(service, 'start').mockResolvedValue({
        started: true,
        reason: null,
        done: Promise.resolve(),
      });
      await service.weekly();
      expect(start).toHaveBeenCalled();
    });

    it('leaves the bank registry alone where it is switched off', async () => {
      process.env.BANK_REGISTRY_SYNC_ENABLED = '0';
      await service.weekly();
      expect(banks.run).not.toHaveBeenCalled();
    });

    it('syncs the tax office map after the banks and before the mahallas', async () => {
      process.env.BANK_REGISTRY_SYNC_ENABLED = '1';
      process.env.NS_SOATO_SYNC_ENABLED = '1';
      const order: string[] = [];
      banks.run.mockImplementation(async () => order.push('banks'));
      nsMap.run.mockImplementation(async () => {
        order.push('ns map');
        throw new Error('cs.egov.uz down');
      });
      db.query.mockImplementation(async (sql: string) =>
        /SELECT initialized_at/.test(sql)
          ? [{ initialized_at: new Date() }]
          : [],
      );
      jest.spyOn(service, 'start').mockImplementation(async () => {
        order.push('mahallas');
        return { started: true, reason: null, done: Promise.resolve() };
      });
      await service.weekly();
      // Its failure is its own report; the mahalla run still goes.
      expect(order).toEqual(['banks', 'ns map', 'mahallas']);
      expect(nsMap.run).toHaveBeenCalledWith({}, 'weekly');
    });

    it('syncs the OKED classifier after the banks and before the tax office map', async () => {
      process.env.BANK_REGISTRY_SYNC_ENABLED = '1';
      process.env.OKED_SYNC_ENABLED = '1';
      process.env.NS_SOATO_SYNC_ENABLED = '1';
      const order: string[] = [];
      banks.run.mockImplementation(async () => order.push('banks'));
      oked.run.mockImplementation(async () => {
        order.push('oked');
        throw new Error('cs.egov.uz down');
      });
      nsMap.run.mockImplementation(async () => order.push('ns map'));
      await service.weekly();
      // Its failure is its own report; the chain goes on.
      expect(order).toEqual(['banks', 'oked', 'ns map']);
      expect(oked.run).toHaveBeenCalledWith({}, 'weekly');
    });

    it('reads the whole accreditation register after OKED and before the tax office map', async () => {
      process.env.OKED_SYNC_ENABLED = '1';
      process.env.ACCREDITATION_SYNC_ENABLED = '1';
      process.env.NS_SOATO_SYNC_ENABLED = '1';
      const order: string[] = [];
      oked.run.mockImplementation(async () => order.push('oked'));
      accreditation.run.mockImplementation(async () => {
        order.push('accreditation');
        throw new Error('akkred.uz down');
      });
      nsMap.run.mockImplementation(async () => order.push('ns map'));
      await service.weekly();
      // Its failure is its own report; the chain goes on.
      expect(order).toEqual(['oked', 'accreditation', 'ns map']);
      expect(accreditation.run).toHaveBeenCalledWith(
        { mode: 'full' },
        'weekly, whole register',
      );
    });

    it('reads the open registers after the accreditation register and before the tax office map', async () => {
      process.env.ACCREDITATION_SYNC_ENABLED = '1';
      process.env.REGISTRIES_SYNC_ENABLED = '1';
      process.env.NS_SOATO_SYNC_ENABLED = '1';
      const order: string[] = [];
      accreditation.run.mockImplementation(async () =>
        order.push('accreditation'),
      );
      registries.weekly.mockImplementation(async () => {
        order.push('registries');
        throw new Error('data.egov.uz down');
      });
      nsMap.run.mockImplementation(async () => order.push('ns map'));
      await service.weekly();
      // Its failure is its own report; the chain goes on.
      expect(order).toEqual(['accreditation', 'registries', 'ns map']);
    });

    it('leaves the open registers alone where they are switched off', async () => {
      process.env.REGISTRIES_SYNC_ENABLED = '0';
      await service.weekly();
      expect(registries.weekly).not.toHaveBeenCalled();
    });

    it('leaves the accreditation register alone where it is switched off', async () => {
      process.env.ACCREDITATION_SYNC_ENABLED = '0';
      await service.weekly();
      expect(accreditation.run).not.toHaveBeenCalled();
    });

    it('leaves the OKED classifier alone where it is switched off', async () => {
      process.env.OKED_SYNC_ENABLED = '0';
      await service.weekly();
      expect(oked.run).not.toHaveBeenCalled();
    });

    it('leaves the tax office map alone where it is switched off', async () => {
      process.env.NS_SOATO_SYNC_ENABLED = '0';
      await service.weekly();
      expect(nsMap.run).not.toHaveBeenCalled();
    });

    it('starts nothing more once the chain is stopped by hand', async () => {
      process.env.BANK_REGISTRY_SYNC_ENABLED = '1';
      process.env.NS_SOATO_SYNC_ENABLED = '1';
      db.query.mockImplementation(async (sql: string) => {
        if (/SELECT initialized_at/.test(sql)) {
          return [{ initialized_at: new Date() }];
        }
        if (/FROM public\.job_controls/.test(sql)) return [{ '?column?': 1 }];
        return [];
      });
      const start = jest.spyOn(service, 'start');
      await service.weekly();
      // The step that was running (the banks) finished; nothing after it ran.
      expect(banks.run).toHaveBeenCalled();
      expect(nsMap.run).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      // And the chain's lock was given back.
      expect(weeklyLock.runner.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [expect.any(Number)],
      );
    });

    it('waits for the first real map sync to be run by hand', async () => {
      process.env.NS_SOATO_SYNC_ENABLED = '1';
      nsMap.started.mockResolvedValue(false);
      await service.weekly();
      expect(nsMap.run).not.toHaveBeenCalled();
    });

    it('runs on one replica only: the others find the chain taken', async () => {
      process.env.BANK_REGISTRY_SYNC_ENABLED = '1';
      process.env.NS_SOATO_SYNC_ENABLED = '1';
      weeklyLock.locked = false;
      const start = jest.spyOn(service, 'start');
      await service.weekly();
      expect(banks.run).not.toHaveBeenCalled();
      expect(nsMap.run).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(weeklyLock.runner.release).toHaveBeenCalled();
    });

    it('lets the chain go again once it has finished', async () => {
      process.env.BANK_REGISTRY_SYNC_ENABLED = '1';
      banks.run.mockRejectedValue(new Error('down'));
      await service.weekly();
      expect(weeklyLock.runner.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        [expect.any(Number)],
      );
    });
  });

  it('writes a report a person can read', () => {
    const report: RunReport = {
      trigger: 'weekly check',
      dry: false,
      startedAt: '2026-09-28T00:00:00.000Z',
      finishedAt: '2026-09-28T00:03:12.000Z',
      durationMs: 192_000,
      stopped: false,
      territoryMahallas: 9070,
      villageMap: {
        codes: 1253,
        byStatus: { auto: 1030, review: 31, none: 192 },
        byTier: {},
      },
      companies: {
        scanned: 1000,
        withMahalla: 900,
        withAlt: 12,
        inserted: 5,
        updated: 20,
        bySource: { cbu_address: 600, registry_village_code: 300, '—': 100 },
        byTier: {},
        byReason: { no_mahalla_given: 80, unknown_district: 20 },
        unknownDistricts: { '1726299': 20 },
      },
      previous: {
        scanned: 990,
        withMahalla: 880,
        finishedAt: '2026-09-21T00:03:00.000Z',
      },
      live: {
        since: '2026-09-21T00:03:00.000Z',
        resolved: 340,
        changed: 12,
        failed: 0,
      },
    };
    const text: string = (service as any).describe(report);
    expect(text).toMatch(/90\.0%, previous run: 88\.9%/);
    expect(text).toMatch(/MFY in the CBU address 600/);
    expect(text).toMatch(/address names no mahalla 80/);
    expect(text).toMatch(
      /Live since 2026-09-21: 340 re-resolved · 12 changed mahalla/,
    );
    expect(text).toMatch(/31 codes await review/);
    expect(text).toMatch(/1726299 — 20 companies/);
    expect(text.startsWith('⚠️')).toBe(true);
  });
});
