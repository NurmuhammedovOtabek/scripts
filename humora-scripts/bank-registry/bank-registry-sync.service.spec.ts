import axios from 'axios';
import {
  BankRegistrySyncService,
  bankRegistrySyncEnabled,
} from './bank-registry-sync.service';

jest.mock('axios');
const post = axios.post as jest.Mock;

const BANKS_ID = '61a60296b83d3e9e6a91d8c8';

const cell = (data: string) => ({ data });
const bank = (type: string, name: string, active = 'A') => ({
  tableColumn: {
    BANK_TYPE: cell(type),
    BANK_NAME: cell(name),
    DATE_OPEN: cell('01.02.1995'),
    DATE_CLOSE: cell(' '),
    DATE_ACT: cell(' '),
    DATE_DEACT: cell(' '),
    ACTIVE: cell(active),
  },
});
const branch = (id: string, type: string, name: string) => ({
  tableColumn: {
    BANK_ID: cell(id),
    BANK_TYPE: cell(type),
    BANK_NAME: cell(name),
    DATE_OPEN: cell('01.02.1995'),
    ACTIVE: cell('A'),
  },
});
const storedBank = (bank_type: string, bank_name: string) => ({
  bank_type,
  bank_name,
  date_open: '1995-02-01',
  date_close: null,
  date_act: null,
  date_deact: null,
  active: 'A',
});
const storedBranch = (
  bank_id: string,
  bank_type: string,
  bank_name: string,
) => ({
  bank_id,
  bank_type,
  region_id: null,
  header_id: null,
  union_id: null,
  tcc_id: null,
  ccc_id: null,
  bank_name,
  bank_adres: null,
  bank_statu: null,
  date_open: '1995-02-01',
  date_close: null,
  date_act: null,
  date_deact: null,
  active: 'A',
  distr: null,
  kol_obm: null,
  inn: null,
});

describe('BankRegistrySyncService', () => {
  let db: { query: jest.Mock; createQueryRunner: jest.Mock };
  let telegram: { send: jest.Mock; deliver: jest.Mock };
  let service: BankRegistrySyncService;

  const source = (banks: any[], branches: any[]) =>
    post.mockImplementation((_url: string, body: { id: string }) =>
      Promise.resolve({
        status: 200,
        data: {
          error: null,
          // What the source really sends, full dataset and all.
          result: {
            isSuccess: false,
            count: (body.id === BANKS_ID ? banks : branches).length,
            data: body.id === BANKS_ID ? banks : branches,
          },
        },
      }),
    );

  beforeEach(() => {
    post.mockReset();
    db = {
      query: jest.fn(async (sql: string) => {
        if (/FROM public\.banks$/.test(sql.trim())) {
          return [
            storedBank('001', 'MARKAZIY BANK'),
            storedBank('002', 'ESKI NOM'),
            storedBank('009', 'YOPILGAN'),
          ];
        }
        if (/FROM public\.bank_branches$/.test(sql.trim())) {
          return [storedBranch('00450', '002', 'BOSH OFIS')];
        }
        return [];
      }),
      createQueryRunner: jest.fn(),
    };
    telegram = {
      send: jest.fn().mockResolvedValue(true),
      deliver: jest.fn().mockResolvedValue(true),
    } as any;
    service = new BankRegistrySyncService(db as any, telegram as any);
  });

  const writes = () =>
    db.query.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => /^\s*(INSERT|UPDATE)/.test(sql));

  it('writes only what is new or changed, and keeps what the source dropped', async () => {
    source(
      [
        bank('001', 'MARKAZIY BANK'),
        bank('002', 'YANGI NOM'),
        bank('003', 'YANGI BANK'),
      ],
      [branch('00450', '002', 'BOSH OFIS'), branch('00451', '002', 'FILIAL')],
    );
    const r = await service.syncAll();

    expect(r.banks).toMatchObject({
      fetched: 3,
      active: 3,
      inserted: 1,
      updated: 1,
      unchanged: 1,
      notInSource: 1,
      examples: {
        inserted: ['003 YANGI BANK'],
        // What changed, not only that something did.
        updated: ['002 YANGI NOM: bank_name ESKI NOM→YANGI NOM'],
        notInSource: ['009 YOPILGAN'],
      },
    });
    expect(r.branches).toMatchObject({
      inserted: 1,
      updated: 0,
      unchanged: 1,
      notInSource: 0,
    });

    const sql = writes();
    expect(sql.some((s) => /INSERT INTO public\.banks/.test(s))).toBe(true);
    expect(sql.some((s) => /UPDATE public\.banks SET fetched_at/.test(s))).toBe(
      true,
    );
    // Nothing is ever deleted.
    expect(db.query.mock.calls.some(([s]) => /DELETE/i.test(String(s)))).toBe(
      false,
    );
  });

  it('writes nothing on a dry run', async () => {
    source(
      [bank('001', 'MARKAZIY BANK'), bank('003', 'YANGI BANK')],
      [branch('00451', '002', 'FILIAL')],
    );
    const r = await service.syncAll({ dry: true });
    expect(r.dry).toBe(true);
    expect(r.banks.inserted).toBe(1);
    expect(writes()).toEqual([]);
  });

  it('treats an empty answer as a failure, not as no banks', async () => {
    source([], [branch('00451', '002', 'FILIAL')]);
    await expect(service.syncAll()).rejects.toThrow(/nothing written/);
    expect(writes()).toEqual([]);
  });

  it('says which HTTP answer it got when the source fails', async () => {
    post.mockResolvedValue({ status: 502, data: '<html>Bad gateway</html>' });
    await expect(service.syncAll()).rejects.toThrow(/HTTP 502/);
    expect(writes()).toEqual([]);
  });

  it('refuses a cut-off answer rather than taking it for a smaller registry', async () => {
    post.mockResolvedValue({
      status: 200,
      data: {
        error: null,
        result: { isSuccess: false, count: 72, data: [bank('001', 'X')] },
      },
    });
    await expect(service.syncAll()).rejects.toThrow(/1 of 72 rows/);
    expect(writes()).toEqual([]);
  });

  describe('run', () => {
    const runner = {
      connect: jest.fn(),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };
    const jobRuns = () =>
      db.query.mock.calls.filter(([sql]) =>
        /INSERT INTO public\.job_runs/.test(String(sql)),
      );

    beforeEach(() => {
      runner.query
        .mockReset()
        .mockImplementation(async (sql: string) =>
          /pg_try_advisory_lock/.test(sql) ? [{ locked: true }] : [],
        );
      db.createQueryRunner.mockReturnValue(runner);
    });

    it('reports, and keeps the report in job_runs', async () => {
      source(
        [bank('001', 'MARKAZIY BANK')],
        [branch('00450', '002', 'BOSH OFIS')],
      );
      await service.run({}, 'weekly');
      expect(telegram.deliver).toHaveBeenCalledTimes(1);
      expect(telegram.deliver.mock.calls[0][0]).toMatch(
        /Bank registry — weekly/,
      );
      const [row] = jobRuns();
      expect(row[1][0]).toBe('bank_registry');
      expect(row[1][5]).toBe(true); // ok
      expect(row[1][9]).toBe(true); // alert_sent
    });

    it('reports a failure, keeps it, and still throws', async () => {
      post.mockRejectedValue(new Error('connect ETIMEDOUT'));
      await expect(service.run({}, 'weekly')).rejects.toThrow(/ETIMEDOUT/);
      expect(telegram.deliver.mock.calls[0][0]).toMatch(/sync failed/);
      const [row] = jobRuns();
      expect(row[1][5]).toBe(false);
      expect(row[1][8]).toMatch(/ETIMEDOUT/);
    });

    it('leaves the run to the replica holding the lock', async () => {
      runner.query.mockResolvedValueOnce([{ locked: false }]);
      expect(await service.run({}, 'weekly')).toBeNull();
      expect(post).not.toHaveBeenCalled();
    });
  });

  it('runs the weekly sync on deployments only, unless told otherwise', () => {
    expect(
      bankRegistrySyncEnabled({ TG_WEBHOOK_URL: 'https://humora.uz/x' } as any),
    ).toBe(true);
    expect(bankRegistrySyncEnabled({} as any)).toBe(false);
    expect(
      bankRegistrySyncEnabled({ BANK_REGISTRY_SYNC_ENABLED: '1' } as any),
    ).toBe(true);
    expect(
      bankRegistrySyncEnabled({
        TG_WEBHOOK_URL: 'x',
        BANK_REGISTRY_SYNC_ENABLED: '0',
      } as any),
    ).toBe(false);
  });
});
