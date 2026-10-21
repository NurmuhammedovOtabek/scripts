import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import axios from 'axios';
import { MibRegistryService } from './mib-registry.service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

const mockDb = () => ({ query: jest.fn() });

/** The page carries its own data URL; the import reads it back out. */
const PAGE_HTML = `
  <html><body><script>
    function getList(){ $.get('ds?xenc=TOKEN123%3D', generateParametr(), cb) }
  </script></body></html>
`;

const row = (over: Record<string, any> = {}) => ({
  debtor: 'AMONOV DALER FAYZILLOYEVICH',
  debtor_birth_date: '17.09.1993',
  debtor_inn: '515960532',
  area: 'Navoiy shahar',
  region: 'Navoiy viloyati',
  doc_register_number: '210119005592',
  chief_inspector_phone: '998944887676',
  ...over,
});

describe('MibRegistryService', () => {
  let service: MibRegistryService;
  let db: ReturnType<typeof mockDb>;

  beforeEach(async () => {
    jest.clearAllMocks();
    db = mockDb();
    db.query.mockResolvedValue([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MibRegistryService,
        { provide: getDataSourceToken('flottDb'), useValue: db },
      ],
    }).compile();

    service = module.get(MibRegistryService);
  });

  /**
   * Answer by URL rather than by call order. A test whose fetch throws on the
   * page request would otherwise leave the queued list response behind, and
   * the next test would receive JSON where it expects HTML.
   */
  const arrangeSource = (body: any, html = PAGE_HTML) => {
    mockedAxios.get.mockReset();
    mockedAxios.get.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('ds?xenc=')
          ? ({ data: body, headers: {} } as any)
          : ({ data: html, headers: {} } as any),
      ),
    );
  };

  // ─── extractDsPath ────────────────────────────────────────────────────────

  describe('extractDsPath', () => {
    const fn = (html: string) => (service as any).extractDsPath(html);

    it('reads the ds?xenc= path out of the page script', () => {
      expect(fn(PAGE_HTML)).toBe('ds?xenc=TOKEN123%3D');
    });

    it('returns null when the page no longer carries one', () => {
      expect(fn('<html><body>nothing here</body></html>')).toBeNull();
    });
  });

  // ─── mapRow ───────────────────────────────────────────────────────────────

  describe('mapRow', () => {
    const fn = (r: any, registry = 'alimony') =>
      (service as any).mapRow(registry, r);

    it('maps the source field names onto our columns', () => {
      const out = fn(row());
      expect(out).toMatchObject({
        registry: 'alimony',
        inn: '515960532',
        full_name: 'AMONOV DALER FAYZILLOYEVICH',
        birth_date: '17.09.1993',
        case_number: '210119005592',
        region: 'Navoiy viloyati',
      });
    });

    it('keeps a row whose INN the registry left blank', () => {
      // Roughly one alimony row in six has no INN. It is still a real
      // enforcement record — dropping it would make our copy disagree with
      // the source.
      const out = fn(row({ debtor_inn: '' }));
      expect(out).not.toBeNull();
      expect(out.inn).toBeNull();
    });

    it('rejects an INN that is not nine digits rather than storing it', () => {
      expect(fn(row({ debtor_inn: '12345' })).inn).toBeNull();
    });

    it('drops a row with no name — it identifies nobody', () => {
      expect(fn(row({ debtor: '   ' }))).toBeNull();
    });

    it('collapses the non-breaking spaces the registry embeds in names', () => {
      const out = fn(row({ debtor: 'NIZAMOV ABDUSAMAD\n MASHRABJON' }));
      expect(out.full_name).toBe('NIZAMOV ABDUSAMAD MASHRABJON');
    });

    it('carries the wanted list decree date', () => {
      const out = fn(row({ search_decree_date: '24.08.2026' }), 'wanted');
      expect(out.decree_date).toBe('24.08.2026');
    });
  });

  // ─── rowKey ───────────────────────────────────────────────────────────────

  describe('rowKey', () => {
    const key = (r: any) => (service as any).mapRow('alimony', r).row_key;

    it('is stable for the same row across runs', () => {
      expect(key(row())).toBe(key(row()));
    });

    it('differs for a different enforcement case', () => {
      expect(key(row())).not.toBe(key(row({ doc_register_number: '999' })));
    });

    it('does not change when the registry starts publishing the STIR', () => {
      // Same enforcement record, one sync later. If the STIR were part of the
      // key this would arrive as a new row and be stored twice.
      expect(key(row({ debtor_inn: '' }))).toBe(key(row()));
    });

    it('separates two rows that both lack a case number', () => {
      // A unique index on case_number alone would treat these as one row, or
      // — nulls being distinct — re-insert both on every sync.
      const a = key(row({ doc_register_number: null, debtor: 'A A A' }));
      const b = key(row({ doc_register_number: null, debtor: 'B B B' }));
      expect(a).not.toBe(b);
    });
  });

  // ─── fetch ────────────────────────────────────────────────────────────────

  describe('fetch', () => {
    it('asks the data URL with page_count — the endpoint requires it', async () => {
      arrangeSource({ total: 1, rows: [row()] });
      await service.fetch('alimony');

      const listUrl = mockedAxios.get.mock.calls[1][0] as string;
      expect(listUrl).toContain('ds?xenc=TOKEN123%3D');
      expect(listUrl).toMatch(/page_count=\d+/);
    });

    it('throws when the source answers its error-shaped empty result', async () => {
      // total:-1 with an empty rows array is a failure, not "nobody is on
      // this list". Treating it as data would silently clear the registry.
      arrangeSource({ msg: 'Тизим хатолиги', total: -1, rows: [] });
      await expect(service.fetch('alimony')).rejects.toThrow(/xatolik/i);
    });

    it('throws when the page stops carrying a data URL', async () => {
      arrangeSource({ total: 1, rows: [row()] }, '<html>redesigned</html>');
      await expect(service.fetch('alimony')).rejects.toThrow(/xenc/);
    });

    it('flags truncation when a full page comes back', async () => {
      const many = Array.from({ length: 3000 }, (_, i) =>
        row({ doc_register_number: `case-${i}` }),
      );
      arrangeSource({ total: 3000, rows: many });

      const out = await service.fetch('alimony');
      expect(out.truncated).toBe(true);
      expect(out.rows).toHaveLength(3000);
    });

    it('does not flag truncation on a short page', async () => {
      arrangeSource({ total: 2, rows: [row(), row({ debtor: 'B B B' })] });
      expect((await service.fetch('alimony')).truncated).toBe(false);
    });
  });

  // ─── sync ─────────────────────────────────────────────────────────────────

  describe('sync', () => {
    const markRemovedCalls = () =>
      db.query.mock.calls.filter(([sql]: [string]) =>
        String(sql).includes('SET removed_at = now()'),
      );

    it('marks rows the source no longer lists as removed', async () => {
      arrangeSource({ total: 1, rows: [row()] });
      db.query.mockResolvedValue([{ inserted: true }]);

      await service.sync('alimony');
      expect(markRemovedCalls()).toHaveLength(1);
    });

    it('never marks anything removed after a truncated fetch', async () => {
      // The run saw a prefix of the list, not the list. A row it did not see
      // is past the cap, not cleared — and on a credit subject, recording an
      // enforcement case as closed when it is not is the worse error.
      const many = Array.from({ length: 3000 }, (_, i) =>
        row({ doc_register_number: `case-${i}` }),
      );
      arrangeSource({ total: 3000, rows: many });
      db.query.mockResolvedValue([{ inserted: true }]);

      const out = await service.sync('alimony');
      expect(out.truncated).toBe(true);
      expect(out.removed).toBe(0);
      expect(markRemovedCalls()).toHaveLength(0);
    });

    it('never marks anything removed when the source returned nothing', async () => {
      // Every debtor being cleared at once is not a thing that happens; a
      // source failure is.
      arrangeSource({ total: 0, rows: [] });

      const out = await service.sync('alimony');
      expect(out.removed).toBe(0);
      expect(markRemovedCalls()).toHaveLength(0);
    });

    it('counts inserts and updates apart', async () => {
      arrangeSource({
        total: 2,
        rows: [row(), row({ doc_register_number: 'other' })],
      });
      db.query
        .mockResolvedValueOnce([{ inserted: true }])
        .mockResolvedValueOnce([{ inserted: false }])
        .mockResolvedValue([]);

      const out = await service.sync('alimony');
      expect(out).toMatchObject({ fetched: 2, inserted: 1, updated: 1 });
    });
  });

  // ─── findByInn ────────────────────────────────────────────────────────────

  describe('findByInn', () => {
    it('does not query the DB for a malformed STIR', async () => {
      expect(await service.findByInn('abc')).toEqual([]);
      expect(db.query).not.toHaveBeenCalled();
    });

    it('reads only rows that are still on a list', async () => {
      db.query.mockResolvedValue([{ registry: 'alimony' }]);
      await service.findByInn('515960532');

      const sql = String(db.query.mock.calls[0][0]);
      expect(sql).toContain('removed_at IS NULL');
    });

    it('survives a DB failure rather than breaking the profile', async () => {
      db.query.mockRejectedValue(new Error('connection lost'));
      expect(await service.findByInn('515960532')).toEqual([]);
    });
  });
});
