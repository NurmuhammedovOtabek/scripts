import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import {
  logChanges,
  logFieldChanges,
  presentOnly,
} from '../../common/change-log';
import { tashkentDay } from '../../common/tashkent-time';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recentJobRuns, recordJobRun } from '../common/job-runs';
import {
  OPENINFO_API,
  OpeninfoClient,
  OpeninfoHttpError,
  portalRefused,
} from './openinfo-client';
import {
  OiAccountingReport,
  OiFactDetailResponse,
  OiFactListItem,
  OiOrganization,
  contentHash,
  factContentOf,
  mapFactListItem,
  mapOrganization,
  reportLines,
} from './openinfo-map';

/** Held by a session; the replica that takes it runs and reports. */
export const LOCK_ID = 8_150_946;
export const JOB = 'openinfo';
const SOURCE = 'openinfo.uz';

/** 812 organisations on 2026-10-16; fewer than this is a cut-off answer. */
const MIN_ORGANIZATIONS = 500;
/** An organisation's fields we show and log; a blank from the portal keeps ours. */
const ORG_FIELDS = [
  'inn',
  'full_name',
  'short_name',
  'ticker',
  'is_listing',
  'listing_date',
] as const;
/** The nightly fact contents: until 05:50 when started at 03:20. */
const NIGHTLY_DETAIL_BUDGET_MS = 2.5 * 60 * 60_000;
/** The daily list re-reads this many days before the newest fact held. */
const FACT_OVERLAP_DAYS = 2;
/** This many fact contents failing in a row is an outage; the rest waits. */
const DETAIL_OUTAGE = 10;
const DETAIL_BATCH = 50;
/** How long after boot an empty table is filled — the app settles first. */
const FIRST_FILL_DELAY_MS = 60_000;
const EXAMPLES = 8;

/**
 * - `daily`: organisations, the facts published since the newest held (two
 *   days back), then fact contents newest first until the night's budget;
 * - `weekly`: organisations, indicators and the annual statements of each;
 * - `full`: all of it — the first fill of an environment;
 * - `company`: one company (by STIR) — its facts, every content, its
 *   statements. By hand, for checking one company.
 */
export type OpeninfoSyncMode = 'daily' | 'weekly' | 'full' | 'company';

export interface OpeninfoSyncOptions {
  mode: OpeninfoSyncMode;
  /** `company` mode: the STIR. */
  inn?: string;
  /** Fact contents to read at most this run (by hand: a trial). */
  detailLimit?: number;
  detailBudgetMs?: number;
}

export interface OpeninfoSyncResult {
  mode: OpeninfoSyncMode;
  inn: string | null;
  organizations: {
    sourceCount: number;
    read: number;
    inserted: number;
    changed: number;
    delisted: number;
    withoutStir: number;
  } | null;
  facts: {
    since: string | null;
    sourceCount: number;
    read: number;
    inserted: number;
    pages: number;
    /** The whole fact list was read to its end (no `since`, no stop). */
    whole?: boolean;
  } | null;
  details: {
    read: number;
    missing: number;
    failed: number;
    pending: number;
    stopReason: 'outage' | 'time budget' | 'limit' | 'stopped' | null;
  } | null;
  statements: {
    organizations: number;
    indicators: number;
    reports: number;
    changed: number;
    /** Organisations where a part could not be asked (network, 5xx). */
    failed: number;
    /** Parts the portal itself could not give (4xx) — not our failure. */
    refused: number;
    /** Those refusals by the portal's own reason. */
    refusedReasons: Record<string, number>;
    /** Indicator rows for a quarter (micro-finance) — not kept. */
    quarterlySkipped: number;
    examples: string[];
  } | null;
  elapsedMs: number;
}

/**
 * Whether openinfo.uz is synced here: on a deployment (TG_WEBHOOK_URL set —
 * dev and prod), not on a laptop. `OPENINFO_SYNC_ENABLED=1|0` overrides.
 */
export function openinfoSyncEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.OPENINFO_SYNC_ENABLED === '1') return true;
  if (env.OPENINFO_SYNC_ENABLED === '0') return false;
  return Boolean(env.TG_WEBHOOK_URL);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const fmt = (n: number) => n.toLocaleString('en-US');

function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return `${Math.round(ms / 1000)} s`;
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

/**
 * Keeps a copy of openinfo.uz, the disclosure portal of joint-stock companies
 * (812 organisations on 2026-10-16): the organisations, their material facts,
 * yearly indicators and annual statements (forms 1 and 2). The company page
 * reads it (`src/org/openinfo`).
 *
 * - **03:20 (Tashkent) daily**: the organisation list (nine requests), the
 *   facts published since the newest held (about 16 a day), then each fact's
 *   content — the list carries only its type, title and date — newest first
 *   until 05:50. 65,643 facts on 2026-10-16 at one request each make the
 *   first pass about ten nights; after that a night reads the day's dozen.
 * - **Sunday 00:30**: indicators and the annual statements of every
 *   organisation (three requests each, about an hour).
 * - **A minute after boot when the tables are empty**: all of the above but
 *   the contents, which the nights read.
 * - A reader opening a fact whose content is not read yet gets it read then
 *   (`OpeninfoService`), through the same client and its pacing.
 *
 * One request every 1.5 s across the process. Nothing the portal stops
 * listing is deleted. Reported to Telegram and `job_runs` every run.
 */
@Injectable()
export class OpeninfoSyncService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OpeninfoSyncService.name);
  private firstFill: NodeJS.Timeout | null = null;
  private stopRequested = false;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly telegram: TelegramAlertService,
    private readonly client: OpeninfoClient,
  ) {}

  onApplicationBootstrap(): void {
    if (!openinfoSyncEnabled()) return;
    this.firstFill = setTimeout(() => {
      this.firstFill = null;
      void this.fillIfEmpty();
    }, FIRST_FILL_DELAY_MS);
    this.firstFill.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstFill) clearTimeout(this.firstFill);
  }

  async fillIfEmpty(): Promise<void> {
    try {
      const [{ n }] = await this.db.query(
        'SELECT count(*)::int AS n FROM public.openinfo_organizations',
      );
      if (n > 0) return;
      await this.run({ mode: 'full', detailLimit: 0 }, 'first fill');
    } catch (err) {
      this.logger.warn(`[openinfo] first fill: ${(err as Error).message}`);
    }
  }

  @Cron('20 3 * * *', { timeZone: 'Asia/Tashkent' })
  async daily(): Promise<void> {
    if (!openinfoSyncEnabled()) return;
    try {
      await this.run({ mode: 'daily' }, 'daily');
    } catch {
      // Reported by `run`.
    }
  }

  @Cron('30 0 * * 0', { timeZone: 'Asia/Tashkent' })
  async weekly(): Promise<void> {
    if (!openinfoSyncEnabled()) return;
    try {
      await this.run({ mode: 'weekly' }, 'weekly');
    } catch {
      // Reported by `run`.
    }
  }

  /** Ends a running walk at its next request (on this replica). */
  requestStop(): void {
    this.stopRequested = true;
  }

  async run(
    opts: OpeninfoSyncOptions,
    trigger: string,
  ): Promise<OpeninfoSyncResult | null> {
    return (await this.start(opts, trigger)).done;
  }

  async start(
    opts: OpeninfoSyncOptions,
    trigger: string,
  ): Promise<{
    started: boolean;
    reason: string | null;
    done: Promise<OpeninfoSyncResult | null>;
  }> {
    const idle = Promise.resolve(null);
    const runner = this.db.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const [row] = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [LOCK_ID],
      );
      locked = row?.locked === true;
    } catch (err) {
      await runner.release().catch(() => undefined);
      return { started: false, reason: (err as Error).message, done: idle };
    }
    if (!locked) {
      await runner.release().catch(() => undefined);
      this.logger.log(
        `[openinfo] ${trigger}: skipped — another replica is syncing`,
      );
      return {
        started: false,
        reason: 'another replica is syncing',
        done: idle,
      };
    }
    this.stopRequested = false;
    const done = this.execute(opts, trigger).finally(async () => {
      await runner
        .query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
        .catch(() => undefined);
      await runner.release().catch(() => undefined);
    });
    return { started: true, reason: null, done };
  }

  private async execute(
    opts: OpeninfoSyncOptions,
    trigger: string,
  ): Promise<OpeninfoSyncResult> {
    const startedAt = new Date();
    try {
      const result = await this.sync(opts);
      const text = this.describe(result, trigger);
      const alertSent = await this.telegram.deliver(text, { tag: 'openinfo' });
      await recordJobRun(this.db, {
        job: JOB,
        trigger,
        startedAt,
        ok: true,
        summary: text,
        report: result,
        alertSent,
      });
      return result;
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`[openinfo] ${trigger}: sync failed — ${message}`);
      const text = [
        `❌ <b>openinfo.uz (${escapeHtml(trigger)}) — sync failed</b>`,
        `<code>${escapeHtml(message)}</code>`,
        'What was written before the failure stays. Retry by hand: POST /api/openinfo-sync/run',
      ].join('\n');
      const alertSent = await this.telegram.deliver(text, { tag: 'openinfo' });
      await recordJobRun(this.db, {
        job: JOB,
        trigger,
        startedAt,
        ok: false,
        summary: text,
        error: message,
        alertSent,
      });
      throw err;
    }
  }

  private async sync(opts: OpeninfoSyncOptions): Promise<OpeninfoSyncResult> {
    const t0 = Date.now();
    const result: OpeninfoSyncResult = {
      mode: opts.mode,
      inn: opts.inn ?? null,
      organizations: null,
      facts: null,
      details: null,
      statements: null,
      elapsedMs: 0,
    };

    if (opts.mode === 'company') {
      if (!opts.inn) throw new Error('company mode needs a STIR');
      let orgIds = await this.orgIdsOf(opts.inn);
      if (orgIds.length === 0) {
        result.organizations = await this.syncOrganizations();
        orgIds = await this.orgIdsOf(opts.inn);
      }
      if (orgIds.length === 0) {
        throw new Error(
          `STIR ${opts.inn} is not among the portal's organisations`,
        );
      }
      result.facts = await this.syncFacts({ orgIds });
      result.statements = await this.syncStatements(orgIds);
      result.details = await this.readDetails({
        orgIds,
        budgetMs: opts.detailBudgetMs ?? 60 * 60_000,
        limit: opts.detailLimit,
      });
    } else {
      result.organizations = await this.syncOrganizations();
      if (opts.mode === 'daily' || opts.mode === 'full') {
        result.facts = await this.syncFacts({
          since: opts.mode === 'daily' ? await this.factsSince() : null,
        });
      }
      if (opts.mode === 'weekly' || opts.mode === 'full') {
        const all: Array<{ org_id: number }> = await this.db.query(
          `SELECT org_id FROM public.openinfo_organizations
            WHERE delisted_at IS NULL ORDER BY org_id`,
        );
        result.statements = await this.syncStatements(all.map((r) => r.org_id));
      }
      if (
        opts.mode === 'daily' ||
        (opts.mode === 'full' && opts.detailLimit !== 0)
      ) {
        result.details = await this.readDetails({
          budgetMs: opts.detailBudgetMs ?? NIGHTLY_DETAIL_BUDGET_MS,
          limit: opts.detailLimit,
        });
      }
    }
    result.elapsedMs = Date.now() - t0;
    return result;
  }

  private async orgIdsOf(inn: string): Promise<number[]> {
    const rows: Array<{ org_id: number }> = await this.db.query(
      'SELECT org_id FROM public.openinfo_organizations WHERE inn = $1 ORDER BY org_id',
      [inn],
    );
    return rows.map((r) => r.org_id);
  }

  /**
   * The newest fact held, less the overlap — null (the whole list) when none
   * is held, or until the whole list has once been read to its end. Facts are
   * written page by page, so a first read cut short leaves the newest facts
   * stored and older pages not: reading only "since the newest" after it
   * would never come back for them.
   */
  private async factsSince(): Promise<string | null> {
    const [whole] = await this.db.query(
      `SELECT 1 FROM public.job_runs
        WHERE job = $1 AND ok
          AND (report->'facts'->>'whole' = 'true'
               -- before page-by-page writes, an ok run with no 'since' had read it all
               OR (report->'facts' ? 'since'
                   AND report->'facts'->>'since' IS NULL
                   AND NOT report->'facts' ? 'whole'
                   AND report->>'mode' IN ('daily', 'full')))
        LIMIT 1`,
      [JOB],
    );
    if (!whole) return null;
    const [row] = await this.db.query(
      'SELECT max(pub_date) AS newest FROM public.openinfo_facts',
    );
    if (!row?.newest) return null;
    const newest = new Date(row.newest);
    return tashkentDay(
      new Date(newest.getTime() - FACT_OVERLAP_DAYS * 24 * 60 * 60_000),
    );
  }

  /**
   * The portal's organisation list. A new one is inserted; a changed one is
   * rewritten after its replaced name, ticker or listing are logged. One the
   * full list no longer carries is marked `delisted_at`, never deleted.
   */
  async syncOrganizations(): Promise<
    NonNullable<OpeninfoSyncResult['organizations']>
  > {
    const runStart = new Date();
    const { count, rows } = await this.client.all<OiOrganization>(
      'organizations/organizations/',
    );
    if (rows.length < MIN_ORGANIZATIONS) {
      throw new Error(
        `organisation list cut off: ${rows.length} read, ${count} listed (at least ${MIN_ORGANIZATIONS} expected)`,
      );
    }
    let inserted = 0;
    let changed = 0;
    let withoutStir = 0;
    for (const raw of rows) {
      const row = mapOrganization(raw);
      if (!Number.isInteger(row.org_id)) continue;
      if (!row.inn) withoutStir++;
      const [held] = await this.db.query(
        `SELECT inn, full_name, short_name, ticker, is_listing,
                listing_date::text AS listing_date, content_hash
           FROM public.openinfo_organizations WHERE org_id = $1`,
        [row.org_id],
      );
      if (!held) {
        await this.db.query(
          `INSERT INTO public.openinfo_organizations
             (org_id, inn, full_name, short_name, ticker, is_listing,
              listing_date, raw, content_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7::date, $8::jsonb, $9)
           ON CONFLICT (org_id) DO NOTHING`,
          [
            row.org_id,
            row.inn,
            row.full_name,
            row.short_name,
            row.ticker,
            row.is_listing,
            row.listing_date,
            JSON.stringify(row.raw),
            row.content_hash,
          ],
        );
        inserted++;
        continue;
      }
      if (held.content_hash === row.content_hash) {
        await this.db.query(
          `UPDATE public.openinfo_organizations
              SET last_seen_at = now(), delisted_at = NULL
            WHERE org_id = $1`,
          [row.org_id],
        );
        continue;
      }
      await this.db.transaction(async (tx) => {
        await logFieldChanges(
          tx,
          {
            entity: 'openinfo_organizations',
            inn: row.inn ?? held.inn ?? null,
            key: String(row.org_id),
            source: SOURCE,
          },
          held,
          // A blank the portal sends changes nothing (below), so it is no
          // change to log either.
          presentOnly(row as unknown as Record<string, unknown>, ORG_FIELDS),
          ORG_FIELDS,
        );
        // Never erase on a source gap (user rule): a STIR, name, ticker or
        // listing the portal now leaves blank keeps what we hold. `inn = $2`
        // would have untied a company from its disclosures on one empty
        // answer (review 2026-10-21).
        await tx.query(
          `UPDATE public.openinfo_organizations
              SET inn = COALESCE($2, inn),
                  full_name = COALESCE($3, full_name),
                  short_name = COALESCE($4, short_name),
                  ticker = COALESCE($5, ticker),
                  is_listing = COALESCE($6, is_listing),
                  listing_date = COALESCE($7::date, listing_date),
                  raw = $8::jsonb,
                  content_hash = $9, updated_at = now(), last_seen_at = now(),
                  delisted_at = NULL
            WHERE org_id = $1`,
          [
            row.org_id,
            row.inn,
            row.full_name,
            row.short_name,
            row.ticker,
            row.is_listing,
            row.listing_date,
            JSON.stringify(row.raw),
            row.content_hash,
          ],
        );
      });
      changed++;
    }
    // Only a whole list says who is gone. A list that stopped short of the
    // portal's own count (a page that answered 404, a `next` missing midway)
    // marked every organisation after the break as no longer listed.
    let delisted = 0;
    if (count && rows.length < count) {
      this.logger.warn(
        `[openinfo] organisation list read ${rows.length} of ${count} — nothing marked as no longer listed`,
      );
    } else {
      const [, n] = await this.db.query(
        `UPDATE public.openinfo_organizations
            SET delisted_at = now()
          WHERE delisted_at IS NULL AND last_seen_at < $1`,
        [runStart],
      );
      delisted = Number(n) || 0;
    }
    return {
      sourceCount: count,
      read: rows.length,
      inserted,
      changed,
      delisted,
      withoutStir,
    };
  }

  /**
   * The fact list: everything (`since` null), the facts published since a
   * day, or every fact of some organisations. A fact held is refreshed (its
   * title, status, date); its content is read separately.
   */
  async syncFacts(scope: {
    since?: string | null;
    orgIds?: number[];
  }): Promise<NonNullable<OpeninfoSyncResult['facts']>> {
    let sourceCount = 0;
    let read = 0;
    let inserted = 0;
    let pages = 0;
    let ended = true;
    const lists = scope.orgIds?.length
      ? scope.orgIds.map((id) => ({ organization_id: id }))
      : [{ pub_date__gte: scope.since ?? undefined }];
    for (const params of lists) {
      // Written page by page (review 2026-10-21): the whole list (~65k
      // facts, ~650 pages at the portal's pace) used to be held in memory
      // for 16 minutes and written only at the end, so one page failing
      // three times lost all of it.
      const got = await this.client.eachPage<OiFactListItem>(
        'disclosure/facts/',
        params,
        async (page) => {
          for (const raw of page) {
            const row = mapFactListItem(raw);
            if (!row) continue;
            read++;
            const [res] = await this.db.query(
              `INSERT INTO public.openinfo_facts
             (id, org_id, fact_number, object_id, title, short_title,
              pub_date, status, list_raw)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, $9::jsonb)
           ON CONFLICT (id) DO UPDATE
              SET org_id = excluded.org_id,
                  fact_number = excluded.fact_number,
                  object_id = COALESCE(excluded.object_id, openinfo_facts.object_id),
                  title = COALESCE(excluded.title, openinfo_facts.title),
                  short_title = COALESCE(excluded.short_title, openinfo_facts.short_title),
                  pub_date = COALESCE(excluded.pub_date, openinfo_facts.pub_date),
                  status = COALESCE(excluded.status, openinfo_facts.status),
                  list_raw = excluded.list_raw,
                  last_seen_at = now()
           RETURNING (xmax = 0) AS inserted`,
              [
                row.id,
                row.org_id,
                row.fact_number,
                row.object_id,
                row.title,
                row.short_title,
                row.pub_date,
                row.status,
                JSON.stringify(row.list_raw),
              ],
            );
            if (res?.inserted) inserted++;
          }
          return this.stopRequested ? false : undefined;
        },
      );
      sourceCount += got.count;
      pages += got.pages;
      if (!got.ended) ended = false;
      if (this.stopRequested) break;
    }
    return {
      since: scope.since ?? null,
      sourceCount,
      read,
      inserted,
      pages,
      whole: !scope.since && !scope.orgIds?.length && ended,
    };
  }

  /**
   * Reads one fact's content and stores it. `missing` when the portal has no
   * such fact any more (404, or an answer with no fact) — not asked again.
   * Throws when the portal could not be asked.
   */
  async fetchDetail(
    id: number,
    opts: { attempts?: number; timeoutMs?: number } = {},
  ): Promise<{
    state: 'read' | 'missing';
    detail: Record<string, unknown> | null;
  }> {
    const body = await this.client.get<OiFactDetailResponse>(
      `disclosure/facts/${id}/`,
      {},
      opts,
    );
    const detail = factContentOf(body);
    if (!detail) {
      await this.db.query(
        `UPDATE public.openinfo_facts SET detail_missing_at = now() WHERE id = $1`,
        [id],
      );
      return { state: 'missing', detail: null };
    }
    await this.db.query(
      `UPDATE public.openinfo_facts
          SET detail = $2::jsonb, detail_fetched_at = now(),
              detail_missing_at = NULL
        WHERE id = $1`,
      [id, JSON.stringify(detail)],
    );
    return { state: 'read', detail };
  }

  /** Fact contents not read yet, newest first, until the budget or limit. */
  private async readDetails(opts: {
    orgIds?: number[];
    budgetMs: number;
    limit?: number;
  }): Promise<NonNullable<OpeninfoSyncResult['details']>> {
    const deadline = Date.now() + opts.budgetMs;
    let read = 0;
    let missing = 0;
    let failed = 0;
    let failedInRow = 0;
    let stopReason: NonNullable<OpeninfoSyncResult['details']>['stopReason'] =
      null;
    const tried = new Set<number>();
    const scope = opts.orgIds?.length ? 'AND org_id = ANY($2::int[])' : '';
    outer: for (;;) {
      const params: unknown[] = [[...tried]];
      if (scope) params.push(opts.orgIds);
      const batch: Array<{ id: number }> = await this.db.query(
        `SELECT id FROM public.openinfo_facts
          WHERE detail_fetched_at IS NULL AND detail_missing_at IS NULL
            AND NOT (id = ANY($1::int[])) ${scope}
          ORDER BY pub_date DESC NULLS LAST, id DESC
          LIMIT ${DETAIL_BATCH}`,
        params,
      );
      if (batch.length === 0) break;
      for (const { id } of batch) {
        if (this.stopRequested) {
          stopReason = 'stopped';
          break outer;
        }
        if (opts.limit !== undefined && read + missing >= opts.limit) {
          stopReason = 'limit';
          break outer;
        }
        if (Date.now() >= deadline) {
          stopReason = 'time budget';
          break outer;
        }
        tried.add(id);
        try {
          const got = await this.fetchDetail(id);
          if (got.state === 'read') read++;
          else missing++;
          failedInRow = 0;
        } catch (err) {
          failed++;
          failedInRow++;
          this.logger.warn(`[openinfo] fact ${id}: ${(err as Error).message}`);
          if (failedInRow >= DETAIL_OUTAGE) {
            stopReason = 'outage';
            break outer;
          }
        }
      }
    }
    const [{ pending }] = await this.db.query(
      `SELECT count(*)::int AS pending FROM public.openinfo_facts
        WHERE detail_fetched_at IS NULL AND detail_missing_at IS NULL`,
    );
    return { read, missing, failed, pending, stopReason };
  }

  /**
   * Indicators and the annual statements (forms 1 and 2) of each
   * organisation, each part on its own: the portal's indicator calculation
   * fails for some companies (HTTP 400) while their statements read fine.
   * A year that changed is rewritten after the values it replaces are
   * logged; a year the portal stops giving is kept. Quarterly statements are
   * not read: the portal gives two a year with no quarter.
   */
  async syncStatements(
    orgIds: number[],
  ): Promise<NonNullable<OpeninfoSyncResult['statements']>> {
    let indicators = 0;
    let reports = 0;
    let changed = 0;
    let failed = 0;
    let refused = 0;
    let quarterlySkipped = 0;
    const refusedReasons: Record<string, number> = {};
    const examples: string[] = [];
    for (const orgId of orgIds) {
      if (this.stopRequested) break;
      const [org] = await this.db.query(
        'SELECT inn FROM public.openinfo_organizations WHERE org_id = $1',
        [orgId],
      );
      const inn: string | null = org?.inn ?? null;
      let orgFailed = false;
      const part = async (name: string, read: () => Promise<void>) => {
        try {
          await read();
        } catch (err) {
          const message = `[openinfo] ${name} of org ${orgId}: ${(err as Error).message}`;
          if (portalRefused(err)) {
            refused++;
            const reason = (err as OpeninfoHttpError).detail ?? 'HTTP 4xx';
            refusedReasons[reason] = (refusedReasons[reason] ?? 0) + 1;
            this.logger.log(message);
          } else {
            orgFailed = true;
            this.logger.warn(message);
          }
        }
      };
      await part('indicators', async () => {
        const body = await this.client.get<{
          results?: Array<Record<string, unknown>>;
        }>('reports/financial_indicators/', { organization_id: orgId });
        for (const r of body?.results ?? []) {
          const year = Number(r.reporting_year);
          if (!Number.isInteger(year)) continue;
          // Micro-finance organisations get a row per quarter (codes like
          // "7", two for one year): kept per year they would overwrite each
          // other and read as the year's figure.
          if (
            r.quarter !== undefined &&
            r.quarter !== null &&
            r.quarter !== ''
          ) {
            quarterlySkipped++;
            continue;
          }
          const values = Object.fromEntries(
            Object.entries(r).filter(([k]) => k !== 'reporting_year'),
          );
          const out = await this.upsertYear(
            'openinfo_indicators',
            { org_id: orgId, year },
            { values },
            inn,
            `indicators ${year}`,
          );
          indicators++;
          if (out === 'changed') changed++;
        }
      });
      for (const form of ['form1', 'form2'] as const) {
        await part(form, async () => {
          const list = await this.client.get<OiAccountingReport[]>(
            `reports/accounting-report/${orgId}/`,
            { accounting_type: form, report_type: 'annual' },
          );
          // Two statements for one year: the later one is the correction.
          const byYear = new Map<number, OiAccountingReport>();
          for (const rep of Array.isArray(list) ? list : []) {
            const year = Number(rep.reporting_year);
            if (!Number.isInteger(year)) continue;
            const prev = byYear.get(year);
            if (!prev || rep.id > prev.id) byYear.set(year, rep);
          }
          for (const [year, rep] of byYear) {
            const out = await this.upsertYear(
              'openinfo_reports',
              { org_id: orgId, form, year },
              { report_id: rep.id, lines: reportLines(rep) },
              inn,
              `${form} ${year}`,
            );
            reports++;
            if (out === 'changed') {
              changed++;
              if (examples.length < EXAMPLES) {
                examples.push(`${inn ?? `org ${orgId}`} ${form} ${year}`);
              }
            }
          }
        });
      }
      if (orgFailed) failed++;
    }
    return {
      organizations: orgIds.length,
      indicators,
      reports,
      changed,
      failed,
      refused,
      refusedReasons,
      quarterlySkipped,
      examples,
    };
  }

  /** One year of indicators or one statement: inserted, rewritten (logged), or seen. */
  private async upsertYear(
    table: 'openinfo_indicators' | 'openinfo_reports',
    key: Record<string, string | number>,
    data: { values?: unknown; lines?: unknown; report_id?: number },
    inn: string | null,
    field: string,
  ): Promise<'inserted' | 'changed' | 'same'> {
    const payload = data.values ?? data.lines;
    const hash = contentHash(payload);
    const keyCols = Object.keys(key);
    const where = keyCols.map((c, i) => `${c} = $${i + 1}`).join(' AND ');
    const keyVals = keyCols.map((c) => key[c]);
    const column = table === 'openinfo_indicators' ? '"values"' : 'lines';
    const [held] = await this.db.query(
      `SELECT content_hash, ${column} AS payload FROM public.${table} WHERE ${where}`,
      keyVals,
    );
    if (held?.content_hash === hash) {
      await this.db.query(
        `UPDATE public.${table} SET last_seen_at = now() WHERE ${where}`,
        keyVals,
      );
      return 'same';
    }
    const extraCols = table === 'openinfo_reports' ? ', report_id' : '';
    const extraVals =
      table === 'openinfo_reports' ? [data.report_id ?? null] : [];
    const n = keyCols.length;
    if (!held) {
      await this.db.query(
        `INSERT INTO public.${table} (${keyCols.join(', ')}, ${column}, content_hash${extraCols})
         VALUES (${keyCols.map((_, i) => `$${i + 1}`).join(', ')}, $${n + 1}::jsonb, $${n + 2}${extraCols ? `, $${n + 3}` : ''})
         ON CONFLICT DO NOTHING`,
        [...keyVals, JSON.stringify(payload), hash, ...extraVals],
      );
      return 'inserted';
    }
    await this.db.transaction(async (tx) => {
      await logChanges(
        tx,
        { entity: table, inn, key: keyVals.join(':'), source: SOURCE },
        [{ field, old: held.payload, new: payload }],
      );
      await tx.query(
        `UPDATE public.${table}
            SET ${column} = $${n + 1}::jsonb, content_hash = $${n + 2},
                ${extraCols ? `report_id = $${n + 3},` : ''}
                updated_at = now(), last_seen_at = now()
          WHERE ${where}`,
        [...keyVals, JSON.stringify(payload), hash, ...extraVals],
      );
    });
    return 'changed';
  }

  describe(r: OpeninfoSyncResult, trigger: string): string {
    const warn =
      (r.organizations && r.organizations.read === 0) ||
      (r.facts && r.facts.pages === 0) ||
      r.details?.stopReason === 'outage' ||
      (r.statements && r.statements.failed > 0);
    const lines = [
      `${warn ? '⚠️' : '✅'} <b>openinfo.uz (${escapeHtml(trigger)}${r.inn ? `, ${r.inn}` : ''})</b>`,
    ];
    if (r.organizations) {
      const o = r.organizations;
      lines.push(
        `Organisations: ${fmt(o.read)} read of ${fmt(o.sourceCount)} — ${o.inserted} new, ${o.changed} changed, ${o.delisted} no longer listed, ${o.withoutStir} without a STIR`,
      );
    }
    if (r.facts) {
      const f = r.facts;
      lines.push(
        `Facts${f.since ? ` since ${f.since}` : ''}: ${fmt(f.read)} read (${f.pages} pages), ${fmt(f.inserted)} new`,
      );
    }
    if (r.details) {
      const d = r.details;
      lines.push(
        `Fact contents: ${fmt(d.read)} read, ${d.missing} gone at the source, ${d.failed} failed — ${fmt(d.pending)} still to read${d.stopReason ? ` (stopped: ${d.stopReason})` : ''}`,
      );
    }
    if (r.statements) {
      const s = r.statements;
      lines.push(
        `Statements: ${s.organizations} organisations — ${fmt(s.indicators)} indicator years, ${fmt(s.reports)} annual statements, ${s.changed} changed, ${s.failed} organisations failed`,
      );
      if (s.examples.length)
        lines.push(`Changed: ${escapeHtml(s.examples.join(', '))}`);
      if (s.refused) {
        const reasons = Object.entries(s.refusedReasons)
          .sort((a, b) => b[1] - a[1])
          .map(([reason, n]) => `"${reason}" ×${n}`)
          .join('; ');
        lines.push(
          `The portal gave no answer for ${s.refused} part(s), saying: ${escapeHtml(reasons)}`,
        );
      }
      if (s.quarterlySkipped) {
        lines.push(
          `Quarterly indicator rows not kept (micro-finance): ${s.quarterlySkipped}`,
        );
      }
    }
    lines.push(`Took ${duration(r.elapsedMs)}`);
    return lines.join('\n');
  }

  async status(): Promise<Record<string, unknown>> {
    const [orgs] = await this.db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE inn IS NOT NULL)::int AS with_stir,
              count(*) FILTER (WHERE delisted_at IS NOT NULL)::int AS delisted
         FROM public.openinfo_organizations`,
    );
    const [facts] = await this.db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE detail_fetched_at IS NOT NULL)::int AS contents_read,
              count(*) FILTER (WHERE detail_missing_at IS NOT NULL)::int AS contents_gone,
              max(pub_date) AS newest
         FROM public.openinfo_facts`,
    );
    const [statements] = await this.db.query(
      `SELECT (SELECT count(*)::int FROM public.openinfo_indicators) AS indicator_years,
              (SELECT count(*)::int FROM public.openinfo_reports) AS annual_statements`,
    );
    return {
      enabled: openinfoSyncEnabled(),
      schedule:
        '03:20 Asia/Tashkent daily (organisations, new facts, contents until 05:50); Sunday 00:30 indicators and annual statements',
      source: OPENINFO_API,
      organizations: orgs,
      facts,
      statements,
      recent_runs: await recentJobRuns(this.db, [JOB], 10),
    };
  }
}
