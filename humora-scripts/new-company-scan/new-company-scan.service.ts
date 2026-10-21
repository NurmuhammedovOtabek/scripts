import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import {
  MysoliqCompanyData,
  MysoliqDataService,
} from '../../mysoliq/mysoliq-data.service';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { listCompanyFromMysoliq } from './company-listing';
import {
  LEGAL_ENTITY_SEQUENCE,
  innFromSequence,
  sequenceOfInn,
} from './inn-sequence';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Held by the session, so a container killed mid-walk frees it by dropping. */
const LOCK_ID = 8_150_915;

/**
 * STIRs generated per range. One query says which of them are already held;
 * the rest go to mysoliq one at a time.
 */
const RANGE = 20;

/**
 * Unissued numbers in a row, past the last company found, that end a run. The
 * run stops where it is and the next one starts from the same place, so a
 * number not issued at noon is asked again at two.
 */
const MISS_LIMIT = 10;

/** Failures in a row that mean mysoliq or the table is broken, not unlucky. */
const ERROR_LIMIT = 10;

/** The trigger the cron passes; any other run is named in its report. */
const SCHEDULED = 'every 2 hours';

export interface ScanOptions {
  /** Walk from this STIR instead of the last company found — a backfill. */
  fromInn?: string;
  missLimit?: number;
  errorLimit?: number;
}

export interface ScanResult {
  /** First and last STIR the walk looked at. */
  startInn: string;
  endInn: string | null;
  frontierBefore: string;
  frontierAfter: string;
  checked: number;
  /** Already in company_info — not asked. */
  alreadyHeld: number;
  added: number;
  /** The STIRs actually listed, so contacts can be fetched for them at once. */
  addedInns: string[];
  /** mysoliq knows the STIR but gave no name, so there was nothing to list. */
  unnamed: number;
  /** mysoliq has no such taxpayer: a gap, or past the end of the counter. */
  missing: number;
  /** Lookups that failed and rows the table refused. */
  errors: number;
  lastError: string | null;
  /** Ended by ERROR_LIMIT rather than by reaching the end of the counter. */
  aborted: boolean;
}

/**
 * Whether the scheduled runs happen here.
 *
 * Not NODE_ENV: the scan is wanted on dev as well as prod, and dev does not run
 * as "production". `TG_WEBHOOK_URL` is set on both deployments and empty on a
 * laptop (see telegram.service.ts), which is exactly the line — a laptop cannot
 * reach mysoliq, whose proxy answers whitelisted addresses only.
 * `NEW_COMPANY_SCAN_ENABLED` overrides it either way.
 */
export function newCompanyScanEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NEW_COMPANY_SCAN_ENABLED === '1') return true;
  if (env.NEW_COMPANY_SCAN_ENABLED === '0') return false;
  return Boolean(env.TG_WEBHOOK_URL);
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

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes} min ${seconds} s` : `${seconds} s`;
}

/** "New companies", with a run that is not the scheduled one named. */
function title(trigger: string): string {
  return trigger === SCHEDULED
    ? 'New companies'
    : `New companies (${escapeHtml(trigger)})`;
}

/**
 * Finds companies registered since the last run and lists them, so a search by
 * name finds a company soon after it opens.
 *
 * Name search reads `company_info` only, and a company used to reach that table
 * when somebody opened it by STIR — which nobody does for a company they cannot
 * find. The STIR counter breaks the circle: new STIRs are the next numbers up,
 * so the scan walks them and asks mysoliq about each one it does not hold.
 *
 * Every two hours it continues from the last company found, twenty STIRs at a
 * time, and stops at the first ten unissued numbers in a row. It leaves the
 * frontier where it was, so the next run asks the same numbers again — by then
 * some of them have been issued. Anything older is a backfill, started by hand
 * with `fromInn`.
 *
 * It writes what mysoliq answers — the name and the fields that come with it —
 * and nothing more. Founders, ratings and the rest arrive through
 * `syncCompanyInfo` the first time the company is opened; filling a blank there
 * writes no history, so the partial row leaves no trace in the change log.
 *
 * Every run that holds the lock sends Telegram one message of totals, whether
 * it added companies or none: a quiet run and a broken one otherwise look alike.
 */
@Injectable()
export class NewCompanyScanService {
  private readonly logger = new Logger(NewCompanyScanService.name);
  private running = false;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly mysoliq: MysoliqDataService,
    private readonly telegram: TelegramAlertService,
  ) {}

  @Cron('0 */2 * * *', { timeZone: 'Asia/Tashkent' })
  async scheduled(): Promise<void> {
    if (!newCompanyScanEnabled()) {
      this.logger.log(
        '[new-company-scan] skipped — TG_WEBHOOK_URL is empty, so this is not ' +
          'a deployment (NEW_COMPANY_SCAN_ENABLED=1 runs it anyway)',
      );
      return;
    }
    const run = await this.start({}, SCHEDULED);
    await run.done;
  }

  /**
   * Takes the lock and starts a run. `done` settles when the run has reported.
   *
   * Returning before the walk finishes lets the admin endpoint answer at once —
   * a backfill can take hours — while the cron simply awaits `done`.
   */
  async start(
    options: ScanOptions,
    trigger: string,
  ): Promise<{ started: boolean; reason: string | null; done: Promise<void> }> {
    const idle = Promise.resolve();
    if (this.running) {
      // A backfill can outlast two hours; the tick that meets it just waits
      // for the next one.
      this.logger.log(
        '[new-company-scan] skipped — a scan is already running here',
      );
      return {
        started: false,
        reason: 'a scan is already running',
        done: idle,
      };
    }

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
      const message = (err as Error).message;
      await this.alert(
        `❌ <b>${title(trigger)} — not started</b>\n` +
          `<code>${escapeHtml(message)}</code>`,
      );
      return { started: false, reason: message, done: idle };
    }

    if (!locked) {
      // The replica holding the lock reports its own run.
      await runner.release().catch(() => undefined);
      this.logger.log(
        '[new-company-scan] skipped — another replica holds the lock',
      );
      return {
        started: false,
        reason: 'another replica is running the scan',
        done: idle,
      };
    }

    this.running = true;
    const done = this.execute(options, trigger).finally(async () => {
      this.running = false;
      await runner
        .query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
        .catch(() => undefined);
      await runner.release().catch(() => undefined);
    });
    return { started: true, reason: null, done };
  }

  private async execute(options: ScanOptions, trigger: string): Promise<void> {
    const startedAt = Date.now();
    try {
      const result = await this.scan(options);
      await this.announce(result, Date.now() - startedAt, trigger);
      // mysoliq publishes no phone or e-mail, so a company just listed has
      // none until registr.stat.uz is asked. That is the contact fill's job,
      // twice a day (07:30 and 19:30), not every two hours on the back of
      // this scan (user decision 2026-10-19) — stat.uz lists a new company a
      // day later anyway, and the fill's recheck asks the last three days.
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`[new-company-scan] failed: ${message}`);
      await this.alert(
        `❌ <b>${title(trigger)} — stopped with an error</b>\n` +
          `<code>${escapeHtml(message)}</code>`,
      );
    }
  }

  /** The walk itself. Public for the tests; runs go through `start`. */
  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const missLimit = options.missLimit ?? MISS_LIMIT;
    const errorLimit = options.errorLimit ?? ERROR_LIMIT;

    const fromSequence =
      options.fromInn === undefined ? null : sequenceOfInn(options.fromInn);
    if (options.fromInn !== undefined && fromSequence === null) {
      throw new Error(`fromInn is not a valid STIR: ${options.fromInn}`);
    }

    const known = (await this.readFrontier()) ?? (await this.highestHeldInn());
    if (known === null && fromSequence === null) {
      throw new Error(
        'nowhere to start: no frontier stored, no legal-entity STIR in ' +
          'company_info, and no fromInn given',
      );
    }

    let frontier =
      known !== null
        ? (sequenceOfInn(known) as number)
        : (fromSequence as number) - 1;
    const start = fromSequence ?? frontier + 1;

    const result: ScanResult = {
      startInn: innFromSequence(start),
      endInn: null,
      frontierBefore: innFromSequence(frontier),
      frontierAfter: innFromSequence(frontier),
      checked: 0,
      alreadyHeld: 0,
      added: 0,
      addedInns: [],
      unnamed: 0,
      missing: 0,
      errors: 0,
      lastError: null,
      aborted: false,
    };

    let misses = 0;
    let failures = 0;
    let stop = false;

    // A failed lookup or a refused row. Neither is a miss — counted as one, an
    // outage would end the run and read as a quiet one — and neither moves the
    // frontier, so the number is asked again unless a later company is found.
    // Ten in a row mean mysoliq or the table is broken, and the run stops.
    const failed = (err: unknown, context?: string): boolean => {
      result.errors++;
      result.lastError =
        `${context ? `${context}: ` : ''}${describeError(err)}`.slice(0, 200);
      failures++;
      if (failures < errorLimit) return false;
      result.aborted = true;
      return true;
    };

    for (
      let base = start;
      !stop && base <= LEGAL_ENTITY_SEQUENCE.last;
      base += RANGE
    ) {
      const range: number[] = [];
      for (
        let sequence = base;
        sequence < base + RANGE && sequence <= LEGAL_ENTITY_SEQUENCE.last;
        sequence++
      ) {
        range.push(sequence);
      }
      const held = await this.heldInns(range.map((s) => innFromSequence(s)));

      for (const sequence of range) {
        // Only misses past the frontier say anything about where the counter
        // ends; behind it — during a backfill — a miss is a gap in numbers
        // already issued.
        if (sequence > frontier && misses >= missLimit) {
          stop = true;
          break;
        }

        const inn = innFromSequence(sequence);
        result.checked++;
        result.endInn = inn;

        if (held.has(inn)) {
          result.alreadyHeld++;
          if (sequence > frontier) frontier = sequence;
          misses = 0;
          continue;
        }

        let company: MysoliqCompanyData | null;
        try {
          company = await this.mysoliq.findCompanyByTin(inn);
        } catch (err) {
          if (failed(err)) {
            stop = true;
            break;
          }
          continue;
        }

        if (!company) {
          failures = 0;
          result.missing++;
          if (sequence > frontier) misses++;
          continue;
        }

        if (!company.company_name) {
          // Search matches on the name; a row without one would never be found.
          failures = 0;
          result.unnamed++;
          if (sequence > frontier) frontier = sequence;
          misses = 0;
          continue;
        }

        let inserted: boolean;
        try {
          inserted = await this.insert(inn, company);
        } catch (err) {
          if (failed(err, inn)) {
            stop = true;
            break;
          }
          continue;
        }

        failures = 0;
        if (sequence > frontier) frontier = sequence;
        misses = 0;
        if (inserted) {
          result.added++;
          result.addedInns.push(inn);
        } else result.alreadyHeld++;
      }
    }

    result.frontierAfter = innFromSequence(frontier);
    await this.saveRun(result);
    this.logger.log(
      `[new-company-scan] ${result.added} added · ${result.alreadyHeld} held · ` +
        `${result.missing} not issued · ${result.errors} failed · ` +
        `${result.checked} checked (${result.startInn} → ${result.endInn ?? '—'}) · ` +
        `frontier ${result.frontierBefore} → ${result.frontierAfter}`,
    );
    return result;
  }

  async status(): Promise<Record<string, unknown>> {
    const [row] = await this.db.query(
      `SELECT frontier_inn, last_run_at, last_run
         FROM public.new_company_scan_cursor
        WHERE id = 1`,
    );
    return {
      running_here: this.running,
      frontier_inn: row?.frontier_inn ?? null,
      last_run_at: row?.last_run_at ?? null,
      last_run: row?.last_run ?? null,
    };
  }

  /**
   * Lists a company with what mysoliq said about it — the insert the STIR lookup
   * behind the search box shares (company-listing.ts). The advisory lock means
   * only a page view could race it, within one statement.
   */
  private insert(inn: string, company: MysoliqCompanyData): Promise<boolean> {
    return listCompanyFromMysoliq(this.db, inn, company);
  }

  private async heldInns(inns: string[]): Promise<Set<string>> {
    const rows: Array<{ inn: string }> = await this.db.query(
      `SELECT inn FROM public.company_info WHERE inn = ANY($1::text[])`,
      [inns],
    );
    return new Set(rows.map((row) => row.inn));
  }

  private async readFrontier(): Promise<string | null> {
    const [row] = await this.db.query(
      `SELECT frontier_inn FROM public.new_company_scan_cursor WHERE id = 1`,
    );
    const inn: string | null = row?.frontier_inn ?? null;
    return sequenceOfInn(inn) === null ? null : inn;
  }

  /**
   * The first run's starting point: the newest legal entity already held.
   *
   * Recent registrations are asked first. The register holds the odd malformed
   * STIR, and one that happens to carry a valid check digit above the counter
   * would put the start past every real number — scheduled runs would find
   * nothing, and a backfill would walk on to the end of the range. A company
   * registered in the last few months is a real number near the frontier.
   */
  private async highestHeldInn(): Promise<string | null> {
    const firstValid = (rows: Array<{ inn: string }>) =>
      rows.map((row) => row.inn).find((inn) => sequenceOfInn(inn) !== null) ??
      null;

    const recent: Array<{ inn: string }> = await this.db.query(
      `SELECT inn FROM public.company_info
        WHERE inn ~ $1
          AND registration_date >= now() - interval '90 days'
        ORDER BY inn DESC
        LIMIT 20`,
      ['^3[0-9]{8}$'],
    );
    const fromRecent = firstValid(recent);
    if (fromRecent) return fromRecent;

    const rows: Array<{ inn: string }> = await this.db.query(
      `SELECT inn FROM public.company_info
        WHERE inn ~ $1
        ORDER BY inn DESC
        LIMIT 20`,
      ['^3[0-9]{8}$'],
    );
    return firstValid(rows);
  }

  private async saveRun(result: ScanResult): Promise<void> {
    await this.db.query(
      `INSERT INTO public.new_company_scan_cursor
         (id, frontier_inn, last_run_at, last_run, updated_at)
       VALUES (1, $1, now(), $2::jsonb, now())
       ON CONFLICT (id) DO UPDATE
          SET frontier_inn = EXCLUDED.frontier_inn,
              last_run_at  = EXCLUDED.last_run_at,
              last_run     = EXCLUDED.last_run,
              updated_at   = now()`,
      [result.frontierAfter, JSON.stringify(result)],
    );
  }

  /**
   * One message of totals per run — never a line per company. The numbers
   * behind it (the STIR range, the frontier) stay in the log and in
   * `new_company_scan_cursor.last_run`.
   *
   * A run with nothing new is not a warning: at night and at weekends that is
   * most of them.
   */
  private async announce(
    result: ScanResult,
    elapsedMs: number,
    trigger: string,
  ): Promise<void> {
    let head = `✅ <b>${title(trigger)}</b>`;
    let note = '';
    if (result.aborted) {
      head = `❌ <b>${title(trigger)} — mysoliq or the database did not answer</b>`;
      note = `\n<i>The next run continues from here.</i>`;
    } else if (result.errors > 0) {
      head = `⚠️ <b>${title(trigger)} — with errors</b>`;
    } else if (result.added === 0) {
      head = `ℹ️ <b>${title(trigger)} — no new companies</b>`;
    }

    const lines = [
      head,
      `Added to the database: <b>${result.added}</b>`,
      `Checked: ${result.checked} STIRs (not found: ${result.missing}, errors: ${result.errors})`,
      ...(result.lastError
        ? [`Last error: <code>${escapeHtml(result.lastError)}</code>`]
        : []),
      `Time: ${formatDuration(elapsedMs)}`,
    ];
    await this.alert(lines.join('\n') + note);
  }

  /** Never let a missing bot token turn into a failed run. */
  private async alert(text: string): Promise<void> {
    try {
      await this.telegram.send(text, { tag: 'new_companies' });
    } catch (err) {
      this.logger.warn(
        `[new-company-scan] alert not sent: ${(err as Error).message}`,
      );
    }
  }
}
