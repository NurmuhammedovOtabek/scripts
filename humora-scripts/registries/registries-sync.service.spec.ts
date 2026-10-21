import { entry } from './adapters/adapter-kit';
import { HostPacer, SourceRefusedError } from './registry-http';
import {
  entryHash,
  RegistriesSyncService,
  registriesSyncEnabled,
} from './registries-sync.service';
import { REGISTRY_ADAPTERS } from './registry-catalog';
import {
  FetchResult,
  MappedEntry,
  RegistryAdapter,
  RegistryMeta,
} from './registry-types';

interface Stored {
  source_key: string;
  content_hash: string;
  delisted_at: string | null;
  inn?: string | null;
  name: string | null;
  number: string | null;
  status: string | null;
  is_active: boolean | null;
  valid_from: string | null;
  valid_to: string | null;
  amount: string | null;
  fields: Record<string, unknown>;
}

function fakeDb(stored: Stored[] = [], adapterState: unknown = null) {
  const period = (s: Stored) => String(s.fields?.period ?? '');
  const query = jest.fn(async (sql: string, params: any[] = []) => {
    if (/SELECT adapter_state FROM/.test(sql)) {
      return [{ adapter_state: adapterState }];
    }
    if (/count\(\*\)::int AS n FROM/.test(sql)) {
      return [
        {
          n: stored.filter(
            (s) => !s.delisted_at && params[1].includes(period(s)),
          ).length,
        },
      ];
    }
    if (/SELECT source_key, content_hash, delisted_at/.test(sql)) {
      return stored.filter((s) => params[1].includes(s.source_key));
    }
    if (/SELECT source_key, name, number FROM/.test(sql)) {
      return stored.filter(
        (s) =>
          !s.delisted_at &&
          !params[1].includes(s.source_key) &&
          !(params[2] ?? []).includes(period(s)),
      );
    }
    if (/count\(\*\)::int AS listed/.test(sql)) {
      return [{ listed: stored.filter((s) => !s.delisted_at).length }];
    }
    return [];
  });
  const db = {
    query,
    transaction: async (cb: (m: any) => Promise<void>) => cb({ query }),
  };
  const sqls = () => query.mock.calls.map(([sql]) => String(sql));
  const writes = (re: RegExp) =>
    query.mock.calls.filter(([sql]) => re.test(String(sql)));
  return { db, query, sqls, writes };
}

const telegram = { deliver: jest.fn().mockResolvedValue(true) };

const META: RegistryMeta = {
  code: 'test_register',
  sector: 'finance',
  kind: 'licence',
  title: { uz: 'Sinov', ru: 'Тест', en: 'Test' },
  cadence: 'weekly',
  display: true,
  fieldLabels: {},
  minRows: 1,
};

function adapter(
  rows: MappedEntry[],
  read: Partial<FetchResult> = {},
  meta: Partial<RegistryMeta> = {},
): RegistryAdapter {
  return {
    meta: { ...META, ...meta },
    fetchAll: async () => ({
      rows,
      complete: true,
      expected: rows.length,
      ...read,
    }),
    map: (row) => row as MappedEntry,
  };
}

const lic = (n: number, extra: Partial<MappedEntry> = {}) =>
  entry({
    sourceKey: `L-${n}`,
    inn: `30000000${n}`,
    name: `"ALFA ${n}" MChJ`,
    number: `L-${n}`,
    validFrom: '2026-01-01',
    fields: { address: 'Toshkent sh.' },
    raw: { n },
    ...extra,
  });

const storedOf = (m: MappedEntry, over: Partial<Stored> = {}): Stored => ({
  source_key: m.sourceKey,
  content_hash: entryHash(m),
  delisted_at: null,
  inn: m.inn,
  name: m.name,
  number: m.number,
  status: m.status,
  is_active: m.isActive,
  valid_from: m.validFrom,
  valid_to: m.validTo,
  amount: m.amount === null ? null : String(m.amount),
  fields: m.fields,
  ...over,
});

const run = (svc: RegistriesSyncService, a: RegistryAdapter, opts = {}) =>
  svc.syncSource(a, new HostPacer(0), { dry: false, trial: null, ...opts });

describe('RegistriesSyncService.syncSource', () => {
  it('inserts new entries and records the read', async () => {
    const { db, writes } = fakeDb();
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(svc, adapter([lic(1), lic(2)]));
    expect(res).toMatchObject({ ok: true, inserted: 2, complete: true });
    const [insert] = writes(/INSERT INTO public\.company_registry_entries/);
    expect(insert[1]).toEqual(
      expect.arrayContaining(['L-1', 'L-2', '300000001']),
    );
    const [ok] = writes(/UPDATE public\.registry_sources SET\s+last_ok_at/);
    expect(ok[1].slice(0, 3)).toEqual(['test_register', true, 2]);
  });

  it('touches an unchanged entry only through the guarded seen-update', async () => {
    const m = lic(1);
    const { db, writes } = fakeDb([storedOf(m)]);
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(svc, adapter([m]));
    expect(res).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 });
    expect(writes(/INSERT INTO public\.company_registry_entries/)).toHaveLength(
      0,
    );
    const [seen] = writes(/jsonb_to_recordset/);
    expect(seen[0]).toMatch(/t\.raw IS DISTINCT FROM x\.raw/);
    expect(writes(/company_change_log/)).toHaveLength(0);
  });

  it('logs the values a changed entry replaces and keeps stored values over blanks', async () => {
    const was = lic(1, { validTo: '2027-01-01' });
    const now = lic(1, { number: 'L-1-NEW', validTo: null });
    const { db, writes } = fakeDb([storedOf(was)]);
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(svc, adapter([now]));
    expect(res.updated).toBe(1);
    const [log] = writes(/INSERT INTO public\.company_change_log/);
    expect(log[1]).toEqual(
      expect.arrayContaining([
        'number',
        JSON.stringify('L-1'),
        JSON.stringify('L-1-NEW'),
      ]),
    );
    // The blank end date the source sent is not a change.
    expect(log[1]).not.toContain('valid_to');
    const [update] = writes(/UPDATE public\.company_registry_entries SET/);
    expect(update[0]).toMatch(/valid_to = COALESCE\(/);
  });

  it('writes nothing from a read the source cut short', async () => {
    const { db, writes } = fakeDb();
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(
      svc,
      adapter([lic(1)], { complete: false, expected: 5 }),
    );
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/incomplete, nothing written/);
    expect(writes(/INSERT INTO public\.company_registry_entries/)).toHaveLength(
      0,
    );
    expect(writes(/last_error = \$2/)).toHaveLength(1);
  });

  it('writes nothing when a register has fewer entries than it can have', async () => {
    const { db, writes } = fakeDb();
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(svc, adapter([lic(1)], {}, { minRows: 10 }));
    expect(res.error).toMatch(/at least 10 expected/);
    expect(writes(/INSERT INTO/)).toHaveLength(0);
  });

  it('delists what a complete read no longer lists, and never on a trial', async () => {
    const gone = lic(2);
    const { db, writes } = fakeDb([
      storedOf(lic(1)),
      storedOf(gone),
      storedOf(lic(3)),
    ]);
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(svc, adapter([lic(1), lic(3)]));
    expect(res.delisted).toBe(1);
    const [delist] = writes(/SET delisted_at = now\(\)/);
    expect(delist[1][1]).toEqual(['L-2']);

    const trial = fakeDb([storedOf(lic(1)), storedOf(gone)]);
    const svc2 = new RegistriesSyncService(trial.db as any, telegram as any);
    const res2 = await run(svc2, adapter([lic(1)]), { trial: 1 });
    expect(res2).toMatchObject({ ok: true, complete: false, delisted: 0 });
    expect(trial.writes(/SET delisted_at = now\(\)/)).toHaveLength(0);
  });

  it('refuses a read that would take most of a register off it', async () => {
    const stored = Array.from({ length: 30 }, (_, i) => storedOf(lic(i + 10)));
    const { db, writes } = fakeDb(stored);
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(svc, adapter([lic(10), lic(11)]));
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/not trusted, nothing written/);
    expect(writes(/SET delisted_at = now\(\)/)).toHaveLength(0);
    expect(writes(/INSERT INTO public\.company_registry_entries/)).toHaveLength(
      0,
    );
  });

  it('lets a new period of a benefit list replace the old one', async () => {
    const stored = Array.from({ length: 30 }, (_, i) => storedOf(lic(i + 10)));
    const { db } = fakeDb(stored);
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(
      svc,
      adapter([lic(1)], {}, { kind: 'benefit', periodic: true }),
    );
    expect(res).toMatchObject({ ok: true, delisted: 30 });
  });

  it('keeps the quarters a read left alone, and remembers what it read', async () => {
    const q = (n: number, p: string) =>
      lic(n, { sourceKey: `P-${p}-${n}`, fields: { period: p } });
    const stored = [
      ...Array.from({ length: 30 }, (_, i) => storedOf(q(i + 10, '2026Q1'))),
      storedOf(q(1, '2026Q3')),
      storedOf(q(2, '2026Q3')),
    ];
    const before = { files: { '2026Q1': 'https://x/q1.pdf' } };
    const { db, writes } = fakeDb(stored, before);
    const fetchAll = jest.fn(async () => ({
      rows: [q(1, '2026Q3')],
      complete: true,
      expected: null,
      heldPeriods: ['2026Q1'],
      state: { files: { ...before.files, '2026Q3': 'https://x/q3.pdf' } },
      notes: ['2025-yil 1-chorak: layout not known — not read'],
    }));
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(svc, {
      ...adapter([], {}, { kind: 'permit', periodic: true, minRows: 20 }),
      fetchAll,
    });
    // The stored state reached the adapter.
    expect((fetchAll.mock.calls[0] as any)[1]).toMatchObject({ state: before });
    // Q1's 30 stay listed and count towards minRows; only Q3's 2 is gone.
    expect(res).toMatchObject({ ok: true, held: 30, delisted: 1 });
    expect(res.notes).toHaveLength(1);
    const [saved] = writes(/adapter_state = CASE/);
    expect(JSON.parse(saved[1][5])).toEqual({
      files: { '2026Q1': 'https://x/q1.pdf', '2026Q3': 'https://x/q3.pdf' },
    });
  });

  it('reads every file again when asked, and never hands a trial the state', async () => {
    const fetchAll = jest.fn(async () => ({
      rows: [lic(1)],
      complete: true,
      expected: 1,
    }));
    const svc = new RegistriesSyncService(
      fakeDb([], { files: { a: 'b' } }).db as any,
      telegram as any,
    );
    await run(svc, { ...adapter([]), fetchAll }, { reread: true });
    await run(svc, { ...adapter([]), fetchAll }, { trial: 1 });
    expect(fetchAll.mock.calls.map((c) => (c as any)[1].state)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('keeps the source file a register was read from, once', async () => {
    const kept = new Set<string>(['audit_firm/_source/2026-02-09-old.pdf']);
    const s3 = {
      ensureBucket: jest.fn(async () => false),
      exists: jest.fn(async (_b: string, key: string) => kept.has(key)),
      upload: jest.fn(async (_b: string, key: string) => {
        kept.add(key);
        return key;
      }),
    };
    const file = {
      url: 'https://api-portal.gov.uz/uploads/3/2026/02/09/a_media_.pdf',
      day: '2026-02-09',
      data: Buffer.from('%PDF-1.5'),
    };
    const svc = new RegistriesSyncService(
      fakeDb().db as any,
      telegram as any,
      s3 as any,
    );
    const a = adapter([lic(1)], { files: [file] });
    const first = await run(svc, a);
    expect(first.notes).toEqual([
      'kept 1 source file(s) in registry-documents',
    ]);
    expect(s3.upload.mock.calls[0][1]).toMatch(
      /^test_register\/_source\/2026-02-09-/,
    );
    const second = await run(svc, a);
    expect(second.notes).toEqual([]);
    expect(s3.upload).toHaveBeenCalledTimes(1);
    // A dry run keeps nothing.
    await run(
      svc,
      adapter([lic(1)], { files: [{ ...file, url: 'https://x/b.pdf' }] }),
      { dry: true },
    );
    expect(s3.upload).toHaveBeenCalledTimes(1);
  });

  it('writes nothing at all on a dry run', async () => {
    const { db, writes } = fakeDb([storedOf(lic(2))]);
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(svc, adapter([lic(1)]), { dry: true });
    expect(res).toMatchObject({ ok: true, inserted: 1, delisted: 1 });
    expect(writes(/^\s*(INSERT|UPDATE)/)).toHaveLength(0);
  });

  it('reports a refusal and leaves the register as it was', async () => {
    const { db, writes } = fakeDb();
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const a = adapter([]);
    a.fetchAll = () =>
      Promise.reject(new SourceRefusedError('example.uz', 403));
    const res = await run(svc, a);
    expect(res).toMatchObject({ ok: false, refused: true });
    expect(writes(/INSERT INTO public\.company_registry_entries/)).toHaveLength(
      0,
    );
  });

  it('drops a repeated row quietly and counts a key read twice with other values', async () => {
    const { db } = fakeDb();
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(
      svc,
      adapter([lic(1), lic(1), lic(1, { number: 'OTHER' })]),
    );
    expect(res).toMatchObject({ entries: 1, copies: 1, duplicates: 1 });
  });

  it('keeps no person’s name from a register without a STIR', async () => {
    const { db, writes } = fakeDb();
    const svc = new RegistriesSyncService(db as any, telegram as any);
    const res = await run(
      svc,
      adapter(
        [
          lic(1, { inn: null }),
          lic(2, { inn: null, name: 'TOSHMATOV ESHMAT' }),
        ],
        {},
        { nameOnly: true },
      ),
    );
    expect(res.entries).toBe(1);
    expect(Object.values(res.skipped)).toEqual([1]);
    const [insert] = writes(/INSERT INTO public\.registry_name_rows/);
    expect(JSON.stringify(insert[1])).not.toContain('TOSHMATOV');
  });

  it('keeps a register with no STIR in the name store', async () => {
    const { db, writes } = fakeDb();
    const svc = new RegistriesSyncService(db as any, telegram as any);
    await run(
      svc,
      adapter(
        [lic(1, { inn: null, region: 'Toshkent sh.' })],
        {},
        { nameOnly: true },
      ),
    );
    const [insert] = writes(/INSERT INTO public\.registry_name_rows/);
    expect(insert[0]).toMatch(/name_key, region/);
    expect(insert[1]).toContain('ALFA1');
  });
});

describe('which registers a run reads', () => {
  const svc = new RegistriesSyncService({} as any, telegram as any);
  const codes = (xs: RegistryAdapter[]) => xs.map((a) => a.meta.code);

  it('reads the daily ones at night, the monthly ones on the first Sunday only', () => {
    const nightly = codes(
      svc.selectAdapters({ scope: 'nightly' }, '2026-10-13'),
    );
    expect(nightly).toEqual(
      expect.arrayContaining(['pharma_gpp', 'pharma_gmp']),
    );
    expect(nightly).not.toContain('customs_benefit');

    const second = codes(svc.selectAdapters({ scope: 'weekly' }, '2026-10-11'));
    expect(second).toContain('customs_benefit');
    expect(second).not.toContain('tax_customs_benefit');
    const first = codes(svc.selectAdapters({ scope: 'weekly' }, '2026-10-04'));
    expect(first).toContain('tax_customs_benefit');
  });

  it('reads the PDF registers from the web, and refuses an unknown code', () => {
    expect(codes(svc.selectAdapters({ scope: 'all' }))).toEqual(
      expect.arrayContaining(['audit_firm', 'sanitary_import_conclusion']),
    );
    expect(() => svc.selectAdapters({ sources: ['nope'] })).toThrow(
      /unknown register/,
    );
  });

  it('has a neutral, unique code for every register', () => {
    const all = REGISTRY_ADAPTERS.map((a) => a.meta.code);
    expect(new Set(all).size).toBe(all.length);
    for (const code of all) {
      expect(code).not.toMatch(/cbu|egov|napp|uzpharm|e_ngo|advokat|soliq|gov/);
    }
  });
});

describe('registriesSyncEnabled', () => {
  it('runs where alerts go, unless switched', () => {
    expect(registriesSyncEnabled({ TG_WEBHOOK_URL: 'x' })).toBe(true);
    expect(registriesSyncEnabled({})).toBe(false);
    expect(
      registriesSyncEnabled({
        REGISTRIES_SYNC_ENABLED: '0',
        TG_WEBHOOK_URL: 'x',
      }),
    ).toBe(false);
    expect(registriesSyncEnabled({ REGISTRIES_SYNC_ENABLED: '1' })).toBe(true);
  });
});
