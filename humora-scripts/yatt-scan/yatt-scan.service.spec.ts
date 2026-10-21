import { BadRequestException } from '@nestjs/common';
import {
  innFromSequence,
  sequenceOfInn,
} from '../new-company-scan/inn-sequence';
import {
  PERSON_SEQUENCE,
  YattScanService,
  blockOf,
  nightlyIntervalMs,
  randomInns,
  readSoliqAnswer,
  sequentialInns,
  yattScanNightlyEnabled,
} from './yatt-scan.service';
import { YattScanController } from './yatt-scan.controller';

/** soliq's factura-all for a STIR it does not know: 200, every field null. */
const EMPTY = {
  ns10Code: null,
  ns11Code: null,
  shortName: null,
  tin: null,
  name: null,
  regDate: null,
  mfo: '',
  account: '',
  address: null,
  isBudget: 0,
  taxpayerType: 0,
  personalNum: null,
  selfEmployment: false,
  privateNotary: false,
  peasantFarm: false,
};
const person = (tin: string, bank?: { mfo: string; account: string }) => ({
  ...EMPTY,
  ns10Code: 26,
  ns11Code: 5,
  tin,
  name: 'TOSHMATOV ESHMAT',
  address: 'Namuna koʻchasi, 1',
  personalNum: '12345678901234',
  mfo: bank?.mfo ?? '',
  account: bank?.account ?? '',
});

describe('readSoliqAnswer', () => {
  it('reads an all-null answer as "no such taxpayer", not as data', () => {
    expect(readSoliqAnswer(EMPTY)).toEqual({ kind: 'empty' });
    expect(readSoliqAnswer(null)).toEqual({ kind: 'empty' });
    expect(readSoliqAnswer('')).toEqual({ kind: 'empty' });
  });

  it('tells a person without an account from one with', () => {
    expect(readSoliqAnswer(person('401234567'))).toEqual({
      kind: 'person',
      bankCode: null,
      account: null,
      ns10: 26,
      ns11: 5,
    });
    expect(
      readSoliqAnswer(
        person('401234567', { mfo: '00000', account: '20218000000000000001' }),
      ),
    ).toEqual({
      kind: 'candidate',
      bankCode: '00000',
      account: '20218000000000000001',
      ns10: 26,
      ns11: 5,
    });
  });
});

describe('STIR generators', () => {
  it('walks one STIR per sequence, every one able to exist', () => {
    const { inns, next } = sequentialInns(40_000_000, 3);
    expect(inns.map((i) => sequenceOfInn(i))).toEqual([
      40_000_000, 40_000_001, 40_000_002,
    ]);
    expect(next).toBe(40_000_003);
  });

  it('stops at the end of people’s STIRs', () => {
    const { inns, next } = sequentialInns(PERSON_SEQUENCE.last - 1, 5);
    expect(inns).toHaveLength(2);
    expect(next).toBe(PERSON_SEQUENCE.last + 1);
  });

  it('samples different STIRs at random, one digit when asked', () => {
    let x = 0;
    const steps = () => (x += 0.137) % 1;
    const inns = randomInns(20, 5, steps);
    expect(new Set(inns).size).toBe(20);
    for (const inn of inns) {
      expect(inn[0]).toBe('5');
      expect(sequenceOfInn(inn)).not.toBeNull();
    }
  });
});

/** A database that answers each statement the scan sends. */
function fakeDb(opts: { held?: string[]; next?: number; night?: number } = {}) {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const db: any = {
    calls,
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (/SELECT next_sequence AS seq FROM/.test(sql)) {
        return [{ seq: String(opts.next ?? 40_000_000) }];
      }
      if (/SELECT night_next_sequence AS seq FROM/.test(sql)) {
        return [{ seq: String(opts.night ?? 40_000_000) }];
      }
      if (/FROM public\.individual_entrepreneurs/.test(sql)) {
        return (opts.held ?? []).map((inn) => ({ inn }));
      }
      if (/INSERT INTO public\.yatt_scan_candidates/.test(sql)) {
        return [{ inserted: true, soato: '1726269' }];
      }
      if (/stop_requested FROM/.test(sql)) return [{ stop_requested: false }];
      return [];
    }),
    createQueryRunner: () => ({
      connect: jest.fn().mockResolvedValue(undefined),
      release: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(async (sql: string) =>
        /pg_try_advisory_lock/.test(sql) ? [{ locked: true }] : [],
      ),
    }),
  };
  return db;
}

const telegram: any = { send: jest.fn().mockResolvedValue(true) };

describe('YattScanService', () => {
  it('asks soliq, keeps only people with a bank account, and moves the cursor', async () => {
    const inns = sequentialInns(40_000_000, 4).inns;
    const db = fakeDb({ held: [inns[3]] });
    const answers: Record<string, unknown> = {
      [inns[0]]: EMPTY,
      [inns[1]]: person(inns[1]),
      [inns[2]]: person(inns[2], {
        mfo: '00000',
        account: '20218000000000000001',
      }),
    };
    const mysoliq: any = {
      request: jest.fn(
        async (_path: string, p: { tin: string }) => answers[p.tin],
      ),
    };
    const scan = new YattScanService(db, mysoliq, telegram);

    const run = await scan.start({ count: 4, mode: 'sequential' }, 'test');
    expect(run.started).toBe(true);
    const report = await run.done;

    expect(report?.ended).toBe('done');
    expect(report?.totals).toMatchObject({
      asked: 3,
      held: 1,
      notFound: 1,
      foundNoBank: 1,
      candidates: 1,
      newCandidates: 1,
      failed: 0,
    });
    // The trader we hold was never asked about.
    expect(mysoliq.request).not.toHaveBeenCalledWith('np1/bytin/factura-all', {
      tin: inns[3],
    });
    // Only the bank fields and the tax office pair are kept — no name, no
    // PINFL, no address — and the district comes from ns_soato_map.
    const insert = db.calls.find((c: any) =>
      /INSERT INTO public\.yatt_scan_candidates/.test(c.sql),
    );
    expect(insert.params).toEqual([
      inns[2],
      '00000',
      '20218000000000000001',
      26,
      5,
    ]);
    expect(insert.sql).toContain('public.ns_soato_map');
    // One type for the office pair: it fills an integer column and meets
    // ns_soato_map's smallint, and without a cast Postgres refused every
    // candidate of the first night.
    expect(insert.sql.match(/\$4::int/g)).toHaveLength(2);
    expect(insert.sql.match(/\$5::int/g)).toHaveLength(2);
    // The block's counts, with the offices of the people found.
    const blocks = db.calls.find((c: any) =>
      /INSERT INTO public\.yatt_scan_blocks/.test(c.sql),
    );
    expect(blocks.params.slice(0, 6)).toEqual([
      [40_000],
      [3],
      [1],
      [1],
      [1],
      [1],
    ]);
    expect(JSON.parse(blocks.params[6][0])).toEqual({ '26/5': 2 });
    expect(JSON.stringify(db.calls)).not.toContain('TOSHMATOV');
    expect(JSON.stringify(db.calls)).not.toContain('12345678901234');
    // The next sequential run starts after the last STIR.
    const saved = db.calls.find((c: any) =>
      /SET next_sequence = \$1/.test(c.sql),
    );
    expect(saved.params[0]).toBe(40_000_004);
    expect(report?.nextInn).toBe(innFromSequence(40_000_004));
  });

  it('asks each STIR once, even when a stop check waits at the end', async () => {
    const db = fakeDb();
    const plain = db.query;
    // The stop check takes a moment, so the other worker can finish the
    // queue meanwhile.
    db.query = jest.fn(async (sql: string, params?: unknown[]) => {
      if (/stop_requested FROM/.test(sql)) {
        await new Promise((r) => setTimeout(r, 5));
      }
      return plain(sql, params);
    });
    const mysoliq: any = { request: jest.fn().mockResolvedValue(EMPTY) };
    const scan = new YattScanService(db, mysoliq, telegram);
    const report = await (
      await scan.start({ count: 40, mode: 'sequential' }, 'test')
    ).done;

    const asked = mysoliq.request.mock.calls.map((c: any[]) => c[1].tin);
    expect(asked).toHaveLength(40);
    expect(asked.every((tin: unknown) => typeof tin === 'string')).toBe(true);
    expect(new Set(asked).size).toBe(40);
    expect(report?.totals.asked).toBe(40);
  });

  it('stops after ten failures in a row and starts there next time', async () => {
    const db = fakeDb({ next: 50_000_000 });
    const mysoliq: any = {
      request: jest.fn().mockRejectedValue(new Error('proxy down')),
    };
    const scan = new YattScanService(db, mysoliq, telegram);
    const report = await (
      await scan.start({ count: 30, mode: 'sequential' }, 'test')
    ).done;

    expect(report?.ended).toBe('aborted');
    expect(report?.totals.failed).toBeGreaterThanOrEqual(10);
    expect(report?.totals.failed).toBeLessThan(30);
    expect(report?.lastError).toBe('proxy down');
    // Nothing unanswered is skipped: the next run asks them again.
    expect(report?.nextInn).toBe(innFromSequence(50_000_000));
  });

  it('starts at a given STIR, and a random run leaves the cursor alone', async () => {
    const db = fakeDb();
    const mysoliq: any = { request: jest.fn().mockResolvedValue(EMPTY) };
    const scan = new YattScanService(db, mysoliq, telegram);

    const from = innFromSequence(61_234_567);
    const a = await (
      await scan.start({ count: 2, mode: 'sequential', fromInn: from }, 't')
    ).done;
    expect(a?.first).toBe(from);
    expect(a?.totals.notFound).toBe(2);

    db.calls.length = 0;
    const b = await (
      await scan.start({ count: 3, mode: 'random', prefix: 4 }, 't')
    ).done;
    expect(b?.totals.asked).toBe(3);
    expect(
      db.calls.some((c: any) => /SET (night_)?next_sequence = \$1/.test(c.sql)),
    ).toBe(false);
  });

  it('a nightly sweep keeps its own cursor and stops at its deadline', async () => {
    const db = fakeDb({ next: 50_000_000, night: 40_000_000 });
    let asked = 0;
    const mysoliq: any = {
      request: jest.fn(async () => {
        asked++;
        return EMPTY;
      }),
    };
    const scan = new YattScanService(db, mysoliq, telegram);
    // A deadline that passes while the sweep runs.
    const deadline = new Date(Date.now() + 60);
    const report = await (
      await scan.start(
        { mode: 'nightly', deadline, intervalMs: 5, concurrency: 1 },
        'nightly',
      )
    ).done;

    expect(report?.ended).toBe('deadline');
    expect(report?.first).toBe(innFromSequence(40_000_000));
    // The pace held: ~one request per 5 ms over ~60 ms, not hundreds.
    expect(asked).toBeGreaterThan(0);
    expect(asked).toBeLessThan(40);
    // Its own cursor moved, to the first STIR it did not ask; the cursor of
    // runs by hand did not.
    const night = db.calls.filter((c: any) =>
      /SET night_next_sequence = \$1/.test(c.sql),
    );
    expect(night.length).toBeGreaterThan(0);
    expect(night[night.length - 1].params[0]).toBe(40_000_000 + asked);
    expect(
      db.calls.some((c: any) => /SET next_sequence = \$1/.test(c.sql)),
    ).toBe(false);
    // It said so in Telegram, at the start and at the end.
    const texts = telegram.send.mock.calls.map((c: any[]) => c[0]);
    expect(texts.some((x: string) => x.includes('scan started'))).toBe(true);
  });

  it('a sample of the night stops after its count, on the night cursor', async () => {
    const db = fakeDb({ next: 50_000_000, night: 40_000_123 });
    const mysoliq: any = { request: jest.fn(async () => EMPTY) };
    const scan = new YattScanService(db, mysoliq, telegram);
    const report = await (
      await scan.start(
        {
          mode: 'nightly',
          count: 7,
          deadline: new Date(Date.now() + 60_000),
          intervalMs: 0,
          concurrency: 1,
        },
        'sample night, 7 STIRs',
      )
    ).done;

    expect(report?.ended).toBe('done');
    expect(report?.totals.asked).toBe(7);
    expect(report?.first).toBe(innFromSequence(40_000_123));
    expect(report?.nextInn).toBe(innFromSequence(40_000_130));
    // The night's cursor moved on, so the night carries on after the sample;
    // the cursor of runs by hand stayed.
    const night = db.calls.filter((c: any) =>
      /SET night_next_sequence = \$1/.test(c.sql),
    );
    expect(night[night.length - 1].params[0]).toBe(40_000_130);
    expect(
      db.calls.some((c: any) => /SET next_sequence = \$1/.test(c.sql)),
    ).toBe(false);
  });

  it('asks nothing when the deadline has already passed', async () => {
    const db = fakeDb();
    const mysoliq: any = { request: jest.fn() };
    const scan = new YattScanService(db, mysoliq, telegram);
    const report = await (
      await scan.start(
        { mode: 'nightly', deadline: new Date(Date.now() - 1000) },
        'nightly',
      )
    ).done;
    expect(report?.ended).toBe('deadline');
    expect(mysoliq.request).not.toHaveBeenCalled();
  });
});

describe('the nightly switch and pace', () => {
  it('runs on production only unless told otherwise', () => {
    expect(yattScanNightlyEnabled({ SERVICE_ENVIRONMENT: 'production' })).toBe(
      true,
    );
    // The test environment tries it by hand only (user decision 2026-10-20).
    expect(yattScanNightlyEnabled({ SERVICE_ENVIRONMENT: 'development' })).toBe(
      false,
    );
    expect(yattScanNightlyEnabled({})).toBe(false);
    expect(
      yattScanNightlyEnabled({
        SERVICE_ENVIRONMENT: 'development',
        YATT_SCAN_ENABLED: '1',
      }),
    ).toBe(true);
    expect(
      yattScanNightlyEnabled({
        SERVICE_ENVIRONMENT: 'production',
        YATT_SCAN_ENABLED: '0',
      }),
    ).toBe(false);
  });

  it('asks soliq twice a second unless set', () => {
    expect(nightlyIntervalMs({})).toBe(500);
    expect(nightlyIntervalMs({ YATT_SCAN_INTERVAL_MS: '1000' })).toBe(1000);
    expect(nightlyIntervalMs({ YATT_SCAN_INTERVAL_MS: 'x' })).toBe(500);
  });

  it('puts a STIR in its block of 1,000 sequences', () => {
    expect(blockOf('433704280')).toBe(43370);
    expect(blockOf(innFromSequence(43370999))).toBe(43370);
    expect(blockOf(innFromSequence(43371000))).toBe(43371);
  });
});

describe('YattScanController', () => {
  const scan: any = {
    start: jest.fn().mockResolvedValue({
      started: true,
      reason: null,
      done: Promise.resolve(null),
    }),
  };
  const c = new YattScanController(scan);

  const refused: Array<[Record<string, string>, string]> = [
    [{}, 'no count'],
    [{ count: '0' }, 'zero'],
    [{ count: '10001' }, 'over the cap'],
    [{ count: '5', fromInn: '300000001' }, 'a company STIR'],
    [{ count: '5', fromInn: '401234560' }, 'a wrong check digit'],
    [{ count: '5', prefix: '4' }, 'a prefix without random'],
    [
      { count: '5', mode: 'random', fromInn: innFromSequence(40_000_000) },
      'fromInn with random',
    ],
    [{ count: '5', mode: 'sideways' }, 'an unknown mode'],
  ];
  it.each(refused)('refuses %j (%s)', async (q) => {
    await expect(
      c.run(q.count, q.mode, q.fromInn, q.prefix, q.wait),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('starts a sequential run from a person’s STIR', async () => {
    const from = innFromSequence(45_000_000);
    await expect(c.run('100', undefined, from)).resolves.toEqual({
      started: true,
      reason: null,
    });
    expect(scan.start).toHaveBeenCalledWith(
      { count: 100, mode: 'sequential', fromInn: from, prefix: undefined },
      'manual, sequential, 100',
    );
  });

  it('runs a sample of the night: its pace, one at a time, `count` STIRs', async () => {
    scan.start.mockClear();
    const res = await c.night(undefined, '100');
    expect(res.started).toBe(true);
    expect(scan.start).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'nightly',
        count: 100,
        intervalMs: 500,
        concurrency: 1,
      }),
      'sample night, 100 STIRs',
    );
  });

  it('answers with the sample’s report when asked to wait', async () => {
    const report = { ended: 'done', totals: { asked: 3 } };
    scan.start.mockResolvedValueOnce({
      started: true,
      reason: null,
      done: Promise.resolve(report),
    });
    await expect(c.night(undefined, '3', '1')).resolves.toMatchObject({
      started: true,
      report,
    });
  });

  it.each(['0', '10001', '2.5', 'x'])(
    'refuses a night sample of %s STIRs',
    async (count) => {
      await expect(c.night(undefined, count)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    },
  );

  it('a night without count still runs to its deadline', async () => {
    scan.start.mockClear();
    await c.night('2');
    const [options, trigger] = scan.start.mock.calls[0];
    expect(options.count).toBeUndefined();
    expect(trigger).toBe('manual night, 2 h');
  });
});
