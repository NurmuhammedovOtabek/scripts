import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import {
  MahallaMatcher,
  SAFE_TIERS,
  districtOfSoato,
  mahallaFromAddress,
} from '../../common/mahalla/mahalla-matcher';
import { onCompanyLocationChanged } from '../../common/mahalla/company-location-events';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recentJobRuns, recordJobRun } from '../common/job-runs';
import {
  BankRegistrySyncService,
  bankRegistrySyncEnabled,
} from '../bank-registry/bank-registry-sync.service';
import {
  NsSoatoMapSyncService,
  nsSoatoSyncEnabled,
} from '../ns-soato-map/ns-soato-map-sync.service';
import {
  OkedSyncService,
  okedSyncEnabled,
} from '../oked-sync/oked-sync.service';
import {
  AccreditationSyncService,
  accreditationSyncEnabled,
} from '../accreditation/accreditation-sync.service';
import {
  PostcodeWatchService,
  postcodeWatchEnabled,
} from '../postcode/postcode-watch.service';
import {
  RegistriesSyncService,
  registriesSyncEnabled,
} from '../registries/registries-sync.service';
import { jobStopRequested } from '../common/job-control';
import {
  CompanyLocationInput,
  CompanyMahallaResult,
  VillageCodeEvidence,
  VillageMapDecision,
  VillageMapEntry,
  VillageMapStatus,
  decideVillageCode,
  explainCompanyMahalla,
  resolveCompanyMahalla,
} from './company-mahalla.resolver';

/** Held by a session, so a container killed mid-run frees it by dropping. */
export const RUN_LOCK = 8_150_931;
/** The whole Sunday chain, so one replica runs it start to end, in order. */
export const WEEKLY_LOCK = 8_150_936;
export const WEEKLY_JOB = 'weekly';

/** Companies read per query in a full run. */
const BATCH = 5_000;
/** Companies re-resolved per query when writes report them. */
const LIVE_BATCH = 1_000;
/**
 * How long reported writes are gathered before they are resolved together.
 * The CBU batch reports a company at a time; this turns a burst of them into
 * one query instead of hundreds.
 */
const LIVE_GATHER_MS = 300;
/** How long a replica trusts its copy of the village map. */
const MAP_TTL_MS = 10 * 60_000;
/** How often a replica re-asks whether the first run has happened yet. */
const INIT_RECHECK_MS = 60_000;

/** A live batch that fails is tried again after this, up to LIVE_ATTEMPTS. */
const LIVE_RETRY_MS = 30_000;
const LIVE_ATTEMPTS = 3;
/** At most one "live refresh failed" message per process in this window. */
const LIVE_ALERT_EVERY_MS = 60 * 60_000;

const WEEKLY = 'weekly check';

const JOB = 'company_mahalla';
const JOB_LIVE = 'company_mahalla_live';

/** What the report calls each source, for people who do not read the code. */
const SOURCE_LABEL: Record<string, string> = {
  cbu_address: 'MFY in the CBU address',
  cbu_village_code: 'CBU village code',
  registry_address: 'MFY in the registry address',
  registry_village_code: 'registry village code',
  registry_village_name: 'registry village name',
};

const REASON_LABEL: Record<string, string> = {
  no_district: 'no district (SOATO)',
  unknown_district: 'district missing from the classifier',
  no_mahalla_given: 'address names no mahalla',
  ambiguous: 'name fits two mahallas in the district',
  not_found: 'name not in the classifier',
};

const MAP_STATUS_LABEL: Record<string, string> = {
  auto: 'auto',
  manual: 'manual',
  review: 'to review',
  none: 'not found',
};

/**
 * The weekly run is on unless `COMPANY_MAHALLA_CRON=0`, and in any case only
 * after the first full run has been started by hand (`initialized_at`).
 */
export function companyMahallaCronEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env.COMPANY_MAHALLA_CRON !== '0';
}

/**
 * Everything a company's mahalla is decided from, in one row. The ns10/ns11
 * pair is translated only for a row with no `soato_code` — a company the
 * new-company scan listed from mysoliq, which sends the pair and no SOATO.
 */
const SELECT_INPUTS = `
  SELECT ci.inn::text              AS inn,
         ci.soato_code::text       AS soato,
         ns.soato::text            AS ns_soato,
         ci.village_code::text     AS village_code,
         ci.village_name           AS village_name,
         ci.street_address         AS street,
         a.soato::text             AS cbu_soato,
         a.village_code::text      AS cbu_village_code,
         a.street_name             AS cbu_street
    FROM public.company_info ci
    LEFT JOIN LATERAL (
      SELECT soato
        FROM public.ns_soato_map
       WHERE nullif(btrim(ci.soato_code::text), '') IS NULL
         AND ns10_code = ci.ns10_code AND ns11_code = ci.ns11_code
       LIMIT 1
    ) ns ON true
    LEFT JOIN LATERAL (
      SELECT soato, village_code, street_name
        FROM public.company_addresses
       WHERE inn = ci.inn AND address_type = 'billing'
       ORDER BY id DESC
       LIMIT 1
    ) a ON true`;

function toInput(r: any): CompanyLocationInput {
  const s = (v: unknown) => {
    const t = v == null ? '' : String(v).trim();
    return t ? t : null;
  };
  return {
    inn: String(r.inn),
    soato: s(r.soato),
    nsSoato: s(r.ns_soato),
    villageCode: s(r.village_code),
    villageName: s(r.village_name),
    street: s(r.street),
    cbuSoato: s(r.cbu_soato),
    cbuVillageCode: s(r.cbu_village_code),
    cbuStreet: s(r.cbu_street),
  };
}

export interface RunOptions {
  /** Compute and report, write nothing — not the map, not the results. */
  dry?: boolean;
}

interface CompanyTotals {
  scanned: number;
  withMahalla: number;
  withAlt: number;
  inserted: number;
  updated: number;
  bySource: Record<string, number>;
  byTier: Record<string, number>;
  byReason: Record<string, number>;
  /** District → companies, for SOATO districts `public.territory` lacks. */
  unknownDistricts: Record<string, number>;
}

export interface RunReport {
  trigger: string;
  dry: boolean;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stopped: boolean;
  territoryMahallas: number;
  villageMap: {
    codes: number;
    byStatus: Record<string, number>;
    byTier: Record<string, number>;
  };
  companies: CompanyTotals;
  /** The previous real run's coverage, to read this one against. */
  previous: { scanned: number; withMahalla: number; finishedAt: string } | null;
  /** Live refreshes since the previous full run, all replicas. */
  live: {
    since: string | null;
    resolved: number;
    changed: number;
    failed: number;
  } | null;
}

/** One company whose mahalla moved, for the logs and the refresh endpoint. */
export interface MahallaMove {
  inn: string;
  from: string | null;
  to: string | null;
  via: string | null;
}

export interface RefreshResult {
  resolved: number;
  /** Rows written: new, or any stored field changed. */
  changed: number;
  /** Of those, the ones whose mahalla_code itself moved. */
  moved: number;
  removed: number;
  /** Up to twenty of the moves. */
  moves: MahallaMove[];
  skipped?: string;
}

function emptyTotals(): CompanyTotals {
  return {
    scanned: 0,
    withMahalla: 0,
    withAlt: 0,
    inserted: 0,
    updated: 0,
    bySource: {},
    byTier: {},
    byReason: {},
    unknownDistricts: {},
  };
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

function pct(part: number, whole: number): string {
  return whole ? `${((100 * part) / whole).toFixed(1)}%` : '—';
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes} daq ${seconds} s` : `${seconds} s`;
}

const bump = (acc: Record<string, number>, key: string | null) => {
  const k = key ?? '—';
  acc[k] = (acc[k] ?? 0) + 1;
};

/**
 * Which GRKI mahalla every company is registered in, kept in
 * `public.company_mahalla` for the bank reports that count clients per
 * mahalla and put them on a map.
 *
 * - **Live.** Whatever writes a company's location — a new row in
 *   `company_info`, a changed soato / street / village, a CBU billing
 *   address — calls `companyLocationChanged(inn)` (company-location-events),
 *   and the company is resolved again within a second, on the replica that
 *   wrote it. Writes are gathered for `LIVE_GATHER_MS` so a batch becomes one
 *   query. Nothing is done before the first full run: without the village map
 *   a live answer would be one the run is about to replace.
 * - **By hand** — `POST /company-mahalla/run` (x-admin-secret), `?dry=1` to
 *   see the numbers first with nothing written. Two passes over
 *   `company_info`: the first decides each 4-5 digit village code's mahalla
 *   (`mahalla_village_map`), the second resolves every company. Needed once
 *   to start, and again after `public.territory` is reloaded.
 * - **Weekly, Sunday 04:30** — the bank registry sync first, then the same
 *   full run, for what no write reports: a village code whose street votes
 *   have shifted, a change in the matching code after a deploy, a writer that
 *   forgot to report, a company removed. It also lists SOATO districts the
 *   classifier does not know (a new district), which is the signal that
 *   `public.territory` needs reloading.
 *
 * Every full run and every live batch given up on is kept in `job_runs` with
 * the report it sent, and reports go through `TelegramAlertService.deliver`,
 * which retries — a message that still fails is in the log whole.
 *
 * A result is written only when it differs from what is stored, so
 * `updated_at` is when a company's mahalla last *changed*.
 */
@Injectable()
export class CompanyMahallaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CompanyMahallaService.name);
  private running = false;
  private matcher: MahallaMatcher | null = null;
  private villageMap: {
    map: Map<string, VillageMapEntry>;
    at: number;
  } | null = null;
  private initialized: { value: boolean; at: number } | null = null;

  private readonly pending = new Set<string>();
  /** STIR → failed live attempts so far, cleared on success. */
  private readonly attempts = new Map<string, number>();
  private gatherTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private lastLiveAlertAt = 0;
  private stopListening: (() => void) | null = null;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly telegram: TelegramAlertService,
    private readonly banks: BankRegistrySyncService,
    private readonly nsMap: NsSoatoMapSyncService,
    private readonly oked: OkedSyncService,
    private readonly accreditation: AccreditationSyncService,
    private readonly postcodeWatch: PostcodeWatchService,
    private readonly registries: RegistriesSyncService,
  ) {}

  onModuleInit(): void {
    this.stopListening = onCompanyLocationChanged((inns) => this.heard(inns));
  }

  onModuleDestroy(): void {
    this.stopListening?.();
    if (this.gatherTimer) clearTimeout(this.gatherTimer);
  }

  // ── live ─────────────────────────────────────────────────────────────────

  /** Runs inside the writer's emit, so it only records and schedules. */
  private heard(inns: string[]): void {
    for (const inn of inns) this.pending.add(inn);
    this.schedule();
  }

  private schedule(): void {
    if (this.gatherTimer) return;
    this.gatherTimer = setTimeout(() => {
      this.gatherTimer = null;
      void this.flush();
    }, LIVE_GATHER_MS);
    this.gatherTimer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.flushing) {
      // One flush at a time; what arrived meanwhile waits for the next.
      this.schedule();
      return;
    }
    const inns = [...this.pending];
    this.pending.clear();
    if (inns.length === 0) return;
    this.flushing = true;
    try {
      const r = await this.refreshInns(inns);
      for (const inn of inns) this.attempts.delete(inn);
      if (!r.skipped) await this.countLive(r.resolved, r.moved, 0);
      if (r.moved || r.removed) {
        // Which company went where — what Kibana is searched for when a
        // bank asks why a client changed mahalla.
        const moves = r.moves
          .slice(0, 10)
          .map(
            (m) => `${m.inn} ${m.from ?? '∅'}→${m.to ?? '∅'} (${m.via ?? '?'})`,
          )
          .join(', ');
        this.logger.log(
          `[company-mahalla] live: ${r.resolved} resolved, ${r.moved} moved, ${r.removed} removed` +
            (moves ? ` — ${moves}` : ''),
        );
      }
    } catch (err) {
      await this.liveFailed(inns, err as Error);
    } finally {
      this.flushing = false;
      if (this.pending.size) this.schedule();
    }
  }

  /**
   * A live batch that failed is not dropped: it is tried again after
   * LIVE_RETRY_MS, LIVE_ATTEMPTS times in all. What still fails is left to
   * the weekly run — and said so, in the log, in `job_runs` and (at most
   * hourly) in Telegram, so a database that keeps refusing is noticed.
   */
  private async liveFailed(inns: string[], err: Error): Promise<void> {
    const retry: string[] = [];
    const dropped: string[] = [];
    for (const inn of inns) {
      const n = (this.attempts.get(inn) ?? 0) + 1;
      if (n < LIVE_ATTEMPTS) {
        this.attempts.set(inn, n);
        retry.push(inn);
      } else {
        this.attempts.delete(inn);
        dropped.push(inn);
      }
    }
    this.logger.warn(
      `[company-mahalla] live refresh of ${inns.length} failed (${err.message}) — ` +
        `${retry.length} tried again in ${LIVE_RETRY_MS / 1000}s, ${dropped.length} left to the weekly run`,
    );
    if (retry.length) {
      const t = setTimeout(() => {
        for (const inn of retry) this.pending.add(inn);
        this.schedule();
      }, LIVE_RETRY_MS);
      t.unref?.();
    }
    if (dropped.length === 0) return;

    await this.countLive(0, 0, dropped.length);
    const startedAt = new Date();
    const text = [
      `⚠️ <b>Company mahalla — live refresh failed</b>`,
      `${fmt(dropped.length)} companies still failed after ${LIVE_ATTEMPTS} attempts. ` +
        `The Sunday 04:30 full run will resolve them.`,
      `Error: <code>${escapeHtml(err.message)}</code>`,
      `Examples: ${dropped.slice(0, 5).join(', ')}`,
    ].join('\n');
    const record = (alertSent: boolean | null) =>
      recordJobRun(this.db, {
        job: JOB_LIVE,
        trigger: 'live',
        startedAt,
        ok: false,
        summary: text,
        report: { dropped: dropped.length, sample: dropped.slice(0, 20) },
        error: err.message,
        alertSent,
      });
    if (Date.now() - this.lastLiveAlertAt < LIVE_ALERT_EVERY_MS) {
      await record(null);
      return;
    }
    this.lastLiveAlertAt = Date.now();
    // Not awaited: Telegram's retries must not hold the live path up.
    void this.telegram
      .deliver(
        `${text}\n<i>Next message like this in an hour at the earliest.</i>`,
        { tag: 'mahalla' },
      )
      .then(record);
  }

  /** Live work summed across replicas; the full run's report reads it. */
  private async countLive(
    resolved: number,
    moved: number,
    failed: number,
  ): Promise<void> {
    if (!resolved && !moved && !failed) return;
    await this.db
      .query(
        `UPDATE public.company_mahalla_state
            SET live_resolved = live_resolved + $1,
                live_changed  = live_changed + $2,
                live_failed   = live_failed + $3,
                live_since    = coalesce(live_since, now())
          WHERE id = 1`,
        [resolved, moved, failed],
      )
      .catch((e: Error) =>
        this.logger.warn(
          `[company-mahalla] live counters not saved: ${e.message}`,
        ),
      );
  }

  /**
   * Resolves these companies now and stores what changed. Used by the live
   * path, by a manual mapping, and by the per-company endpoint.
   */
  async refreshInns(inns: string[]): Promise<RefreshResult> {
    const unique = [...new Set(inns.filter(Boolean))];
    const result: RefreshResult = {
      resolved: 0,
      changed: 0,
      moved: 0,
      removed: 0,
      moves: [],
    };
    if (unique.length === 0) return result;
    if (!(await this.isInitialized())) {
      return {
        ...result,
        skipped: 'not initialized — run POST /company-mahalla/run first',
      };
    }
    const matcher = await this.loadMatcher(false);
    const map = await this.cachedVillageMap();

    for (let i = 0; i < unique.length; i += LIVE_BATCH) {
      const chunk = unique.slice(i, i + LIVE_BATCH);
      const rows: any[] = await this.db.query(
        `${SELECT_INPUTS} WHERE ci.inn::text = ANY($1::text[])`,
        [chunk],
      );
      const stored: Array<{ inn: string; mahalla_code: string | null }> =
        await this.db.query(
          `SELECT inn, mahalla_code FROM public.company_mahalla WHERE inn = ANY($1::text[])`,
          [chunk],
        );
      const before = new Map(
        stored.map((s) => [String(s.inn), s.mahalla_code]),
      );
      const results = this.resolveRows(rows, matcher, (c) => map.get(c));
      const written = await this.upsert(results);
      result.resolved += results.length;
      result.changed += written.inserted + written.updated;
      for (const r of results) {
        const was = before.get(r.inn) ?? null;
        if (was === r.mahalla_code) continue;
        result.moved++;
        if (result.moves.length < 20) {
          result.moves.push({
            inn: r.inn,
            from: was,
            to: r.mahalla_code,
            via: r.source ?? r.reason,
          });
        }
      }

      // Reported but no longer in company_info: the company was removed, and
      // its answer goes with it.
      const found = new Set(results.map((r) => r.inn));
      const gone = chunk.filter((inn) => !found.has(inn));
      if (gone.length) {
        // TypeORM answers a DELETE with [rows, count].
        const [, count] = await this.db.query(
          `DELETE FROM public.company_mahalla WHERE inn = ANY($1::text[])`,
          [gone],
        );
        result.removed += Number(count) || 0;
      }
    }
    return result;
  }

  // ── scheduled ────────────────────────────────────────────────────────────

  /**
   * Sunday 04:30: the weekly refresh behind the bank reports. The bank
   * registry goes first — the reports read a company's bank through it —
   * then the OKED classifier (cs.egov.uz too, read by the OKED endpoints),
   * then the whole accreditation register (akkred.uz; its nightly walk takes
   * only the newest changes and leaves Sunday to this), then the open
   * registers (licence, certificate and member lists — `RegistriesSyncService`),
   * then the postal network check (UzPost and EMU, behind the postal codes), then the tax
   * office → SOATO map, which gives the district of every company listed from
   * mysoliq, so the mahalla run reads it fresh. The banks, OKED, the register
   * and the postal check run
   * on deployments whether or not the mahalla fill has started; the map once
   * a real sync has been run by hand; each part reports on its own, so one
   * failing does not silence the others.
   *
   * Every replica fires this cron. One takes `WEEKLY_LOCK` and runs the whole
   * chain; the others do nothing. Each part has its own lock too, but those
   * alone let a replica that found the bank sync taken move straight on and
   * start the mahalla run before another replica had finished the map.
   */
  @Cron('30 4 * * 0', { timeZone: 'Asia/Tashkent' })
  async weekly(): Promise<void> {
    const runner = this.db.createQueryRunner();
    try {
      await runner.connect();
      const rows = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [WEEKLY_LOCK],
      );
      if (rows?.[0]?.locked !== true) return;
      try {
        await this.weeklyChain();
      } finally {
        await runner
          .query('SELECT pg_advisory_unlock($1)', [WEEKLY_LOCK])
          .catch(() => undefined);
      }
    } catch (err) {
      this.logger.error(`[company-mahalla] weekly: ${(err as Error).message}`);
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  private async weeklyChain(): Promise<void> {
    const startedAt = new Date();
    // POST /api/jobs/weekly/stop: the step running finishes (or is stopped
    // on its own), and nothing after it starts.
    const stopped = async (next: string) => {
      if (!(await jobStopRequested(this.db, WEEKLY_JOB, startedAt))) {
        return false;
      }
      this.logger.warn(
        `[company-mahalla] weekly: stopped by hand before ${next}`,
      );
      return true;
    };
    if (bankRegistrySyncEnabled()) {
      // It reports its own failure; the rest still goes.
      await this.banks.run({}, 'weekly').catch(() => undefined);
    }
    if (okedSyncEnabled()) {
      if (await stopped('the OKED classifier')) return;
      await this.oked.run({}, 'weekly').catch(() => undefined);
    }
    if (accreditationSyncEnabled()) {
      if (await stopped('the accreditation register')) return;
      await this.accreditation
        .run({ mode: 'full' }, 'weekly, whole register')
        .catch(() => undefined);
    }
    if (registriesSyncEnabled()) {
      if (await stopped('the open registers')) return;
      await this.registries.weekly().catch(() => undefined);
    }
    if (postcodeWatchEnabled()) {
      if (await stopped('the postal network check')) return;
      await this.postcodeWatch.run({}, 'weekly').catch(() => undefined);
    }
    if (
      nsSoatoSyncEnabled() &&
      (await this.nsMap.started().catch(() => false))
    ) {
      if (await stopped('the tax office map')) return;
      await this.nsMap.run({}, 'weekly').catch(() => undefined);
    }
    if (!companyMahallaCronEnabled()) return;
    if (!(await this.isInitialized(true).catch(() => false))) return;
    if (await stopped('the mahalla run')) return;
    const run = await this.start({}, WEEKLY);
    await run.done;
  }

  // ── the full run ─────────────────────────────────────────────────────────

  /**
   * Takes the lock and starts a run; `done` settles when it has reported. The
   * endpoint answers at once, the cron awaits `done`.
   */
  async start(
    options: RunOptions,
    trigger: string,
  ): Promise<{ started: boolean; reason: string | null; done: Promise<void> }> {
    const idle = Promise.resolve();
    if (this.running) {
      return {
        started: false,
        reason: 'a run is already going here',
        done: idle,
      };
    }

    const runner = this.db.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const rows = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [RUN_LOCK],
      );
      locked = rows?.[0]?.locked === true;
    } catch (err) {
      await runner.release().catch(() => undefined);
      return { started: false, reason: (err as Error).message, done: idle };
    }
    if (!locked) {
      await runner.release().catch(() => undefined);
      return {
        started: false,
        reason: 'another replica is running it',
        done: idle,
      };
    }

    this.running = true;
    const done = this.execute(options, trigger).finally(async () => {
      this.running = false;
      await runner
        .query('SELECT pg_advisory_unlock($1)', [RUN_LOCK])
        .catch(() => undefined);
      await runner.release().catch(() => undefined);
    });
    return { started: true, reason: null, done };
  }

  /** Asks the run to stop after the batch it is on, on whichever replica. */
  async requestStop(): Promise<{ running: boolean }> {
    await this.db.query(
      `UPDATE public.company_mahalla_state
          SET stop_requested = true, updated_at = now()
        WHERE id = 1`,
    );
    return { running: await this.isRunLockHeld() };
  }

  private async execute(options: RunOptions, trigger: string): Promise<void> {
    const dry = options.dry === true;
    const started = new Date();
    try {
      await this.db.query(
        `UPDATE public.company_mahalla_state
            SET run_started_at = now(), run_trigger = $1, stop_requested = false,
                progress = $2, updated_at = now()
          WHERE id = 1`,
        [trigger, JSON.stringify({ phase: 'loading', dry })],
      );

      const matcher = await this.loadMatcher(true);
      const decisions = await this.decideVillageCodes(matcher, dry);
      if (decisions === null) {
        await this.finish(trigger, dry, started, matcher, null, null, true);
        return;
      }
      if (!dry) await this.writeVillageMap(decisions);
      const villageMap = await this.villageMapFor(decisions, dry);

      const totals = await this.resolveAll(matcher, villageMap, dry);
      const stopped = totals === null;

      if (!dry && !stopped) {
        // Companies removed from company_info since the last run.
        await this.db.query(
          `DELETE FROM public.company_mahalla cm
            WHERE NOT EXISTS (
              SELECT 1 FROM public.company_info ci WHERE ci.inn::text = cm.inn)`,
        );
        await this.db.query(
          `UPDATE public.company_mahalla_state
              SET initialized_at = coalesce(initialized_at, now())
            WHERE id = 1`,
        );
        this.initialized = { value: true, at: Date.now() };
      }
      if (!dry) this.villageMap = null;
      await this.finish(
        trigger,
        dry,
        started,
        matcher,
        decisions,
        totals,
        stopped,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `[company-mahalla] run failed (${trigger}): ${(err as Error).stack ?? message}`,
      );
      const [state] = await this.db
        .query(
          `UPDATE public.company_mahalla_state
              SET run_started_at = NULL, updated_at = now()
            WHERE id = 1
          RETURNING progress`,
        )
        .catch(() => [[]]);
      // Where it stopped, so the message says how far it got.
      const progress = state?.[0]?.progress ?? null;
      const text = [
        `❌ <b>Company mahalla (${escapeHtml(trigger)}) — run failed</b>`,
        `Took: ${formatDuration(Date.now() - started.getTime())}` +
          (progress
            ? ` · stopped in: ${escapeHtml(String(progress.phase ?? '?'))}, after ${fmt(Number(progress.scanned ?? 0))} companies`
            : ''),
        `<code>${escapeHtml(message)}</code>`,
        dry
          ? 'It was a dry run — nothing was written.'
          : 'Stored results are untouched; live refresh keeps running.',
      ].join('\n');
      const alertSent = await this.telegram.deliver(text, { tag: 'mahalla' });
      await recordJobRun(this.db, {
        job: JOB,
        trigger,
        dry,
        startedAt: started,
        ok: false,
        summary: text,
        report: { progress },
        error: message,
        alertSent,
      });
    }
  }

  /**
   * Pass one: what every village code carries — its name, the districts its
   * companies are in, and which mahalla their street lines name — then each
   * code's decision. Null when a stop was asked for.
   */
  private async decideVillageCodes(
    matcher: MahallaMatcher,
    dry: boolean,
  ): Promise<VillageMapDecision[] | null> {
    const evidence = new Map<string, VillageCodeEvidence>();
    const at = (code: string) => {
      let ev = evidence.get(code);
      if (!ev) {
        ev = {
          names: new Map(),
          districts: new Map(),
          companies: 0,
          votes: new Map(),
        };
        evidence.set(code, ev);
      }
      return ev;
    };
    const add = (m: Map<string, number>, k: string | null) => {
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    };
    const safe = (district: string | null, text: string | null) => {
      if (!district || !text) return null;
      const m = matcher.resolve(district, text);
      return m.code && m.tier && SAFE_TIERS.has(m.tier) ? m.code : null;
    };

    let lastInn = '';
    let scanned = 0;
    for (;;) {
      const rows: any[] = await this.db.query(
        `${SELECT_INPUTS}
          WHERE ci.inn IS NOT NULL AND ci.inn::text > $1
          ORDER BY ci.inn::text
          LIMIT $2`,
        [lastInn, BATCH],
      );
      if (rows.length === 0) break;
      lastInn = String(rows[rows.length - 1].inn);
      scanned += rows.length;

      for (const r of rows) {
        const c = toInput(r);
        const ciDistrict =
          districtOfSoato(c.soato) ?? districtOfSoato(c.nsSoato);
        const cbuDistrict = districtOfSoato(c.cbuSoato);
        const voted = new Set<string>();

        if (c.villageCode) {
          const ev = at(c.villageCode);
          ev.companies++;
          add(ev.names, c.villageName);
          // Same code on the CBU row means CBU's district is the current one.
          add(
            ev.districts,
            c.cbuVillageCode === c.villageCode && cbuDistrict
              ? cbuDistrict
              : ciDistrict,
          );
          const m = safe(ciDistrict, mahallaFromAddress(c.street));
          if (m) voted.add(`${c.villageCode}|${m}`);
        }
        if (c.cbuVillageCode) {
          const ev = at(c.cbuVillageCode);
          if (c.cbuVillageCode !== c.villageCode) {
            ev.companies++;
            add(ev.districts, cbuDistrict);
          }
          const m = safe(cbuDistrict, mahallaFromAddress(c.cbuStreet));
          if (m) voted.add(`${c.cbuVillageCode}|${m}`);
        }
        for (const v of voted) {
          const [code, mahalla] = v.split('|');
          add(at(code).votes, mahalla);
        }
      }

      await this.progress({ phase: 'village-codes', scanned, dry });
      if (await this.stopRequested()) return null;
    }

    return [...evidence].map(([code, ev]) =>
      decideVillageCode(code, ev, matcher),
    );
  }

  /**
   * The decisions written, except over a person's: a `manual` row keeps its
   * mahalla and status and only has its counts refreshed.
   */
  private async writeVillageMap(
    decisions: VillageMapDecision[],
  ): Promise<void> {
    for (let i = 0; i < decisions.length; i += BATCH) {
      const chunk = decisions.slice(i, i + BATCH);
      await this.db.query(
        `INSERT INTO public.mahalla_village_map AS vm
           (village_code, mahalla_code, status, tier, village_name, district_code,
            companies, street_votes, street_agree)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[],
                              $5::text[], $6::text[], $7::int[], $8::int[], $9::int[])
         ON CONFLICT (village_code) DO UPDATE SET
           mahalla_code  = CASE WHEN vm.status = 'manual' THEN vm.mahalla_code ELSE EXCLUDED.mahalla_code END,
           tier          = CASE WHEN vm.status = 'manual' THEN vm.tier ELSE EXCLUDED.tier END,
           street_agree  = CASE WHEN vm.status = 'manual' THEN vm.street_agree ELSE EXCLUDED.street_agree END,
           status        = CASE WHEN vm.status = 'manual' THEN vm.status ELSE EXCLUDED.status END,
           village_name  = EXCLUDED.village_name,
           district_code = EXCLUDED.district_code,
           companies     = EXCLUDED.companies,
           street_votes  = EXCLUDED.street_votes,
           updated_at    = now()`,
        [
          chunk.map((d) => d.villageCode),
          chunk.map((d) => d.mahallaCode),
          chunk.map((d) => d.status),
          chunk.map((d) => d.tier),
          chunk.map((d) => d.villageName),
          chunk.map((d) => d.districtCode),
          chunk.map((d) => d.companies),
          chunk.map((d) => d.streetVotes),
          chunk.map((d) => d.streetAgree),
        ],
      );
    }
  }

  /** The map the second pass reads: the stored one, or this run's for a dry run. */
  private async villageMapFor(
    decisions: VillageMapDecision[],
    dry: boolean,
  ): Promise<Map<string, VillageMapEntry>> {
    if (!dry) return this.loadVillageMap();
    const map = new Map<string, VillageMapEntry>();
    for (const d of decisions) {
      map.set(d.villageCode, {
        mahallaCode: d.mahallaCode,
        status: d.status,
        tier: d.tier,
        villageName: d.villageName,
      });
    }
    // A person's decisions stand in a dry run too.
    for (const [code, entry] of await this.loadVillageMap()) {
      if (entry.status === 'manual') map.set(code, entry);
    }
    return map;
  }

  /** Pass two: every company resolved and, unless dry, stored. Null if stopped. */
  private async resolveAll(
    matcher: MahallaMatcher,
    villageMap: Map<string, VillageMapEntry>,
    dry: boolean,
  ): Promise<CompanyTotals | null> {
    const totals = emptyTotals();
    const lookup = (code: string) => villageMap.get(code);

    let lastInn = '';
    for (;;) {
      const rows: any[] = await this.db.query(
        `${SELECT_INPUTS}
          WHERE ci.inn IS NOT NULL AND ci.inn::text > $1
          ORDER BY ci.inn::text
          LIMIT $2`,
        [lastInn, BATCH],
      );
      if (rows.length === 0) break;
      lastInn = String(rows[rows.length - 1].inn);

      const results = this.resolveRows(rows, matcher, lookup);
      for (const r of results) {
        totals.scanned++;
        if (r.mahalla_code) totals.withMahalla++;
        if (r.alt_mahalla_code) totals.withAlt++;
        bump(totals.bySource, r.source);
        bump(totals.byTier, r.tier);
        if (r.reason) bump(totals.byReason, r.reason);
        if (r.reason === 'unknown_district') {
          bump(totals.unknownDistricts, r.district_code);
        }
      }
      const written = dry
        ? await this.wouldChange(results)
        : await this.upsert(results);
      totals.inserted += written.inserted;
      totals.updated += written.updated;

      await this.progress({
        phase: 'companies',
        scanned: totals.scanned,
        dry,
      });
      if (await this.stopRequested()) return null;
    }
    return totals;
  }

  /** One result per STIR — company_info is not unique on inn everywhere. */
  private resolveRows(
    rows: any[],
    matcher: MahallaMatcher,
    lookup: (code: string) => VillageMapEntry | undefined,
  ): CompanyMahallaResult[] {
    const seen = new Set<string>();
    const out: CompanyMahallaResult[] = [];
    for (const r of rows) {
      const input = toInput(r);
      if (seen.has(input.inn)) continue;
      seen.add(input.inn);
      out.push(resolveCompanyMahalla(input, matcher, lookup));
    }
    return out;
  }

  private static readonly COLUMNS = [
    'inn',
    'mahalla_code',
    'district_code',
    'region_code',
    'source',
    'tier',
    'matched_name',
    'alt_mahalla_code',
    'reason',
    'tried_name',
  ] as const;

  /** Written only where the answer differs; counts what was new and what moved. */
  private async upsert(
    results: CompanyMahallaResult[],
  ): Promise<{ inserted: number; updated: number }> {
    if (results.length === 0) return { inserted: 0, updated: 0 };
    const cols = CompanyMahallaService.COLUMNS;
    const rows: Array<{ inserted: boolean }> = await this.db.query(
      `INSERT INTO public.company_mahalla AS cm (${cols.join(', ')})
       SELECT * FROM unnest(${cols.map((_, i) => `$${i + 1}::text[]`).join(', ')})
       ON CONFLICT (inn) DO UPDATE SET
         ${cols
           .slice(1)
           .map((c) => `${c} = EXCLUDED.${c}`)
           .join(',\n         ')},
         updated_at = now()
       WHERE (${cols
         .slice(1)
         .map((c) => `cm.${c}`)
         .join(', ')})
             IS DISTINCT FROM
             (${cols
               .slice(1)
               .map((c) => `EXCLUDED.${c}`)
               .join(', ')})
       RETURNING (xmax = 0) AS inserted`,
      cols.map((c) => results.map((r) => r[c] ?? null)),
    );
    const inserted = rows.filter((r) => r.inserted).length;
    return { inserted, updated: rows.length - inserted };
  }

  /** The dry run's version of `upsert`: the same counts, nothing written. */
  private async wouldChange(
    results: CompanyMahallaResult[],
  ): Promise<{ inserted: number; updated: number }> {
    if (results.length === 0) return { inserted: 0, updated: 0 };
    const stored: any[] = await this.db.query(
      `SELECT * FROM public.company_mahalla WHERE inn = ANY($1::text[])`,
      [results.map((r) => r.inn)],
    );
    const byInn = new Map(stored.map((s) => [String(s.inn), s]));
    let inserted = 0;
    let updated = 0;
    for (const r of results) {
      const s = byInn.get(r.inn);
      if (!s) inserted++;
      else if (
        CompanyMahallaService.COLUMNS.slice(1).some(
          (c) => (s[c] ?? null) !== (r[c] ?? null),
        )
      ) {
        updated++;
      }
    }
    return { inserted, updated };
  }

  private async finish(
    trigger: string,
    dry: boolean,
    started: Date,
    matcher: MahallaMatcher,
    decisions: VillageMapDecision[] | null,
    totals: CompanyTotals | null,
    stopped: boolean,
  ): Promise<void> {
    const finished = new Date();
    const byStatus: Record<string, number> = {};
    const byTier: Record<string, number> = {};
    for (const d of decisions ?? []) {
      bump(byStatus, d.status);
      if (d.status === 'auto') bump(byTier, d.tier);
    }
    // The previous real run, to read this one against.
    const [prevRow] = await this.db.query(
      `SELECT last_run FROM public.company_mahalla_state WHERE id = 1`,
    );
    const prevRun = prevRow?.last_run as RunReport | null | undefined;
    const previous =
      prevRun && !prevRun.dry && !prevRun.stopped && prevRun.companies?.scanned
        ? {
            scanned: prevRun.companies.scanned,
            withMahalla: prevRun.companies.withMahalla,
            finishedAt: prevRun.finishedAt,
          }
        : null;

    // The live work since that run, taken and set back to zero in one step,
    // so a refresh landing meanwhile is counted in this report or the next.
    let live: RunReport['live'] = null;
    if (!dry && !stopped) {
      const [rows] = await this.db.query(
        `UPDATE public.company_mahalla_state s
            SET live_resolved = 0, live_changed = 0, live_failed = 0, live_since = now()
           FROM (SELECT live_since, live_resolved, live_changed, live_failed
                   FROM public.company_mahalla_state WHERE id = 1 FOR UPDATE) old
          WHERE s.id = 1
        RETURNING old.live_since, old.live_resolved, old.live_changed, old.live_failed`,
      );
      const o = rows?.[0];
      if (o) {
        live = {
          since: o.live_since ? new Date(o.live_since).toISOString() : null,
          resolved: Number(o.live_resolved) || 0,
          changed: Number(o.live_changed) || 0,
          failed: Number(o.live_failed) || 0,
        };
      }
    }

    const report: RunReport = {
      trigger,
      dry,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      stopped,
      territoryMahallas: matcher.size,
      villageMap: { codes: decisions?.length ?? 0, byStatus, byTier },
      companies: totals ?? emptyTotals(),
      previous,
      live,
    };
    // A dry run leaves last_run alone: it is the baseline the next real
    // run is compared with.
    await this.db.query(
      `UPDATE public.company_mahalla_state
          SET run_started_at = NULL, progress = NULL,
              last_run = CASE WHEN $2 THEN last_run ELSE $1::jsonb END,
              updated_at = now()
        WHERE id = 1`,
      [JSON.stringify(report), dry],
    );
    this.logger.log(
      `[company-mahalla] run finished: ${JSON.stringify(report)}`,
    );
    const text = this.describe(report);
    const alertSent = await this.telegram.deliver(text, { tag: 'mahalla' });
    await recordJobRun(this.db, {
      job: JOB,
      trigger,
      dry,
      startedAt: started,
      finishedAt: finished,
      ok: !stopped,
      summary: text,
      report,
      alertSent,
    });
  }

  private describe(r: RunReport): string {
    const c = r.companies;
    const unknown = Object.entries(c.unknownDistricts).sort(
      (a, b) => b[1] - a[1],
    );
    const head = r.stopped ? '⏹' : r.dry ? '🧪' : unknown.length ? '⚠️' : '✅';
    const list = (
      m: Record<string, number>,
      labels: Record<string, string>,
      skip?: string,
    ) =>
      Object.entries(m)
        .filter(([k]) => k !== skip)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${labels[k] ?? k} ${fmt(v)}`)
        .join(' · ') || '—';

    const coverage = pct(c.withMahalla, c.scanned);
    const before = r.previous
      ? `, previous run: ${pct(r.previous.withMahalla, r.previous.scanned)}`
      : '';
    const lines = [
      `${head} <b>Company mahalla — ${escapeHtml(r.trigger)}</b>` +
        (r.dry ? ' (dry run, nothing written)' : '') +
        (r.stopped ? ' (stopped part-way)' : ''),
      `Took: ${formatDuration(r.durationMs)}`,
      `Companies: ${fmt(c.scanned)} · with a mahalla: ${fmt(c.withMahalla)} (${coverage}${before})`,
      `${r.dry ? 'Would write' : 'Written'}: new ${fmt(c.inserted)} · changed ${fmt(c.updated)}` +
        (c.withAlt ? ` · sources disagree: ${fmt(c.withAlt)}` : ''),
      `Found via: ${list(c.bySource, SOURCE_LABEL, '—')}`,
      `No mahalla: ${list(c.byReason, REASON_LABEL)}`,
    ];
    if (r.live) {
      lines.push(
        `Live since ${r.live.since ? r.live.since.slice(0, 10) : 'the start'}: ` +
          `${fmt(r.live.resolved)} re-resolved · ${fmt(r.live.changed)} changed mahalla` +
          (r.live.failed
            ? ` · ⚠️ ${fmt(r.live.failed)} failed`
            : ' · no failures'),
      );
    }
    const review = r.villageMap.byStatus.review ?? 0;
    lines.push(
      `Village codes: ${fmt(r.villageMap.codes)} — ${list(r.villageMap.byStatus, MAP_STATUS_LABEL)}`,
    );
    if (review) {
      lines.push(
        `👉 ${fmt(review)} codes await review: GET /api/company-mahalla/village-map?status=review`,
      );
    }
    if (unknown.length) {
      // The classifier is behind — a district formed after it was exported.
      lines.push(
        `⚠️ Districts missing from the classifier (reload territory): ` +
          unknown
            .slice(0, 10)
            .map(([d, n]) => `${d} — ${fmt(n)} companies`)
            .join(' · '),
      );
    }
    return lines.join('\n');
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async status(): Promise<Record<string, unknown>> {
    const [state] = await this.db.query(
      `SELECT initialized_at, run_started_at, run_trigger, progress,
              stop_requested, last_run, live_since,
              live_resolved::int AS live_resolved, live_changed::int AS live_changed,
              live_failed::int AS live_failed
         FROM public.company_mahalla_state WHERE id = 1`,
    );
    const [coverage] = await this.db.query(
      `SELECT count(*)::int AS companies,
              count(mahalla_code)::int AS with_mahalla,
              count(alt_mahalla_code)::int AS with_alt,
              max(updated_at) AS last_change
         FROM public.company_mahalla`,
    );
    const bySource = await this.db.query(
      `SELECT coalesce(source, 'none: ' || coalesce(reason, '?')) AS key, count(*)::int AS n
         FROM public.company_mahalla GROUP BY 1 ORDER BY 2 DESC`,
    );
    const unknownDistricts = await this.db.query(
      `SELECT district_code, count(*)::int AS companies
         FROM public.company_mahalla
        WHERE reason = 'unknown_district'
        GROUP BY 1 ORDER BY 2 DESC LIMIT 20`,
    );
    const villageMap = await this.db.query(
      `SELECT status, count(*)::int AS codes, sum(companies)::int AS companies
         FROM public.mahalla_village_map GROUP BY 1 ORDER BY 1`,
    );
    const [territory] = await this.db.query(
      `SELECT count(*) FILTER (WHERE level = 5)::int AS mahallas,
              count(*) FILTER (WHERE level = 3)::int AS districts
         FROM public.territory`,
    );
    return {
      running: await this.isRunLockHeld(),
      running_here: this.running,
      initialized_at: state?.initialized_at ?? null,
      run_started_at: state?.run_started_at ?? null,
      run_trigger: state?.run_trigger ?? null,
      progress: state?.progress ?? null,
      stop_requested: state?.stop_requested ?? false,
      weekly_enabled: companyMahallaCronEnabled(),
      territory,
      coverage,
      by_source: bySource,
      unknown_districts: unknownDistricts,
      village_map: villageMap,
      live_since_last_run: {
        since: state?.live_since ?? null,
        resolved: state?.live_resolved ?? 0,
        moved: state?.live_changed ?? 0,
        failed: state?.live_failed ?? 0,
      },
      last_run: state?.last_run ?? null,
      // Kept whether or not Telegram took them — alert_sent says which.
      recent_runs: await recentJobRuns(this.db, [JOB, JOB_LIVE], 10),
    };
  }

  /** Every step tried for one company, what it would get now, what is stored. */
  async explain(inn: string): Promise<Record<string, unknown>> {
    const matcher = await this.loadMatcher(false);
    const map = await this.loadVillageMap();
    const [row] = await this.db.query(
      `${SELECT_INPUTS} WHERE ci.inn::text = $1 LIMIT 1`,
      [inn],
    );
    if (!row) return { inn, found: false };
    const input = toInput(row);
    const { result, steps } = explainCompanyMahalla(input, matcher, (c) =>
      map.get(c),
    );
    const [stored] = await this.db.query(
      `SELECT * FROM public.company_mahalla WHERE inn = $1`,
      [inn],
    );
    const named = (code: string | null) =>
      code ? { code, name: matcher.nameOf(code) } : null;
    return {
      inn,
      found: true,
      input,
      steps: steps.map((s) => ({
        ...s,
        mahalla_name: s.code ? matcher.nameOf(s.code) : null,
      })),
      now: {
        ...result,
        mahalla: named(result.mahalla_code),
        alt: named(result.alt_mahalla_code),
      },
      stored: stored ?? null,
    };
  }

  /**
   * The names that most often matched nothing, by district — what to look
   * at next. Each group carries one STIR to open with GET /inn/:inn.
   */
  async listUnmatched(
    reason: string,
    limit: number,
    district: string | null,
  ): Promise<{ total: number; groups: any[] }> {
    const [total] = await this.db.query(
      `SELECT count(*)::int AS n FROM public.company_mahalla
        WHERE mahalla_code IS NULL AND reason = $1
          AND ($2::text IS NULL OR district_code = $2)`,
      [reason, district],
    );
    const groups = await this.db.query(
      `SELECT cm.district_code, t.name_latin AS district_name, cm.tried_name,
              count(*)::int AS companies, min(cm.inn) AS example_inn
         FROM public.company_mahalla cm
         LEFT JOIN public.territory t ON t.code = cm.district_code AND t.level = 3
        WHERE cm.mahalla_code IS NULL AND cm.reason = $1
          AND ($3::text IS NULL OR cm.district_code = $3)
        GROUP BY cm.district_code, t.name_latin, cm.tried_name
        ORDER BY companies DESC, cm.district_code, cm.tried_name
        LIMIT $2`,
      [reason, limit, district],
    );
    return { total: total?.n ?? 0, groups };
  }

  async listVillageMap(
    status: VillageMapStatus | null,
    limit: number,
  ): Promise<any[]> {
    return this.db.query(
      `SELECT vm.village_code, vm.status, vm.tier, vm.village_name, vm.district_code,
              vm.mahalla_code, t.name_latin AS mahalla_name, t.district_code AS mahalla_district,
              vm.companies, vm.street_votes, vm.street_agree, vm.updated_at
         FROM public.mahalla_village_map vm
         LEFT JOIN public.territory t ON t.code = vm.mahalla_code
        WHERE ($1::text IS NULL OR vm.status = $1)
        ORDER BY vm.companies DESC, vm.village_code
        LIMIT $2`,
      [status, limit],
    );
  }

  /**
   * A person's decision on village codes. `mahallaCode` null means "this code
   * is no mahalla we can name"; `reset` hands the code back to the fill. The
   * companies carrying the codes are resolved again before this answers.
   * Other replicas pick the change up when their copy of the map expires.
   */
  async setVillageMappings(
    items: Array<{
      villageCode: string;
      mahallaCode: string | null;
      reset: boolean;
    }>,
  ): Promise<{ saved: number; reset: number } & RefreshResult> {
    let saved = 0;
    let reset = 0;
    for (const it of items) {
      if (it.reset) {
        // TypeORM answers an UPDATE with [rows, count], not rows.
        const [, count] = await this.db.query(
          `UPDATE public.mahalla_village_map
              SET status = 'none', mahalla_code = NULL, tier = NULL, updated_at = now()
            WHERE village_code = $1 AND status = 'manual'`,
          [it.villageCode],
        );
        reset += Number(count) || 0;
        continue;
      }
      await this.db.query(
        `INSERT INTO public.mahalla_village_map (village_code, mahalla_code, status, tier)
         VALUES ($1, $2, 'manual', 'manual')
         ON CONFLICT (village_code) DO UPDATE SET
           mahalla_code = EXCLUDED.mahalla_code, status = 'manual', tier = 'manual',
           updated_at = now()`,
        [it.villageCode, it.mahallaCode],
      );
      saved++;
    }
    this.villageMap = null;
    const affected: Array<{ inn: string }> = await this.db.query(
      `SELECT inn::text AS inn FROM public.company_info
        WHERE village_code::text = ANY($1::text[])
       UNION
       SELECT inn::text FROM public.company_addresses
        WHERE address_type = 'billing' AND village_code::text = ANY($1::text[])`,
      [items.map((i) => i.villageCode)],
    );
    const refreshed = await this.refreshInns(affected.map((a) => a.inn));
    return { saved, reset, ...refreshed };
  }

  /** Which of `codes` exist as mahallas — for validating a manual mapping. */
  async existingMahallas(codes: string[]): Promise<Set<string>> {
    const rows: Array<{ code: string }> = await this.db.query(
      `SELECT code FROM public.territory WHERE level = 5 AND code = ANY($1::text[])`,
      [codes],
    );
    return new Set(rows.map((r) => r.code));
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  /** The classifier, read once per process and again at each full run. */
  private async loadMatcher(fresh: boolean): Promise<MahallaMatcher> {
    if (this.matcher && !fresh) return this.matcher;
    const [mahallas, districts] = await Promise.all([
      this.db.query(
        `SELECT code, district_code, region_code, name_latin, name_cyrl, name_ru
           FROM public.territory WHERE level = 5`,
      ),
      this.db.query(
        `SELECT code, region_code FROM public.territory WHERE level = 3`,
      ),
    ]);
    const matcher = new MahallaMatcher(mahallas ?? [], districts ?? []);
    if (matcher.size === 0) {
      throw new Error(
        'public.territory holds no mahallas — load it with scripts/load-territory.js first',
      );
    }
    this.matcher = matcher;
    return matcher;
  }

  private async loadVillageMap(): Promise<Map<string, VillageMapEntry>> {
    const rows: any[] = await this.db.query(
      `SELECT village_code, mahalla_code, status, tier, village_name
         FROM public.mahalla_village_map`,
    );
    return new Map(
      rows.map((r) => [
        String(r.village_code),
        {
          mahallaCode: r.mahalla_code ?? null,
          status: r.status as VillageMapStatus,
          tier: r.tier ?? null,
          villageName: r.village_name ?? null,
        },
      ]),
    );
  }

  private async cachedVillageMap(): Promise<Map<string, VillageMapEntry>> {
    if (this.villageMap && Date.now() - this.villageMap.at < MAP_TTL_MS) {
      return this.villageMap.map;
    }
    const map = await this.loadVillageMap();
    this.villageMap = { map, at: Date.now() };
    return map;
  }

  /** Once true it stays true; a false answer is asked again after a minute. */
  private async isInitialized(fresh = false): Promise<boolean> {
    if (
      !fresh &&
      this.initialized &&
      (this.initialized.value ||
        Date.now() - this.initialized.at < INIT_RECHECK_MS)
    ) {
      return this.initialized.value;
    }
    const [row] = await this.db.query(
      `SELECT initialized_at FROM public.company_mahalla_state WHERE id = 1`,
    );
    const value = Boolean(row?.initialized_at);
    this.initialized = { value, at: Date.now() };
    return value;
  }

  private async progress(p: Record<string, unknown>): Promise<void> {
    await this.db.query(
      `UPDATE public.company_mahalla_state SET progress = $1, updated_at = now() WHERE id = 1`,
      [JSON.stringify(p)],
    );
  }

  private async stopRequested(): Promise<boolean> {
    const [row] = await this.db.query(
      `SELECT stop_requested FROM public.company_mahalla_state WHERE id = 1`,
    );
    return row?.stop_requested === true;
  }

  private async isRunLockHeld(): Promise<boolean> {
    const [row] = await this.db.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND objid = $1 AND granted
       ) AS held`,
      [RUN_LOCK],
    );
    return row?.held === true;
  }
}
