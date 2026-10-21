import { CourtDocumentsSyncService } from './court-documents-sync.service';

/**
 * The behaviours worth pinning down are the ones that cost real money or real
 * goodwill if they regress: re-downloading ~95k files from a government portal,
 * writing a multipart preamble into a PDF nobody can open, and forgetting a
 * file we already hold.
 */
describe('CourtDocumentsSyncService', () => {
  const PDF = Buffer.from('%PDF-1.7\nbody here\n%%EOF');
  const wrapped = (pdf: Buffer) =>
    Buffer.concat([
      Buffer.from(
        '--BmT9\r\nContent-Disposition: form-data; name="file"\r\n' +
          'Content-Type: application/pdf\r\n\r\n',
      ),
      pdf,
      Buffer.from('\r\n--BmT9--\r\n'),
    ]);

  let db: { query: jest.Mock };
  let s3: {
    exists: jest.Mock;
    upload: jest.Mock;
    ensureBucket: jest.Mock;
    getObjectStream: jest.Mock;
  };
  let tg: { send: jest.Mock };
  let service: CourtDocumentsSyncService;

  const make = () =>
    new CourtDocumentsSyncService(db as any, s3 as any, tg as any);

  beforeEach(() => {
    jest.restoreAllMocks();
    delete process.env.MINIO_COURT_PREFIX;
    delete process.env.MINIO_COURT_BUCKET;
    db = { query: jest.fn().mockResolvedValue([]) };
    s3 = {
      exists: jest.fn().mockResolvedValue(false),
      upload: jest.fn().mockResolvedValue('url'),
      ensureBucket: jest.fn().mockResolvedValue(false),
      getObjectStream: jest.fn(),
    };
    tg = { send: jest.fn().mockResolvedValue(undefined) };
    service = make();
  });

  describe('object key', () => {
    const key = (svc: CourtDocumentsSyncService, c: string, d: string) =>
      (svc as any).objectKey(c, d);

    it('flattens the slash in a case number so the path stays one folder deep', () => {
      expect(key(service, '4-1501-2503/20477', 'abc')).toBe(
        '4-1501-2503_20477/abc.pdf',
      );
    });

    it('puts a test environment in its own prefix', () => {
      process.env.MINIO_COURT_PREFIX = 'test/';
      expect(key(make(), '4-1501-2503/20477', 'abc')).toBe(
        'test/4-1501-2503_20477/abc.pdf',
      );
    });

    it('tolerates a prefix written without the trailing slash', () => {
      process.env.MINIO_COURT_PREFIX = 'test';
      expect(key(make(), '1/2', 'abc')).toBe('test/1_2/abc.pdf');
    });
  });

  describe('unwrap', () => {
    const unwrap = (b: Buffer) => (service as any).unwrap(b) as Buffer;

    it('strips the multipart envelope down to the PDF itself', () => {
      const out = unwrap(wrapped(PDF));
      expect(out.subarray(0, 5).toString()).toBe('%PDF-');
      expect(out.subarray(-5).toString()).toBe('%%EOF');
      expect(out.indexOf('Content-Disposition')).toBe(-1);
      expect(out.equals(PDF)).toBe(true);
    });

    it('leaves a bare PDF untouched', () => {
      expect(unwrap(PDF).equals(PDF)).toBe(true);
    });

    // The real source ends `%%EOF` `\n` `\r\n--boundary`, and counts that first
    // break in the pdf_size it publishes. Dropping it left every such file one
    // byte short of the original, so a stored size could never be compared
    // against the declared one.
    it('keeps the line break that ends the document', () => {
      const withEol = Buffer.from('%PDF-1.7\nbody here\n%%EOF\n');
      const out = unwrap(
        Buffer.concat([
          Buffer.from('--BmT9\r\nContent-Type: application/pdf\r\n\r\n'),
          withEol,
          Buffer.from('\r\n--BmT9--\r\n'),
        ]),
      );
      expect(out.equals(withEol)).toBe(true);
      expect(out.length).toBe(withEol.length);
    });

    it('keeps a CRLF terminator whole', () => {
      const withCrlf = Buffer.from('%PDF-1.7\nbody\n%%EOF\r\n');
      expect(unwrap(wrapped(withCrlf)).equals(withCrlf)).toBe(true);
    });

    // Only the document's own terminator — never the CRLF that frames the
    // multipart boundary, which would put envelope bytes back in the file.
    it('takes at most one terminator, not the boundary framing', () => {
      const out = unwrap(wrapped(PDF));
      expect(out.equals(PDF)).toBe(true);
      expect(out.indexOf('--BmT9')).toBe(-1);
    });

    it('refuses a body that holds no PDF at all', () => {
      expect(() => unwrap(Buffer.from('<html>error</html>'))).toThrow(/no PDF/);
    });

    // An envelope around nothing and a file in another format are both "no
    // PDF", but the reason kept says which the source sent.
    it('tells an empty answer from a file in another format', () => {
      const reasonOf = (raw: Buffer) => {
        try {
          unwrap(raw);
        } catch (err: any) {
          return err.reason;
        }
      };
      expect(reasonOf(wrapped(Buffer.alloc(0)))).toBe('empty');
      expect(
        reasonOf(
          Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(27_000)]),
        ),
      ).toBe('not_pdf');
    });
  });

  describe('a decision the source has no PDF for', () => {
    const row = {
      doc_id: '11111111-1111-1111-1111-111111111111',
      pdf_id: '22222222-2222-2222-2222-222222222222',
      case_number: '4-1303-2401/2573',
    };
    const marks = () =>
      db.query.mock.calls.filter((c) =>
        /SET unavailable_at = now\(\)/.test(String(c[0])),
      );

    beforeEach(() => {
      (service as any).isRunning = true;
    });

    // 1,154 of these were asked for every night from August on. The source's
    // answer stands until the feed names another file; it is not a failure
    // to retry.
    it('marks it and does not count it as a failure', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => wrapped(Buffer.alloc(0)),
      }) as any;

      const r = await (service as any).storeAll([row], 1);

      expect(r).toMatchObject({ stored: 0, failed: 0, noPdf: 1 });
      expect(marks()).toHaveLength(1);
      expect(marks()[0][1]).toEqual([row.doc_id, 'empty']);
      expect(s3.upload).not.toHaveBeenCalled();
    });

    // A source that did not answer says nothing about the decision; marking
    // it would hide a good file until the feed happened to change.
    it('leaves it unmarked when the request itself failed', async () => {
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      global.fetch = jest
        .fn()
        .mockRejectedValue(new Error('fetch failed')) as any;

      const r = await (service as any).storeAll([row], 1);

      expect(r).toMatchObject({ failed: 1, noPdf: 0 });
      expect(marks()).toHaveLength(0);
    });

    // No timed recheck: only the feed naming another file brings it back
    // (the test below).
    it('is not asked for again while it stays marked', async () => {
      (service as any).isRunning = false;
      await service.fillPending();
      const sql = String(db.query.mock.calls[0][0]);
      expect(sql).toMatch(/d\.unavailable_at IS NULL/);
      expect(sql).not.toMatch(/interval/);
    });

    it('loses the mark once the file is stored', async () => {
      await (service as any).markStored(row.doc_id, 'k.pdf');
      expect(String(db.query.mock.calls[0][0])).toMatch(
        /unavailable_at = NULL, unavailable_reason = NULL/,
      );
    });

    // The court uploading the file shows up as a new id or size in the feed;
    // that is worth asking at once rather than in a month.
    it('drops the mark when the source names a different file', async () => {
      await (service as any).upsertMetadata([
        {
          id: row.doc_id,
          case_number: row.case_number,
          pdf: { id: row.pdf_id, size: 27_000 },
        },
      ]);
      expect(String(db.query.mock.calls[0][0])).toMatch(
        /unavailable_at = CASE\s+WHEN company_court_documents\.pdf_id IS DISTINCT FROM EXCLUDED\.pdf_id\s+OR company_court_documents\.pdf_size IS DISTINCT FROM EXCLUDED\.pdf_size\s+THEN NULL/,
      );
    });
  });

  describe('storeOne', () => {
    const row = {
      doc_id: '11111111-1111-1111-1111-111111111111',
      pdf_id: '22222222-2222-2222-2222-222222222222',
      case_number: '4-1501-2503/20477',
    };

    it('downloads, unwraps and uploads when the object is new', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () => wrapped(PDF),
      });
      global.fetch = fetchMock as any;

      await expect((service as any).storeOne(row)).resolves.toBe(true);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toContain(row.pdf_id);
      const [bucket, key, body, type] = s3.upload.mock.calls[0];
      expect(bucket).toBe('court-documents');
      expect(key).toBe(
        '4-1501-2503_20477/11111111-1111-1111-1111-111111111111.pdf',
      );
      expect((body as Buffer).equals(PDF)).toBe(true);
      expect(type).toBe('application/pdf');
    });

    // The whole point of the design: a second run must not re-fetch 95k files.
    it('does not touch the source when the object is already stored', async () => {
      s3.exists.mockResolvedValue(true);
      const fetchMock = jest.fn();
      global.fetch = fetchMock as any;

      await expect((service as any).storeOne(row)).resolves.toBe(false);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(s3.upload).not.toHaveBeenCalled();
      // ...but the row is still linked, so a cleared stored_key heals itself.
      const update = db.query.mock.calls.find((c) =>
        String(c[0]).includes('stored_key = $2'),
      );
      expect(update).toBeDefined();
      expect(update![1][0]).toBe(row.doc_id);
    });
  });

  describe('getWithRetry', () => {
    it('retries a dropped connection and returns the eventual success', async () => {
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      const fetchMock = jest
        .fn()
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValue({ ok: true });
      global.fetch = fetchMock as any;

      await expect((service as any).getWithRetry('u')).resolves.toEqual({
        ok: true,
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('gives up after the last attempt instead of looping forever', async () => {
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      const fetchMock = jest.fn().mockRejectedValue(new Error('fetch failed'));
      global.fetch = fetchMock as any;

      await expect((service as any).getWithRetry('u', 3)).rejects.toThrow(
        'fetch failed',
      );
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('treats a non-2xx answer as a failure worth retrying', async () => {
      jest.spyOn(service as any, 'sleep').mockResolvedValue(undefined);
      const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 502 });
      global.fetch = fetchMock as any;

      await expect((service as any).getWithRetry('u', 2)).rejects.toThrow(
        'HTTP 502',
      );
    });
  });

  describe('upsertMetadata', () => {
    it('records every published decision, ours or not', async () => {
      await (service as any).upsertMetadata([
        {
          id: 'a',
          case_number: 'c1',
          pdf: { id: 'p1', name: 'n', size: 5 },
          instance: 'FIRST',
          result: 'FULFILLED',
          hearing_date: null,
          court_names: { uz: 'sud' },
        },
        { id: 'b', case_number: 'c2', pdf: { id: 'p2' } },
      ]);
      const [sql, params] = db.query.mock.calls[0];
      expect(sql).toContain('ON CONFLICT (doc_id) DO UPDATE');
      expect(params).toHaveLength(18); // 2 rows × 9 columns
    });

    // Re-running the sweep must never clear a file we already hold.
    it('never overwrites stored_key on conflict', async () => {
      await (service as any).upsertMetadata([
        { id: 'a', case_number: 'c1', pdf: { id: 'p1' } },
      ]);
      expect(db.query.mock.calls[0][0]).not.toContain('stored_key');
    });

    it('skips records the source published without a file', async () => {
      await (service as any).upsertMetadata([{ id: 'a', case_number: 'c1' }]);
      expect(db.query).not.toHaveBeenCalled();
    });
  });

  describe('start', () => {
    it('refuses to run twice at once', async () => {
      (service as any).isRunning = true;
      await expect(service.start()).resolves.toEqual({
        status: 'already_running',
      });
    });

    it('reports the bucket and prefix it will write to', async () => {
      process.env.MINIO_COURT_PREFIX = 'test/';
      const svc = make();
      jest.spyOn(svc as any, 'runLoop').mockResolvedValue(undefined);
      const res = await svc.start({ concurrency: 3 });
      expect(res).toMatchObject({
        status: 'started',
        bucket: 'court-documents',
        prefix: 'test/',
        concurrency: 3,
      });
    });
  });

  // Weekly is the only schedule (user decision, 2026-09-30): the nightly run
  // that walked one page is gone, and so is the nightly backlog pass.
  it('has no nightly run any more', () => {
    expect((service as any).runNightly).toBeUndefined();
  });

  describe('runWeekly', () => {
    beforeEach(() => {
      db.query.mockImplementation(async (sql: string) =>
        /SET run_lock_at = now\(\)/.test(String(sql)) ? [{ ok: 1 }] : [],
      );
    });

    afterEach(() => {
      delete process.env.NODE_ENV;
    });

    it('does not walk a government portal from a dev deployment', async () => {
      process.env.NODE_ENV = 'development';
      const walk = jest.spyOn(service as any, 'runLoop');
      await service.runWeekly();
      expect(walk).not.toHaveBeenCalled();
    });

    // Never resumed: a walk a deploy cut short is done again whole.
    it('walks the whole feed from page 0', async () => {
      process.env.NODE_ENV = 'production';
      const walk = jest
        .spyOn(service as any, 'runLoop')
        .mockResolvedValue(undefined);

      await service.runWeekly();

      const sqls = db.query.mock.calls.map((c: any[]) => String(c[0]));
      const reset = sqls.findIndex((q: string) => /SET last_page = 0/.test(q));
      expect(reset).toBeGreaterThanOrEqual(0);
      expect(walk).toHaveBeenCalledWith({});
    });

    // The lock is what keeps the other replicas off; released before the walk
    // ends, it would let a second one start underneath it.
    it('holds the lock until the walk has finished', async () => {
      process.env.NODE_ENV = 'production';
      const order: string[] = [];
      jest.spyOn(service as any, 'runLoop').mockImplementation(async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('walk done');
      });
      db.query.mockImplementation(async (sql: string) => {
        const q = String(sql);
        if (/SET run_lock_at = NULL/.test(q)) order.push('lock released');
        return /SET run_lock_at = now\(\)/.test(q) ? [{ ok: 1 }] : [];
      });

      await service.runWeekly();

      expect(order).toEqual(['walk done', 'lock released']);
    });

    it('hands the lock back even when the walk crashes', async () => {
      process.env.NODE_ENV = 'production';
      jest
        .spyOn(service as any, 'runLoop')
        .mockRejectedValue(new Error('boom'));

      await service.runWeekly();

      const released = db.query.mock.calls.some((c: any[]) =>
        /SET run_lock_at = NULL/.test(String(c[0])),
      );
      expect(released).toBe(true);
      expect((service as any).isRunning).toBe(false);
    });

    it('stays out when another replica holds the lock', async () => {
      process.env.NODE_ENV = 'production';
      db.query.mockResolvedValue([]);
      const walk = jest.spyOn(service as any, 'runLoop');
      await service.runWeekly();
      expect(walk).not.toHaveBeenCalled();
    });
  });
});

// How the first production sweep died: page 25 listed one decision twice, and
// Postgres aborts an ON CONFLICT DO UPDATE that would touch the same row twice.
describe('upsertMetadata — duplicates inside one page', () => {
  let db: { query: jest.Mock };
  let service: CourtDocumentsSyncService;

  beforeEach(() => {
    db = { query: jest.fn().mockResolvedValue([]) };
    service = new CourtDocumentsSyncService(
      db as any,
      { exists: jest.fn(), upload: jest.fn(), ensureBucket: jest.fn() } as any,
      { send: jest.fn() } as any,
    );
  });

  it('writes a repeated doc_id once, not twice', async () => {
    await (service as any).upsertMetadata([
      { id: 'same', case_number: 'c1', pdf: { id: 'p1', size: 1 } },
      { id: 'other', case_number: 'c2', pdf: { id: 'p2', size: 2 } },
      { id: 'same', case_number: 'c1', pdf: { id: 'p3', size: 3 } },
    ]);

    const [, params] = db.query.mock.calls[0];
    expect(params).toHaveLength(18); // 2 rows × 9 columns, not 3
    // The feed is newest first, so the first listing of a repeated id wins.
    expect(params).toContain('p1');
    expect(params).not.toContain('p3');
  });

  it('still writes a page that holds no duplicate at all', async () => {
    await (service as any).upsertMetadata([
      { id: 'a', case_number: 'c1', pdf: { id: 'p1' } },
      { id: 'b', case_number: 'c2', pdf: { id: 'p2' } },
    ]);
    expect(db.query.mock.calls[0][1]).toHaveLength(18);
  });

  it('drops a duplicate that carries no file without emptying the batch', async () => {
    await (service as any).upsertMetadata([
      { id: 'a', case_number: 'c1' },
      { id: 'a', case_number: 'c1', pdf: { id: 'p1' } },
    ]);
    expect(db.query.mock.calls[0][1]).toHaveLength(9);
  });
});

// A sweep runs for hours. Reporting only every 50 pages meant a short run said
// nothing at all, and a stalled one was indistinguishable from a slow one.
describe('progress reporting', () => {
  let service: CourtDocumentsSyncService;

  beforeEach(() => {
    service = new CourtDocumentsSyncService(
      { query: jest.fn().mockResolvedValue([]) } as any,
      { exists: jest.fn(), upload: jest.fn(), ensureBucket: jest.fn() } as any,
      { send: jest.fn() } as any,
    );
  });

  const line = (page: number, total: number, agoMs: number, done: number) =>
    (service as any).progressLine(page, total, Date.now() - agoMs, done);

  it('reports position, share and a remaining estimate', () => {
    // 340 of 1580 pages took 42 minutes, so the other 1240 take about 2h33m.
    const out = line(340, 1580, 42 * 60_000, 340);
    expect(out).toContain('340</code>/1580');
    expect(out).toContain('22%');
    expect(out).toContain('42m elapsed');
    expect(out).toMatch(/~2h \d+m left/);
  });

  it('falls back to page and elapsed before the feed states a total', () => {
    const out = line(7, 0, 30_000, 7);
    expect(out).toContain('Page <code>7</code>');
    expect(out).toContain('30s elapsed');
    expect(out).not.toContain('left');
  });

  it('does not divide by zero on the very first page', () => {
    expect(() => line(0, 1580, 1000, 0)).not.toThrow();
  });

  it('never claims more than 100% when the feed shrinks mid-run', () => {
    expect(line(1600, 1580, 60_000, 1600)).toContain('100%');
  });

  describe('humanMs', () => {
    const h = (ms: number) => (service as any).humanMs(ms);

    it('reads as hours, minutes or seconds, whichever fits', () => {
      expect(h(45_000)).toBe('45s');
      expect(h(9 * 60_000)).toBe('9m');
      expect(h(3 * 3600_000 + 25 * 60_000)).toBe('3h 25m');
    });

    it('shows nothing negative if the clock jumps', () => {
      expect(h(-5000)).toBe('0s');
    });
  });
});

// adolatapi1.sud.uz answered 502 to everything one night — its own root
// included. Because a failed page only advanced the counter, the sweep walked
// from page 879 to 2578, asking a dead server for pages the feed does not even
// have, and would have carried on until someone noticed.
describe('runLoop — the source going down', () => {
  let db: any;
  let tg: { send: jest.Mock };
  let service: CourtDocumentsSyncService;

  beforeEach(() => {
    jest.restoreAllMocks();
    db = { query: jest.fn().mockResolvedValue([{ last_page: 100 }]) };
    tg = { send: jest.fn().mockResolvedValue(undefined) };
    service = new CourtDocumentsSyncService(
      db as any,
      {
        exists: jest.fn().mockResolvedValue(false),
        upload: jest.fn(),
        ensureBucket: jest.fn().mockResolvedValue(false),
      } as any,
      tg as any,
    );
    (service as any).isRunning = true;
  });

  it('gives up after ten pages in a row fail, instead of walking forever', async () => {
    const fetchPage = jest
      .spyOn(service as any, 'fetchPage')
      .mockRejectedValue(new Error('HTTP 502'));

    await (service as any).runLoop({});

    expect(fetchPage).toHaveBeenCalledTimes(10);
    const alert = tg.send.mock.calls.map(String).join('\n');
    expect(alert).toMatch(/source unreachable/i);
  });

  it('says where it stopped, so the restart is obviously safe', async () => {
    jest
      .spyOn(service as any, 'fetchPage')
      .mockRejectedValue(new Error('HTTP 502'));

    await (service as any).runLoop({});

    const alert = tg.send.mock.calls.map((c) => String(c[0])).join('\n');
    expect(alert).toContain('100'); // the page the cursor is parked on
    expect(alert).toMatch(/resumes/i);
  });

  // A single dropped connection is normal here — one in twenty, measured — and
  // must not end a four-hour run.
  it('walks past an isolated failure', async () => {
    let call = 0;
    jest.spyOn(service as any, 'fetchPage').mockImplementation(async () => {
      call++;
      if (call <= 3) throw new Error('fetch failed');
      return { rows: [], totalPages: 1580 }; // empty page ends the cycle
    });
    const upsert = jest
      .spyOn(service as any, 'upsertMetadata')
      .mockResolvedValue(undefined);

    await (service as any).runLoop({});

    expect(call).toBe(4);
    expect(upsert).not.toHaveBeenCalled();
    expect(tg.send.mock.calls.map(String).join('\n')).toMatch(
      /cycle complete/i,
    );
  });

  it('resets the streak once a page succeeds', async () => {
    let call = 0;
    jest.spyOn(service as any, 'fetchPage').mockImplementation(async () => {
      call++;
      // Nine failures, one success, nine more: never ten in a row.
      if (call === 10) return { rows: [], totalPages: 1580 };
      throw new Error('fetch failed');
    });

    await (service as any).runLoop({});

    expect(call).toBe(10);
    expect(tg.send.mock.calls.map(String).join('\n')).not.toMatch(
      /source unreachable/i,
    );
  });
});

/**
 * On 7 August the nightly cron fired on all three production replicas at once.
 * Each walked the same 1,621 pages of a government portal — about half a
 * million page requests — to store 357 PDFs between them, because the only
 * guard was a boolean local to one Node process.
 */
describe('CourtDocumentsSyncService — one replica, and only the new pages', () => {
  let db: { query: jest.Mock };
  let s3: any;
  let tg: { send: jest.Mock };
  let service: CourtDocumentsSyncService;

  /** Route the shared db mock by what the SQL is asking for. */
  const routeDb = (cursor: Record<string, any>, lockWins = true) =>
    jest.fn().mockImplementation(async (sql: string) => {
      const q = String(sql);
      if (/UPDATE .* SET run_lock_at = now\(\)/s.test(q))
        return lockWins ? [{ '?column?': 1 }] : [];
      if (/SELECT last_page/.test(q)) return [cursor];
      if (/count\(DISTINCT c\.casenumber\)/.test(q)) return [{ n: 0 }];
      return [];
    });

  beforeEach(() => {
    jest.restoreAllMocks();
    tg = { send: jest.fn().mockResolvedValue(undefined) };
    s3 = { ensureBucket: jest.fn().mockResolvedValue(false) };
    db = { query: routeDb({}) };
    service = new CourtDocumentsSyncService(db as any, s3, tg as any);
    (service as any).isRunning = true;
  });

  describe('the lock', () => {
    it('lets the replica through when it claims the row', async () => {
      db.query = routeDb({}, true);
      expect(await (service as any).tryLock('host:1')).toBe(true);
    });

    it('turns the other replicas away', async () => {
      db.query = routeDb({}, false);
      expect(await (service as any).tryLock('host:2')).toBe(false);
    });

    // The whole point: losing the race must cost nothing, not a second sweep.
    it('skips the weekly walk entirely when the lock is held elsewhere', async () => {
      const prev = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      db.query = routeDb({}, false);
      (service as any).isRunning = false;
      const walk = jest.spyOn(service as any, 'runLoop');

      await service.runWeekly();

      expect(walk).not.toHaveBeenCalled();
      process.env.NODE_ENV = prev;
    });
  });

  describe('the walk', () => {
    const page = (ids: string[], totalElements: number) => ({
      rows: ids.map((id) => ({ id, case_number: `case-${id}` })),
      totalPages: 20,
      totalElements,
    });

    beforeEach(() => {
      jest.spyOn(service as any, 'upsertMetadata').mockResolvedValue(undefined);
      jest.spyOn(service as any, 'matchedOurs').mockResolvedValue([]);
    });

    // What the old nightly run did wrong: page 0 held yesterday's first
    // publication, so it stopped there. A walk ends only where the feed does.
    it('does not stop at a publication it has seen before', async () => {
      db.query = routeDb({ last_page: 0, completed_cycles: 1 });
      const fetchPage = jest
        .spyOn(service as any, 'fetchPage')
        .mockImplementationOnce(async () => page(['seen-last-week'], 300))
        .mockImplementationOnce(async () => page(['new-in-the-middle'], 300))
        .mockImplementationOnce(async () => page([], 300));

      await (service as any).runLoop({});

      expect(fetchPage).toHaveBeenCalledTimes(3);
      expect(tg.send.mock.calls.map(String).join('\n')).toMatch(
        /cycle complete/i,
      );
    });

    it('keeps its lock alive on every page', async () => {
      db.query = routeDb({ last_page: 0, completed_cycles: 1 });
      jest
        .spyOn(service as any, 'fetchPage')
        .mockImplementationOnce(async () => page(['a'], 200))
        .mockImplementationOnce(async () => page(['b'], 200))
        .mockImplementationOnce(async () => page([], 200));

      await (service as any).runLoop({});

      const renewals = db.query.mock.calls.filter((c) =>
        /run_lock_at = CASE WHEN run_owner IS NOT NULL/.test(String(c[0])),
      );
      expect(renewals).toHaveLength(2);
    });

    it('records the feed total and reports what share it read', async () => {
      db.query = routeDb({ last_page: 0, completed_cycles: 1 });
      jest
        .spyOn(service as any, 'fetchPage')
        .mockImplementationOnce(async () => page(['a', 'b', 'c', 'd'], 4))
        .mockImplementationOnce(async () => page([], 4));

      await (service as any).runLoop({});

      const done = db.query.mock.calls.find((c) =>
        /completed_cycles = completed_cycles \+ 1/.test(String(c[0])),
      );
      expect(done?.[1]).toContain(4);
      const report = tg.send.mock.calls.map((c) => String(c[0])).join('\n');
      expect(report).toContain('Feed: 4 · read: <b>4</b> (100.0%)');
      expect(report).not.toContain('⚠️');
    });

    // Short pages are normal for this source; a walk that read far less than
    // the feed holds lost pages and has to say so.
    it('flags a walk that read well short of the feed total', async () => {
      db.query = routeDb({ last_page: 0, completed_cycles: 1 });
      jest
        .spyOn(service as any, 'fetchPage')
        .mockImplementationOnce(async () => page(['a'], 1000))
        .mockImplementationOnce(async () => page([], 1000));

      await (service as any).runLoop({});

      expect(tg.send.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(
        /⚠️ Feed: 1,000 · read: <b>1<\/b> \(0\.1%\) — the walk came up short/,
      );
    });
  });
});

describe('the "already stored" tally', () => {
  let db: any;
  let tg: { send: jest.Mock };
  let service: CourtDocumentsSyncService;

  const CURSOR = { last_page: 0, completed_cycles: 1 };

  beforeEach(() => {
    jest.restoreAllMocks();
    db = { query: jest.fn().mockResolvedValue([CURSOR]) };
    tg = { send: jest.fn().mockResolvedValue(undefined) };
    service = new CourtDocumentsSyncService(
      db as any,
      {
        exists: jest.fn().mockResolvedValue(true),
        upload: jest.fn(),
        ensureBucket: jest.fn().mockResolvedValue(false),
      } as any,
      tg as any,
    );
    (service as any).isRunning = true;
  });

  /**
   * The counter is per page, and the running total must not be the thing
   * subtracted from it. Written the other way it took every page's unmatched
   * count off the next page's batch, so the figure fell further behind on each
   * page — production reported "Already stored: -22925" across 51 pages.
   */
  it('does not go negative as the pages add up', async () => {
    const pageOf = (n: number) =>
      Array.from({ length: 100 }, (_, i) => ({
        id: `p${n}-${i}`,
        case_number: `case-${n}-${i}`,
      }));

    // Three pages of a hundred, then the end of the feed.
    jest
      .spyOn(service as any, 'fetchPage')
      .mockImplementation(async (page: any) => ({
        rows: Number(page) < 3 ? pageOf(Number(page)) : [],
        totalPages: 3,
        totalElements: 300,
      }));
    jest.spyOn(service as any, 'upsertMetadata').mockResolvedValue(undefined);
    // Nothing left to fetch, and thirty of every hundred belong to nobody we
    // hold — the shape that made the old arithmetic drift.
    jest.spyOn(service as any, 'matchedOurs').mockResolvedValue([]);
    jest.spyOn(service as any, 'countUnmatched').mockResolvedValue(30);

    await (service as any).runLoop({});

    const report = tg.send.mock.calls.map((c) => String(c[0])).join('\n');
    const tally = report.match(/already stored: (-?\d+)/i);
    expect(tally).not.toBeNull();
    // Three pages of a hundred: 30 unmatched each, the other 70 already held.
    expect(Number(tally![1])).toBe(210);
    expect(report).toMatch(/not ours: 90/i);
  });
});
