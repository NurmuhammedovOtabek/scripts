import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  MysoliqCompanyData,
  MysoliqDataService,
} from '../../mysoliq/mysoliq-data.service';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { returnedRows } from '../contact-fill/contact-fill.service';
import { listCompanyFromMysoliq } from './company-listing';
import { innFromSequence, sequenceOfInn } from './inn-sequence';
import { newCompanyScanEnabled } from './new-company-scan.service';

/** Its own lock, so the two-hourly scan keeps listing today's companies. */
const LOCK_ID = 8_151_005;

/**
 * Numbers per chunk. One query says which of them are held, the rest go to
 * mysoliq, and the chunk's end is where a restart picks up — so a restart
 * repeats at most this many numbers, and the held ones cost nothing.
 */
const CHUNK = 200;

/** Failures in a row (across the workers) that mean mysoliq is down. */
const ERROR_LIMIT = 15;

export const MAX_CONCURRENCY = 5;
const DEFAULT_CONCURRENCY = 2;

/** Telegram gets a progress line this often; the log gets one per chunk. */
const PROGRESS_EVERY_MS = 30 * 60_000;

/** Used for the plan's estimate until a run has measured mysoliq itself. */
const ASSUMED_LOOKUP_MS = 600;

/**
 * The month whose last company the walk starts from when none is given.
 *
 * March, not April: on prod (2026-10-05) January–March hold 7.3k–8k companies
 * each and April 489, so April itself is the start of the gap.
 */
export const DEFAULT_AFTER_MONTH = '2026-03';

/** How long after boot an interrupted run is picked up again. */
const AUTO_RESUME_DELAY_MS = 60_000;

/** A run in one of these may be continued. */
const UNFINISHED = ['running', 'stopped', 'aborted', 'failed'];

export interface BackfillOptions {
  /** Start here instead of after the last company of `afterMonth`. */
  fromInn?: string;
  /** End here instead of at the scan's frontier. */
  toInn?: string;
  /** YYYY-MM; the walk starts at the newest held STIR registered that month. */
  afterMonth?: string;
  /** Parallel mysoliq lookups, 1..MAX_CONCURRENCY. */
  concurrency?: number;
  /** Start a new run even when an unfinished one could be continued. */
  fresh?: boolean;
  errorLimit?: number;
  /** Walk only this many numbers from the start — a trial run. */
  limit?: number;
}

export interface BackfillTotals {
  /** Numbers walked, held or not. */
  checked: number;
  /** Already in company_info — not asked. */
  held: number;
  /** Sent to mysoliq. */
  asked: number;
  added: number;
  /** Listed by someone else between our check and our insert. */
  raced: number;
  /** mysoliq has no such taxpayer — a gap in the counter. */
  missing: number;
  /** mysoliq knows the STIR but gave no name, so nothing was listed. */
  unnamed: number;
  /** Failed lookups and refused rows, retries included. */
  errors: number;
  /** Lookups mysoliq answered (found or not). */
  answered: number;
  /** Summed wall time of the answered lookups, for the average. */
  lookupMs: number;
}

interface RunRow {
  id: number;
  from_inn: string;
  to_inn: string;
  next_inn: string | null;
  status: string;
  concurrency: number;
  stop_requested: boolean;
  totals: Partial<BackfillTotals>;
  failed_inns: string[];
  last_error: string | null;
  trigger: string | null;
  started_at: Date;
  updated_at: Date;
  finished_at: Date | null;
}

export interface BackfillRange {
  fromInn: string;
  toInn: string;
  /** Where the bounds came from, for the report. */
  fromSource: string;
  toSource: string;
}

export interface BackfillPlan extends BackfillRange {
  numbers: number;
  held: number;
  toAsk: number;
  lookupMs: number;
  lookupMsMeasured: boolean;
  estimate: Record<string, string>;
}

class BackfillAborted extends Error {}

const emptyTotals = (): BackfillTotals => ({
  checked: 0,
  held: 0,
  asked: 0,
  added: 0,
  raced: 0,
  missing: 0,
  unnamed: 0,
  errors: 0,
  answered: 0,
  lookupMs: 0,
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function describeError(err: unknown): string {
  const e = err as {
    getStatus?: () => number;
    getResponse?: () => unknown;
    message?: string;
  };
  if (typeof e?.getStatus === 'function') {
    const body =
      typeof e.getResponse === 'function'
        ? JSON.stringify(e.getResponse())
        : '';
    return `HTTP ${e.getStatus()} ${body}`.slice(0, 200);
  }
  return String(e?.message ?? err).slice(0, 200);
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours ? `${hours} h ${rest} min` : `${rest} min`;
}

const n = (value: number) => value.toLocaleString('en-US');

/**
 * Fills a stretch of the STIR counter the two-hourly scan never walked.
 *
 * The scan (new-company-scan.service.ts) went live in September and only walks
 * forward from its frontier. Companies registered before that reached
 * `company_info` only when someone opened them, so from April — when the
 * register stopped arriving in bulk — to the scan's start most of them are
 * missing, and a search by name does not find them.
 *
 * The walk: from the newest STIR held for a month (April by default) to the
 * scan's frontier, every number in turn. A number already held is skipped; any
 * other is asked from mysoliq and, when it names a company, listed with the
 * same insert the scan uses. A miss is a gap in the counter, nothing more —
 * this range is all issued, so misses never end the walk.
 *
 * Long by nature (tens of thousands of numbers), so it:
 *  - runs under its own advisory lock, beside the scan, never instead of it;
 *  - saves where it is after every chunk, and a start with no `fromInn`
 *    continues an unfinished run instead of beginning again;
 *  - stops between chunks when asked (from any replica, through the row);
 *  - treats ERROR_LIMIT failures in a row as an outage and stops with an
 *    alert; numbers that fail alone are asked again at the chunk's end and
 *    once more at the end of the walk;
 *  - reports to Telegram at the start, every half hour, and at the end.
 *
 * Contacts are not fetched here: at stat.uz's pace the fill would take days
 * and hold its own lock all that time. The contact fill's rolling window
 * reaches these companies on its own.
 */
@Injectable()
export class NewCompanyBackfillService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(NewCompanyBackfillService.name);
  private running = false;
  private resumeTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly mysoliq: MysoliqDataService,
    private readonly telegram: TelegramAlertService,
  ) {}

  /** Where a run with these options would walk — no lookups. */
  async resolveRange(options: BackfillOptions): Promise<BackfillRange> {
    let fromInn = options.fromInn ?? null;
    let fromSource = 'given';
    if (!fromInn) {
      const month = options.afterMonth ?? DEFAULT_AFTER_MONTH;
      fromInn = await this.lastInnOfMonth(month);
      fromSource = `last company registered in ${month}`;
      if (!fromInn) {
        throw new Error(
          `no legal-entity STIR registered in ${month} is held — give fromInn`,
        );
      }
    }

    let toInn = options.toInn ?? null;
    let toSource = 'given';
    if (!toInn) {
      toInn = await this.scanFrontier();
      toSource = 'new-company scan frontier';
      if (!toInn) {
        throw new Error(
          'the new-company scan has no frontier yet — give toInn',
        );
      }
    }

    const from = sequenceOfInn(fromInn);
    const to = sequenceOfInn(toInn);
    if (from === null) throw new Error(`not a valid STIR: ${fromInn}`);
    if (to === null) throw new Error(`not a valid STIR: ${toInn}`);
    if (from >= to) {
      throw new Error(`nothing to walk: ${fromInn} is not below ${toInn}`);
    }
    if (options.limit !== undefined && from + options.limit - 1 < to) {
      toInn = innFromSequence(from + options.limit - 1);
      toSource = `trial: first ${options.limit} numbers`;
    }
    return { fromInn, toInn, fromSource, toSource };
  }

  /**
   * A deploy or a crash in the middle of a walk leaves its row "running" with
   * nobody holding the lock. A minute after boot — every replica tries, the
   * lock lets one through — such a run is continued. A run stopped on request
   * or by an outage is not: that one waits for a person.
   */
  onApplicationBootstrap(): void {
    if (!newCompanyScanEnabled()) return;
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null;
      void this.resumeInterrupted();
    }, AUTO_RESUME_DELAY_MS);
    this.resumeTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.resumeTimer) clearTimeout(this.resumeTimer);
  }

  /** Public for the tests. */
  async resumeInterrupted(): Promise<boolean> {
    try {
      const [row] = await this.db.query(
        `SELECT id, status FROM public.new_company_backfill_run
          ORDER BY id DESC LIMIT 1`,
      );
      if (row?.status !== 'running') return false;
      const run = await this.start({}, 'auto-resume after restart');
      if (run.started) {
        this.logger.log(
          `[new-company-backfill] run ${run.runId} resumed after a restart`,
        );
      }
      return run.started;
    } catch (err) {
      this.logger.warn(
        `[new-company-backfill] auto-resume check failed: ${(err as Error).message}`,
      );
      return false;
    }
  }

  /**
   * How much a run would do and roughly how long it would take, from one
   * query — nothing is asked from mysoliq.
   */
  async plan(options: BackfillOptions): Promise<BackfillPlan> {
    const range = await this.resolveRange(options);
    const from = sequenceOfInn(range.fromInn) as number;
    const to = sequenceOfInn(range.toInn) as number;
    const numbers = to - from + 1;
    const held = await this.heldCount(range.fromInn, range.toInn);
    const toAsk = Math.max(0, numbers - held);

    const measured = await this.measuredLookupMs();
    const lookupMs = measured ?? ASSUMED_LOOKUP_MS;
    const estimate: Record<string, string> = {};
    for (const c of [1, 2, 3, MAX_CONCURRENCY]) {
      estimate[`concurrency_${c}`] = formatDuration((toAsk * lookupMs) / c);
    }
    return {
      ...range,
      numbers,
      held,
      toAsk,
      lookupMs,
      lookupMsMeasured: measured !== null,
      estimate,
    };
  }

  /**
   * Takes the lock and starts (or continues) a run; `done` settles when the
   * run has reported. Returns at once — the endpoint must not wait hours.
   */
  async start(
    options: BackfillOptions,
    trigger: string,
  ): Promise<{
    started: boolean;
    reason: string | null;
    runId: number | null;
    resumed: boolean;
    range: { fromInn: string; nextInn: string; toInn: string } | null;
    done: Promise<void>;
  }> {
    const idle = Promise.resolve();
    const refuse = (reason: string) => ({
      started: false,
      reason,
      runId: null,
      resumed: false,
      range: null,
      done: idle,
    });
    if (this.running) return refuse('a backfill is already running here');

    const runner = this.db.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const rows = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [LOCK_ID],
      );
      locked = rows?.[0]?.locked === true;
    } catch (err) {
      await runner.release().catch(() => undefined);
      return refuse(`could not take the lock: ${(err as Error).message}`);
    }
    if (!locked) {
      await runner.release().catch(() => undefined);
      return refuse('another replica is running a backfill');
    }

    const unlock = async () => {
      await runner
        .query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
        .catch(() => undefined);
      await runner.release().catch(() => undefined);
    };

    let run: RunRow;
    let resumed = false;
    try {
      const concurrency = Math.min(
        MAX_CONCURRENCY,
        Math.max(1, Math.floor(options.concurrency ?? DEFAULT_CONCURRENCY)),
      );
      const explicit = Boolean(
        options.fromInn || options.toInn || options.limit !== undefined,
      );
      const previous =
        options.fresh || explicit ? null : await this.unfinishedRun();
      if (previous) {
        // We hold the lock, so a row still saying "running" is a walk whose
        // container went away mid-run.
        resumed = true;
        run = await this.updateRun(previous.id, {
          status: 'running',
          stop_requested: false,
          concurrency,
          finished_at: null,
        });
      } else {
        const range = await this.resolveRange(options);
        run = await this.createRun(range, concurrency, trigger);
      }
    } catch (err) {
      await unlock();
      const message = (err as Error).message;
      this.logger.error(`[new-company-backfill] not started: ${message}`);
      return refuse(message);
    }

    this.running = true;
    const done = this.execute(
      run,
      resumed,
      trigger,
      options.errorLimit,
    ).finally(async () => {
      this.running = false;
      await unlock();
    });
    return {
      started: true,
      reason: null,
      runId: run.id,
      resumed,
      range: {
        fromInn: run.from_inn,
        nextInn: run.next_inn ?? run.from_inn,
        toInn: run.to_inn,
      },
      done,
    };
  }

  /** Asks the running walk to stop after its current chunk. */
  async requestStop(): Promise<{ requested: boolean; runId: number | null }> {
    // An UPDATE answers [rows, count] — see CLAUDE.md.
    const rows = returnedRows<{ id: number }>(
      await this.db.query(
        `UPDATE public.new_company_backfill_run
            SET stop_requested = true, updated_at = now()
          WHERE status = 'running'
          RETURNING id`,
      ),
    );
    const id = rows[0]?.id ?? null;
    if (id !== null) {
      this.logger.log(`[new-company-backfill] stop requested for run ${id}`);
    }
    return { requested: id !== null, runId: id };
  }

  async status(): Promise<Record<string, unknown>> {
    const [row]: RunRow[] = await this.db.query(
      `SELECT * FROM public.new_company_backfill_run ORDER BY id DESC LIMIT 1`,
    );
    const [lock] = await this.db.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 0 AND objid = $1
            AND objsubid = 1 AND granted
       ) AS held`,
      [LOCK_ID],
    );
    const active = lock?.held === true;
    if (!row) return { active, running_here: this.running, run: null };

    const totals = { ...emptyTotals(), ...row.totals };
    const from = sequenceOfInn(row.from_inn) as number;
    const to = sequenceOfInn(row.to_inn) as number;
    const next = sequenceOfInn(row.next_inn) ?? from;
    const total = to - from + 1;
    const done = Math.min(total, Math.max(0, next - from));
    return {
      active,
      running_here: this.running,
      // "running" in the row while nobody holds the lock: the container went
      // away mid-walk. POST /run continues it.
      stale: row.status === 'running' && !active,
      run: {
        ...row,
        totals,
        failed_inns_count: row.failed_inns.length,
        failed_inns: row.failed_inns.slice(0, 50),
        progress_percent: total ? Math.floor((done / total) * 1000) / 10 : 100,
        avg_lookup_ms: totals.answered
          ? Math.round(totals.lookupMs / totals.answered)
          : null,
      },
    };
  }

  private async execute(
    run: RunRow,
    resumed: boolean,
    trigger: string,
    errorLimit = ERROR_LIMIT,
  ): Promise<void> {
    const startedAt = Date.now();
    const totals: BackfillTotals = { ...emptyTotals(), ...run.totals };
    const failedInns = new Set<string>(run.failed_inns ?? []);
    const from = sequenceOfInn(run.from_inn) as number;
    const to = sequenceOfInn(run.to_inn) as number;
    let next = sequenceOfInn(run.next_inn) ?? from;
    const startNext = next;
    let lastError: string | null = run.last_error;
    let lastProgressAt = Date.now();

    const head = `run ${run.id} ${run.from_inn} → ${run.to_inn}`;
    this.logger.log(
      `[new-company-backfill] ${resumed ? 'resumed' : 'started'} ${head} ` +
        `at ${innFromSequence(next)} · concurrency ${run.concurrency} · ${trigger}`,
    );

    try {
      const toAskEstimate = resumed
        ? null
        : Math.max(
            0,
            to - from + 1 - (await this.heldCount(run.from_inn, run.to_inn)),
          );
      await this.alert(
        [
          `🔎 <b>New-company backfill ${resumed ? 'resumed' : 'started'}</b> (run ${run.id})`,
          `Range: ${run.from_inn} → ${run.to_inn} (${n(to - from + 1)} numbers)`,
          ...(resumed
            ? [`Continuing at ${innFromSequence(next)}`]
            : [
                `To ask mysoliq: ~${n(toAskEstimate ?? 0)} (the rest are held)`,
              ]),
          `Concurrency: ${run.concurrency} · trigger: ${escapeHtml(trigger)}`,
        ].join('\n'),
      );

      const lookup = new Lookup(
        this.db,
        this.mysoliq,
        totals,
        errorLimit,
        (message) => (lastError = message),
      );

      let stopped = false;
      while (next <= to) {
        if (await this.stopRequested(run.id)) {
          stopped = true;
          break;
        }
        const end = Math.min(to, next + CHUNK - 1);
        const inns: string[] = [];
        for (let s = next; s <= end; s++) inns.push(innFromSequence(s));

        const held = await this.heldInns(inns);
        totals.checked += inns.length;
        totals.held += held.size;
        const toAsk = inns.filter((inn) => !held.has(inn));

        let failed: string[];
        try {
          failed = await lookup.all(toAsk, run.concurrency);
          // One more go, alone, for whatever failed amid the others.
          if (failed.length) failed = await lookup.all(failed, 1);
        } catch (err) {
          if (!(err instanceof BackfillAborted)) throw err;
          // The chunk is repeated on resume; its held numbers cost nothing.
          totals.checked -= inns.length;
          totals.held -= held.size;
          await this.saveProgress(run.id, next, totals, failedInns, lastError);
          await this.finish(run.id, 'aborted', lastError);
          this.logger.error(
            `[new-company-backfill] aborted ${head} at ${innFromSequence(next)}: ` +
              `${errorLimit} failures in a row — ${lastError}`,
          );
          await this.alert(
            [
              `❌ <b>New-company backfill stopped — mysoliq is not answering</b> (run ${run.id})`,
              `${errorLimit} lookups failed in a row at ${innFromSequence(next)}.`,
              `Last error: <code>${escapeHtml(lastError ?? '—')}</code>`,
              this.totalsLine(totals),
              `<i>POST /new-company-scan/backfill/run continues from here.</i>`,
            ].join('\n'),
          );
          return;
        }
        for (const inn of failed) failedInns.add(inn);

        next = end + 1;
        await this.saveProgress(run.id, next, totals, failedInns, lastError);

        const done = next - from;
        const total = to - from + 1;
        const walkedHere = next - startNext;
        const etaMs =
          walkedHere > 0
            ? ((Date.now() - startedAt) / walkedHere) * (to - next + 1)
            : 0;
        this.logger.log(
          `[new-company-backfill] ${head} · ${((done / total) * 100).toFixed(1)}% ` +
            `· at ${innFromSequence(end)} · added ${totals.added} · held ${totals.held} ` +
            `· missing ${totals.missing} · unnamed ${totals.unnamed} · errors ${totals.errors} ` +
            `· failed ${failedInns.size} · eta ${formatDuration(etaMs)}`,
        );
        if (Date.now() - lastProgressAt >= PROGRESS_EVERY_MS && next <= to) {
          lastProgressAt = Date.now();
          await this.alert(
            [
              `⏳ <b>New-company backfill — ${Math.floor((done / total) * 100)}%</b> (run ${run.id})`,
              `Walked ${n(done)} / ${n(total)} · now at ${innFromSequence(end)}`,
              this.totalsLine(totals),
              `ETA: ~${formatDuration(etaMs)}`,
            ].join('\n'),
          );
        }
      }

      if (stopped) {
        await this.finish(run.id, 'stopped', lastError);
        this.logger.log(
          `[new-company-backfill] stopped on request ${head} at ${innFromSequence(next)}`,
        );
        await this.alert(
          [
            `⏹ <b>New-company backfill stopped on request</b> (run ${run.id})`,
            `Stopped at ${innFromSequence(Math.min(next, to))}`,
            this.totalsLine(totals),
            `<i>POST /new-company-scan/backfill/run continues from here.</i>`,
          ].join('\n'),
        );
        return;
      }

      // Last call for the numbers that failed alone along the way.
      if (failedInns.size) {
        this.logger.log(
          `[new-company-backfill] retrying ${failedInns.size} failed numbers`,
        );
        let still: string[] = [];
        try {
          still = await lookup.all([...failedInns], 1);
        } catch (err) {
          if (!(err instanceof BackfillAborted)) throw err;
          still = [...failedInns];
        }
        failedInns.clear();
        for (const inn of still) failedInns.add(inn);
        await this.saveProgress(run.id, next, totals, failedInns, lastError);
      }

      await this.finish(run.id, 'done', lastError);
      const elapsed = Date.now() - startedAt;
      this.logger.log(
        `[new-company-backfill] done ${head} in ${formatDuration(elapsed)} · ` +
          `added ${totals.added} · held ${totals.held} · missing ${totals.missing} ` +
          `· unnamed ${totals.unnamed} · errors ${totals.errors} · unanswered ${failedInns.size}`,
      );
      const icon = failedInns.size ? '⚠️' : '✅';
      await this.alert(
        [
          `${icon} <b>New-company backfill finished</b> (run ${run.id})`,
          `Range: ${run.from_inn} → ${run.to_inn}`,
          `Added to the database: <b>${n(totals.added)}</b>`,
          this.totalsLine(totals),
          ...(failedInns.size
            ? [
                `Never answered: ${n(failedInns.size)} (listed in GET /new-company-scan/backfill/status)`,
              ]
            : []),
          ...(lastError
            ? [`Last error: <code>${escapeHtml(lastError)}</code>`]
            : []),
          `Time: ${formatDuration(elapsed)}`,
        ].join('\n'),
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`[new-company-backfill] crashed ${head}: ${message}`);
      await this.saveProgress(run.id, next, totals, failedInns, message).catch(
        () => undefined,
      );
      await this.finish(run.id, 'failed', message).catch(() => undefined);
      await this.alert(
        [
          `❌ <b>New-company backfill crashed</b> (run ${run.id})`,
          `At ${innFromSequence(Math.min(next, to))}`,
          `<code>${escapeHtml(message.slice(0, 300))}</code>`,
          `<i>POST /new-company-scan/backfill/run continues from here.</i>`,
        ].join('\n'),
      );
    }
  }

  private totalsLine(t: BackfillTotals): string {
    const avg = t.answered
      ? ` · avg ${Math.round(t.lookupMs / t.answered)} ms`
      : '';
    return (
      `Added ${n(t.added)} · already held ${n(t.held)} · not issued ${n(t.missing)} ` +
      `· no name ${n(t.unnamed)} · errors ${n(t.errors)} · asked ${n(t.asked)}${avg}`
    );
  }

  /**
   * The newest valid legal-entity STIR registered in `month`. Several are
   * read and the first with a right check digit wins: the register holds the
   * odd malformed STIR, and one of those would start the walk in the wrong
   * place.
   */
  private async lastInnOfMonth(month: string): Promise<string | null> {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new Error(`afterMonth must be YYYY-MM: ${month}`);
    }
    const rows: Array<{ inn: string }> = await this.db.query(
      `SELECT inn FROM public.company_info
        WHERE inn ~ '^3[0-9]{8}$'
          AND registration_date >= ($1 || '-01')::date
          AND registration_date <  ($1 || '-01')::date + interval '1 month'
        ORDER BY inn DESC
        LIMIT 50`,
      [month],
    );
    return (
      rows.map((r) => r.inn).find((inn) => sequenceOfInn(inn) !== null) ?? null
    );
  }

  private async scanFrontier(): Promise<string | null> {
    const [row] = await this.db.query(
      `SELECT frontier_inn FROM public.new_company_scan_cursor WHERE id = 1`,
    );
    const inn: string | null = row?.frontier_inn ?? null;
    return sequenceOfInn(inn) === null ? null : inn;
  }

  /** Held STIRs in the range that are real counter numbers. */
  private async heldCount(fromInn: string, toInn: string): Promise<number> {
    const rows: Array<{ inn: string }> = await this.db.query(
      `SELECT DISTINCT inn FROM public.company_info
        WHERE inn BETWEEN $1 AND $2 AND inn ~ '^3[0-9]{8}$'`,
      [fromInn, toInn],
    );
    return rows.filter((r) => sequenceOfInn(r.inn) !== null).length;
  }

  private async heldInns(inns: string[]): Promise<Set<string>> {
    const rows: Array<{ inn: string }> = await this.db.query(
      `SELECT inn FROM public.company_info WHERE inn = ANY($1::text[])`,
      [inns],
    );
    return new Set(rows.map((row) => row.inn));
  }

  /** Average lookup time of the latest run that asked anything. */
  private async measuredLookupMs(): Promise<number | null> {
    const [row] = await this.db.query(
      `SELECT totals FROM public.new_company_backfill_run
        WHERE COALESCE((totals->>'answered')::int, 0) > 0
        ORDER BY id DESC LIMIT 1`,
    );
    const t = row?.totals as Partial<BackfillTotals> | undefined;
    return t?.answered && t.lookupMs
      ? Math.round(t.lookupMs / t.answered)
      : null;
  }

  private async unfinishedRun(): Promise<RunRow | null> {
    const [row]: RunRow[] = await this.db.query(
      `SELECT * FROM public.new_company_backfill_run
        WHERE status = ANY($1::text[])
        ORDER BY id DESC LIMIT 1`,
      [UNFINISHED],
    );
    return row ?? null;
  }

  private async createRun(
    range: BackfillRange,
    concurrency: number,
    trigger: string,
  ): Promise<RunRow> {
    // Only one run is ever continued: a new one closes the old.
    await this.db.query(
      `UPDATE public.new_company_backfill_run
          SET status = 'superseded', updated_at = now(), finished_at = now()
        WHERE status = ANY($1::text[])`,
      [UNFINISHED],
    );
    const [row]: RunRow[] = await this.db.query(
      `INSERT INTO public.new_company_backfill_run
         (from_inn, to_inn, next_inn, status, concurrency, totals, trigger)
       VALUES ($1, $2, $1, 'running', $3, $4::jsonb, $5)
       RETURNING *`,
      [
        range.fromInn,
        range.toInn,
        concurrency,
        JSON.stringify(emptyTotals()),
        `${trigger} · from: ${range.fromSource} · to: ${range.toSource}`,
      ],
    );
    return row;
  }

  private async updateRun(
    id: number,
    fields: Partial<
      Pick<RunRow, 'status' | 'stop_requested' | 'concurrency' | 'finished_at'>
    >,
  ): Promise<RunRow> {
    const [row] = returnedRows<RunRow>(
      await this.db.query(
        `UPDATE public.new_company_backfill_run
          SET status = COALESCE($2, status),
              stop_requested = COALESCE($3, stop_requested),
              concurrency = COALESCE($4, concurrency),
              finished_at = $5,
              updated_at = now()
        WHERE id = $1
        RETURNING *`,
        [
          id,
          fields.status ?? null,
          fields.stop_requested ?? null,
          fields.concurrency ?? null,
          fields.finished_at ?? null,
        ],
      ),
    );
    return row;
  }

  private async saveProgress(
    id: number,
    nextSequence: number,
    totals: BackfillTotals,
    failedInns: Set<string>,
    lastError: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE public.new_company_backfill_run
          SET next_inn = $2, totals = $3::jsonb, failed_inns = $4::text[],
              last_error = $5, updated_at = now()
        WHERE id = $1`,
      [
        id,
        nextSequence <= 99_999_999 ? innFromSequence(nextSequence) : null,
        JSON.stringify(totals),
        [...failedInns],
        lastError,
      ],
    );
  }

  private async stopRequested(id: number): Promise<boolean> {
    const [row] = await this.db.query(
      `SELECT stop_requested FROM public.new_company_backfill_run WHERE id = $1`,
      [id],
    );
    return row?.stop_requested === true;
  }

  private async finish(
    id: number,
    status: string,
    lastError: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE public.new_company_backfill_run
          SET status = $2, last_error = $3, stop_requested = false,
              finished_at = now(), updated_at = now()
        WHERE id = $1`,
      [id, status, lastError],
    );
  }

  /** Never let a missing bot token turn into a failed run. */
  private async alert(text: string): Promise<void> {
    try {
      await this.telegram.send(text, { tag: 'newco_backfill' });
    } catch (err) {
      this.logger.warn(
        `[new-company-backfill] alert not sent: ${(err as Error).message}`,
      );
    }
  }
}

/**
 * Asks mysoliq about a list of STIRs with a few workers and lists every
 * company it names. Answers the STIRs that failed; throws BackfillAborted when
 * `errorLimit` failures come in a row, which is an outage, not bad luck.
 */
class Lookup {
  private failuresInRow = 0;

  constructor(
    private readonly db: DataSource,
    private readonly mysoliq: MysoliqDataService,
    private readonly totals: BackfillTotals,
    private readonly errorLimit: number,
    private readonly onError: (message: string) => void,
  ) {}

  async all(inns: string[], concurrency: number): Promise<string[]> {
    const failed: string[] = [];
    let index = 0;
    let aborted = false;
    const worker = async () => {
      while (!aborted && index < inns.length) {
        const inn = inns[index++];
        const ok = await this.one(inn);
        if (ok) continue;
        failed.push(inn);
        if (this.failuresInRow >= this.errorLimit) aborted = true;
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, inns.length) }, worker),
    );
    if (aborted) throw new BackfillAborted();
    return failed;
  }

  /** False when the lookup failed or the row was refused. */
  private async one(inn: string): Promise<boolean> {
    this.totals.asked++;
    const began = Date.now();
    let company: MysoliqCompanyData | null;
    try {
      company = await this.mysoliq.findCompanyByTin(inn);
    } catch (err) {
      // Not timed: a 15 s timeout would make every estimate after it wrong.
      return this.failed(err, inn);
    }
    this.totals.answered++;
    this.totals.lookupMs += Date.now() - began;

    if (!company) {
      this.failuresInRow = 0;
      this.totals.missing++;
      return true;
    }
    if (!company.company_name) {
      // Search matches on the name; a row without one would never be found.
      this.failuresInRow = 0;
      this.totals.unnamed++;
      return true;
    }
    try {
      const inserted = await listCompanyFromMysoliq(this.db, inn, company);
      if (inserted) this.totals.added++;
      else this.totals.raced++;
    } catch (err) {
      return this.failed(err, `${inn} insert`);
    }
    this.failuresInRow = 0;
    return true;
  }

  private failed(err: unknown, context: string): boolean {
    this.totals.errors++;
    this.failuresInRow++;
    this.onError(`${context}: ${describeError(err)}`.slice(0, 200));
    return false;
  }
}
