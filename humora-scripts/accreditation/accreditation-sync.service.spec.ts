import axios from 'axios';
import {
  AKKRED_REGISTER_URL,
  AccreditationSyncService,
  accreditationSyncEnabled,
  documentObjectKey,
} from './accreditation-sync.service';
import { AkkredEntry, mapAccreditation } from './accreditation-map';

jest.mock('axios');
const get = axios.get as jest.Mock;

/** A register entry. Nothing in it is real. */
function entry(id: number, over: Partial<AkkredEntry> = {}): AkkredEntry {
  return {
    id,
    uid: null,
    number: `O'ZAK.SL.${String(id).padStart(4, '0')}`,
    status: 'active',
    status_date: '2026-04-30',
    accreditation_date: '2024-12-26',
    accreditation_duration: '2029-12-25',
    tin: '123456789',
    legal_entity_name: 'NAMUNA LABORATORIYA MChJ',
    phone: '+998 71 000 00 00',
    full_name_supervisor_ao: 'TOSHMATOV ESHMAT',
    type_std: { key: 'SL', full: 'Sinov laboratoriyasi' },
    directions: [1],
    certificate_pdf: `https://api-e.akkred.uz/media/file/pdf/sl${id}-Certificate.pdf`,
    modified_date: '2026-04-14T15:05:19.030265+05:00',
    ...over,
  };
}

/** The stored row an entry would have become. */
function storedFrom(e: AkkredEntry, over: Record<string, unknown> = {}) {
  const r = mapAccreditation(e)!;
  return { ...r, delisted_at: null, ...over };
}

const register = (n: number) =>
  Array.from({ length: n }, (_, i) => entry(i + 1));

/** The register answering, in pages of the size asked for. */
function serve(entries: AkkredEntry[], count = entries.length) {
  get.mockImplementation(async (url: string, cfg: any) => {
    if (url !== AKKRED_REGISTER_URL) throw new Error(`unexpected ${url}`);
    const { page, page_size, ordering } = cfg.params;
    const sorted =
      ordering === '-modified_date'
        ? [...entries].sort(
            (a, b) =>
              Date.parse(String(b.modified_date)) -
              Date.parse(String(a.modified_date)),
          )
        : [...entries].sort((a, b) => a.id - b.id);
    const results = sorted.slice((page - 1) * page_size, page * page_size);
    return {
      status: 200,
      data: {
        count,
        next:
          page * page_size < sorted.length ? `${url}?page=${page + 1}` : null,
        results,
      },
    };
  });
}

describe('AccreditationSyncService', () => {
  let stored: any[];
  let pendingDocs: any[];
  let db: {
    query: jest.Mock;
    transaction: jest.Mock;
    createQueryRunner: jest.Mock;
  };
  let tx: { query: jest.Mock };
  let telegram: { deliver: jest.Mock };
  let s3: { ensureBucket: jest.Mock; exists: jest.Mock; upload: jest.Mock };
  let service: AccreditationSyncService;

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
    pendingDocs = [];
    tx = { query: jest.fn().mockResolvedValue([]) };
    db = {
      query: jest.fn(async (sql: string, params?: any[]) => {
        if (/max\(source_modified_at\) AS newest/.test(sql)) {
          const newest = stored
            .map((s) => s.source_modified_at)
            .filter(Boolean)
            .sort()
            .pop();
          return [{ newest: newest ? new Date(newest) : null }];
        }
        if (/SELECT source_id, content_hash, delisted_at/.test(sql)) {
          return stored.filter((s) => params![0].includes(s.source_id));
        }
        if (/AS label/.test(sql)) {
          return stored
            .filter((s) => !s.delisted_at && !params![0].includes(s.source_id))
            .map((s) => ({ source_id: s.source_id, label: s.number }));
        }
        if (/SELECT id, source_id, number,/.test(sql)) return pendingDocs;
        if (/AS pending/.test(sql)) return [{ pending: 0 }];
        return [];
      }),
      transaction: jest.fn(async (fn: (m: unknown) => Promise<void>) => fn(tx)),
      createQueryRunner: jest.fn(() => lockRunner(true)),
    };
    telegram = { deliver: jest.fn().mockResolvedValue(true) };
    s3 = {
      ensureBucket: jest.fn().mockResolvedValue(undefined),
      exists: jest.fn().mockResolvedValue(false),
      upload: jest.fn().mockResolvedValue('url'),
    };
    service = new AccreditationSyncService(
      db as any,
      telegram as any,
      s3 as any,
    );
  });

  const txCalls = (re: RegExp) =>
    tx.query.mock.calls.filter(([sql]) => re.test(String(sql)));

  describe('the whole register', () => {
    it('writes a first fill in batches, with no change log', async () => {
      serve(register(450));
      const r = await service.syncAll({ mode: 'full' });
      expect(r).toMatchObject({
        mode: 'full',
        sourceCount: 450,
        read: 450,
        pages: 1,
        inserted: 450,
        updated: 0,
        delisted: 0,
      });
      expect(
        txCalls(/INSERT INTO public\.company_accreditations/),
      ).toHaveLength(5);
      expect(txCalls(/company_change_log/)).toHaveLength(0);
      // Read by id, so no page can shift under the walk.
      expect(get.mock.calls[0][1].params).toMatchObject({ ordering: 'id' });
    });

    it('sends lists as JSON text, not as Postgres arrays', async () => {
      serve(register(450));
      await service.syncAll({ mode: 'full' });
      const [, params] = txCalls(
        /INSERT INTO public\.company_accreditations/,
      )[0];
      expect(params).toContain('[1]');
      expect(params).toContain(
        JSON.stringify({ key: 'SL', full: 'Sinov laboratoriyasi' }),
      );
    });

    it('refuses a register cut off before its own count', async () => {
      serve(register(450), 823);
      await expect(service.syncAll({ mode: 'full' })).rejects.toThrow(
        /sent 450 of 823/,
      );
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('refuses a register too small to be the real one', async () => {
      serve(register(12));
      await expect(service.syncAll({ mode: 'full' })).rejects.toThrow(
        /too few to trust/,
      );
      expect(db.transaction).not.toHaveBeenCalled();
    });

    it('refuses an answer that is not a list', async () => {
      get.mockResolvedValue({ status: 200, data: { detail: 'maintenance' } });
      await expect(service.syncAll({ mode: 'full' })).rejects.toThrow(
        /without a list/,
      );
      get.mockResolvedValue({ status: 502, data: '' });
      await expect(service.syncAll({ mode: 'full' })).rejects.toThrow(
        /HTTP 502/,
      );
    });

    it('keeps a unit the register stopped listing, and marks it', async () => {
      const entries = register(450);
      stored = entries.map((e) => storedFrom(e));
      stored.push(storedFrom(entry(9001)));
      serve(entries);

      const r = await service.syncAll({ mode: 'full' });
      expect(r.delisted).toBe(1);
      expect(r.unchanged).toBe(450);
      const [mark] = txCalls(/SET delisted_at = now\(\)/);
      expect(mark[1][0]).toEqual([9001]);
      // Nothing is deleted.
      expect(txCalls(/DELETE/)).toHaveLength(0);
    });

    it('marks what it read as seen, and lists a delisted unit again', async () => {
      const entries = register(450);
      stored = entries.map((e) => storedFrom(e));
      stored[0].delisted_at = '2026-10-04T03:40:00+05:00';
      serve(entries);

      const r = await service.syncAll({ mode: 'full' });
      expect(r.relisted).toBe(1);
      const seen = txCalls(/jsonb_to_recordset/);
      expect(seen).toHaveLength(3); // 450 rows in batches of 200
      expect(String(seen[0][0])).toMatch(/delisted_at = NULL/);
    });
  });

  describe('a changed unit', () => {
    const base = register(450);

    it('logs what it replaces, keeps held values over blanks, and keeps the old status', async () => {
      stored = base.map((e) => storedFrom(e));
      const changed = base.map((e) =>
        e.id === 7 ? { ...e, status: 'paused', phone: '' } : e,
      );
      serve(changed);

      const r = await service.syncAll({ mode: 'full' });
      expect(r.updated).toBe(1);
      expect(r.statusChanges).toBe(1);
      expect(r.examples.statusChanges[0]).toMatch(/active → paused/);

      const [log] = txCalls(/INSERT INTO public\.company_change_log/);
      expect(log[1]).toEqual(
        expect.arrayContaining([
          'company_accreditations',
          '7',
          'status',
          JSON.stringify('active'),
          JSON.stringify('paused'),
          'akkred.uz',
        ]),
      );
      // A blank phone replaces nothing, so nothing of it is logged.
      expect(log[1]).not.toContain('phone');

      const [update] = txCalls(/UPDATE public\.company_accreditations SET/);
      expect(String(update[0])).toMatch(
        /phone = COALESCE\(\$\d+::text, phone\)/,
      );
      expect(String(update[0])).toMatch(/previous_status = CASE/);
      expect(String(update[0])).toMatch(
        /updated_at = CASE WHEN \$\d+::boolean/,
      );
      expect(update[1]).toContain(true);
    });

    it('counts a unit changed only by blanks apart, and moves no updated_at', async () => {
      stored = base.map((e) => storedFrom(e));
      serve(base.map((e) => (e.id === 3 ? { ...e, phone: '-' } : e)));

      const r = await service.syncAll({ mode: 'full' });
      expect(r.updated).toBe(0);
      expect(r.blanksKept).toBe(1);
      const [update] = txCalls(/UPDATE public\.company_accreditations SET/);
      expect(update[1][update[1].length - 1]).toBe(false);
    });

    it('unties a unit from the company when its TIN stops being a STIR', async () => {
      stored = base.map((e) => storedFrom(e));
      serve(
        base.map((e) => (e.id === 5 ? { ...e, tin: '12345678900001' } : e)),
      );

      await service.syncAll({ mode: 'full' });
      const [log] = txCalls(/INSERT INTO public\.company_change_log/);
      expect(log[1]).toEqual(
        expect.arrayContaining(['inn', JSON.stringify('123456789'), 'null']),
      );
      const [update] = txCalls(/UPDATE public\.company_accreditations SET/);
      expect(String(update[0])).toMatch(
        /inn = CASE WHEN \$\d+::text IS NOT NULL THEN \$\d+::text ELSE inn END/,
      );
    });

    it('writes nothing on a dry run, and fetches no documents', async () => {
      stored = base.map((e) => storedFrom(e));
      serve(base.map((e) => (e.id === 7 ? { ...e, status: 'paused' } : e)));
      pendingDocs = [{ id: 1, source_id: 1, certificate_url: 'x' }];

      const r = await service.syncAll({ mode: 'full', dry: true });
      expect(r.updated).toBe(1);
      expect(r.documents).toBeNull();
      expect(db.transaction).not.toHaveBeenCalled();
      expect(s3.upload).not.toHaveBeenCalled();
    });
  });

  describe('the nightly walk', () => {
    it('reads the newest changes until it reaches what we hold', async () => {
      const old = register(450).map((e) => ({
        ...e,
        modified_date: '2026-01-01T00:00:00+05:00',
      }));
      // The newest change held.
      old[449] = { ...old[449], modified_date: '2026-05-01T00:00:00+05:00' };
      stored = old.map((e) => storedFrom(e));
      const fresh = old.map((e) =>
        e.id <= 2
          ? {
              ...e,
              status: 'expired',
              modified_date: '2026-10-09T10:00:00+05:00',
            }
          : e,
      );
      serve(fresh);

      const r = await service.syncAll({ mode: 'nightly' });
      expect(r.mode).toBe('nightly');
      expect(r.pages).toBe(1);
      // The two changed, and the one saved at the newest held time itself.
      expect(r.read).toBe(3);
      expect(r.updated).toBe(2);
      expect(r.unchanged).toBe(1);
      expect(get.mock.calls[0][1].params).toMatchObject({
        ordering: '-modified_date',
        page_size: 100,
      });
      // Only the whole register can say what is no longer listed.
      expect(r.delisted).toBe(0);
    });

    it('stops at the first entry older than the newest held', async () => {
      const old = register(450).map((e) => ({
        ...e,
        modified_date: '2026-01-01T00:00:00+05:00',
      }));
      stored = old.map((e) => storedFrom(e));
      stored[0].source_modified_at = '2026-05-01T00:00:00+05:00';
      serve([
        entry(500, { modified_date: '2026-10-09T10:00:00+05:00' }),
        ...old,
      ]);

      const r = await service.syncAll({ mode: 'nightly' });
      expect(r.read).toBe(1);
      expect(r.inserted).toBe(1);
      expect(get).toHaveBeenCalledTimes(1);
    });

    it('reads the whole register when nothing is held yet', async () => {
      serve(register(450));
      const r = await service.syncAll({ mode: 'nightly' });
      expect(r.mode).toBe('full');
      expect(r.inserted).toBe(450);
    });
  });

  describe('documents', () => {
    const pdf = Buffer.from('%PDF-1.7 namuna');
    const row = {
      id: 11,
      source_id: 409,
      number: "O'ZAK.SL.0001",
      certificate_url: 'https://api-e.akkred.uz/media/c.pdf',
      certificate_key_from: null,
      certificate_missing_from: null,
      scope_url: 'https://api-e.akkred.uz/media/s.pdf',
      scope_key_from: null,
      scope_missing_from: null,
    };

    it('stores a PDF, and marks a file the source does not have', async () => {
      pendingDocs = [row];
      get.mockImplementation(async (url: string) =>
        url.endsWith('c.pdf')
          ? { status: 200, data: pdf }
          : { status: 404, data: Buffer.alloc(0) },
      );

      const r = await service.mirrorDocuments();
      expect(r).toMatchObject({ stored: 1, missing: 1, failed: 0 });
      const key = documentObjectKey(409, 'certificate', row.certificate_url);
      expect(s3.upload).toHaveBeenCalledWith(
        'accreditation-documents',
        key,
        pdf,
        'application/pdf',
      );
      const writes = db.query.mock.calls.filter(([sql]) =>
        /UPDATE public\.company_accreditations/.test(String(sql)),
      );
      expect(String(writes[0][0])).toMatch(/certificate_key = \$2/);
      expect(writes[0][1]).toEqual([11, key, row.certificate_url]);
      expect(String(writes[1][0])).toMatch(/scope_missing_from = \$2/);
      expect(writes[1][1]).toEqual([11, row.scope_url]);
    });

    it('does not keep what is not a PDF', async () => {
      pendingDocs = [{ ...row, scope_url: null }];
      get.mockResolvedValue({ status: 200, data: Buffer.from('<html>') });
      const r = await service.mirrorDocuments();
      expect(r.missing).toBe(1);
      expect(r.examples.missing[0]).toMatch(/not a PDF/);
      expect(s3.upload).not.toHaveBeenCalled();
    });

    it('asks again next run after a failure, and stops on an outage', async () => {
      pendingDocs = Array.from({ length: 12 }, (_, i) => ({
        ...row,
        id: i + 1,
        source_id: i + 1,
        scope_url: null,
      }));
      get.mockResolvedValue({ status: 503, data: Buffer.alloc(0) });
      // Skip the pauses between downloads; leave every other timer alone.
      const realSetTimeout = global.setTimeout;
      jest.spyOn(global, 'setTimeout').mockImplementation(((
        fn: () => void,
        ms?: number,
      ) => {
        if (ms === 300) {
          fn();
          return 0 as any;
        }
        return realSetTimeout(fn, ms);
      }) as any);

      const r = await service.mirrorDocuments();
      expect(r.failed).toBe(10);
      expect(r.stoppedEarly).toBe(true);
      expect(r.stopReason).toBe('outage');
      // A failure marks nothing missing.
      expect(
        db.query.mock.calls.some(([sql]) => /_missing_from = \$2/.test(sql)),
      ).toBe(false);
      (global.setTimeout as unknown as jest.SpyInstance).mockRestore();
    });

    it('gives every download a hard deadline, connection included', async () => {
      pendingDocs = [{ ...row, scope_url: null }];
      get.mockResolvedValue({ status: 200, data: pdf });
      await service.mirrorDocuments();
      const [, cfg] = get.mock.calls[0];
      expect(cfg.signal).toBeInstanceOf(AbortSignal);
      expect(cfg.timeout).toBe(60_000);
    });

    it('gives up on object storage that does not answer, and moves on', async () => {
      jest.useFakeTimers();
      try {
        pendingDocs = [{ ...row, scope_url: null }];
        s3.exists.mockReturnValue(new Promise(() => undefined));
        const p = service.mirrorDocuments();
        await jest.advanceTimersByTimeAsync(61_000);
        const r = await p;
        expect(r.failed).toBe(1);
        expect(r.examples.failed[0]).toMatch(/object storage: no answer/);
        expect(get).not.toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves the rest for the next run once its time is up', async () => {
      pendingDocs = [{ ...row, scope_url: null }];
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValueOnce(0).mockReturnValue(3 * 60 * 60_000);
      try {
        const r = await service.mirrorDocuments();
        expect(r).toMatchObject({
          stored: 0,
          stoppedEarly: true,
          stopReason: 'time budget',
        });
        expect(get).not.toHaveBeenCalled();
      } finally {
        now.mockRestore();
      }
    });

    it('keys a file by its URL, so a new upload is a new object', () => {
      const a = documentObjectKey(409, 'certificate', 'https://x/a.pdf');
      const b = documentObjectKey(409, 'certificate', 'https://x/b.pdf');
      expect(a).toMatch(/^409\/certificate-[0-9a-f]{12}\.pdf$/);
      expect(a).not.toBe(b);
    });
  });

  describe('run', () => {
    it('reports to Telegram and job_runs', async () => {
      serve(register(450));
      const r = await service.run({ mode: 'full' }, 'manual');
      expect(r?.inserted).toBe(450);
      expect(telegram.deliver).toHaveBeenCalledTimes(1);
      expect(telegram.deliver.mock.calls[0][0]).toMatch(
        /Accreditation register — manual/,
      );
      expect(
        db.query.mock.calls.some(([sql]) =>
          /INSERT INTO public\.job_runs/.test(sql),
        ),
      ).toBe(true);
    });

    it('does nothing and says nothing while another replica holds the lock', async () => {
      db.createQueryRunner.mockImplementation(() => lockRunner(false));
      const r = await service.run({ mode: 'full' }, 'nightly');
      expect(r).toBeNull();
      expect(get).not.toHaveBeenCalled();
      expect(telegram.deliver).not.toHaveBeenCalled();
    });

    it('reports a failed sync, then throws', async () => {
      get.mockResolvedValue({ status: 500, data: '' });
      await expect(service.run({ mode: 'full' }, 'nightly')).rejects.toThrow(
        /HTTP 500/,
      );
      expect(telegram.deliver.mock.calls[0][0]).toMatch(/sync failed/);
    });
  });

  it('runs on deployments only, unless told', () => {
    expect(
      accreditationSyncEnabled({ TG_WEBHOOK_URL: 'https://x' } as any),
    ).toBe(true);
    expect(accreditationSyncEnabled({} as any)).toBe(false);
    expect(
      accreditationSyncEnabled({
        TG_WEBHOOK_URL: 'https://x',
        ACCREDITATION_SYNC_ENABLED: '0',
      } as any),
    ).toBe(false);
    expect(
      accreditationSyncEnabled({ ACCREDITATION_SYNC_ENABLED: '1' } as any),
    ).toBe(true);
  });
});
