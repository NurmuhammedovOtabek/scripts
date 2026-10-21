import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { MysoliqService } from '../../mysoliq/mysoliq.service';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recordJobRun } from '../common/job-runs';
import {
  innFromSequence,
  sequenceOfInn,
} from '../new-company-scan/inn-sequence';
import { nextWindowEnd } from '../yatt-crawl/yatt-crawl.service';

/**
 * Finding traders by STIR now that myorg is off (user request 2026-10-19).
 *
 * A trader's STIR is the person's own (4, 5 or 6 first), issued when they
 * became a taxpayer — often years before they registered as a trader — so
 * the counter is a list of people, not of traders. 500 traders from the myorg
 * walk all passed the check digit, sat ~2% dense across their range, and
 * came in loose clusters (tax-office batches, families registered together):
 * nothing in the number itself marks a trader. soliq's `factura-all` answers
 * for any person; what told a trader apart in the user's hand test was a
 * bank account. So this asks soliq about every STIR that can exist and keeps
 * the ones with an account as candidates (`yatt_scan_candidates`), to be
 * checked against birdarcha before anything treats them as traders.
 *
 * User decisions 2026-10-19: approximate is fine — better more requests than
 * a skipped trader; run at night, 21:00–06:00 Tashkent, and keep the pace
 * low even though soliq is fast; log, alert and keep enough to judge it.
 *
 * Rules:
 * - Only STIRs that can exist: every sequence has one check digit.
 * - A STIR soliq does not know comes back as HTTP 200 with every field
 *   null — "not found", never an error and never data.
 * - A STIR we already hold as a trader is not asked.
 * - Kept per candidate: bank code and account, the tax office pair and the
 *   district it maps to (`ns_soato_map` — the official pair → SOATO, not a
 *   reading of the address text). No name, no PINFL, no address. A candidate
 *   later found without an account keeps what it had.
 * - Kept per block of 1,000 sequences (`yatt_scan_blocks`): how many were
 *   asked, not found, found without a bank, candidates, and the tax offices
 *   of the people found — counts only. That is the density map: which ranges
 *   to sweep first next time, and which district a range was issued in.
 * - Ten soliq failures in a row stop the run; it resumes at the first STIR
 *   that went unanswered. The cursor is saved after every 500 STIRs.
 */

/** Held by the session, so a container killed mid-run frees it. */
const LOCK_ID = 8_151_050;

/** People's STIRs: 4, 5 and 6 first — sequences 40 000 000 – 69 999 999. */
export const PERSON_SEQUENCE = { first: 40_000_000, last: 69_999_999 } as const;

/** The most STIRs one run by hand asks about. */
export const MAX_COUNT = 10_000;

/** A block of the density map: 1,000 sequences (10,000 STIR numbers). */
export const BLOCK = 1_000;

const CHUNK = 500;
const FAILURE_LIMIT = 10;
const STOP_CHECK_EVERY = 20;
const LOG_EVERY_MS = 15 * 60_000;

/**
 * The nightly pace: one request every this many ms — default 500, two a
 * second (user decision 2026-10-19), ~65k STIRs in a 21:00–06:00 night.
 */
export function nightlyIntervalMs(
  env: Record<string, string | undefined> = process.env,
): number {
  const v = Number(env.YATT_SCAN_INTERVAL_MS);
  return Number.isFinite(v) && v >= 0 ? v : 500;
}

/**
 * Whether the nightly sweep runs here: production only (user decision
 * 2026-10-20, `SERVICE_ENVIRONMENT=production`, the main.* tags). The test
 * environment ran it the first night and now tries it by hand only
 * (`POST /yatt-scan/night?count=N`): two sweeps would ask soliq twice for
 * the same STIRs. `YATT_SCAN_ENABLED=1|0` overrides.
 */
export function yattScanNightlyEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.YATT_SCAN_ENABLED === '0') return false;
  if (env.YATT_SCAN_ENABLED === '1') return true;
  return env.SERVICE_ENVIRONMENT === 'production';
}

export type ScanMode = 'sequential' | 'random' | 'nightly';

export interface ScanOptions {
  mode: ScanMode;
  /**
   * STIRs to ask (sequential, random). A nightly run goes to its deadline,
   * or stops after `count` when given — a sample of the night by hand.
   */
  count?: number;
  /** Sequential: start at this STIR instead of where the last run ended. */
  fromInn?: string;
  /** Random: only STIRs starting with this digit. */
  prefix?: 4 | 5 | 6;
  /** Stop starting new lookups at this moment. */
  deadline?: Date;
  /** Pause between the starts of two lookups, across workers. */
  intervalMs?: number;
  /** Parallel lookups. */
  concurrency?: number;
}

export interface ScanTotals {
  /** STIRs soliq was asked about. */
  asked: number;
  /** Already a trader here — not asked. */
  held: number;
  /** soliq answered with an empty record: no such taxpayer. */
  notFound: number;
  /** A person soliq knows, with no bank account. */
  foundNoBank: number;
  /** A person with a bank account — kept as a candidate. */
  candidates: number;
  /** …of which seen for the first time. */
  newCandidates: number;
  /** soliq did not answer. */
  failed: number;
  /** A candidate or a block that could not be written. */
  errors: number;
}

export interface ScanReport {
  ended: 'done' | 'stopped' | 'aborted' | 'deadline' | 'end';
  mode: ScanMode;
  trigger: string;
  first: string | null;
  last: string | null;
  nextInn: string | null;
  totals: ScanTotals;
  /** Blocks of the density map this run touched. */
  blocks: number;
  /** The run's densest blocks: candidates per block. */
  densest: Array<{ block: number; candidates: number; asked: number }>;
  lastError: string | null;
  ms: number;
}

/** What is kept about a person: the bank and the tax office pair. */
export interface SoliqPersonFields {
  bankCode: string | null;
  account: string | null;
  ns10: number | null;
  ns11: number | null;
}

export type SoliqVerdict =
  | { kind: 'empty' }
  | ({ kind: 'person' | 'candidate' } & SoliqPersonFields);

const clean = (v: unknown): string | null => {
  const text = v == null ? '' : String(v).trim();
  return text === '' ? null : text;
};
const int = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || v === '' || !Number.isInteger(n) ? null : n;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * soliq's answer in the scan's terms. A STIR it does not know is an object
 * with every field null (`tin`, `name`, `personalNum` …), not an error.
 */
export function readSoliqAnswer(data: unknown): SoliqVerdict {
  if (!data || typeof data !== 'object') return { kind: 'empty' };
  const d = data as Record<string, unknown>;
  if (!clean(d.tin) && !clean(d.name) && !clean(d.personalNum)) {
    return { kind: 'empty' };
  }
  const account = clean(d.account);
  return {
    kind: account ? 'candidate' : 'person',
    bankCode: account ? clean(d.mfo) : null,
    account,
    ns10: int(d.ns10Code),
    ns11: int(d.ns11Code),
  };
}

/** `count` STIRs from `start` up, one per sequence, never past the 6s. */
export function sequentialInns(
  start: number,
  count: number,
): { inns: string[]; next: number } {
  const inns: string[] = [];
  let seq = start;
  while (inns.length < count && seq <= PERSON_SEQUENCE.last) {
    inns.push(innFromSequence(seq));
    seq++;
  }
  return { inns, next: seq };
}

/** `count` different STIRs at random, all of the 4–6 range or one digit's. */
export function randomInns(
  count: number,
  prefix?: 4 | 5 | 6,
  random: () => number = Math.random,
): string[] {
  const lo = prefix ? prefix * 10_000_000 : PERSON_SEQUENCE.first;
  const span = prefix ? 10_000_000 : PERSON_SEQUENCE.last - lo + 1;
  const seen = new Set<string>();
  while (seen.size < count) {
    seen.add(innFromSequence(lo + Math.floor(random() * span)));
  }
  return [...seen];
}

/** One block's counts as a run gathers them. */
export interface BlockTally {
  asked: number;
  notFound: number;
  foundNoBank: number;
  candidates: number;
  held: number;
  /** "ns10/ns11" → people found under that tax office. */
  offices: Record<string, number>;
}

export const blockOf = (inn: string): number =>
  Math.floor(Number(inn.slice(0, 8)) / BLOCK);

const emptyTotals = (): ScanTotals => ({
  asked: 0,
  held: 0,
  notFound: 0,
  foundNoBank: 0,
  candidates: 0,
  newCandidates: 0,
  failed: 0,
  errors: 0,
});

const emptyTally = (): BlockTally => ({
  asked: 0,
  notFound: 0,
  foundNoBank: 0,
  candidates: 0,
  held: 0,
  offices: {},
});

/** The shared state of one run's workers. */
interface RunState {
  failuresInRow: number;
  sinceStopCheck: number;
  lastError: string | null;
  /** The first STIR of the current run of failures. */
  streakStart: string | null;
  ended: ScanReport['ended'];
  /** When the next lookup may start (the pace). */
  nextAt: number;
  intervalMs: number;
  deadline: number | null;
  lastLogAt: number;
}

@Injectable()
export class YattScanService {
  private readonly logger = new Logger(YattScanService.name);
  private running = false;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly mysoliq: MysoliqService,
    private readonly telegram: TelegramAlertService,
  ) {}

  /** 21:00 Tashkent: the night's sweep, until 06:00. */
  @Cron('0 21 * * *', { timeZone: 'Asia/Tashkent' })
  async nightly(): Promise<void> {
    if (!yattScanNightlyEnabled()) {
      this.logger.log(
        '[yatt-scan] nightly sweep skipped — production only (YATT_SCAN_ENABLED=1 runs it anyway; POST /yatt-scan/night?count=N tries it by hand)',
      );
      return;
    }
    const run = await this.start(
      {
        mode: 'nightly',
        deadline: nextWindowEnd(new Date()),
        intervalMs: nightlyIntervalMs(),
        concurrency: 1,
      },
      'nightly',
    );
    if (!run.started) {
      this.logger.log(`[yatt-scan] nightly sweep not started: ${run.reason}`);
      return;
    }
    await run.done;
  }

  async start(
    options: ScanOptions,
    trigger: string,
  ): Promise<{
    started: boolean;
    reason: string | null;
    done: Promise<ScanReport | null>;
  }> {
    const idle = Promise.resolve(null);
    if (this.running) {
      return { started: false, reason: 'already running here', done: idle };
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
      return {
        started: false,
        reason: `could not take the lock: ${(err as Error).message}`,
        done: idle,
      };
    }
    if (!locked) {
      await runner.release().catch(() => undefined);
      return {
        started: false,
        reason: 'another replica is running a scan',
        done: idle,
      };
    }

    this.running = true;
    const done = this.execute(options, trigger)
      .catch((err) => {
        this.logger.error(
          `[yatt-scan] crashed: ${(err as Error).message}`,
          (err as Error).stack,
        );
        void this.alert(
          `❌ <b>Trader STIR scan crashed</b> (${escapeHtml(trigger)})\n<code>${escapeHtml((err as Error).message)}</code>`,
        );
        return null;
      })
      .finally(async () => {
        this.running = false;
        await runner
          .query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
          .catch(() => undefined);
        await runner.release().catch(() => undefined);
      });
    return { started: true, reason: null, done };
  }

  async requestStop(): Promise<{ requested: boolean }> {
    await this.db.query(
      `UPDATE public.yatt_scan_state
          SET stop_requested = true, updated_at = now()
        WHERE id = 1`,
    );
    this.logger.log('[yatt-scan] stop requested');
    return { requested: true };
  }

  async status(): Promise<Record<string, unknown>> {
    const [state] = await this.db.query(
      `SELECT next_sequence, night_next_sequence, stop_requested, last_run, updated_at
         FROM public.yatt_scan_state WHERE id = 1`,
    );
    const [counts] = await this.db.query(
      `SELECT (SELECT count(*)::int FROM public.yatt_scan_candidates) AS candidates,
              (SELECT max(last_seen_at) FROM public.yatt_scan_candidates) AS last_seen_at,
              (SELECT count(*)::int FROM public.yatt_scan_blocks) AS blocks,
              (SELECT COALESCE(sum(asked), 0)::bigint FROM public.yatt_scan_blocks) AS asked`,
    );
    const innAt = (v: unknown) => {
      const n = v == null ? null : Number(v);
      return n !== null && n <= PERSON_SEQUENCE.last
        ? innFromSequence(n)
        : null;
    };
    return {
      running_here: this.running,
      nightly_enabled: yattScanNightlyEnabled(),
      nightly_interval_ms: nightlyIntervalMs(),
      next_inn: innAt(state?.next_sequence),
      night_next_inn: innAt(state?.night_next_sequence),
      stop_requested: state?.stop_requested === true,
      candidates: counts?.candidates ?? 0,
      last_candidate_at: counts?.last_seen_at ?? null,
      blocks_scanned: counts?.blocks ?? 0,
      stirs_asked: Number(counts?.asked ?? 0),
      last_run: state?.last_run ?? null,
    };
  }

  /** The newest candidates: STIR, bank code, the account's type, district. */
  async candidates(limit: number): Promise<unknown[]> {
    return this.db.query(
      `SELECT inn, bank_code, left(bank_account, 5) AS account_type,
              ns10_code, ns11_code, soato, first_seen_at, last_seen_at
         FROM public.yatt_scan_candidates
        ORDER BY last_seen_at DESC, inn
        LIMIT $1`,
      [limit],
    );
  }

  /**
   * The density map: blocks by candidates per STIR asked (`dense`) or the
   * latest scanned (`recent`), each with its most common tax office.
   */
  async blocks(limit: number, order: 'dense' | 'recent'): Promise<unknown[]> {
    const rows: any[] = await this.db.query(
      `SELECT block, asked, not_found, found_no_bank, candidates, held, offices,
              last_scanned_at
         FROM public.yatt_scan_blocks
        WHERE asked > 0
        ORDER BY ${
          order === 'dense'
            ? 'candidates::float / NULLIF(asked, 0) DESC, candidates DESC'
            : 'last_scanned_at DESC'
        }
        LIMIT $1`,
      [limit],
    );
    // The most common office per block, named from ns_soato_map.
    const tops = rows.map((r) => {
      const entries = Object.entries(
        (r.offices ?? {}) as Record<string, number>,
      );
      entries.sort((a, b) => b[1] - a[1]);
      return entries[0] ?? null;
    });
    const pairs = [
      ...new Set(tops.filter(Boolean).map((t) => (t as [string, number])[0])),
    ];
    const names = new Map<string, any>();
    if (pairs.length) {
      const found: any[] = await this.db
        .query(
          `SELECT ns10_code || '/' || ns11_code AS pair, ns10_name, ns11_name, soato
             FROM public.ns_soato_map
            WHERE (ns10_code || '/' || ns11_code) = ANY($1::text[])`,
          [pairs],
        )
        .catch(() => []);
      for (const f of found) names.set(f.pair, f);
    }
    return rows.map((r, i) => {
      const top = tops[i];
      const office = top ? names.get(top[0]) : null;
      return {
        block: r.block,
        stirs: `${innFromSequence(r.block * BLOCK)} – ${innFromSequence(r.block * BLOCK + BLOCK - 1)}`,
        asked: r.asked,
        not_found: r.not_found,
        found_no_bank: r.found_no_bank,
        candidates: r.candidates,
        held: r.held,
        candidate_share: r.asked
          ? Math.round((1000 * r.candidates) / r.asked) / 10
          : null,
        top_office: top
          ? {
              pair: top[0],
              people: top[1],
              region: office?.ns10_name ?? null,
              district: office?.ns11_name ?? null,
              soato: office?.soato ?? null,
            }
          : null,
        last_scanned_at: r.last_scanned_at,
      };
    });
  }

  private async execute(
    options: ScanOptions,
    trigger: string,
  ): Promise<ScanReport> {
    const startedAt = Date.now();
    const totals = emptyTotals();
    const blockTallies = new Map<number, BlockTally>();
    await this.db.query(
      `UPDATE public.yatt_scan_state
          SET stop_requested = false, updated_at = now() WHERE id = 1`,
    );
    const run: RunState = {
      failuresInRow: 0,
      sinceStopCheck: 0,
      lastError: null,
      streakStart: null,
      ended: 'done',
      nextAt: 0,
      intervalMs: Math.max(0, options.intervalMs ?? 0),
      deadline: options.deadline ? options.deadline.getTime() : null,
      lastLogAt: Date.now(),
    };
    const concurrency = Math.max(1, options.concurrency ?? 2);
    const nightly = options.mode === 'nightly';
    const cursorColumn = nightly ? 'night_next_sequence' : 'next_sequence';

    let first: string | null = null;
    let last: string | null = null;
    let next: number | null = null;

    if (options.mode === 'random') {
      const inns = randomInns(options.count ?? 0, options.prefix);
      first = inns[0] ?? null;
      last = inns[inns.length - 1] ?? null;
      await this.announce(options, trigger, first);
      await this.processChunk(inns, totals, blockTallies, run, concurrency);
    } else {
      if (options.fromInn) {
        next = Number(options.fromInn.slice(0, 8));
      } else {
        const [state] = await this.db.query(
          `SELECT ${cursorColumn} AS seq FROM public.yatt_scan_state WHERE id = 1`,
        );
        next = Number(state?.seq ?? PERSON_SEQUENCE.first);
      }
      let remaining = nightly
        ? (options.count ?? Infinity)
        : (options.count ?? 0);
      await this.announce(
        options,
        trigger,
        next <= PERSON_SEQUENCE.last ? innFromSequence(next) : null,
      );
      while (remaining > 0 && run.ended === 'done') {
        if (run.deadline !== null && Date.now() >= run.deadline) {
          run.ended = 'deadline';
          break;
        }
        const { inns, next: after } = sequentialInns(
          next,
          Math.min(CHUNK, remaining),
        );
        if (inns.length === 0) {
          run.ended = 'end';
          break;
        }
        first ??= inns[0];
        const reached = await this.processChunk(
          inns,
          totals,
          blockTallies,
          run,
          concurrency,
        );
        // processChunk moves run.ended; TypeScript still holds it at 'done'
        // from the loop's condition.
        const endedNow = run.ended as ScanReport['ended'];
        // Where the next run starts: past the chunk, or at the first STIR
        // not asked (stopped, deadline) or not answered (aborted).
        const resumeAt =
          endedNow === 'aborted'
            ? run.streakStart
            : reached < inns.length
              ? inns[reached]
              : null;
        next = resumeAt ? (sequenceOfInn(resumeAt) as number) : after;
        last = inns[Math.max(0, Math.min(reached, inns.length) - 1)] ?? last;
        remaining -= reached;
        await this.saveCursor(cursorColumn, next);
        await this.saveBlocks(blockTallies, totals);
        if (reached < inns.length && run.ended === 'done') {
          run.ended = 'deadline';
        }
      }
    }
    if (options.mode === 'random') await this.saveBlocks(blockTallies, totals);

    const densest = [...this.runBlocks]
      .map(([block, t]) => ({
        block,
        candidates: t.candidates,
        asked: t.asked,
      }))
      .filter((b) => b.candidates > 0)
      .sort((a, b) => b.candidates - a.candidates)
      .slice(0, 3);
    const report: ScanReport = {
      ended: run.ended,
      mode: options.mode,
      trigger,
      first,
      last,
      nextInn:
        next !== null && next <= PERSON_SEQUENCE.last
          ? innFromSequence(next)
          : null,
      totals,
      blocks: this.runBlocks.size,
      densest,
      lastError: run.lastError,
      ms: Date.now() - startedAt,
    };
    this.runBlocks.clear();
    await this.db
      .query(
        `UPDATE public.yatt_scan_state
            SET last_run = $1::jsonb, updated_at = now()
          WHERE id = 1`,
        [JSON.stringify(report)],
      )
      .catch((err) =>
        this.logger.warn(
          `[yatt-scan] last run not saved: ${(err as Error).message}`,
        ),
      );
    await this.report(report, options, startedAt);
    return report;
  }

  /** Every block a run touched, with its whole tally (for the report). */
  private readonly runBlocks = new Map<number, BlockTally>();

  /**
   * Asks soliq about one chunk. Answers how many STIRs of the chunk were
   * taken (asked, or skipped as held) — fewer when the run stopped.
   */
  private async processChunk(
    inns: string[],
    totals: ScanTotals,
    tallies: Map<number, BlockTally>,
    run: RunState,
    concurrency: number,
  ): Promise<number> {
    const tally = (inn: string) => {
      const b = blockOf(inn);
      let t = tallies.get(b);
      if (!t) {
        t = emptyTally();
        tallies.set(b, t);
      }
      let all = this.runBlocks.get(b);
      if (!all) {
        all = emptyTally();
        this.runBlocks.set(b, all);
      }
      return [t, all];
    };

    // A trader we hold is not asked: the scan is for the ones we do not.
    const heldRows: Array<{ inn: string }> = inns.length
      ? await this.db.query(
          `SELECT inn FROM public.individual_entrepreneurs WHERE inn = ANY($1)`,
          [inns],
        )
      : [];
    const held = new Set(heldRows.map((r) => r.inn));

    let index = 0;
    const worker = async () => {
      while (index < inns.length && run.ended === 'done') {
        if (++run.sinceStopCheck >= STOP_CHECK_EVERY) {
          run.sinceStopCheck = 0;
          if (await this.stopRequested()) {
            run.ended = 'stopped';
            break;
          }
        }
        if (run.deadline !== null && Date.now() >= run.deadline) break;
        // The other worker may have taken the last STIR while this one
        // waited on the stop check (a run of 1000 once asked 1001).
        if (index >= inns.length || run.ended !== 'done') break;
        const inn = inns[index++];
        if (held.has(inn)) {
          totals.held++;
          for (const t of tally(inn)) t.held++;
          continue;
        }
        await this.pace(run);
        let data: unknown;
        try {
          data = await this.mysoliq.request('np1/bytin/factura-all', {
            tin: inn,
          });
        } catch (err) {
          totals.failed++;
          if (run.failuresInRow === 0) run.streakStart = inn;
          run.lastError = (err as Error).message;
          this.logger.warn(
            `[yatt-scan] soliq did not answer for ${inn}: ${run.lastError}`,
          );
          if (++run.failuresInRow >= FAILURE_LIMIT) run.ended = 'aborted';
          continue;
        }
        run.failuresInRow = 0;
        totals.asked++;
        const verdict = readSoliqAnswer(data);
        const ts = tally(inn);
        for (const t of ts) t.asked++;
        if (verdict.kind === 'empty') {
          totals.notFound++;
          for (const t of ts) t.notFound++;
        } else {
          if (verdict.ns10 != null && verdict.ns11 != null) {
            const office = `${verdict.ns10}/${verdict.ns11}`;
            for (const t of ts)
              t.offices[office] = (t.offices[office] ?? 0) + 1;
          }
          if (verdict.kind === 'person') {
            totals.foundNoBank++;
            for (const t of ts) t.foundNoBank++;
          } else {
            for (const t of ts) t.candidates++;
            await this.keep(inn, verdict, totals);
          }
        }
        if (Date.now() - run.lastLogAt >= LOG_EVERY_MS) {
          run.lastLogAt = Date.now();
          this.logger.log(
            `[yatt-scan] at ${inn} · asked ${totals.asked} · not found ${totals.notFound} ` +
              `· no bank ${totals.foundNoBank} · with bank ${totals.candidates} · failed ${totals.failed}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, inns.length) }, worker),
    );
    return Math.min(index, inns.length);
  }

  /** Waits for the run's next slot: one lookup start per `intervalMs`. */
  private async pace(run: RunState): Promise<void> {
    if (run.intervalMs <= 0) return;
    const now = Date.now();
    const at = Math.max(now, run.nextAt);
    run.nextAt = at + run.intervalMs;
    if (at > now) await sleep(at - now);
  }

  private async keep(
    inn: string,
    v: SoliqPersonFields,
    totals: ScanTotals,
  ): Promise<void> {
    try {
      // $4 and $5 are cast once: they fill an integer column and are compared
      // with ns_soato_map's smallint, and Postgres refuses a parameter whose
      // type it deduces two ways ("inconsistent types deduced for parameter
      // $4") — every candidate of the first night (2026-10-19, 1,737) was
      // refused for it.
      const rows: Array<{ inserted: boolean; soato: string | null }> =
        await this.db.query(
          `INSERT INTO public.yatt_scan_candidates
             (inn, bank_code, bank_account, ns10_code, ns11_code, soato)
           VALUES ($1, $2, $3, $4::int, $5::int,
                   (SELECT m.soato FROM public.ns_soato_map m
                     WHERE m.ns10_code = $4::int AND m.ns11_code = $5::int
                     LIMIT 1))
           ON CONFLICT (inn) DO UPDATE SET
             bank_code    = COALESCE(EXCLUDED.bank_code, yatt_scan_candidates.bank_code),
             bank_account = COALESCE(EXCLUDED.bank_account, yatt_scan_candidates.bank_account),
             ns10_code    = COALESCE(EXCLUDED.ns10_code, yatt_scan_candidates.ns10_code),
             ns11_code    = COALESCE(EXCLUDED.ns11_code, yatt_scan_candidates.ns11_code),
             soato        = COALESCE(EXCLUDED.soato, yatt_scan_candidates.soato),
             last_seen_at = now()
           RETURNING (xmax = 0) AS inserted, soato`,
          [inn, v.bankCode, v.account, v.ns10, v.ns11],
        );
      totals.candidates++;
      if (rows?.[0]?.inserted) totals.newCandidates++;
      // The account's first five digits say what kind it is; the rest stays
      // out of the log.
      this.logger.log(
        `[yatt-scan] candidate ${inn} — bank ${v.bankCode ?? '—'}, account type ${v.account?.slice(0, 5) ?? '—'}, soato ${rows?.[0]?.soato ?? '—'}`,
      );
    } catch (err) {
      totals.errors++;
      this.logger.warn(
        `[yatt-scan] candidate ${inn} not written: ${(err as Error).message}`,
      );
    }
  }

  private async saveCursor(column: string, next: number): Promise<void> {
    await this.db
      .query(
        `UPDATE public.yatt_scan_state
            SET ${column} = $1::bigint, updated_at = now()
          WHERE id = 1`,
        [next],
      )
      .catch((err) =>
        this.logger.warn(
          `[yatt-scan] cursor not saved: ${(err as Error).message}`,
        ),
      );
  }

  /** Adds the chunk's block tallies to `yatt_scan_blocks`, then clears them. */
  private async saveBlocks(
    tallies: Map<number, BlockTally>,
    totals: ScanTotals,
  ): Promise<void> {
    if (tallies.size === 0) return;
    const rows = [...tallies.entries()];
    tallies.clear();
    try {
      await this.db.query(
        `INSERT INTO public.yatt_scan_blocks AS b
           (block, asked, not_found, found_no_bank, candidates, held, offices)
         SELECT * FROM unnest($1::int[], $2::int[], $3::int[], $4::int[],
                              $5::int[], $6::int[], $7::jsonb[])
         ON CONFLICT (block) DO UPDATE SET
           asked         = b.asked + EXCLUDED.asked,
           not_found     = b.not_found + EXCLUDED.not_found,
           found_no_bank = b.found_no_bank + EXCLUDED.found_no_bank,
           candidates    = b.candidates + EXCLUDED.candidates,
           held          = b.held + EXCLUDED.held,
           offices       = (SELECT COALESCE(jsonb_object_agg(k,
                               COALESCE((b.offices ->> k)::int, 0) +
                               COALESCE((EXCLUDED.offices ->> k)::int, 0)), '{}'::jsonb)
                              FROM (SELECT jsonb_object_keys(b.offices)
                                    UNION
                                    SELECT jsonb_object_keys(EXCLUDED.offices)) AS keys(k)),
           last_scanned_at = now()`,
        [
          rows.map(([b]) => b),
          rows.map(([, t]) => t.asked),
          rows.map(([, t]) => t.notFound),
          rows.map(([, t]) => t.foundNoBank),
          rows.map(([, t]) => t.candidates),
          rows.map(([, t]) => t.held),
          rows.map(([, t]) => JSON.stringify(t.offices)),
        ],
      );
    } catch (err) {
      totals.errors++;
      this.logger.warn(
        `[yatt-scan] ${rows.length} block tally(ies) not written: ${(err as Error).message}`,
      );
    }
  }

  private async stopRequested(): Promise<boolean> {
    const [row] = await this.db.query(
      `SELECT stop_requested FROM public.yatt_scan_state WHERE id = 1`,
    );
    return row?.stop_requested === true;
  }

  /** The start: one line in the log, and Telegram for a nightly sweep. */
  private async announce(
    options: ScanOptions,
    trigger: string,
    from: string | null,
  ): Promise<void> {
    const pace = options.intervalMs
      ? `1 request / ${options.intervalMs} ms (~${n(Math.round(3_600_000 / options.intervalMs))}/hour)`
      : `${options.concurrency ?? 2} at a time, no pause`;
    const until = options.deadline
      ? ` · until ${options.deadline.toISOString().slice(11, 16)} UTC`
      : '';
    this.logger.log(
      `[yatt-scan] started · ${options.mode} · from ${from ?? 'random'}${until} · ${pace} · ${trigger}`,
    );
    if (options.mode === 'nightly') {
      await this.alert(
        [
          `🌙 <b>Trader STIR scan started</b> (${escapeHtml(trigger)})`,
          `From STIR ${from ?? '—'}${until}`,
          `Pace: ${pace}`,
        ].join('\n'),
      );
    }
  }

  private async report(
    r: ScanReport,
    options: ScanOptions,
    startedAt: number,
  ): Promise<void> {
    const t = r.totals;
    const head =
      r.ended === 'aborted'
        ? '❌ <b>Trader STIR scan stopped — soliq is not answering</b>'
        : r.ended === 'stopped'
          ? '⏹ <b>Trader STIR scan stopped on request</b>'
          : r.ended === 'end'
            ? '✅ <b>Trader STIR scan reached the end of people’s STIRs</b>'
            : t.errors
              ? '⚠️ <b>Trader STIR scan done, with errors</b>'
              : t.candidates
                ? '✅ <b>Trader STIR scan done</b>'
                : 'ℹ️ <b>Trader STIR scan done — no bank accounts found</b>';
    const range =
      r.mode === 'random'
        ? `Random ${n(options.count ?? 0)} STIRs${options.prefix ? ` starting with ${options.prefix}` : ''}`
        : `STIRs ${r.first ?? '—'} … ${r.last ?? '—'}`;
    const share = t.asked ? ((100 * t.candidates) / t.asked).toFixed(1) : '0';
    const lines = [
      `${head} (${escapeHtml(r.trigger)})`,
      range,
      `With a bank account: <b>${n(t.candidates)}</b> (new ${n(t.newCandidates)}, ${share}% of asked) · found, no bank ${n(t.foundNoBank)} · not found ${n(t.notFound)}`,
      `Asked soliq ${n(t.asked)} · already traders here ${n(t.held)} · soliq not answering ${n(t.failed)} · write errors ${n(t.errors)}`,
      `Blocks of 1,000: ${n(r.blocks)}${
        r.densest.length
          ? ` · densest ${r.densest.map((d) => `${d.block}xxx (${d.candidates})`).join(', ')}`
          : ''
      }`,
      ...(r.mode !== 'random' && r.nextInn ? [`Next start: ${r.nextInn}`] : []),
      ...(r.lastError
        ? [`Last error: <code>${escapeHtml(r.lastError)}</code>`]
        : []),
      `Time: ${formatDuration(r.ms)}`,
    ];
    this.logger.log(
      `[yatt-scan] ended (${r.ended}) · ${r.mode} · asked ${t.asked} · not found ${t.notFound} ` +
        `· no bank ${t.foundNoBank} · with bank ${t.candidates} (new ${t.newCandidates}) ` +
        `· held ${t.held} · failed ${t.failed} · errors ${t.errors} · blocks ${r.blocks}` +
        `${r.nextInn && r.mode !== 'random' ? ` · next ${r.nextInn}` : ''}`,
    );
    const text = lines.join('\n');
    const alertSent = await this.alert(text);
    await recordJobRun(this.db, {
      job: 'yatt_scan',
      trigger: r.trigger,
      startedAt: new Date(startedAt),
      ok: r.ended !== 'aborted' && t.errors === 0,
      summary: text,
      report: r,
      error: r.ended === 'aborted' ? r.lastError : null,
      alertSent,
    });
  }

  private async alert(text: string): Promise<boolean | null> {
    try {
      return await this.telegram.send(text, { tag: 'yatt_scan' });
    } catch (err) {
      this.logger.warn(`[yatt-scan] alert not sent: ${(err as Error).message}`);
      return null;
    }
  }
}

const n = (v: number) => v.toLocaleString('en-US');

function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
