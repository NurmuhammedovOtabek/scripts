import type { MysoliqCompanyData } from '../../mysoliq/mysoliq-data.service';
import { innFromSequence } from './inn-sequence';
import { NewCompanyBackfillService } from './new-company-backfill.service';

/**
 * A backfill walks a stretch that is all issued, for hours. What matters:
 * misses never end it, held numbers are never asked, a lone failure is asked
 * again, an outage stops it where a restart can continue, and a stop request
 * from any replica is obeyed between chunks.
 */
describe('NewCompanyBackfillService', () => {
  type Answer = 'found' | 'missing' | 'unnamed' | 'fail' | 'failOnce';

  interface Setup {
    /** Newest STIR held per month, as company_info would answer. */
    lastOfMonth?: Record<string, number | string>;
    frontier?: number | null;
    held?: number[];
    answers?: Record<number, Answer>;
    /** Every lookup fails. */
    outage?: boolean;
    /** An unfinished run already in the table. */
    unfinished?: { from: number; to: number; next: number } | null;
    unfinishedStatus?: string;
    /** stop_requested reads true from this check on (1-based). */
    stopAtCheck?: number;
  }

  const company = (
    over: Partial<MysoliqCompanyData> = {},
  ): MysoliqCompanyData => ({
    short_name: 'TEST',
    company_name: 'TEST MCHJ',
    director_name: null,
    director_tin: null,
    director_pinfl: null,
    street_address: null,
    oked_code: null,
    status: '1',
    status_description: null,
    activity_state: 1,
    registration_date: null,
    bank_code: null,
    bank_account_number: null,
    is_budget: false,
    accountant: null,
    ns10_code: null,
    ns11_code: null,
    ...over,
  });

  const build = (setup: Setup = {}) => {
    const held = new Set((setup.held ?? []).map((s) => innFromSequence(s)));
    const inserted: string[] = [];
    const asked: string[] = [];
    const alerts: string[] = [];
    const seenOnce = new Set<string>();
    let stopChecks = 0;
    let row: Record<string, any> | null = setup.unfinished
      ? {
          id: 7,
          from_inn: innFromSequence(setup.unfinished.from),
          to_inn: innFromSequence(setup.unfinished.to),
          next_inn: innFromSequence(setup.unfinished.next),
          status: setup.unfinishedStatus ?? 'aborted',
          concurrency: 1,
          stop_requested: false,
          totals: { checked: 5, added: 3 },
          failed_inns: [],
          last_error: null,
        }
      : null;

    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: true }]),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const db = {
      createQueryRunner: jest.fn(() => runner),
      query: jest.fn(async (sql: string, params: any[] = []) => {
        if (sql.includes('registration_date >=')) {
          const v = setup.lastOfMonth?.[params[0]];
          if (v === undefined) return [];
          return [
            { inn: typeof v === 'number' ? innFromSequence(v) : v },
            ...(typeof v === 'string'
              ? [{ inn: innFromSequence(Number(v.slice(0, 8)) - 1) }]
              : []),
          ];
        }
        if (sql.includes('FROM public.new_company_scan_cursor')) {
          return setup.frontier
            ? [{ frontier_inn: innFromSequence(setup.frontier) }]
            : [];
        }
        if (sql.includes('SELECT DISTINCT inn FROM public.company_info')) {
          return [...held]
            .filter((inn) => inn >= params[0] && inn <= params[1])
            .map((inn) => ({ inn }));
        }
        if (sql.includes('inn = ANY')) {
          return (params[0] as string[])
            .filter((inn) => held.has(inn))
            .map((inn) => ({ inn }));
        }
        if (sql.includes('INSERT INTO public.company_info')) {
          inserted.push(params[0]);
          held.add(params[0]);
          return [{ inn: params[0] }];
        }
        if (sql.includes("totals->>'answered'")) return [];
        if (sql.includes('SELECT id, status')) return row ? [row] : [];
        if (sql.includes('WHERE status = ANY')) {
          if (sql.startsWith('SELECT') || sql.trim().startsWith('SELECT')) {
            return row && row.status !== 'done' ? [row] : [];
          }
          if (row && row.status !== 'done') row.status = 'superseded';
          return [[], 0];
        }
        if (sql.includes('INSERT INTO public.new_company_backfill_run')) {
          row = {
            id: 8,
            from_inn: params[0],
            to_inn: params[1],
            next_inn: params[0],
            status: 'running',
            concurrency: params[2],
            stop_requested: false,
            totals: JSON.parse(params[3]),
            failed_inns: [],
            last_error: null,
          };
          return [row];
        }
        if (sql.includes('SET status = COALESCE')) {
          Object.assign(row!, {
            status: params[1] ?? row!.status,
            concurrency: params[3] ?? row!.concurrency,
          });
          return [[row], 1];
        }
        if (sql.includes('SET next_inn')) {
          Object.assign(row!, {
            next_inn: params[1],
            totals: JSON.parse(params[2]),
            failed_inns: params[3],
            last_error: params[4],
          });
          return [[], 1];
        }
        if (sql.includes('SELECT stop_requested')) {
          stopChecks++;
          return [
            {
              stop_requested:
                setup.stopAtCheck !== undefined &&
                stopChecks >= setup.stopAtCheck,
            },
          ];
        }
        if (sql.includes('SET status = $2')) {
          Object.assign(row!, { status: params[1], last_error: params[2] });
          return [[], 1];
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    };

    const mysoliq = {
      findCompanyByTin: jest.fn(async (inn: string) => {
        asked.push(inn);
        if (setup.outage) throw new Error('socket hang up');
        const answer = setup.answers?.[Number(inn.slice(0, 8))] ?? 'missing';
        if (answer === 'fail') throw new Error('timeout');
        if (answer === 'failOnce' && !seenOnce.has(inn)) {
          seenOnce.add(inn);
          throw new Error('timeout');
        }
        if (answer === 'missing') return null;
        if (answer === 'unnamed') return company({ company_name: null });
        return company();
      }),
    };

    const telegram = {
      send: jest.fn(async (text: string) => {
        alerts.push(text);
      }),
    };

    const service = new NewCompanyBackfillService(
      db as any,
      mysoliq as any,
      telegram as any,
    );
    return {
      service,
      inserted,
      asked,
      alerts,
      row: () => row,
    };
  };

  const APRIL_LAST = 31300576;
  const FRONTIER = 31300590;

  it('walks from the last March company to the scan frontier', async () => {
    const t = build({
      lastOfMonth: { '2026-03': APRIL_LAST },
      frontier: FRONTIER,
      held: [APRIL_LAST, 31300580, FRONTIER],
      answers: {
        31300577: 'found',
        31300578: 'found',
        31300581: 'unnamed',
        31300589: 'found',
      },
    });
    const run = await t.service.start({}, 'test');
    expect(run.started).toBe(true);
    expect(run.range).toEqual({
      fromInn: innFromSequence(APRIL_LAST),
      nextInn: innFromSequence(APRIL_LAST),
      toInn: innFromSequence(FRONTIER),
    });
    await run.done;

    // Misses in between never ended the walk: the last one was reached.
    expect(t.inserted).toEqual(
      [31300577, 31300578, 31300589].map((s) => innFromSequence(s)),
    );
    // Held numbers were never asked.
    expect(t.asked).not.toContain(innFromSequence(31300580));
    expect(t.asked).not.toContain(innFromSequence(APRIL_LAST));
    expect(t.asked).not.toContain(innFromSequence(FRONTIER));

    const row = t.row()!;
    expect(row.status).toBe('done');
    expect(row.totals).toMatchObject({
      checked: 15,
      held: 3,
      asked: 12,
      added: 3,
      unnamed: 1,
      missing: 8,
      errors: 0,
    });
    expect(t.alerts[0]).toContain('started');
    expect(t.alerts.at(-1)).toContain('finished');
    expect(t.alerts.at(-1)).toContain('<b>3</b>');
  });

  it('skips a malformed STIR when finding the start', async () => {
    // 313005761 has the wrong check digit; the next valid one is used.
    const t = build({
      lastOfMonth: { '2026-03': '313005761' },
      frontier: FRONTIER,
    });
    const range = await t.service.resolveRange({});
    expect(range.fromInn).toBe(innFromSequence(31300575));
  });

  it('asks a lone failure again and keeps one that never answers', async () => {
    const t = build({
      lastOfMonth: { '2026-03': APRIL_LAST },
      frontier: APRIL_LAST + 4,
      answers: {
        [APRIL_LAST + 1]: 'failOnce',
        [APRIL_LAST + 2]: 'fail',
        [APRIL_LAST + 3]: 'found',
      },
    });
    const run = await t.service.start({ concurrency: 1 }, 'test');
    await run.done;
    expect(t.inserted).toContain(innFromSequence(APRIL_LAST + 3));
    expect(t.inserted).toContain(innFromSequence(APRIL_LAST + 1));
    expect(t.row()!.failed_inns).toEqual([innFromSequence(APRIL_LAST + 2)]);
    expect(t.row()!.status).toBe('done');
    expect(t.alerts.at(-1)).toContain('Never answered: 1');
  });

  it('stops on an outage where a restart can continue', async () => {
    const t = build({
      lastOfMonth: { '2026-03': APRIL_LAST },
      frontier: APRIL_LAST + 400,
      outage: true,
    });
    const run = await t.service.start({ errorLimit: 5 }, 'test');
    await run.done;
    const row = t.row()!;
    expect(row.status).toBe('aborted');
    expect(row.next_inn).toBe(innFromSequence(APRIL_LAST));
    expect(t.asked.length).toBeLessThan(10);
    expect(t.alerts.at(-1)).toContain('not answering');
  });

  it('continues an unfinished run from where it stopped', async () => {
    const t = build({
      frontier: FRONTIER,
      unfinished: { from: APRIL_LAST, to: FRONTIER, next: 31300588 },
      answers: { 31300589: 'found' },
    });
    const run = await t.service.start({}, 'test');
    expect(run.resumed).toBe(true);
    await run.done;
    expect(t.asked).toEqual(
      [31300588, 31300589, 31300590].map((s) => innFromSequence(s)),
    );
    expect(t.row()!.status).toBe('done');
    // Totals carry on from the earlier part of the run.
    expect(t.row()!.totals.added).toBe(4);
    expect(t.alerts[0]).toContain('resumed');
  });

  it('starts over when told to, closing the unfinished run', async () => {
    const t = build({
      lastOfMonth: { '2026-03': APRIL_LAST },
      frontier: FRONTIER,
      unfinished: { from: 31200000, to: 31200100, next: 31200050 },
    });
    const run = await t.service.start({ fresh: true }, 'test');
    expect(run.resumed).toBe(false);
    expect(run.runId).toBe(8);
    await run.done;
  });

  it('obeys a stop request between chunks', async () => {
    const t = build({
      lastOfMonth: { '2026-03': APRIL_LAST },
      frontier: APRIL_LAST + 1000,
      stopAtCheck: 2,
    });
    const run = await t.service.start({}, 'test');
    await run.done;
    expect(t.row()!.status).toBe('stopped');
    // One chunk of 200 was walked, then it stopped.
    expect(t.row()!.next_inn).toBe(innFromSequence(APRIL_LAST + 200));
    expect(t.alerts.at(-1)).toContain('stopped on request');
  });

  it('refuses a range that goes nowhere', async () => {
    const t = build({
      lastOfMonth: { '2026-03': FRONTIER },
      frontier: FRONTIER,
    });
    const run = await t.service.start({}, 'test');
    expect(run.started).toBe(false);
    expect(run.reason).toContain('nothing to walk');
  });

  it('plans without asking mysoliq', async () => {
    const t = build({
      lastOfMonth: { '2026-03': APRIL_LAST },
      frontier: FRONTIER,
      held: [APRIL_LAST, 31300580, FRONTIER],
    });
    const plan = await t.service.plan({});
    expect(plan.numbers).toBe(15);
    expect(plan.held).toBe(3);
    expect(plan.toAsk).toBe(12);
    expect(plan.lookupMsMeasured).toBe(false);
    expect(Object.keys(plan.estimate)).toContain('concurrency_2');
    expect(t.asked).toEqual([]);
  });

  it('walks only the first numbers on a trial run', async () => {
    const t = build({
      lastOfMonth: { '2026-03': APRIL_LAST },
      frontier: APRIL_LAST + 5000,
      answers: { [APRIL_LAST + 3]: 'found' },
    });
    const run = await t.service.start({ limit: 20 }, 'test');
    expect(run.range!.toInn).toBe(innFromSequence(APRIL_LAST + 19));
    await run.done;
    expect(t.row()!.status).toBe('done');
    expect(t.row()!.totals.checked).toBe(20);
    expect(t.inserted).toEqual([innFromSequence(APRIL_LAST + 3)]);
  });

  it('continues a run a restart interrupted, and only such a run', async () => {
    const env = process.env.NEW_COMPANY_SCAN_ENABLED;
    try {
      const interrupted = build({
        frontier: FRONTIER,
        unfinished: { from: APRIL_LAST, to: FRONTIER, next: 31300588 },
        unfinishedStatus: 'running',
      });
      expect(await interrupted.service.resumeInterrupted()).toBe(true);

      const stopped = build({
        frontier: FRONTIER,
        unfinished: { from: APRIL_LAST, to: FRONTIER, next: 31300588 },
        unfinishedStatus: 'stopped',
      });
      expect(await stopped.service.resumeInterrupted()).toBe(false);
      expect(stopped.asked).toEqual([]);
    } finally {
      process.env.NEW_COMPANY_SCAN_ENABLED = env;
    }
  });
});
