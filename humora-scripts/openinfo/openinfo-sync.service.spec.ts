import { OpeninfoHttpError } from './openinfo-client';
import { OpeninfoSyncService } from './openinfo-sync.service';

/** A statement the portal gives for a year. */
const statement = (year: number) => [
  {
    id: year,
    reporting_year: year,
    accounting_report: [{ tnum: '010', title: 'Line', value1: 1, value2: 2 }],
  },
];

function serviceWith(indicators: () => Promise<unknown>) {
  const db = {
    query: jest.fn(async (sql: string) =>
      sql.includes('SELECT inn FROM') ? [{ inn: '300000001' }] : [],
    ),
    transaction: jest.fn(),
  };
  const client = {
    get: jest.fn(async (path: string) =>
      path.startsWith('reports/financial_indicators')
        ? indicators()
        : statement(2024),
    ),
  };
  const service = new OpeninfoSyncService(
    db as never,
    { deliver: jest.fn() } as never,
    client as never,
  );
  return { service, client };
}

describe('OpeninfoSyncService.syncStatements', () => {
  it('reads the statements when the portal cannot give the indicators', async () => {
    const { service } = serviceWith(async () => {
      throw new OpeninfoHttpError(
        'openinfo reports/financial_indicators/: HTTP 400',
        400,
        "Error calculating financial indicators: local variable 'long_term_bank_loans' referenced before assignment",
      );
    });
    const out = await service.syncStatements([81]);
    expect(out).toMatchObject({
      reports: 2,
      indicators: 0,
      refused: 1,
      failed: 0,
      refusedReasons: {
        "Error calculating financial indicators: local variable 'long_term_bank_loans' referenced before assignment": 1,
      },
    });
  });

  it('counts a request it could not make as a failure', async () => {
    const { service } = serviceWith(async () => {
      throw new OpeninfoHttpError('openinfo …: socket hang up', null);
    });
    const out = await service.syncStatements([81]);
    expect(out).toMatchObject({ reports: 2, refused: 0, failed: 1 });
  });

  it('keeps no indicator row for a quarter', async () => {
    const { service } = serviceWith(async () => ({
      results: [
        { reporting_year: 2025, quarter: '7', return_on_assets: 1 },
        { reporting_year: 2024, return_on_assets: 2 },
      ],
    }));
    const out = await service.syncStatements([841]);
    expect(out).toMatchObject({ indicators: 1, quarterlySkipped: 1 });
  });

  it('the report says what the portal could not give, without a warning', () => {
    const { service } = serviceWith(async () => ({ results: [] }));
    const text = service.describe(
      {
        mode: 'weekly',
        inn: null,
        organizations: null,
        facts: null,
        details: null,
        statements: {
          organizations: 812,
          indicators: 7000,
          reports: 14000,
          changed: 0,
          failed: 0,
          refused: 2,
          refusedReasons: {
            'Micro-finance organizations only have quarterly reports.': 2,
          },
          quarterlySkipped: 3,
          examples: [],
        },
        elapsedMs: 60_000,
      },
      'weekly',
    );
    expect(text.startsWith('✅')).toBe(true);
    expect(text).toContain(
      'gave no answer for 2 part(s), saying: "Micro-finance organizations only have quarterly reports." ×2',
    );
    expect(text).toContain(
      'Quarterly indicator rows not kept (micro-finance): 3',
    );
  });
});

/**
 * The organisation list (review 2026-10-21): a blank from the portal never
 * erases what we hold, and only a whole list marks anyone as gone.
 */
describe('OpeninfoSyncService.syncOrganizations', () => {
  const org = (id: number, over: Record<string, unknown> = {}) => ({
    id,
    inn: String(300000000 + id),
    full_name_text: `ORG ${id} AJ`,
    short_name_text: `ORG ${id}`,
    exchange_ticket_name: 'ORG',
    is_listing: true,
    listing_date: '2020-01-01',
    ...over,
  });

  function setup(opts: {
    rows: unknown[];
    count: number;
    held?: Record<string, unknown>;
  }) {
    const queries: Array<{ sql: string; params?: unknown[] }> = [];
    const run = jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('FROM public.openinfo_organizations WHERE org_id')) {
        // Only organisation 1 is held; the rest are new.
        return opts.held && params?.[0] === 1 ? [opts.held] : [];
      }
      if (sql.includes('SET delisted_at = now()')) return [[], 3];
      return [];
    });
    const db = {
      query: run,
      transaction: jest.fn(async (fn: (tx: unknown) => unknown) =>
        fn({ query: run }),
      ),
    };
    const client = {
      all: jest.fn(async () => ({
        count: opts.count,
        rows: opts.rows,
        pages: 1,
      })),
    };
    const service = new OpeninfoSyncService(
      db as never,
      { deliver: jest.fn() } as never,
      client as never,
    );
    jest
      .spyOn((service as any).logger, 'warn')
      .mockImplementation(() => undefined);
    return { service, queries };
  }

  const many = (n: number, first: Record<string, unknown> = {}) =>
    Array.from({ length: n }, (_, i) => org(i + 1, i === 0 ? first : {}));

  it('keeps a held STIR and name when the portal sends them blank', async () => {
    const { service, queries } = setup({
      rows: many(600, { inn: null, full_name_text: '' }),
      count: 600,
      held: {
        inn: '300000001',
        full_name: 'ORG 1 AJ',
        short_name: 'ORG 1',
        ticker: 'ORG',
        is_listing: true,
        listing_date: '2020-01-01',
        content_hash: 'old',
      },
    });
    await service.syncOrganizations();

    const update = queries.find(
      (q) =>
        q.sql.includes('UPDATE public.openinfo_organizations') &&
        q.sql.includes('COALESCE($2, inn)'),
    );
    expect(update).toBeDefined();
    expect(update!.params![0]).toBe(1);
    expect(update!.params![1]).toBeNull();
    expect(update!.sql).toContain('full_name = COALESCE($3, full_name)');
    // A blank is no change, so it is not logged as one.
    const logged = queries
      .filter((q) => q.sql.includes('company_change_log'))
      .map((q) => JSON.stringify(q.params));
    expect(
      logged.some((p) => p.includes('"inn"') || p.includes('full_name')),
    ).toBe(false);
  });

  it('marks nobody as gone when the list stopped short of its count', async () => {
    const { service, queries } = setup({ rows: many(600), count: 812 });
    const res = await service.syncOrganizations();
    expect(queries.some((q) => q.sql.includes('SET delisted_at = now()'))).toBe(
      false,
    );
    expect(res.delisted).toBe(0);
  });

  it('marks the ones a whole list no longer carries', async () => {
    const { service, queries } = setup({ rows: many(600), count: 600 });
    const res = await service.syncOrganizations();
    expect(queries.some((q) => q.sql.includes('SET delisted_at = now()'))).toBe(
      true,
    );
    expect(res.delisted).toBe(3);
  });
});

/**
 * The fact list is written page by page (review 2026-10-21): a page that
 * fails no longer loses the pages read before it, and until the whole list
 * has once been read, the daily run reads it whole rather than "since the
 * newest fact held".
 */
describe('OpeninfoSyncService.syncFacts — page by page', () => {
  const fact = (id: number) => ({
    id,
    organization: 7,
    fact_number: 25,
    fact_title: 'Fact ' + id,
    pub_date: '2026-10-16 10:21:47',
  });

  function setup(pages: Array<unknown[] | Error>, count: number) {
    const written: number[] = [];
    const db = {
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO public.openinfo_facts')) {
          written.push(params![0] as number);
          return [{ inserted: true }];
        }
        return [];
      }),
      transaction: jest.fn(),
    };
    const client = {
      eachPage: jest.fn(
        async (
          _path: string,
          _params: unknown,
          onPage: (rows: unknown[]) => Promise<unknown>,
        ) => {
          let read = 0;
          for (const p of pages) {
            if (p instanceof Error) throw p;
            read += p.length;
            if ((await onPage(p)) === false)
              return { count, pages: 1, read, ended: false };
          }
          return { count, pages: pages.length, read, ended: read >= count };
        },
      ),
    };
    const service = new OpeninfoSyncService(
      db as never,
      { deliver: jest.fn() } as never,
      client as never,
    );
    return { service, written, db };
  }

  it('keeps the pages read before one that fails', async () => {
    const { service, written } = setup(
      [[fact(1), fact(2)], new Error('openinfo: 502')],
      4,
    );
    await expect(service.syncFacts({ since: null })).rejects.toThrow('502');
    expect(written).toEqual([1, 2]);
  });

  it('calls the list whole only when it was read to its end', async () => {
    const full = setup([[fact(1)], [fact(2)]], 2);
    expect((await full.service.syncFacts({ since: null })).whole).toBe(true);
    const short = setup([[fact(1)]], 5);
    expect((await short.service.syncFacts({ since: null })).whole).toBe(false);
    const since = setup([[fact(1)]], 1);
    expect((await since.service.syncFacts({ since: '2026-10-14' })).whole).toBe(
      false,
    );
  });

  it('reads the whole list until a run has once read it to its end', async () => {
    const run = (wholeRun: boolean) => {
      const db = {
        query: jest.fn(async (sql: string) => {
          if (sql.includes('FROM public.job_runs'))
            return wholeRun ? [{ '?column?': 1 }] : [];
          if (sql.includes('max(pub_date)'))
            return [{ newest: '2026-10-20T12:00:00+05:00' }];
          return [];
        }),
      };
      const service = new OpeninfoSyncService(
        db as never,
        { deliver: jest.fn() } as never,
        {} as never,
      );
      return (service as any).factsSince() as Promise<string | null>;
    };
    expect(await run(false)).toBeNull();
    expect(await run(true)).toBe('2026-10-18');
  });
});
