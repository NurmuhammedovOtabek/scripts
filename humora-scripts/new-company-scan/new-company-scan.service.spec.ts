import type { MysoliqCompanyData } from '../../mysoliq/mysoliq-data.service';
import { innFromSequence } from './inn-sequence';
import {
  NewCompanyScanService,
  ScanResult,
  newCompanyScanEnabled,
} from './new-company-scan.service';

/**
 * The walk has to know three things apart: a number not issued yet, a number
 * mysoliq failed to answer for, and a company already held. Confusing the
 * first two ends a run early and reports it as quiet; confusing the last
 * spends a lookup on every company we have.
 */
describe('NewCompanyScanService', () => {
  type Answer = 'found' | 'unnamed' | 'fail' | 'hang';

  interface Setup {
    frontier?: number | null;
    /** Newest legal entity registered in the last few months. */
    recent?: number | null;
    /** Newest legal entity held at all. */
    highest?: number | null;
    held?: number[];
    answers?: Record<number, Answer>;
    /** Sequences whose insert company_info refuses. */
    refuse?: number[];
    locked?: boolean;
  }

  const SCHEDULED = 'every 2 hours';

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
    const insertParams: unknown[][] = [];
    const saved: ScanResult[] = [];
    const ranges: string[][] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));

    const runner = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue([{ locked: setup.locked ?? true }]),
      release: jest.fn().mockResolvedValue(undefined),
    };

    const db = {
      createQueryRunner: jest.fn(() => runner),
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO public.new_company_scan_cursor')) {
          saved.push(JSON.parse(String(params[1])) as ScanResult);
          return [];
        }
        if (sql.includes('FROM public.new_company_scan_cursor')) {
          return setup.frontier
            ? [{ frontier_inn: innFromSequence(setup.frontier) }]
            : [];
        }
        if (sql.includes('ORDER BY inn DESC')) {
          const newest = sql.includes('registration_date >=')
            ? setup.recent
            : setup.highest;
          return newest ? [{ inn: innFromSequence(newest) }] : [];
        }
        if (sql.includes('inn = ANY')) {
          const inns = params[0] as string[];
          ranges.push(inns);
          return inns.filter((inn) => held.has(inn)).map((inn) => ({ inn }));
        }
        if (sql.includes('INSERT INTO public.company_info')) {
          const inn = String(params[0]);
          insertParams.push(params);
          if ((setup.refuse ?? []).includes(Number(inn.slice(0, 8)))) {
            throw new Error('value too long for type character varying(64)');
          }
          inserted.push(inn);
          held.add(inn);
          return [{ inn }];
        }
        return [];
      }),
    };

    const mysoliq = {
      findCompanyByTin: jest.fn(
        async (inn: string): Promise<MysoliqCompanyData | null> => {
          const answer = setup.answers?.[Number(inn.slice(0, 8))];
          if (answer === 'hang') {
            await gate;
            return null;
          }
          if (answer === 'fail') {
            throw new Error(
              'MySoliq server unreachable (allowed network only)',
            );
          }
          if (answer === 'unnamed') return company({ company_name: null });
          if (answer === 'found') return company();
          return null;
        },
      ),
    };

    // Every run ends in a Telegram message, so it is a spy, not a stub.
    const telegram = { send: jest.fn().mockResolvedValue(undefined) };

    const svc = new NewCompanyScanService(
      db as never,
      mysoliq as never,
      telegram as never,
    );
    return {
      svc,
      db,
      runner,
      mysoliq,
      telegram,
      inserted,
      insertParams,
      saved,
      ranges,
      release: () => release(),
    };
  };

  const alertText = (telegram: { send: jest.Mock }) =>
    telegram.send.mock.calls.map((c) => String(c[0])).join('\n');

  const asked = (mysoliq: { findCompanyByTin: jest.Mock }): string[] =>
    mysoliq.findCompanyByTin.mock.calls.map((c) => String(c[0]));

  /** An arbitrary point on the counter. */
  const S = 31_333_190;

  describe('scan — ranges of twenty from the last company found', () => {
    it('continues right after the last company found', async () => {
      const { svc, mysoliq, inserted, saved } = build({
        frontier: S,
        answers: { [S + 1]: 'found', [S + 2]: 'found', [S + 4]: 'found' },
      });

      const result = await svc.scan({ missLimit: 3 });

      expect(asked(mysoliq)[0]).toBe(innFromSequence(S + 1));
      expect(inserted).toEqual([S + 1, S + 2, S + 4].map(innFromSequence));
      expect(result.added).toBe(3);
      // S+3 was a gap between companies, not the end: the walk carried on.
      expect(result.frontierAfter).toBe(innFromSequence(S + 4));
      // Three misses past S+4, then it stopped without asking S+8.
      expect(result.endInn).toBe(innFromSequence(S + 7));
      expect(saved.at(-1)?.frontierAfter).toBe(innFromSequence(S + 4));
    });

    it('stops at ten misses in a row and leaves the frontier where it was', async () => {
      const { svc, mysoliq } = build({ frontier: S });

      const result = await svc.scan();

      // S+1 … S+10, and not one more.
      expect(asked(mysoliq)).toHaveLength(10);
      expect(result.frontierAfter).toBe(innFromSequence(S));
      expect(result.added).toBe(0);
    });

    it('generates twenty STIRs at a time and moves to the next range while companies turn up', async () => {
      const { svc, mysoliq, inserted, ranges } = build({
        frontier: S,
        answers: { [S + 8]: 'found', [S + 17]: 'found', [S + 26]: 'found' },
      });

      const result = await svc.scan();

      expect(ranges[0]).toHaveLength(20);
      expect(ranges[0][0]).toBe(innFromSequence(S + 1));
      expect(ranges[1][0]).toBe(innFromSequence(S + 21));
      expect(inserted).toEqual([S + 8, S + 17, S + 26].map(innFromSequence));
      expect(result.frontierAfter).toBe(innFromSequence(S + 26));
      // Ten misses after S+26 ended it.
      expect(asked(mysoliq).at(-1)).toBe(innFromSequence(S + 36));
    });

    it('never asks mysoliq about a company already in company_info', async () => {
      const { svc, mysoliq } = build({
        frontier: S,
        held: [S + 1],
        answers: { [S + 2]: 'found' },
      });

      const result = await svc.scan({ missLimit: 2 });

      expect(asked(mysoliq)).not.toContain(innFromSequence(S + 1));
      expect(result.alreadyHeld).toBe(1);
      expect(result.added).toBe(1);
    });

    it('does not read a failed lookup as a number not issued', async () => {
      const { svc, inserted } = build({
        frontier: S,
        answers: {
          [S + 1]: 'fail',
          [S + 2]: 'fail',
          [S + 3]: 'fail',
          [S + 4]: 'found',
        },
      });

      const result = await svc.scan({ missLimit: 3 });

      // Three failures in a row would have ended the walk had they been misses.
      expect(inserted).toEqual([innFromSequence(S + 4)]);
      expect(result.errors).toBe(3);
      expect(result.lastError).toContain('unreachable');
    });

    it('gives up on an outage without moving the frontier past unanswered numbers', async () => {
      const answers: Record<number, Answer> = { [S + 1]: 'found' };
      for (let s = S + 2; s < S + 30; s++) answers[s] = 'fail';
      const { svc, mysoliq } = build({ frontier: S, answers });

      const result = await svc.scan({ errorLimit: 5 });

      expect(result.aborted).toBe(true);
      expect(result.errors).toBe(5);
      expect(result.frontierAfter).toBe(innFromSequence(S + 1));
      // S+1, then five failures.
      expect(asked(mysoliq)).toHaveLength(6);
    });

    it('walks on past a company the table refuses, instead of stopping on it every run', async () => {
      const { svc, inserted } = build({
        frontier: S,
        answers: { [S + 1]: 'found', [S + 2]: 'found' },
        refuse: [S + 1],
      });

      const result = await svc.scan({ missLimit: 3 });

      expect(inserted).toEqual([innFromSequence(S + 2)]);
      expect(result.errors).toBe(1);
      expect(result.lastError).toContain(innFromSequence(S + 1));
      expect(result.lastError).toContain('value too long');
    });

    it('does not move the frontier for a refused company, so the next run asks again', async () => {
      const { svc } = build({
        frontier: S,
        answers: { [S + 1]: 'found' },
        refuse: [S + 1],
      });

      const result = await svc.scan({ missLimit: 3 });

      expect(result.added).toBe(0);
      expect(result.frontierAfter).toBe(innFromSequence(S));
    });

    it('stops when the table refuses ten companies in a row', async () => {
      const answers: Record<number, Answer> = {};
      const refuse: number[] = [];
      for (let s = S + 1; s <= S + 15; s++) {
        answers[s] = 'found';
        refuse.push(s);
      }
      const { svc } = build({ frontier: S, answers, refuse });

      const result = await svc.scan();

      expect(result.aborted).toBe(true);
      expect(result.errors).toBe(10);
      expect(result.frontierAfter).toBe(innFromSequence(S));
    });

    it('passes on only a registration date the column can take', async () => {
      const { svc, mysoliq, insertParams } = build({ frontier: S });
      mysoliq.findCompanyByTin.mockImplementation(async (inn: string) => {
        const sequence = Number(inn.slice(0, 8));
        if (sequence === S + 1) {
          return company({ registration_date: '31/09/2026 10:00' });
        }
        if (sequence === S + 2) {
          return company({ registration_date: '2026-09-15' });
        }
        return null;
      });

      await svc.scan({ missLimit: 1 });

      expect(insertParams[0][11]).toBeNull();
      expect(insertParams[1][11]).toBe('2026-09-15');
    });

    it('does not list a taxpayer mysoliq names nothing for', async () => {
      const { svc, inserted } = build({
        frontier: S,
        answers: { [S + 1]: 'unnamed' },
      });

      const result = await svc.scan({ missLimit: 2 });

      expect(inserted).toEqual([]);
      expect(result.unnamed).toBe(1);
      // It exists, though, so the counter has reached it.
      expect(result.frontierAfter).toBe(innFromSequence(S + 1));
    });

    it('starts right after the newest legal entity held when nothing is stored', async () => {
      const { svc, mysoliq } = build({ frontier: null, highest: S });

      await svc.scan({ missLimit: 1 });

      expect(asked(mysoliq)[0]).toBe(innFromSequence(S + 1));
    });

    it('prefers a recent registration to a stray STIR far above the counter', async () => {
      const { svc, mysoliq } = build({
        frontier: null,
        recent: S,
        highest: S + 5_000_000,
      });

      await svc.scan({ missLimit: 1 });

      expect(asked(mysoliq)[0]).toBe(innFromSequence(S + 1));
    });

    it('walks a backfill from fromInn without stopping on gaps behind the frontier', async () => {
      const { svc, mysoliq, inserted } = build({
        frontier: S + 50,
        answers: { [S + 30]: 'found' },
      });

      const result = await svc.scan({ fromInn: innFromSequence(S) });

      expect(asked(mysoliq)[0]).toBe(innFromSequence(S));
      expect(inserted).toEqual([innFromSequence(S + 30)]);
      // Past the frontier the usual ten misses end it.
      expect(result.endInn).toBe(innFromSequence(S + 60));
    });

    it('refuses a fromInn whose check digit is wrong', async () => {
      const { svc } = build({ frontier: S });
      const valid = innFromSequence(S);
      const wrong = valid.slice(0, 8) + ((Number(valid[8]) + 1) % 10);

      await expect(svc.scan({ fromInn: wrong })).rejects.toThrow(
        'not a valid STIR',
      );
    });

    it('refuses to guess when there is nowhere to start', async () => {
      const { svc } = build({ frontier: null, highest: null });

      await expect(svc.scan()).rejects.toThrow('nowhere to start');
    });
  });

  describe('start — one message of totals per run', () => {
    it('reports companies as a count, never one by one', async () => {
      const { svc, telegram } = build({
        frontier: S,
        answers: { [S + 1]: 'found', [S + 2]: 'found', [S + 3]: 'found' },
      });

      await (
        await svc.start({ missLimit: 1 }, SCHEDULED)
      ).done;

      expect(telegram.send).toHaveBeenCalledTimes(1);
      const text = alertText(telegram);
      expect(text).toContain('✅');
      expect(text).toContain(`Added to the database: <b>3</b>`);
      for (const s of [S + 1, S + 2, S + 3]) {
        expect(text).not.toContain(innFromSequence(s));
      }
    });

    it('reports a run with nothing new as information, not a warning', async () => {
      const { svc, telegram } = build({ frontier: S });

      await (
        await svc.start({ missLimit: 1 }, SCHEDULED)
      ).done;

      expect(telegram.send).toHaveBeenCalledTimes(1);
      const text = alertText(telegram);
      expect(text).toContain(`no new companies`);
      expect(text).not.toContain('⚠️');
    });

    it('names a run started by hand', async () => {
      const { svc, telegram } = build({ frontier: S });

      await (
        await svc.start({ missLimit: 1 }, `by hand`)
      ).done;

      expect(alertText(telegram)).toContain(`New companies (by hand)`);
    });

    it('reports a run that crashed', async () => {
      const { svc, telegram, db } = build({ frontier: S });
      db.query.mockRejectedValueOnce(new Error('connection lost'));

      await (
        await svc.start({}, SCHEDULED)
      ).done;

      expect(alertText(telegram)).toContain('connection lost');
    });

    it('lets a tick pass quietly while a run is still going', async () => {
      const { svc, telegram, release } = build({
        frontier: S,
        answers: { [S + 1]: 'hang' },
      });

      const first = await svc.start({ missLimit: 1 }, SCHEDULED);
      const second = await svc.start({}, SCHEDULED);

      expect(second.started).toBe(false);
      expect(telegram.send).not.toHaveBeenCalled();

      release();
      await first.done;
      // Only the run that actually ran reports.
      expect(telegram.send).toHaveBeenCalledTimes(1);
    });

    it('stays silent and walks nothing when another replica holds the lock', async () => {
      const { svc, telegram, mysoliq, runner } = build({
        frontier: S,
        locked: false,
      });

      const run = await svc.start({}, SCHEDULED);
      await run.done;

      expect(run.started).toBe(false);
      expect(mysoliq.findCompanyByTin).not.toHaveBeenCalled();
      expect(telegram.send).not.toHaveBeenCalled();
      expect(runner.release).toHaveBeenCalled();
    });

    it('releases the lock when the run is over', async () => {
      const { svc, runner } = build({ frontier: S });

      await (
        await svc.start({ missLimit: 1 }, SCHEDULED)
      ).done;

      expect(runner.query).toHaveBeenCalledWith(
        'SELECT pg_advisory_unlock($1)',
        expect.any(Array),
      );
      expect(runner.release).toHaveBeenCalled();
    });
  });

  describe('where the scheduled runs happen', () => {
    it('runs on both deployments, which set TG_WEBHOOK_URL', () => {
      expect(
        newCompanyScanEnabled({
          TG_WEBHOOK_URL: 'https://test.humora.uz/api/telegram/webhook',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
    });

    it('does not run on a laptop, where it is empty', () => {
      expect(newCompanyScanEnabled({} as NodeJS.ProcessEnv)).toBe(false);
    });

    it('can be forced on or off', () => {
      expect(
        newCompanyScanEnabled({
          NEW_COMPANY_SCAN_ENABLED: '1',
        } as NodeJS.ProcessEnv),
      ).toBe(true);
      expect(
        newCompanyScanEnabled({
          NEW_COMPANY_SCAN_ENABLED: '0',
          TG_WEBHOOK_URL: 'https://humora.uz/api/telegram/webhook',
        } as NodeJS.ProcessEnv),
      ).toBe(false);
    });

    it('leaves the database alone on a laptop cron tick', async () => {
      const before = {
        url: process.env.TG_WEBHOOK_URL,
        flag: process.env.NEW_COMPANY_SCAN_ENABLED,
      };
      delete process.env.TG_WEBHOOK_URL;
      delete process.env.NEW_COMPANY_SCAN_ENABLED;
      try {
        const { svc, db, telegram } = build({ frontier: S });
        await svc.scheduled();
        expect(db.createQueryRunner).not.toHaveBeenCalled();
        expect(telegram.send).not.toHaveBeenCalled();
      } finally {
        if (before.url !== undefined) process.env.TG_WEBHOOK_URL = before.url;
        if (before.flag !== undefined) {
          process.env.NEW_COMPANY_SCAN_ENABLED = before.flag;
        }
      }
    });
  });
});
