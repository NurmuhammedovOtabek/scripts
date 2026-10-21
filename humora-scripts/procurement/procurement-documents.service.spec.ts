import { ProcurementDocumentsService } from './procurement-documents.service';

/**
 * Mirroring runs behind a company page and behind the sync that fills it, so
 * the rule that matters most is that it never becomes the reason a deal fails
 * to appear. The rest is about not re-fetching what we already hold.
 */
describe('ProcurementDocumentsService', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 7,
    lot_display_no: '26120012503865',
    contract_file_path: '/files/2026/9/8/a.pdf',
    contract_file_ext: '.PDF',
    protocol_file_path: 'tender/user-files/2026/9/2/b.pdf',
    protocol_file_ext: '.pdf',
    ...over,
  });

  const build = (over: Record<string, any> = {}) => {
    const db = { query: jest.fn().mockResolvedValue([row()]), ...over.db };
    const s3 = {
      exists: jest.fn().mockResolvedValue(false),
      ensureBucket: jest.fn().mockResolvedValue(false),
      upload: jest.fn().mockResolvedValue('url'),
      ...over.s3,
    };
    const etender = {
      downloadFile: jest.fn().mockResolvedValue({
        body: Buffer.from('%PDF-'),
        contentType: 'application/pdf',
      }),
      ...over.etender,
    };
    return {
      db,
      s3,
      etender,
      svc: new ProcurementDocumentsService(
        db as never,
        s3 as never,
        etender as never,
      ),
    };
  };

  it('does nothing at all for an empty list', async () => {
    const { svc, db } = build();
    await expect(svc.mirrorDeals([])).resolves.toEqual({ stored: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('stores both documents and records where they went', async () => {
    const { svc, s3, db } = build();
    await expect(svc.mirrorDeals([7])).resolves.toEqual({ stored: 1 });

    const keys = s3.upload.mock.calls.map((c: unknown[]) => c[1]);
    expect(keys).toEqual([
      '26120012503865/contract.pdf',
      '26120012503865/protocol.pdf',
    ]);

    const update = db.query.mock.calls.find((c: string[]) =>
      c[0].includes('UPDATE'),
    );
    expect(update[1]).toEqual([
      7,
      '26120012503865/contract.pdf',
      '26120012503865/protocol.pdf',
    ]);
  });

  it('normalises the extension the API sends with a dot and in caps', async () => {
    const { svc, s3 } = build();
    await svc.mirrorDeals([7]);
    // `.PDF` upstream — the key must not become `contract..PDF`.
    expect(s3.upload.mock.calls[0][1]).toBe('26120012503865/contract.pdf');
  });

  it('does not fetch a document it already holds', async () => {
    const { svc, s3, etender } = build({
      s3: { exists: jest.fn().mockResolvedValue(true) },
    });
    await svc.mirrorDeals([7]);
    expect(etender.downloadFile).not.toHaveBeenCalled();
    expect(s3.upload).not.toHaveBeenCalled();
  });

  it('skips a row with no paperwork at all', async () => {
    const { svc, s3 } = build({
      db: {
        query: jest
          .fn()
          .mockResolvedValue([
            row({ contract_file_path: null, protocol_file_path: null }),
          ]),
      },
    });
    await svc.mirrorDeals([7]);
    expect(s3.upload).not.toHaveBeenCalled();
  });

  /**
   * The contract usually arrives after the protocol has been mirrored.
   * Requiring both stored keys to be empty skipped exactly that row, so the
   * contract was never fetched.
   */
  it('asks for a document not yet stored, not for a row with nothing stored', async () => {
    const { svc, db } = build();
    await svc.mirrorDeals([7]);
    const select = db.query.mock.calls[0][0] as string;
    expect(select).toContain(
      'contract_file_path IS NOT NULL AND contract_stored_key IS NULL',
    );
    expect(select).toContain(
      'protocol_file_path IS NOT NULL AND protocol_stored_key IS NULL',
    );
  });

  it('fetches only the contract when the protocol is already stored', async () => {
    const { svc, s3, etender, db } = build({
      db: {
        query: jest
          .fn()
          .mockResolvedValue([
            row({ protocol_stored_key: '26120012503865/protocol.pdf' }),
          ]),
      },
    });
    await expect(svc.mirrorDeals([7])).resolves.toEqual({ stored: 1 });
    expect(etender.downloadFile).toHaveBeenCalledTimes(1);
    expect(etender.downloadFile).toHaveBeenCalledWith('/files/2026/9/8/a.pdf');
    expect(s3.upload.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      '26120012503865/contract.pdf',
    ]);
    const update = db.query.mock.calls.find((c: string[]) =>
      c[0].includes('UPDATE'),
    );
    // Null for the protocol: the COALESCE keeps the key it already has.
    expect(update[1]).toEqual([7, '26120012503865/contract.pdf', null]);
  });

  describe('failure is a log line, not an exception', () => {
    it('survives a document that will not download', async () => {
      const { svc, db } = build({
        etender: { downloadFile: jest.fn().mockResolvedValue(null) },
      });
      await expect(svc.mirrorDeals([7])).resolves.toEqual({ stored: 0 });
      // Still stamped, so a later pass can tell "tried" from "never looked".
      const update = db.query.mock.calls.find((c: string[]) =>
        c[0].includes('UPDATE'),
      );
      expect(update[1]).toEqual([7, null, null]);
    });

    it('survives storage refusing the upload', async () => {
      const { svc } = build({
        s3: { upload: jest.fn().mockRejectedValue(new Error('no space')) },
      });
      await expect(svc.mirrorDeals([7])).resolves.toEqual({ stored: 0 });
    });

    it('survives the database going away', async () => {
      const { svc } = build({
        db: {
          query: jest.fn().mockRejectedValue(new Error('connection lost')),
        },
      });
      await expect(svc.mirrorDeals([7])).resolves.toEqual({ stored: 0 });
    });
  });

  describe('storedKey', () => {
    it('hands the route what it needs to stream', async () => {
      const { svc } = build({
        db: {
          query: jest
            .fn()
            .mockResolvedValue([
              { key: 'lot/contract.pdf', lot: '26120012503865', ext: '.pdf' },
            ]),
        },
      });
      await expect(svc.storedKey(7, 'contract')).resolves.toEqual({
        key: 'lot/contract.pdf',
        lot: '26120012503865',
        ext: '.pdf',
      });
    });

    it('returns null when nothing is stored, so the route answers 404', async () => {
      const { svc } = build({ db: { query: jest.fn().mockResolvedValue([]) } });
      await expect(svc.storedKey(7, 'protocol')).resolves.toBeNull();
    });

    it('asks for the column belonging to the kind', async () => {
      const { svc, db } = build({
        db: { query: jest.fn().mockResolvedValue([]) },
      });
      await svc.storedKey(7, 'protocol');
      expect(db.query.mock.calls[0][0]).toContain('protocol_stored_key');
      expect(db.query.mock.calls[0][0]).not.toContain('contract_stored_key');
    });
  });
});
