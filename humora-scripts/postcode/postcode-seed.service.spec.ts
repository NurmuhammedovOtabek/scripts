import {
  PostcodeDataset,
  PostcodeSeedService,
  datasetProblems,
  readDataset,
} from './postcode-seed.service';
import { readCompanyPostcode } from '../../org/company-postcode';

/** A dataset of the real size with made-up codes. */
function dataset(over: Partial<PostcodeDataset> = {}): PostcodeDataset {
  const mahallas = Array.from(
    { length: 5200 },
    (_, i) =>
      [
        `17${String(i).padStart(8, '0')}`,
        `1${String(i % 99999).padStart(5, '0')}`,
        i % 10 ? 'uzpost' : 'emu',
      ] as [string, string, string],
  );
  return { version: '2026-10-02', mahallas, ...over };
}

describe('the bundled postal-code dataset', () => {
  it('is the 2026-10-02 build and passes its own checks', () => {
    const d = readDataset();
    expect(d.version).toBe('2026-10-02');
    expect(d.mahallas).toHaveLength(7447);
    // No district main offices: no approximate codes.
    expect(d).not.toHaveProperty('districts');
    expect(datasetProblems(d)).toEqual([]);
  });

  it('refuses a cut-off, misshapen or doubled file', () => {
    expect(datasetProblems(dataset({ mahallas: [] }))).toEqual(
      expect.arrayContaining([expect.stringMatching(/0 mahallas/)]),
    );
    const d = dataset();
    d.mahallas[3] = ['17000', '12345', 'uzpost'];
    d.mahallas.push(d.mahallas[0]);
    expect(datasetProblems(d)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/not shaped like a code/),
        'a mahalla listed twice',
      ]),
    );
    expect(datasetProblems({ mahallas: [] } as any)).toEqual(['no version']);
  });
});

describe('PostcodeSeedService', () => {
  let held: {
    version: string | null;
    mahallas: Array<{ mahalla_code: string; postcode: string; source: string }>;
  };
  let tx: { query: jest.Mock };
  let db: {
    query: jest.Mock;
    transaction: jest.Mock;
    createQueryRunner: jest.Mock;
  };
  let telegram: { deliver: jest.Mock };
  let service: PostcodeSeedService;

  const lockRunner = (locked: boolean) => ({
    connect: jest.fn(),
    release: jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (sql: string) =>
      /pg_try_advisory_lock/.test(sql) ? [{ locked }] : [],
    ),
  });

  beforeEach(() => {
    held = { version: null, mahallas: [] };
    tx = { query: jest.fn().mockResolvedValue([]) };
    db = {
      query: jest.fn(async (sql: string) => {
        if (/FROM public\.postcode_dataset/.test(sql)) {
          return held.version ? [{ version: held.version }] : [];
        }
        if (/FROM public\.mahalla_postcode/.test(sql)) return held.mahallas;
        return [];
      }),
      transaction: jest.fn(async (fn: (m: unknown) => Promise<void>) => fn(tx)),
      createQueryRunner: jest.fn(() => lockRunner(true)),
    };
    telegram = { deliver: jest.fn().mockResolvedValue(true) };
    service = new PostcodeSeedService(db as any, telegram as any);
  });

  const writes = (table: string) =>
    tx.query.mock.calls.filter(([sql]) =>
      new RegExp(`INSERT INTO public\\.${table}`).test(String(sql)),
    );

  it('writes a first load in batches and records the version', async () => {
    const r = await service.load(dataset());
    expect(r.previousVersion).toBeNull();
    expect(r.mahallas).toMatchObject({ inFile: 5200, inserted: 5200 });
    expect(writes('mahalla_postcode')).toHaveLength(6); // batches of 1000
    const [state] = writes('postcode_dataset');
    expect(state[1]).toEqual(['2026-10-02']);
  });

  it('writes only what changed, and keeps what the file no longer has', async () => {
    const d = dataset();
    held.version = '2026-09-01';
    held.mahallas = d.mahallas.map(([c, p, s]) => ({
      mahalla_code: c,
      postcode: p,
      source: s,
    }));
    held.mahallas[0] = { ...held.mahallas[0], postcode: '999999' };
    held.mahallas.push({
      mahalla_code: '1799999999',
      postcode: '170000',
      source: 'emu',
    });

    const r = await service.load(d);
    expect(r.previousVersion).toBe('2026-09-01');
    expect(r.mahallas).toMatchObject({
      inserted: 0,
      updated: 1,
      unchanged: 5199,
      notInFile: 1,
    });
    expect(r.examples.changed[0]).toMatch(/999999 → 100000/);
    const [write] = writes('mahalla_postcode');
    expect(write[1][0]).toEqual([d.mahallas[0][0]]);
    // Nothing is deleted.
    expect(
      tx.query.mock.calls.some(([sql]) => /DELETE/.test(String(sql))),
    ).toBe(false);
  });

  it('refuses to load a dataset that fails its checks', async () => {
    await expect(service.load(dataset({ mahallas: [] }))).rejects.toThrow(
      /0 mahallas/,
    );
    expect(db.transaction).not.toHaveBeenCalled();
  });

  it('reports a load, and stays quiet while another replica loads', async () => {
    const r = await service.run('manual', dataset());
    expect(r?.mahallas.inserted).toBe(5200);
    expect(telegram.deliver.mock.calls[0][0]).toMatch(/Postal codes — manual/);
    expect(telegram.deliver.mock.calls[0][0]).toMatch(/first load/);

    telegram.deliver.mockClear();
    db.createQueryRunner.mockImplementation(() => lockRunner(false));
    expect(await service.run('boot', dataset())).toBeNull();
    expect(telegram.deliver).not.toHaveBeenCalled();
  });

  it('reports a failed load, then throws', async () => {
    db.transaction.mockRejectedValue(new Error('disk full'));
    await expect(service.run('manual', dataset())).rejects.toThrow('disk full');
    expect(telegram.deliver.mock.calls[0][0]).toMatch(/load failed/);
  });

  it('loads at boot only when the bundled version is not the one held', async () => {
    held.version = readDataset().version;
    expect(await service.loadIfNewer()).toBeNull();
    expect(db.createQueryRunner).not.toHaveBeenCalled();

    held.version = '2026-01-01';
    const r = await service.loadIfNewer();
    expect(r?.version).toBe('2026-10-02');
  });
});

describe('readCompanyPostcode', () => {
  it("answers the mahalla's code, or null", async () => {
    const db = { query: jest.fn() };
    db.query.mockResolvedValueOnce([{ postcode: '171003' }]);
    expect(await readCompanyPostcode(db, '123456789')).toBe('171003');
    db.query.mockResolvedValueOnce([]);
    expect(await readCompanyPostcode(db, '123456789')).toBeNull();
  });
});
