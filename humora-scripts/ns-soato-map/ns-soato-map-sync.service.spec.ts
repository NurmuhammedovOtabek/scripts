import axios from 'axios';
import {
  NsSoatoMapSyncService,
  nsSoatoSyncEnabled,
} from './ns-soato-map-sync.service';

jest.mock('axios');
const post = axios.post as jest.Mock;

const TAX_OFFICES_ID = '61a5d33db83d3e9e6a91c95c';
const MHOBT_ID = '61a5d234b83d3e9e6a91c958';

// Cells as cs.egov.uz sends them: numbers, and text in four languages.
const num = (n: number) => ({ text: null, number: n, data: null, default: n });
const txt = (s: string) => ({
  text: { uzbText: s, uzbKrText: s, rusText: s, engText: s },
  number: 0,
  data: null,
  default: s,
});
const office = (ns10: number, ns11: number, name: string) => ({
  tableColumn: { RegionCode: num(ns10), PNREgion: num(ns11), Name: txt(name) },
});
const place = (code: string, name: string) => ({
  tableColumn: {
    MHOBT: txt(code),
    MHOBT7: txt(code.slice(0, 7)),
    NAME: txt(name),
  },
});

// Enough rows to pass the "cut-off answer" floor; they match nothing.
const fillerOffices = Array.from({ length: 150 }, (_, i) =>
  office(99, i + 1, `Тўлдирувчи${i} туман давлат солиқ инспекцияси`),
);
const fillerPlaces = Array.from({ length: 200 }, (_, i) =>
  place(`17${90 + Math.floor(i / 90)}2${(i % 90) + 10}`, `Қўшимча${i} тумани`),
);

const OFFICES = [
  office(3, 1, 'Андижон шаҳар давлат солиқ инспeкцияси'),
  office(3, 9, 'Бўз туман давлат солиқ инспeкцияси'),
  office(18, 1, 'Самарқанд шаҳар давлат солиқ инспeкцияси'),
  office(30, 5, 'Фарғона шаҳар давлат солиқ инспeкцияси'),
  office(30, 19, 'Фарғона туман давлат солиқ инспeкцияси'),
  office(50, 1, 'Йирик солиқ тўловчилар бўйича ҳудудлараро солиқ инспeкцияси'),
  ...fillerOffices,
];
const PLACES = [
  place('1703203', 'Андижон тумани'),
  place('1703209', 'Бўстон тумани'),
  place('1703401', 'Андижон'),
  place('1718233', 'Самарқанд тумани'),
  place('1718401', 'Самарқанд'),
  place('1722210', 'Денов тумани'),
  place('1722210501', 'Денов'),
  place('1730233', 'Фарғона тумани'),
  place('1730401', 'Фарғона'),
  ...fillerPlaces,
];

const HELD = [
  // The seed's mistake: the city office in the rural district.
  {
    ns10_code: 30,
    ns11_code: 5,
    ns10_name: 'ФАРҒОНА ВИЛОЯТИ',
    ns11_name: 'ФАРҒОНА ШАҲАР',
    soato: '1730233',
  },
  {
    ns10_code: 30,
    ns11_code: 19,
    ns10_name: 'ФАРҒОНА ВИЛОЯТИ',
    ns11_name: 'ФАРҒОНА ТУМАНИ',
    soato: '1730233',
  },
  // Not in the tax list: decided by its own name, and 1722407 is no code.
  {
    ns10_code: 22,
    ns11_code: 2,
    ns10_name: 'СУРХОНДАРЁ',
    ns11_name: 'ДЕНОВ ШАҲАР',
    soato: '1722407',
  },
  // Renamed (Бўз → Бўстон): the classifiers cannot say, so it stays.
  {
    ns10_code: 3,
    ns11_code: 9,
    ns10_name: 'АНДИЖОН ВИЛОЯТИ',
    ns11_name: 'БЎЗ ТУМАНИ',
    soato: '1703209',
  },
  // A code neither classifier has, under a name that matches nothing.
  {
    ns10_code: 9,
    ns11_code: 9,
    ns10_name: null,
    ns11_name: 'НОМАЪЛУМ ТУМАН',
    soato: '1799999',
  },
  // An inspection for the whole country is no district.
  {
    ns10_code: 50,
    ns11_code: 1,
    ns10_name: null,
    ns11_name: 'ЙИРИК',
    soato: '1726266',
  },
  // The companies contradict the classifiers here: held back.
  {
    ns10_code: 18,
    ns11_code: 1,
    ns10_name: 'САМАРҚАНД',
    ns11_name: 'САМАРҚАНД ШАҲАР',
    soato: '1718233',
  },
];
const EVIDENCE = [
  { ns10: 30, ns11: 5, d: '1730401', n: 241 },
  { ns10: 18, ns11: 1, d: '1718233', n: 30 },
];
// спр.125 in full (235 districts in life): enough to say a code is unknown.
const TERRITORY = [
  { code: '1703209' },
  { code: '1730233' },
  ...Array.from({ length: 200 }, (_, i) => ({
    code: `179${String(i).padStart(4, '0')}`,
  })),
];

describe('NsSoatoMapSyncService', () => {
  let db: {
    query: jest.Mock;
    createQueryRunner: jest.Mock;
    transaction: jest.Mock;
  };
  let tx: { query: jest.Mock };
  let telegram: { send: jest.Mock; deliver: jest.Mock };
  let service: NsSoatoMapSyncService;

  beforeEach(() => {
    post.mockReset();
    post.mockImplementation((_url: string, body: { id: string }) =>
      Promise.resolve({
        status: 200,
        data: {
          error: null,
          result: {
            isSuccess: false,
            count: body.id === TAX_OFFICES_ID ? OFFICES.length : PLACES.length,
            data:
              body.id === TAX_OFFICES_ID
                ? OFFICES
                : body.id === MHOBT_ID
                  ? PLACES
                  : [],
          },
        },
      }),
    );
    tx = {
      query: jest.fn(async (sql: string) => {
        if (/FROM public\.company_info/.test(sql)) return EVIDENCE;
        if (
          /SELECT count\(\*\)::int AS n FROM public\.company_branches/.test(sql)
        )
          return [{ n: 4 }];
        if (/UPDATE public\.company_branches/.test(sql)) return [[], 3];
        if (/UPDATE public\.ns_soato_map/.test(sql)) return [[], 1];
        return [];
      }),
    };
    db = {
      query: jest.fn(async (sql: string) => {
        if (/FROM public\.ns_soato_map/.test(sql)) return HELD;
        if (/FROM public\.territory/.test(sql)) return TERRITORY;
        return [];
      }),
      createQueryRunner: jest.fn(() => ({
        connect: jest.fn(),
        release: jest.fn().mockResolvedValue(undefined),
        query: jest.fn(async (sql: string) =>
          /pg_try_advisory_lock/.test(sql) ? [{ locked: true }] : [],
        ),
      })),
      transaction: jest.fn(async (fn: (m: unknown) => unknown) => fn(tx)),
    };
    telegram = {
      send: jest.fn().mockResolvedValue(true),
      deliver: jest.fn().mockResolvedValue(true),
    };
    service = new NsSoatoMapSyncService(db as any, telegram as any);
  });

  const writes = (re: RegExp) =>
    tx.query.mock.calls.filter(([sql]) => re.test(String(sql)));

  it('takes each pair from the classifiers, and leaves what they cannot tell', async () => {
    const r = (await service.run({}, 'manual'))!;
    const changes = Object.fromEntries(
      r.changed.map((c) => [`${c.ns10}/${c.ns11}`, [c.from, c.to, c.how]]),
    );
    expect(changes).toEqual({
      '30/5': ['1730233', '1730401', 'name'],
      '22/2': ['1722407', '1722210', 'district_rank_city'],
      '9/9': ['1799999', null, 'invalid_code'],
      '50/1': ['1726266', null, 'not_territorial'],
    });
    expect(r.confirmed).toBe(1); // 30/19
    expect(r.unconfirmed.map((u) => `${u.ns10}/${u.ns11}`)).toEqual(['3/9']);
    expect(r.inserted.map((c) => [`${c.ns10}/${c.ns11}`, c.to])).toEqual([
      ['3/1', '1703401'],
    ]);
    // 241 companies on 30/5 agree with the change; 30 on 18/1 refuse it.
    expect(r.held_back.map((h) => `${h.ns10}/${h.ns11}`)).toEqual(['18/1']);
    expect(r.held_back[0].detail).toMatch(
      /classifiers say 1718401, 0% of 30 companies are there; most \(100%\) say 1718233/,
    );

    // Written only where the held value is still the one read, and the
    // branches stored from it follow.
    const mapUpdates = writes(/UPDATE public\.ns_soato_map/);
    expect(mapUpdates.map(([, p]) => p)).toContainEqual([
      30,
      5,
      '1730401',
      '1730233',
    ]);
    expect(mapUpdates.some(([, p]) => p[0] === 18)).toBe(false);
    expect(writes(/UPDATE public\.company_branches/)).toHaveLength(4);
    expect(r.branches_corrected).toBe(12);
    // A new pair takes the region name its neighbours already carry, and a
    // name in the seed's style — not the tax list's, with its Latin "e".
    expect(writes(/INSERT INTO public\.ns_soato_map/)[0][1]).toEqual([
      3,
      1,
      'АНДИЖОН ВИЛОЯТИ',
      'АНДИЖОН ШАҲАР',
      '1703401',
    ]);

    const text = telegram.deliver.mock.calls[0][0] as string;
    expect(text).toMatch(
      /30\/5 Фарғона шаҳар.*1730233 → 1730401 \(same name: Фарғона\), 3 branches/,
    );
    expect(text).toMatch(/Held back — the companies say otherwise/);
    expect(text).toMatch(/Unconfirmed, kept as they are/);
    expect(text).toMatch(/POST \/api\/company-mahalla\/run/);
  });

  it('writes nothing on a dry run, and still counts the branches', async () => {
    const r = (await service.run({ dry: true }, 'manual, dry run'))!;
    expect(r.dry).toBe(true);
    expect(writes(/UPDATE|INSERT/)).toHaveLength(0);
    expect(r.branches_corrected).toBe(4 * r.changed.length);
    expect(telegram.deliver.mock.calls[0][0]).toMatch(
      /dry run, nothing written/,
    );
  });

  it('changes nothing when the source answers short', async () => {
    post.mockResolvedValue({
      status: 200,
      data: { result: { count: 3, data: OFFICES.slice(0, 3) } },
    });
    await expect(service.run({}, 'weekly')).rejects.toThrow(/too few to trust/);
    expect(writes(/UPDATE|INSERT/)).toHaveLength(0);
    expect(telegram.deliver.mock.calls[0][0]).toMatch(/sync failed/);
  });

  describe('when the company check cannot run', () => {
    beforeEach(() => {
      tx.query.mockImplementation(async (sql: string) => {
        if (/FROM public\.company_info/.test(sql)) {
          throw new Error('canceling statement due to statement timeout');
        }
        if (/SELECT count/.test(sql)) return [{ n: 0 }];
        return [[], 1];
      });
    });

    it('writes nothing: the classifiers alone do not decide a real run', async () => {
      await expect(service.run({}, 'manual')).rejects.toThrow(
        /company check could not run .*canceling statement.*nothing written/,
      );
      expect(writes(/UPDATE|INSERT/)).toHaveLength(0);
      expect(telegram.deliver.mock.calls[0][0]).toMatch(/sync failed/);
    });

    it('still shows a dry run, and says the check was skipped', async () => {
      const r = (await service.run({ dry: true }, 'manual, dry run'))!;
      expect(r.company_check).toMatch(/skipped — canceling statement/);
      expect(r.changed.map((c) => `${c.ns10}/${c.ns11}`)).toContain('18/1');
    });
  });

  it('checks a new pair, or a filled blank, against its companies too', async () => {
    tx.query.mockImplementation(async (sql: string) => {
      // 3/1 is new to the table; its 25 companies are all in 1703203.
      if (/FROM public\.company_info/.test(sql)) {
        return [...EVIDENCE, { ns10: 3, ns11: 1, d: '1703203', n: 25 }];
      }
      if (/SELECT count/.test(sql)) return [{ n: 0 }];
      return [[], 1];
    });
    const r = (await service.run({}, 'manual'))!;
    expect(r.inserted).toHaveLength(0);
    expect(writes(/INSERT INTO public\.ns_soato_map/)).toHaveLength(0);
    expect(r.held_back.find((h) => h.ns10 === 3)?.detail).toMatch(
      /classifiers say 1703401, 0% of 25 companies are there; most \(100%\) say 1703203/,
    );
  });

  it('clears no code as unknown when the classifier copy is partial', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (/FROM public\.ns_soato_map/.test(sql)) return HELD;
      if (/FROM public\.territory/.test(sql)) return [{ code: '1703209' }];
      return [];
    });
    const r = (await service.run({ dry: true }, 'manual, dry run'))!;
    expect(r.changed.map((c) => `${c.ns10}/${c.ns11}`)).not.toContain('9/9');
    expect(r.unconfirmed.map((u) => `${u.ns10}/${u.ns11}`)).toContain('9/9');
  });

  it('decides nothing for a pair the source lists twice under two names', async () => {
    const twice = [
      ...OFFICES,
      office(30, 5, 'Фарғона туман давлат солиқ инспeкцияси'),
    ];
    post.mockImplementation((_url: string, body: { id: string }) =>
      Promise.resolve({
        status: 200,
        data: {
          result: {
            count: body.id === TAX_OFFICES_ID ? twice.length : PLACES.length,
            data: body.id === TAX_OFFICES_ID ? twice : PLACES,
          },
        },
      }),
    );
    const r = (await service.run({ dry: true }, 'manual, dry run'))!;
    expect(r.changed.map((c) => `${c.ns10}/${c.ns11}`)).not.toContain('30/5');
    expect(
      r.unconfirmed.find((u) => u.ns10 === 30 && u.ns11 === 5),
    ).toMatchObject({
      how: 'ambiguous',
      detail: expect.stringMatching(/listed twice/),
    });
  });

  it('leaves a row someone changed meanwhile, and its branches', async () => {
    // Stored with a trailing space: the conditions use the stored value.
    db.query.mockImplementation(async (sql: string) => {
      if (/FROM public\.ns_soato_map/.test(sql)) {
        return HELD.map((h) =>
          h.ns10_code === 30 && h.ns11_code === 5
            ? { ...h, soato: '1730233 ' }
            : h,
        );
      }
      return [];
    });
    tx.query.mockImplementation(async (sql: string, p?: unknown[]) => {
      if (/FROM public\.company_info/.test(sql)) return EVIDENCE;
      // 22/2 was edited by hand after it was read.
      if (/UPDATE public\.ns_soato_map/.test(sql)) {
        return [[], p?.[0] === 22 ? 0 : 1];
      }
      if (/UPDATE public\.company_branches/.test(sql)) return [[], 2];
      return [];
    });
    const r = (await service.run({}, 'manual'))!;
    expect(
      writes(/UPDATE public\.ns_soato_map/).map(([, q]) => q),
    ).toContainEqual([30, 5, '1730401', '1730233 ']);
    expect(r.changed.map((c) => `${c.ns10}/${c.ns11}`)).not.toContain('22/2');
    expect(r.held_back.find((h) => h.ns10 === 22)?.detail).toMatch(
      /changed while syncing/,
    );
    const branchPairs = writes(/UPDATE public\.company_branches/).map(
      ([, q]) => q?.[0],
    );
    expect(branchPairs).toContain(30);
    expect(branchPairs).not.toContain(22);
  });

  it('stops by hand before the slow check, and writes nothing', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (/FROM public\.ns_soato_map/.test(sql)) return HELD;
      if (/FROM public\.territory/.test(sql)) return TERRITORY;
      if (/FROM public\.job_controls/.test(sql)) return [{ '?column?': 1 }];
      return [];
    });
    await expect(service.run({}, 'weekly')).rejects.toThrow(
      /stopped by hand before the company check; nothing written/,
    );
    expect(writes(/FROM public\.company_info/)).toHaveLength(0);
    expect(writes(/UPDATE|INSERT/)).toHaveLength(0);
  });

  it('knows whether a real sync has ever been run', async () => {
    db.query.mockResolvedValueOnce([]);
    await expect(service.started()).resolves.toBe(false);
    db.query.mockResolvedValueOnce([{ '?column?': 1 }]);
    await expect(service.started()).resolves.toBe(true);
    expect(db.query.mock.calls[1][0]).toMatch(/ok AND NOT dry/);
  });

  it('runs on deployments unless told otherwise', () => {
    expect(nsSoatoSyncEnabled({ TG_WEBHOOK_URL: 'https://x' })).toBe(true);
    expect(nsSoatoSyncEnabled({})).toBe(false);
    expect(nsSoatoSyncEnabled({ NS_SOATO_SYNC_ENABLED: '1' })).toBe(true);
    expect(
      nsSoatoSyncEnabled({
        TG_WEBHOOK_URL: 'https://x',
        NS_SOATO_SYNC_ENABLED: '0',
      }),
    ).toBe(false);
  });
});
