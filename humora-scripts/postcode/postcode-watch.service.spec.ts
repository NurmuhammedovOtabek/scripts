import {
  diffKeyed,
  parseEmuZones,
  parseUzpostOffices,
} from './postcode-watch-parse';
import {
  EMU_ZONES_URL,
  PostcodeWatchService,
  UZPOST_OFFICES_URL,
  postcodeWatchEnabled,
} from './postcode-watch.service';

const office = (index: string, ring: number[][] | null = [[41.3, 69.2]]) => ({
  postal_office: {
    index,
    name_uz: `Bo'lim ${index}`,
    region: 'Toshkent',
    district: 'Yunusobod',
    mfy: 'Namuna',
    lat: '41.3',
    lng: '69.2',
  },
  locations: { locations: ring },
});

const offices = (n: number, from = 100000) =>
  Array.from({ length: n }, (_, i) => office(String(from + i)));

const zones = (n: number, from = 100000) => ({
  features: Array.from({ length: n }, (_, i) => ({
    i: String(from + i),
    g: { type: 'Polygon', coordinates: [[[69, 41]]] },
  })),
});

describe('postcode-watch parsing', () => {
  it('reads UzPost offices, their mahalla and a hash of the service area', () => {
    const [o, none] = parseUzpostOffices({
      result: [office('171003'), office('171004', null), office('17x')],
    });
    expect(o).toMatchObject({ postcode: '171003', mfy: 'Namuna', lat: 41.3 });
    expect(o.areaHash).toMatch(/^[0-9a-f]{40}$/);
    expect(none.areaHash).toBeNull();
    expect(() => parseUzpostOffices({ detail: 'down' })).toThrow(
      /without a list/,
    );
  });

  it('hashes all polygons of one EMU index together', () => {
    const z = parseEmuZones({
      features: [
        { i: '100000', g: { a: 1 } },
        { i: 100000, g: { a: 2 } },
        { i: '1000', g: { a: 3 } },
      ],
    });
    expect([...z.keys()]).toEqual(['100000']);
  });

  it('tells added, gone and changed apart', () => {
    expect(
      diffKeyed(
        new Map([
          ['a', '1'],
          ['b', '1'],
          ['c', '1'],
        ]),
        new Map([
          ['a', '1'],
          ['b', '2'],
          ['d', '1'],
        ]),
      ),
    ).toEqual({ added: ['d'], gone: ['c'], changed: ['b'], unchanged: 1 });
  });
});

describe('PostcodeWatchService', () => {
  let held: {
    offices: Array<{ postcode: string; area_hash: string | null }>;
    zones: Array<{ postcode: string; area_hash: string }>;
  };
  let pages: Record<string, string>;
  let tx: { query: jest.Mock };
  let db: {
    query: jest.Mock;
    transaction: jest.Mock;
    createQueryRunner: jest.Mock;
  };
  let telegram: { deliver: jest.Mock };
  let service: PostcodeWatchService;
  const realFetch = global.fetch;

  beforeEach(() => {
    held = { offices: [], zones: [] };
    pages = {
      [UZPOST_OFFICES_URL]: JSON.stringify({ result: offices(1200) }),
      [EMU_ZONES_URL]: JSON.stringify(zones(1200)),
    };
    global.fetch = jest.fn(async (url: any) => {
      const body = pages[String(url)];
      if (body === undefined) return { ok: false, status: 503 } as any;
      return { ok: true, status: 200, text: async () => body } as any;
    }) as any;
    tx = { query: jest.fn().mockResolvedValue([]) };
    db = {
      query: jest.fn(async (sql: string) => {
        if (/FROM public\.postcode_watch_office/.test(sql)) return held.offices;
        if (/FROM public\.postcode_watch_zone/.test(sql)) return held.zones;
        return [];
      }),
      transaction: jest.fn(async (fn: (m: unknown) => Promise<void>) => fn(tx)),
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn(),
        release: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(async (sql: string) =>
          /pg_try_advisory_lock/.test(sql) ? [{ locked: true }] : [],
        ),
      })),
    };
    telegram = { deliver: jest.fn().mockResolvedValue(true) };
    service = new PostcodeWatchService(db as any, telegram as any);
  });

  afterEach(() => {
    global.fetch = realFetch;
  });

  it('records a baseline on its first run, without listing everything as new', async () => {
    const r = await service.run({}, 'weekly');
    expect(r?.offices).toMatchObject({ baseline: true, read: 1200 });
    expect(r?.zones).toMatchObject({ baseline: true });
    expect(r?.needsNewExport).toBe(false);
    expect(telegram.deliver.mock.calls[0][0]).toMatch(/baseline recorded/);
  });

  it('asks for a new export when service areas change', async () => {
    held.offices = offices(1200).map((o) => ({
      postcode: o.postal_office.index,
      area_hash: 'old',
    }));
    held.zones = [];
    const r = await service.check({ dry: true });
    expect(r.offices).toMatchObject({ baseline: false });
    expect((r.offices as any).changed).toHaveLength(1200);
    expect(r.needsNewExport).toBe(true);
    expect(db.transaction).not.toHaveBeenCalled(); // dry
  });

  it('says to ask for a new export in the report', async () => {
    held.offices = offices(1200).map((o) => ({
      postcode: o.postal_office.index,
      area_hash: 'old',
    }));
    await service.run({}, 'weekly');
    expect(telegram.deliver.mock.calls[0][0]).toMatch(
      /Ask OPdata for a new export/,
    );
    expect(telegram.deliver.mock.calls[0][0]).not.toMatch(/district/i);
  });

  it('keeps going when one source fails, and says which', async () => {
    delete pages[EMU_ZONES_URL];
    const r = await service.run({}, 'weekly');
    expect(r?.zones).toEqual({ error: 'HTTP 503' });
    expect(r?.offices).toMatchObject({ read: 1200 });
    expect(telegram.deliver.mock.calls[0][0]).toMatch(/EMU zones: ❌ HTTP 503/);
  });

  it('writes nothing for a cut-off answer', async () => {
    pages[UZPOST_OFFICES_URL] = JSON.stringify({ result: offices(10) });
    const r = await service.check({});
    expect(r.offices).toEqual({ error: '10 offices, fewer than 1000' });
  });

  it('runs on deployments only, unless told', () => {
    expect(postcodeWatchEnabled({ TG_WEBHOOK_URL: 'x' } as any)).toBe(true);
    expect(postcodeWatchEnabled({} as any)).toBe(false);
    expect(postcodeWatchEnabled({ POSTCODE_WATCH_ENABLED: '1' } as any)).toBe(
      true,
    );
  });
});
