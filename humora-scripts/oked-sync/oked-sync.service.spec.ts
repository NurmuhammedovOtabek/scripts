import { OkedSyncService, okedSyncEnabled } from './oked-sync.service';
import { parseOkedDataset } from './oked-parse';
import { OkedTreeNode } from '../../oked/oked-tree';
import * as csEgov from '../common/cs-egov';

jest.mock('../common/cs-egov', () => ({
  ...jest.requireActual('../common/cs-egov'),
  fetchCsDataset: jest.fn(),
}));
const fetchCsDataset = csEgov.fetchCsDataset as jest.Mock;

const cell = (text: string) => ({
  text: { uzbText: text, uzbKrText: text, rusText: text, engText: text },
  default: text,
});

function line(cols: Record<string, string>, name: string): csEgov.CsRow {
  return {
    tableColumn: {
      DIVISION: cell(cols.DIVISION ?? '-'),
      GROUP: cell(cols.GROUP ?? '-'),
      CLASS: cell(cols.CLASS ?? '-'),
      SUBCLASS: cell(cols.SUBCLASS ?? '-'),
      groupname: cell(cols.groupname ?? '-'),
      name: cell(name),
    },
  };
}

/**
 * A classifier of real size: 21 sections, one division each, 3 groups, 3
 * classes per group and 3 subclasses per class — 567 subclasses.
 */
function classifier(sections = 'ABCDEFGHIJKLMNOPQRSTU'.split('')) {
  const rows: csEgov.CsRow[] = [];
  sections.forEach((letter, i) => {
    const d = String(10 + i);
    rows.push(line({ DIVISION: `Section ${letter}` }, `name ${letter}`));
    rows.push(line({ DIVISION: d, groupname: letter }, `name ${d}`));
    for (let g = 1; g <= 3; g++) {
      rows.push(line({ GROUP: `${d}.${g}` }, `name ${d}${g}`));
      for (let c = 1; c <= 3; c++) {
        rows.push(
          line({ CLASS: `${d}.${g}${c}`, groupname: d }, `name ${d}${g}${c}`),
        );
        for (let s = 0; s < 3; s++) {
          rows.push(
            line(
              { SUBCLASS: `${d}.${g}${c}.${s}`, groupname: `${d}.${g}${c}` },
              `name ${d}${g}${c}${s}`,
            ),
          );
        }
      }
    }
  });
  return rows;
}

describe('OkedSyncService', () => {
  let db: {
    query: jest.Mock;
    transaction: jest.Mock;
    createQueryRunner: jest.Mock;
  };
  let tx: { query: jest.Mock };
  let telegram: { deliver: jest.Mock };
  let stored: OkedTreeNode[];
  let service: OkedSyncService;

  const lockRunner = (locked: boolean) => ({
    connect: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string) =>
      /pg_try_advisory_lock/.test(sql) ? [{ locked }] : [],
    ),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    stored = [];
    tx = { query: jest.fn().mockResolvedValue([]) };
    db = {
      query: jest.fn(async (sql: string) =>
        /FROM public\.oked_tree/.test(sql) ? stored : [],
      ),
      transaction: jest.fn(async (fn: (m: unknown) => Promise<void>) => fn(tx)),
      createQueryRunner: jest.fn(() => lockRunner(true)),
    };
    telegram = { deliver: jest.fn().mockResolvedValue(true) };
    service = new OkedSyncService(db as any, telegram as any);
  });

  const inserts = () =>
    tx.query.mock.calls.filter(([sql]) =>
      /INSERT INTO public\.oked_tree/.test(String(sql)),
    );

  it('refuses a classifier too small to be the real one, and writes nothing', async () => {
    fetchCsDataset.mockResolvedValue(classifier(['A', 'B']));
    await expect(service.syncAll()).rejects.toThrow(/too few to trust/);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('writes every node of a first fill', async () => {
    fetchCsDataset.mockResolvedValue(classifier());
    const r = await service.syncAll();
    expect(r.fetched).toEqual({
      section: 21,
      division: 21,
      group: 63,
      class: 189,
      subclass: 567,
    });
    expect(r.inserted).toBe(861);
    expect(r.updated).toBe(0);
    // In batches of 500.
    expect(inserts()).toHaveLength(2);
  });

  it('counts new, changed, unchanged and gone — and keeps the gone', async () => {
    const rows = classifier();
    const fresh = parseOkedDataset(rows).nodes;
    stored = fresh
      .filter((n) => n.code !== 'A') // A is new
      .map((n) => (n.code === '10' ? { ...n, name_ru: 'old name' } : { ...n }));
    stored.push({
      code: '99999',
      level: 'subclass',
      parent_code: '9999',
      section_code: 'U',
      name_uz: 'gone',
      name_uz_cyrl: null,
      name_ru: null,
      name_en: null,
    });
    fetchCsDataset.mockResolvedValue(rows);

    const r = await service.syncAll();
    expect(r.inserted).toBe(1);
    expect(r.updated).toBe(1);
    expect(r.notInSource).toBe(1);
    expect(r.unchanged).toBe(fresh.length - 2);
    expect(r.examples.updated).toEqual(['10: name_ru old name→name 10']);
    expect(r.examples.notInSource).toEqual(['99.99.9 gone']);

    // Only the new and the changed are written; the rest get fetched_at.
    const [[, params]] = inserts();
    expect(params).toContain('A');
    expect(params).toContain('10');
    expect(params).not.toContain('11');
    const touched = tx.query.mock.calls.find(([sql]) =>
      /SET fetched_at = now\(\)/.test(String(sql)),
    );
    expect(touched?.[1][0]).toHaveLength(fresh.length - 2);
    // Nothing is ever deleted.
    expect(
      tx.query.mock.calls.some(([sql]) => /DELETE/i.test(String(sql))),
    ).toBe(false);
  });

  it('writes nothing on a dry run', async () => {
    fetchCsDataset.mockResolvedValue(classifier());
    const r = await service.syncAll({ dry: true });
    expect(r.dry).toBe(true);
    expect(r.inserted).toBe(861);
    expect(db.transaction).not.toHaveBeenCalled();
  });

  describe('run', () => {
    it('reports to Telegram and job_runs', async () => {
      fetchCsDataset.mockResolvedValue(classifier());
      const r = await service.run({}, 'manual');
      expect(r).not.toBeNull();
      expect(telegram.deliver).toHaveBeenCalledTimes(1);
      const text = telegram.deliver.mock.calls[0][0] as string;
      expect(text).toMatch(/OKED classifier — manual/);
      expect(text).toMatch(
        /21 sections · 21 divisions · 63 groups · 189 classes · 567 subclasses/,
      );
      const jobRun = db.query.mock.calls.find(([sql]) =>
        /INSERT INTO public\.job_runs/.test(String(sql)),
      );
      expect(jobRun?.[1][0]).toBe('oked_tree');
      expect(jobRun?.[1][5]).toBe(true);
    });

    it('reports a failed fetch and leaves the table alone', async () => {
      fetchCsDataset.mockRejectedValue(
        new Error('cs.egov.uz answered HTTP 502'),
      );
      await expect(service.run({}, 'weekly')).rejects.toThrow(/HTTP 502/);
      expect(telegram.deliver.mock.calls[0][0]).toMatch(/sync failed/);
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('does nothing where another replica holds the lock', async () => {
      db.createQueryRunner.mockReturnValue(lockRunner(false));
      expect(await service.run({}, 'weekly')).toBeNull();
      expect(fetchCsDataset).not.toHaveBeenCalled();
      expect(telegram.deliver).not.toHaveBeenCalled();
    });
  });

  describe('the first fill', () => {
    it('fills an empty table', async () => {
      db.query.mockImplementation(async (sql: string) =>
        /count\(\*\)/.test(sql) ? [{ n: 0 }] : [],
      );
      const run = jest.spyOn(service, 'run').mockResolvedValue(null);
      await service.fillIfEmpty();
      expect(run).toHaveBeenCalledWith({}, 'first fill');
    });

    it('leaves a filled table to the weekly run', async () => {
      db.query.mockImplementation(async (sql: string) =>
        /count\(\*\)/.test(sql) ? [{ n: 1679 }] : [],
      );
      const run = jest.spyOn(service, 'run');
      await service.fillIfEmpty();
      expect(run).not.toHaveBeenCalled();
    });
  });

  it('runs on deployments, not on a laptop, unless told otherwise', () => {
    expect(okedSyncEnabled({ TG_WEBHOOK_URL: 'https://x' })).toBe(true);
    expect(okedSyncEnabled({})).toBe(false);
    expect(okedSyncEnabled({ OKED_SYNC_ENABLED: '1' })).toBe(true);
    expect(
      okedSyncEnabled({ TG_WEBHOOK_URL: 'https://x', OKED_SYNC_ENABLED: '0' }),
    ).toBe(false);
  });
});
