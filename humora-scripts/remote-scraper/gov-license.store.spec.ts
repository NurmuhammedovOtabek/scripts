import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { GovLicenseStore } from './gov-license.store';

/**
 * The tests below follow the writes. The read of stored standing and the
 * change-log rows (company_change_log) go to `side`, so they do not shift the
 * write calls the tests count.
 */
const build = async (
  query: jest.Mock,
  side: jest.Mock = jest.fn().mockResolvedValue([]),
) => {
  const route = (sql: string, params?: unknown[]) =>
    /^\s*SELECT uuid,/.test(sql) || sql.includes('company_change_log')
      ? side(sql, params)
      : query(sql, params);
  const moduleRef = await Test.createTestingModule({
    providers: [
      GovLicenseStore,
      { provide: getDataSourceToken('flottDb'), useValue: { query: route } },
    ],
  }).compile();
  return moduleRef.get(GovLicenseStore);
};

const permit = (over: Record<string, unknown> = {}) => ({
  uuid: 'u-1',
  register_number: 'R-4218101048',
  number: '226497',
  name: 'Permit',
  ...over,
});

describe('GovLicenseStore — replacing older rows in place', () => {
  it('claims a myorg row with the same document number instead of inserting', async () => {
    // The bug this prevents: myorg rows carry no uuid, so the upsert's partial
    // unique key cannot match them and the same permit lands twice.
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 1 }) // the claim found one
      .mockResolvedValue({ rowCount: 0 });

    const stored = await (await build(query)).save('202099756', [permit()]);

    expect(stored).toBe(1);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('UPDATE public.company_licenses');
    expect(query.mock.calls[0][0]).toContain('uuid IS NULL');
  });

  it('inserts when no older row carries that document number', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0 }) // nothing to claim
      .mockResolvedValueOnce({ rowCount: 1 }); // so insert

    const stored = await (await build(query)).save('202099756', [permit()]);

    expect(stored).toBe(1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][0]).toContain(
      'INSERT INTO public.company_licenses',
    );
  });

  it('does not try to claim a permit with no document number', async () => {
    // Nothing to match on, so the claim would scan for `register_number = NULL`
    // and quietly match nothing — better not to ask.
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });

    await (
      await build(query)
    ).save('202099756', [permit({ register_number: null })]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('INSERT INTO');
  });

  it('claims one row per permit, never two', async () => {
    // `LIMIT 1` inside the subquery: two stored rows sharing a document number
    // must not both be overwritten by one registry permit.
    const query = jest.fn().mockResolvedValue({ rowCount: 1 });

    await (await build(query)).save('202099756', [permit()]);

    expect(query.mock.calls[0][0]).toContain('LIMIT 1');
  });

  /**
   * The registry leaving an address or the issuing officer out of one answer
   * does not mean the permit lost them. Its word on standing is different: a
   * suspension lifted or an expiry dropped is news, empty or not.
   */
  it('keeps stored descriptions where the registry sends nothing, and takes standing as sent', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0 }) // nothing to claim
      .mockResolvedValueOnce({ rowCount: 1 });

    await (await build(query)).save('202099756', [permit()]);
    const [claim, insert] = query.mock.calls.map((c) => c[0] as string);

    for (const col of ['address', 'organization_director', 'title', 'pin']) {
      expect(insert).toContain(
        `${col} = COALESCE(EXCLUDED.${col}, company_licenses.${col})`,
      );
      expect(claim).toMatch(
        new RegExp(`\\b${col} = COALESCE\\(\\$\\d+, ${col}\\)`),
      );
    }
    for (const col of [
      'status_code',
      'is_active',
      'validity',
      'revoke_date',
      'suspension_begin',
      'suspension_end',
    ]) {
      expect(insert).toContain(`${col} = EXCLUDED.${col}`);
      expect(claim).toMatch(new RegExp(`\\b${col} = \\$\\d+`));
    }
  });

  it('skips records the registry sent without a uuid', async () => {
    const query = jest.fn();

    const stored = await (
      await build(query)
    ).save('202099756', [{ register_number: 'R-1', name: 'no uuid' }]);

    expect(stored).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('GovLicenseStore — standing it replaces is kept', () => {
  it('logs a suspension the registry lifted', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValue({ rowCount: 1 });
    const side = jest.fn<Promise<unknown[]>, [string, unknown[]?]>(
      async (sql) =>
        /^\s*SELECT uuid,/.test(sql)
          ? [
              {
                uuid: 'u-1',
                status_code: 'SUSPENDED',
                is_active: false,
                validity: '2027-01-01',
                revoke_date: null,
                suspension_begin: '2026-05-01',
                suspension_end: '2026-12-01',
              },
            ]
          : [],
    );

    await (
      await build(query, side)
    ).save('202099756', [
      {
        ...permit(),
        status: { status: 'ACTIVE' },
        active: true,
        expiry_date: '01.01.2027',
      },
    ]);

    const logged = side.mock.calls.filter((c) =>
      String(c[0]).includes('company_change_log'),
    );
    expect(logged).toHaveLength(1);
    const fields = (logged[0] as unknown[][])[1].filter((_, i) => i % 7 === 3);
    expect(fields).toEqual(
      expect.arrayContaining([
        'is_active',
        'suspension_begin',
        'suspension_end',
      ]),
    );
    expect(fields).not.toContain('validity');
  });
});
