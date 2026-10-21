import { MibRegistryCronService } from './mib-registry-cron.service';

describe('MibRegistryCronService', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  const build = (opts: { lock?: boolean; sync?: jest.Mock } = {}) => {
    const runnerQuery = jest.fn(async (sql: string) =>
      sql.includes('pg_try_advisory_lock') ? [{ ok: opts.lock ?? true }] : [],
    );
    const db = {
      query: jest.fn().mockResolvedValue([]),
      createQueryRunner: () => ({
        connect: jest.fn(),
        release: jest.fn(),
        query: runnerQuery,
      }),
    };
    const registry = {
      syncAll:
        opts.sync ??
        jest.fn().mockResolvedValue([
          {
            registry: 'alimony',
            fetched: 3000,
            inserted: 2,
            updated: 2998,
            removed: 0,
            truncated: true,
          },
          {
            registry: 'wanted',
            fetched: 2968,
            inserted: 0,
            updated: 2968,
            removed: 0,
            truncated: false,
          },
        ]),
    };
    const alerts = { send: jest.fn().mockResolvedValue(true) };
    return {
      svc: new MibRegistryCronService(
        db as any,
        registry as any,
        alerts as any,
      ),
      db,
      registry,
      alerts,
    };
  };

  const jobRun = (db: { query: jest.Mock }) =>
    db.query.mock.calls.find(([sql]) => String(sql).includes('job_runs'));

  it('runs where TG_WEBHOOK_URL is set and records the run', async () => {
    process.env.TG_WEBHOOK_URL = 'https://example.test/hook';
    delete process.env.MIB_REGISTRY_SYNC_ENABLED;
    const { svc, registry, alerts, db } = build();
    await svc.daily();
    expect(registry.syncAll).toHaveBeenCalled();
    expect(alerts.send).not.toHaveBeenCalled();
    expect(jobRun(db)).toBeDefined();
  });

  it('off on a laptop, and off by flag', async () => {
    delete process.env.TG_WEBHOOK_URL;
    const a = build();
    await a.svc.daily();
    expect(a.registry.syncAll).not.toHaveBeenCalled();

    process.env.TG_WEBHOOK_URL = 'https://example.test/hook';
    process.env.MIB_REGISTRY_SYNC_ENABLED = '0';
    const b = build();
    await b.svc.daily();
    expect(b.registry.syncAll).not.toHaveBeenCalled();
  });

  it('another replica holding the lock means nothing runs here', async () => {
    process.env.MIB_REGISTRY_SYNC_ENABLED = '1';
    const { svc, registry } = build({ lock: false });
    await svc.daily();
    expect(registry.syncAll).not.toHaveBeenCalled();
  });

  it('a failure reaches Telegram', async () => {
    process.env.MIB_REGISTRY_SYNC_ENABLED = '1';
    const { svc, alerts } = build({
      sync: jest.fn().mockRejectedValue(new Error('mib.uz 504')),
    });
    await svc.daily();
    expect(alerts.send).toHaveBeenCalledWith(
      expect.stringContaining('mib.uz 504'),
      { tag: 'mib_registry' },
    );
  });

  it('a list that came back empty is a broken answer and is reported', async () => {
    process.env.MIB_REGISTRY_SYNC_ENABLED = '1';
    const { svc, alerts } = build({
      sync: jest.fn().mockResolvedValue([
        {
          registry: 'alimony',
          fetched: 0,
          inserted: 0,
          updated: 0,
          removed: 0,
          truncated: false,
        },
        {
          registry: 'wanted',
          fetched: 10,
          inserted: 0,
          updated: 10,
          removed: 0,
          truncated: false,
        },
      ]),
    });
    await svc.daily();
    expect(alerts.send).toHaveBeenCalledWith(
      expect.stringContaining('alimony'),
      { tag: 'mib_registry' },
    );
  });
});
