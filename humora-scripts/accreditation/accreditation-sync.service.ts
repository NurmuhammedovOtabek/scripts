import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import axios from 'axios';
import { createHash } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { S3Service } from '../../s3/s3.service';
import { comparable, logFieldChanges } from '../../common/change-log';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recentJobRuns, recordJobRun } from '../common/job-runs';
import {
  ACCREDITATION_DATA_FIELDS,
  AccreditationRecord,
  AkkredEntry,
  mapAccreditation,
  sentValues,
} from './accreditation-map';

/** The register's list (Django REST: `{ count, next, previous, results }`). */
export const AKKRED_REGISTER_URL =
  'https://api-e.akkred.uz/apps/registries/main/';

/** Held by a session; the replica that takes it runs and reports. */
export const LOCK_ID = 8_150_941;
export const JOB = 'company_accreditations';
const SOURCE = 'akkred.uz';

/** The whole register in pages of this many, by id — two requests in 2026. */
const FULL_PAGE_SIZE = 500;
/** The nightly walk, newest change first, until it reaches what we hold. */
const NIGHTLY_PAGE_SIZE = 100;
/** 823 entries on 2026-10-10; fewer than this is a cut-off answer. */
const MIN_FULL_ENTRIES = 400;
/**
 * Hard deadlines, whole request included. axios's `timeout` alone is a
 * response timeout: a download that stalled while connecting held the run —
 * and its lock — for good on 2026-10-11 (local test).
 */
const PAGE_TIMEOUT_MS = 90_000;
const DOCUMENT_TIMEOUT_MS = 60_000;
/** Object storage has no deadline of its own (the SDK waits for ever). */
const STORAGE_TIMEOUT_MS = 60_000;
/** The documents of one run; what is left waits for the next one. */
const DOCUMENTS_BUDGET_MS = 2 * 60 * 60_000;
/** Between two downloads: the register's file host owes us nothing. */
const DOCUMENT_PAUSE_MS = 300;
/** This many failed downloads in a row is an outage; the rest waits a run. */
const DOCUMENT_OUTAGE = 10;
/** How long after boot an empty table is filled — the app settles first. */
const FIRST_FILL_DELAY_MS = 60_000;
const INSERT_BATCH = 100;
const SEEN_BATCH = 200;
const EXAMPLES = 10;

export type AccreditationSyncMode = 'full' | 'nightly';
export type AccreditationDocumentKind = 'certificate' | 'scope';
export const ACCREDITATION_DOCUMENT_KINDS: AccreditationDocumentKind[] = [
  'certificate',
  'scope',
];

/**
 * Whether the register is synced here: on a deployment (TG_WEBHOOK_URL set —
 * dev and prod), not on a laptop. `ACCREDITATION_SYNC_ENABLED=1|0` overrides.
 */
export function accreditationSyncEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.ACCREDITATION_SYNC_ENABLED === '1') return true;
  if (env.ACCREDITATION_SYNC_ENABLED === '0') return false;
  return Boolean(env.TG_WEBHOOK_URL);
}

/**
 * Where the certificates and scopes are kept. Exported so the route that
 * streams a file and the sync that writes it cannot disagree about the bucket.
 */
export function accreditationBucket(): string {
  return process.env.MINIO_ACCREDITATION_BUCKET || 'accreditation-documents';
}

/** Key prefix, so a test environment writes into a folder it can drop later. */
function accreditationPrefix(): string {
  const p = process.env.MINIO_ACCREDITATION_PREFIX || '';
  return p && !p.endsWith('/') ? `${p}/` : p;
}

/**
 * `409/certificate-3f2a9c01b7d4.pdf` — the unit's register id, the kind, and
 * the source URL hashed: a file published under a new URL is a new object,
 * and the one before it stays.
 */
export function documentObjectKey(
  sourceId: number,
  kind: AccreditationDocumentKind,
  url: string,
): string {
  const tag = createHash('sha1').update(url).digest('hex').slice(0, 12);
  return `${accreditationPrefix()}${sourceId}/${kind}-${tag}.pdf`;
}

export interface AccreditationDocumentsResult {
  stored: number;
  /** The source answered with no PDF (404, or not a PDF); not asked again. */
  missing: number;
  /** Did not download (timeout, 5xx); asked again by the next run. */
  failed: number;
  /** The copy ended before the last document; why, in `stopReason`. */
  stoppedEarly: boolean;
  /** `outage` (DOCUMENT_OUTAGE failures in a row) · `time budget` · `error`. */
  stopReason: 'outage' | 'time budget' | 'error' | null;
  /** Still to fetch once this run ended. */
  pending: number;
  bytes: number;
  examples: { missing: string[]; failed: string[] };
}

export interface AccreditationSyncResult {
  mode: AccreditationSyncMode;
  /** Entries the register says it lists (its own `count`). */
  sourceCount: number;
  /** Entries read by this run. */
  read: number;
  pages: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /**
   * Changed at the source only by fields gone blank. The stored values were
   * kept, so nothing a reader sees changed.
   */
  blanksKept: number;
  statusChanges: number;
  /** Full walk only: held here and no longer listed. Kept, never deleted. */
  delisted: number;
  /** Listed again after the source had stopped listing them. */
  relisted: number;
  /** Entries with no id to key them by — left out. */
  unreadable: number;
  duplicates: number[];
  /** Entries whose TIN is not a nine-digit STIR: kept, tied to no company. */
  withoutStir: number;
  documents: AccreditationDocumentsResult | null;
  examples: {
    inserted: string[];
    updated: string[];
    statusChanges: string[];
    delisted: string[];
  };
  elapsedMs: number;
  dry: boolean;
}

interface Page {
  count: number;
  next: string | null;
  results: AkkredEntry[];
}

/** What a stored row is compared with. */
type StoredRow = Pick<AccreditationRecord, 'source_id' | 'content_hash'> &
  Record<(typeof ACCREDITATION_DATA_FIELDS)[number], any> & {
    delisted_at: Date | string | null;
  };

interface DocumentRow {
  id: number;
  source_id: number;
  number: string | null;
  certificate_url: string | null;
  certificate_key_from: string | null;
  certificate_missing_from: string | null;
  scope_url: string | null;
  scope_key_from: string | null;
  scope_missing_from: string | null;
}

type DocumentOutcome =
  | { kind: 'stored'; key: string; bytes: number }
  | { kind: 'missing'; reason: string }
  | { kind: 'failed'; reason: string };

const JSON_FIELDS = new Set<string>(['type_std', 'directions']);
const DATE_FIELDS = new Set<string>([
  'status_date',
  'accreditation_date',
  're_accreditation_date',
  'expiry_date',
]);
const BOOL_FIELDS = new Set<string>([
  'specific_to_finance',
  'in_production',
  'is_fact_address',
]);

/** The Postgres type a field's parameter is cast to. */
function castOf(field: string): string {
  if (JSON_FIELDS.has(field)) return 'jsonb';
  if (DATE_FIELDS.has(field)) return 'date';
  if (BOOL_FIELDS.has(field)) return 'boolean';
  if (field === 'region_id') return 'integer';
  return 'text';
}

/**
 * A value as a query parameter. Lists and objects go as JSON text: the driver
 * would send a JS array as a Postgres array literal, which jsonb refuses.
 */
function paramOf(field: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  return JSON_FIELDS.has(field) ? JSON.stringify(value) : value;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** `promise`, or an error after `ms` — for a call with no deadline of its own. */
function within<T>(ms: number, what: string, promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what}: no answer in ${ms / 1000} s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Keeps `public.company_accreditations` to the National Accreditation System
 * register (akkred.uz): every accredited laboratory, certification and
 * inspection body, with its company's STIR, status, dates, contacts and the
 * scope of its accreditation. The company page reads it
 * (`OrgService.getAccreditationsByInn`).
 *
 * - **03:40 (Tashkent), Monday to Saturday** the newest changes: the register
 *   ordered by its own modification time, read until the entries are older
 *   than the newest we hold — one request on a quiet night. The register
 *   changes on working days (5–25 entries a day in September 2026).
 * - **Sunday 04:30, in the weekly chain** after the OKED classifier, the
 *   whole register (two requests), which also finds the units it stopped
 *   listing (`delisted_at`; kept, never deleted).
 * - **A minute after boot when the table is empty**, the whole register, so a
 *   new environment does not wait for Sunday. By hand: POST
 *   /accreditation-sync/run[?mode=full&dry=1].
 *
 * A change is the content, not the source's modification time: on 2026-04-14
 * the register re-saved most entries without changing them. Changed rows log
 * the values they replace (`company_change_log`), a blank the source sends
 * never replaces a stored value, and a status change keeps the status before
 * it. After the data, the certificate and scope PDFs not yet held are copied
 * into object storage, one at a time.
 *
 * Reported to Telegram and `job_runs` every run, quiet nights too: "nothing
 * new" is also what a run that never reached the source would look like, so
 * the report always says how much it read.
 */
@Injectable()
export class AccreditationSyncService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(AccreditationSyncService.name);
  private firstFill: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly telegram: TelegramAlertService,
    private readonly s3: S3Service,
  ) {}

  onApplicationBootstrap(): void {
    if (!accreditationSyncEnabled()) return;
    this.firstFill = setTimeout(() => {
      this.firstFill = null;
      void this.fillIfEmpty();
    }, FIRST_FILL_DELAY_MS);
    this.firstFill.unref?.();
  }

  onModuleDestroy(): void {
    if (this.firstFill) clearTimeout(this.firstFill);
  }

  /** The first fill of an environment; every replica asks, one runs. */
  async fillIfEmpty(): Promise<void> {
    try {
      const [{ n }] = await this.db.query(
        'SELECT count(*)::int AS n FROM public.company_accreditations',
      );
      if (n > 0) return;
      await this.run({ mode: 'full' }, 'first fill');
    } catch (err) {
      // `run` has reported a failed sync; this is the count failing.
      this.logger.warn(
        `[accreditation-sync] first fill: ${(err as Error).message}`,
      );
    }
  }

  /**
   * The newest changes, Monday to Saturday. Sunday's whole-register walk runs
   * in the Sunday 04:30 chain (`CompanyMahallaService.weekly`), so this night
   * is left to it.
   */
  @Cron('40 3 * * 1-6', { timeZone: 'Asia/Tashkent' })
  async scheduled(): Promise<void> {
    if (!accreditationSyncEnabled()) return;
    try {
      await this.run({ mode: 'nightly' }, 'nightly');
    } catch {
      // Reported by `run`.
    }
  }

  /**
   * One sync under the lock, reported to Telegram and kept in `job_runs`
   * whatever happened. Null when another replica holds the lock (that one
   * reports). Throws after reporting when the sync failed.
   */
  async run(
    opts: { mode?: AccreditationSyncMode; dry?: boolean },
    trigger: string,
  ): Promise<AccreditationSyncResult | null> {
    return (await this.start(opts, trigger)).done;
  }

  /**
   * Takes the lock and starts a sync; `done` settles when it has reported
   * (and rejects when the sync failed, after reporting). The endpoint answers
   * at once — the first copy of the documents takes half an hour — and the
   * cron awaits `done`.
   */
  async start(
    opts: { mode?: AccreditationSyncMode; dry?: boolean },
    trigger: string,
  ): Promise<{
    started: boolean;
    reason: string | null;
    /** The report, or null when nothing started. */
    done: Promise<AccreditationSyncResult | null>;
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
      this.logger.warn(
        `[accreditation-sync] ${trigger}: could not take the lock — ${(err as Error).message}`,
      );
      return { started: false, reason: (err as Error).message, done: idle };
    }
    if (!locked) {
      await runner.release().catch(() => undefined);
      this.logger.log(
        `[accreditation-sync] ${trigger}: skipped — another replica is syncing`,
      );
      return {
        started: false,
        reason: 'another replica is syncing',
        done: idle,
      };
    }
    const done = this.execute(opts, trigger).finally(async () => {
      await runner
        .query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
        .catch(() => undefined);
      await runner.release().catch(() => undefined);
    });
    return { started: true, reason: null, done };
  }

  private async execute(
    opts: { mode?: AccreditationSyncMode; dry?: boolean },
    trigger: string,
  ): Promise<AccreditationSyncResult> {
    const startedAt = new Date();
    try {
      const result = await this.syncAll(opts);
      const text = this.describe(result, trigger);
      const alertSent = await this.telegram.deliver(text, {
        tag: 'accreditation',
      });
      await recordJobRun(this.db, {
        job: JOB,
        trigger,
        dry: result.dry,
        startedAt,
        ok: true,
        summary: text,
        report: result,
        alertSent,
      });
      return result;
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(
        `[accreditation-sync] ${trigger}: sync failed — ${message}`,
      );
      const text = [
        `❌ <b>Accreditation register (${escapeHtml(trigger)}) — sync failed</b>`,
        `<code>${escapeHtml(message)}</code>`,
        'The stored register is untouched. Retry by hand: POST /api/accreditation-sync/run',
      ].join('\n');
      const alertSent = await this.telegram.deliver(text, {
        tag: 'accreditation',
      });
      await recordJobRun(this.db, {
        job: JOB,
        trigger,
        dry: opts.dry === true,
        startedAt,
        ok: false,
        summary: text,
        error: message,
        alertSent,
      });
      throw err;
    }
  }

  /** What we hold, the documents, and the last runs. */
  async status(): Promise<Record<string, unknown>> {
    const [held] = await this.db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE inn IS NOT NULL)::int AS with_stir,
              count(DISTINCT inn)::int AS companies,
              count(*) FILTER (WHERE delisted_at IS NOT NULL)::int AS delisted,
              count(*) FILTER (WHERE certificate_key IS NOT NULL)::int AS certificates_stored,
              count(*) FILTER (WHERE scope_key IS NOT NULL)::int AS scopes_stored,
              count(*) FILTER (WHERE certificate_url IS NOT NULL
                                 AND certificate_url IS DISTINCT FROM certificate_key_from
                                 AND certificate_url IS DISTINCT FROM certificate_missing_from)::int
                AS certificates_pending,
              count(*) FILTER (WHERE scope_url IS NOT NULL
                                 AND scope_url IS DISTINCT FROM scope_key_from
                                 AND scope_url IS DISTINCT FROM scope_missing_from)::int
                AS scopes_pending,
              count(*) FILTER (WHERE certificate_missing_from IS NOT NULL
                                 AND certificate_missing_from = certificate_url)::int
                AS certificates_missing_at_source,
              count(*) FILTER (WHERE scope_missing_from IS NOT NULL
                                 AND scope_missing_from = scope_url)::int
                AS scopes_missing_at_source,
              max(updated_at) AS last_changed,
              max(last_seen_at) AS last_seen,
              max(source_modified_at) AS newest_source_change
         FROM public.company_accreditations`,
    );
    const byStatus: Array<{ status: string | null; total: number }> =
      await this.db.query(
        `SELECT status, count(*)::int AS total
           FROM public.company_accreditations
          GROUP BY status ORDER BY total DESC`,
      );
    return {
      enabled: accreditationSyncEnabled(),
      schedule:
        '03:40 Asia/Tashkent Mon–Sat (newest changes); Sunday 04:30 chain the whole register',
      source: AKKRED_REGISTER_URL,
      bucket: accreditationBucket(),
      ...held,
      by_status: Object.fromEntries(
        byStatus.map((r) => [r.status ?? 'unknown', r.total]),
      ),
      recent_runs: await recentJobRuns(this.db, [JOB], 10),
    };
  }

  /**
   * The register read (whole, or its newest changes), compared with what we
   * hold and — unless `dry` — written in one transaction, then the documents.
   */
  async syncAll(
    opts: { mode?: AccreditationSyncMode; dry?: boolean } = {},
  ): Promise<AccreditationSyncResult> {
    const start = Date.now();
    const dry = opts.dry === true;

    // A nightly walk needs something to walk back to.
    const [{ newest }] = await this.db.query(
      `SELECT max(source_modified_at) AS newest
         FROM public.company_accreditations`,
    );
    const mode: AccreditationSyncMode =
      opts.mode === 'nightly' && newest ? 'nightly' : 'full';

    const fetched =
      mode === 'full'
        ? await this.fetchWhole()
        : await this.fetchNewest(new Date(newest));

    // Read into our columns; one entry per id.
    const records = new Map<number, AccreditationRecord>();
    const duplicates: number[] = [];
    let unreadable = 0;
    for (const entry of fetched.entries) {
      const record = mapAccreditation(entry);
      if (!record) {
        unreadable++;
        continue;
      }
      if (records.has(record.source_id)) duplicates.push(record.source_id);
      records.set(record.source_id, record);
    }
    if (mode === 'full' && records.size < MIN_FULL_ENTRIES) {
      throw new Error(
        `akkred.uz listed ${records.size} units (count ${fetched.count}) — ` +
          'too few to trust, nothing written',
      );
    }

    const ids = [...records.keys()];
    const stored: StoredRow[] = ids.length
      ? await this.db.query(
          `SELECT source_id, content_hash, delisted_at,
                  ${ACCREDITATION_DATA_FIELDS.join(', ')}
             FROM public.company_accreditations
            WHERE source_id = ANY($1::int[])`,
          [ids],
        )
      : [];
    const storedById = new Map(stored.map((s) => [s.source_id, s]));

    const inserted: AccreditationRecord[] = [];
    // Rewritten: the source's entry differs from the one we last took.
    const rewritten: Array<{ record: AccreditationRecord; visible: boolean }> =
      [];
    const unchanged: AccreditationRecord[] = [];
    const statusChanged: string[] = [];
    const updatedLines: string[] = [];
    let updatedCount = 0;
    let blanksKept = 0;
    let restated = 0;
    let relisted = 0;
    for (const record of records.values()) {
      const was = storedById.get(record.source_id);
      if (!was) {
        inserted.push(record);
        continue;
      }
      if (was.delisted_at) relisted++;
      if (was.content_hash === record.content_hash) {
        unchanged.push(record);
        continue;
      }
      // What a reader would see change: a field the source sent that differs
      // from the held one. A blank sent over a held value keeps the value.
      const sent = sentValues(record);
      const fields = Object.keys(sent).filter(
        (f) => comparable((was as any)[f]) !== comparable(sent[f]),
      );
      rewritten.push({ record, visible: fields.length > 0 });
      if (fields.length) {
        updatedCount++;
        updatedLines.push(
          `${labelOf(record)}: ${fields.slice(0, 4).join(', ')}` +
            (fields.length > 4 ? ` (+${fields.length - 4})` : ''),
        );
      } else if (
        ACCREDITATION_DATA_FIELDS.some(
          (f) => !(f in sent) && comparable((was as any)[f]) !== '',
        )
      ) {
        blanksKept++;
      } else {
        // The source sends again what we already hold (a blank it had sent
        // before, filled back): nothing to show.
        restated++;
      }
      if (record.status && was.status && record.status !== was.status) {
        statusChanged.push(
          `${labelOf(record)}: ${was.status} → ${record.status}`,
        );
      }
    }

    // Only the whole register says what it no longer lists.
    let delistedRows: Array<{ source_id: number; label: string }> = [];
    if (mode === 'full') {
      delistedRows = await this.db.query(
        `SELECT source_id,
                concat_ws(' ', number, legal_entity_name) AS label
           FROM public.company_accreditations
          WHERE delisted_at IS NULL
            AND NOT (source_id = ANY($1::int[]))
          ORDER BY source_id`,
        [ids],
      );
    }

    if (!dry) {
      await this.db.transaction(async (m) => {
        await this.insertRecords(m, inserted);
        for (const { record, visible } of rewritten) {
          await this.updateRecord(
            m,
            storedById.get(record.source_id)!,
            record,
            visible,
          );
        }
        await this.markSeen(m, unchanged);
        if (delistedRows.length) {
          await m.query(
            `UPDATE public.company_accreditations
                SET delisted_at = now()
              WHERE source_id = ANY($1::int[]) AND delisted_at IS NULL`,
            [delistedRows.map((r) => r.source_id)],
          );
        }
      });
    }

    const documents = dry ? null : await this.mirrorDocuments();

    const elapsedMs = Date.now() - start;
    this.logger.log(
      `[accreditation-sync] ${mode}${dry ? ' dry run' : ''} done in ${elapsedMs}ms — ` +
        `read ${records.size} of ${fetched.count} in ${fetched.pages} page(s), ` +
        `+${inserted.length} ~${updatedCount} =${unchanged.length + restated}, ` +
        `delisted ${delistedRows.length}` +
        (documents
          ? `, documents stored ${documents.stored} missing ${documents.missing} failed ${documents.failed} pending ${documents.pending}`
          : ''),
    );
    return {
      mode,
      sourceCount: fetched.count,
      read: records.size,
      pages: fetched.pages,
      inserted: inserted.length,
      updated: updatedCount,
      unchanged: unchanged.length + restated,
      blanksKept,
      statusChanges: statusChanged.length,
      delisted: delistedRows.length,
      relisted,
      unreadable,
      duplicates,
      withoutStir: [...records.values()].filter((r) => r.tin && !r.inn).length,
      documents,
      examples: {
        inserted: inserted.slice(0, EXAMPLES).map(labelOf),
        updated: updatedLines.slice(0, EXAMPLES),
        statusChanges: statusChanged.slice(0, EXAMPLES),
        delisted: delistedRows.slice(0, EXAMPLES).map((r) => r.label),
      },
      elapsedMs,
      dry,
    };
  }

  /** One page of the register, or an error — never an empty register. */
  private async fetchPage(
    params: Record<string, string | number>,
  ): Promise<Page> {
    const resp = await axios.get(AKKRED_REGISTER_URL, {
      params,
      timeout: PAGE_TIMEOUT_MS,
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
      headers: { Accept: 'application/json' },
      validateStatus: () => true,
    });
    const body: any = resp.data;
    if (resp.status !== 200) {
      throw new Error(
        `akkred.uz answered HTTP ${resp.status} for page ${params.page}`,
      );
    }
    if (
      !body ||
      !Array.isArray(body.results) ||
      !Number.isInteger(body.count)
    ) {
      throw new Error(`akkred.uz answered page ${params.page} without a list`);
    }
    return {
      count: body.count,
      next: typeof body.next === 'string' ? body.next : null,
      results: body.results,
    };
  }

  /**
   * The whole register, by id so a page cannot shift under the walk. Fewer
   * entries than the register's own count is a cut-off answer.
   */
  private async fetchWhole(): Promise<{
    entries: AkkredEntry[];
    count: number;
    pages: number;
  }> {
    const entries: AkkredEntry[] = [];
    let count = 0;
    let pages = 0;
    for (let page = 1; ; page++) {
      const p = await this.fetchPage({
        page,
        page_size: FULL_PAGE_SIZE,
        ordering: 'id',
      });
      pages++;
      if (page === 1) count = p.count;
      entries.push(...p.results);
      if (!p.next || p.results.length === 0) break;
      if (pages > Math.ceil(count / FULL_PAGE_SIZE) + 1) {
        throw new Error(`akkred.uz kept answering after ${pages} pages`);
      }
    }
    if (entries.length < count) {
      throw new Error(
        `akkred.uz sent ${entries.length} of ${count} entries — nothing written`,
      );
    }
    return { entries, count, pages };
  }

  /**
   * The newest changes: entries ordered by the register's modification time,
   * read until a page reaches one older than `since` (the newest we hold).
   * Entries modified at exactly `since` are read again — the same second can
   * hold another change.
   */
  private async fetchNewest(since: Date): Promise<{
    entries: AkkredEntry[];
    count: number;
    pages: number;
  }> {
    const entries: AkkredEntry[] = [];
    let count = 0;
    let pages = 0;
    for (let page = 1; ; page++) {
      const p = await this.fetchPage({
        page,
        page_size: NIGHTLY_PAGE_SIZE,
        ordering: '-modified_date',
      });
      pages++;
      if (page === 1) count = p.count;
      let older = false;
      for (const e of p.results) {
        const at = Date.parse(String(e.modified_date ?? ''));
        if (Number.isFinite(at) && at < since.getTime()) {
          older = true;
          break;
        }
        entries.push(e);
      }
      if (older || !p.next || p.results.length === 0) break;
      if (pages > Math.ceil(count / NIGHTLY_PAGE_SIZE) + 1) {
        throw new Error(`akkred.uz kept answering after ${pages} pages`);
      }
    }
    return { entries, count, pages };
  }

  /** New units, batched. A first fill of a unit writes no change log. */
  private async insertRecords(
    m: EntityManager,
    records: AccreditationRecord[],
  ): Promise<void> {
    const cols = [
      'source_id',
      'source_uid',
      ...ACCREDITATION_DATA_FIELDS,
      'source_modified_at',
      'content_hash',
      'raw',
    ];
    const casts = cols.map((c) =>
      c === 'source_id'
        ? 'integer'
        : c === 'source_uid'
          ? 'uuid'
          : c === 'source_modified_at'
            ? 'timestamptz'
            : c === 'raw'
              ? 'jsonb'
              : c === 'content_hash'
                ? 'text'
                : castOf(c),
    );
    for (let i = 0; i < records.length; i += INSERT_BATCH) {
      const params: unknown[] = [];
      const tuples = records.slice(i, i + INSERT_BATCH).map((r) => {
        const at = params.length;
        for (const c of cols) {
          const v = (r as any)[c];
          params.push(c === 'raw' ? JSON.stringify(v) : paramOf(c, v));
        }
        return `(${cols.map((_, j) => `$${at + j + 1}::${casts[j]}`).join(', ')})`;
      });
      await m.query(
        `INSERT INTO public.company_accreditations (${cols.join(', ')})
         VALUES ${tuples.join(', ')}
         ON CONFLICT (source_id) DO NOTHING`,
        params,
      );
    }
  }

  /**
   * One unit whose entry changed at the source: the values it replaces go to
   * the change log first, a blank the source sends keeps the stored value,
   * and a new status keeps the one before it. `updated_at` moves only when a
   * reader would see something change.
   */
  private async updateRecord(
    m: EntityManager,
    was: StoredRow,
    record: AccreditationRecord,
    visible: boolean,
  ): Promise<void> {
    await logFieldChanges(
      m,
      {
        entity: 'company_accreditations',
        inn: record.inn ?? was.inn ?? null,
        key: String(record.source_id),
        source: SOURCE,
      },
      was,
      sentValues(record),
      ACCREDITATION_DATA_FIELDS,
    );

    const params: unknown[] = [record.source_id];
    const p = (value: unknown, cast: string) => {
      params.push(value);
      return `$${params.length}::${cast}`;
    };
    const sets = ACCREDITATION_DATA_FIELDS.map((f) => {
      // Read off another field: they follow it whenever it was sent.
      if (f === 'inn') {
        return `inn = CASE WHEN ${p(record.tin, 'text')} IS NOT NULL THEN ${p(record.inn, 'text')} ELSE inn END`;
      }
      if (f === 'type_code') {
        return `type_code = CASE WHEN ${p(record.number, 'text')} IS NOT NULL THEN ${p(record.type_code, 'text')} ELSE type_code END`;
      }
      return `${f} = COALESCE(${p(paramOf(f, record[f]), castOf(f))}, ${f})`;
    });
    const status = p(record.status, 'text');

    // Every right-hand side reads the row as it was, so the status columns
    // see the old status whatever their order.
    await m.query(
      `UPDATE public.company_accreditations SET
         ${sets.join(',\n         ')},
         previous_status = CASE WHEN ${status} IS NOT NULL AND status IS DISTINCT FROM ${status}
                                THEN status ELSE previous_status END,
         status_changed_seen_at = CASE WHEN ${status} IS NOT NULL AND status IS DISTINCT FROM ${status}
                                       THEN now() ELSE status_changed_seen_at END,
         source_uid = COALESCE(${p(record.source_uid, 'uuid')}, source_uid),
         source_modified_at = COALESCE(${p(record.source_modified_at, 'timestamptz')}, source_modified_at),
         content_hash = ${p(record.content_hash, 'text')},
         raw = ${p(JSON.stringify(record.raw), 'jsonb')},
         delisted_at = NULL,
         last_seen_at = now(),
         updated_at = CASE WHEN ${p(visible, 'boolean')} THEN now() ELSE updated_at END
       WHERE source_id = $1`,
      params,
    );
  }

  /**
   * Units listed as we hold them: seen, with the source's modification time
   * and its whole entry (fields we do not read can still move). In batches —
   * a whole entry is ~23 KB, the scope text with it.
   */
  private async markSeen(
    m: EntityManager,
    records: AccreditationRecord[],
  ): Promise<void> {
    for (let i = 0; i < records.length; i += SEEN_BATCH) {
      const rows = records.slice(i, i + SEEN_BATCH).map((r) => ({
        source_id: r.source_id,
        source_modified_at: r.source_modified_at,
        raw: r.raw,
      }));
      await m.query(
        `UPDATE public.company_accreditations t
            SET last_seen_at = now(),
                delisted_at = NULL,
                source_modified_at = COALESCE(x.source_modified_at, t.source_modified_at),
                raw = x.raw
           FROM jsonb_to_recordset($1::jsonb)
                AS x(source_id integer, source_modified_at timestamptz, raw jsonb)
          WHERE t.source_id = x.source_id`,
        [JSON.stringify(rows)],
      );
    }
  }

  /**
   * The certificates and scopes not yet held, copied into object storage one
   * at a time. Never throws: a document is worth a line in the report, not a
   * failed sync of the register it belongs to.
   */
  async mirrorDocuments(): Promise<AccreditationDocumentsResult> {
    const result: AccreditationDocumentsResult = {
      stored: 0,
      missing: 0,
      failed: 0,
      stoppedEarly: false,
      stopReason: null,
      pending: 0,
      bytes: 0,
      examples: { missing: [], failed: [] },
    };
    const stop = (reason: AccreditationDocumentsResult['stopReason']) => {
      result.stoppedEarly = true;
      result.stopReason = reason;
    };
    const deadline = Date.now() + DOCUMENTS_BUDGET_MS;
    try {
      const rows: DocumentRow[] = await this.db.query(
        `SELECT id, source_id, number,
                certificate_url, certificate_key_from, certificate_missing_from,
                scope_url, scope_key_from, scope_missing_from
           FROM public.company_accreditations
          WHERE (certificate_url IS NOT NULL
                 AND certificate_url IS DISTINCT FROM certificate_key_from
                 AND certificate_url IS DISTINCT FROM certificate_missing_from)
             OR (scope_url IS NOT NULL
                 AND scope_url IS DISTINCT FROM scope_key_from
                 AND scope_url IS DISTINCT FROM scope_missing_from)
          ORDER BY id`,
      );
      if (rows.length) {
        await within(
          STORAGE_TIMEOUT_MS,
          'object storage',
          this.s3.ensureBucket(accreditationBucket()),
        );
      }

      let failedInRow = 0;
      outer: for (const row of rows) {
        for (const kind of ACCREDITATION_DOCUMENT_KINDS) {
          const url = row[`${kind}_url`];
          if (
            !url ||
            url === row[`${kind}_key_from`] ||
            url === row[`${kind}_missing_from`]
          ) {
            continue;
          }
          if (Date.now() > deadline) {
            stop('time budget');
            break outer;
          }
          const outcome = await this.storeDocument(row.source_id, kind, url);
          const label = `${row.number ?? row.source_id} ${kind}`;
          if (outcome.kind === 'stored') {
            failedInRow = 0;
            result.stored++;
            result.bytes += outcome.bytes;
            await this.db.query(
              `UPDATE public.company_accreditations
                  SET ${kind}_key = $2, ${kind}_key_from = $3,
                      ${kind}_missing_from = NULL, documents_tried_at = now()
                WHERE id = $1`,
              [row.id, outcome.key, url],
            );
          } else if (outcome.kind === 'missing') {
            failedInRow = 0;
            result.missing++;
            if (result.examples.missing.length < EXAMPLES) {
              result.examples.missing.push(`${label}: ${outcome.reason}`);
            }
            // The copy held from an earlier URL, if any, stays.
            await this.db.query(
              `UPDATE public.company_accreditations
                  SET ${kind}_missing_from = $2, documents_tried_at = now()
                WHERE id = $1`,
              [row.id, url],
            );
          } else {
            failedInRow++;
            result.failed++;
            if (result.examples.failed.length < EXAMPLES) {
              result.examples.failed.push(`${label}: ${outcome.reason}`);
            }
            await this.db.query(
              `UPDATE public.company_accreditations
                  SET documents_tried_at = now() WHERE id = $1`,
              [row.id],
            );
            if (failedInRow >= DOCUMENT_OUTAGE) {
              stop('outage');
              break outer;
            }
          }
          await sleep(DOCUMENT_PAUSE_MS);
        }
      }

      const [{ pending }] = await this.db.query(
        `SELECT (count(*) FILTER (WHERE certificate_url IS NOT NULL
                                   AND certificate_url IS DISTINCT FROM certificate_key_from
                                   AND certificate_url IS DISTINCT FROM certificate_missing_from)
               + count(*) FILTER (WHERE scope_url IS NOT NULL
                                   AND scope_url IS DISTINCT FROM scope_key_from
                                   AND scope_url IS DISTINCT FROM scope_missing_from))::int
                AS pending
           FROM public.company_accreditations`,
      );
      result.pending = pending;
    } catch (err) {
      this.logger.error(
        `[accreditation-sync] documents: ${(err as Error).message}`,
      );
      if (result.examples.failed.length < EXAMPLES) {
        result.examples.failed.push(`stopped: ${(err as Error).message}`);
      }
      stop('error');
    }
    return result;
  }

  /**
   * One document into storage. No PDF at the source — a 404, or something
   * that is not a PDF — is an answer; a timeout or a server error is not.
   */
  private async storeDocument(
    sourceId: number,
    kind: AccreditationDocumentKind,
    url: string,
  ): Promise<DocumentOutcome> {
    const bucket = accreditationBucket();
    const key = documentObjectKey(sourceId, kind, url);
    try {
      // A run that stored the file and stopped before writing the row.
      if (
        await within(
          STORAGE_TIMEOUT_MS,
          'object storage',
          this.s3.exists(bucket, key),
        )
      ) {
        return { kind: 'stored', key, bytes: 0 };
      }
      const resp = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: DOCUMENT_TIMEOUT_MS,
        signal: AbortSignal.timeout(DOCUMENT_TIMEOUT_MS),
        validateStatus: () => true,
        maxRedirects: 3,
      });
      if (resp.status === 404 || resp.status === 410) {
        return { kind: 'missing', reason: `HTTP ${resp.status}` };
      }
      if (resp.status !== 200) {
        return { kind: 'failed', reason: `HTTP ${resp.status}` };
      }
      const body = Buffer.from(resp.data);
      if (body.length === 0) return { kind: 'missing', reason: 'empty file' };
      if (body.subarray(0, 5).toString('latin1') !== '%PDF-') {
        return { kind: 'missing', reason: 'not a PDF' };
      }
      await within(
        STORAGE_TIMEOUT_MS,
        'object storage',
        this.s3.upload(bucket, key, body, 'application/pdf'),
      );
      return { kind: 'stored', key, bytes: body.length };
    } catch (err) {
      return { kind: 'failed', reason: (err as Error).message };
    }
  }

  private describe(r: AccreditationSyncResult, trigger: string): string {
    const list = (label: string, total: number, xs: string[]) =>
      xs.length
        ? [
            `${label}${total > xs.length ? ` (${xs.length} of ${total})` : ''}:`,
            ...xs.map((x) => `  • ${escapeHtml(x)}`),
          ]
        : [];
    const d = r.documents;
    const changed = r.inserted + r.updated + r.delisted;
    const warn =
      r.read === 0 ||
      r.unreadable > 0 ||
      r.duplicates.length > 0 ||
      (d !== null && (d.failed > 0 || d.stoppedEarly));
    const head = r.dry ? '🧪' : warn ? '⚠️' : changed ? '📜' : '✅';
    const mb = (bytes: number) => `${(bytes / 1048576).toFixed(1)} MB`;
    return [
      `${head} <b>Accreditation register — ${escapeHtml(trigger)}</b>` +
        `${r.dry ? ' (dry run, nothing written)' : ''}`,
      `Took: ${Math.round(r.elapsedMs / 1000)} s · source: akkred.uz · ` +
        (r.mode === 'full'
          ? 'whole register'
          : 'newest changes since the last one held'),
      `Read: ${r.read} units in ${r.pages} request(s) · the register lists ${r.sourceCount}`,
      `New ${r.inserted} · changed ${r.updated} · unchanged ${r.unchanged}` +
        (r.mode === 'full'
          ? ` · no longer listed ${r.delisted} (kept here)`
          : ''),
      ...(r.relisted ? [`Listed again: ${r.relisted}`] : []),
      ...(r.blanksKept
        ? [
            `Changed only by blanks at the source, stored values kept: ${r.blanksKept}`,
          ]
        : []),
      ...(changed ? [] : ['No changes.']),
      ...list('Status changes', r.statusChanges, r.examples.statusChanges),
      ...list('New', r.inserted, r.examples.inserted),
      ...list('Changed', r.updated, r.examples.updated),
      ...list('No longer listed', r.delisted, r.examples.delisted),
      ...(r.mode === 'full' && r.withoutStir
        ? [`TIN not a STIR, kept and tied to no company: ${r.withoutStir}`]
        : []),
      ...(r.unreadable
        ? [`Entries with no id, left out: ${r.unreadable}`]
        : []),
      ...(r.duplicates.length
        ? [
            `Listed twice: ${r.duplicates.slice(0, EXAMPLES).join(', ')}` +
              (r.duplicates.length > EXAMPLES
                ? ` (+${r.duplicates.length - EXAMPLES})`
                : ''),
          ]
        : []),
      ...(d
        ? [
            `Documents: stored ${d.stored} (${mb(d.bytes)}) · no PDF at the source ${d.missing} · ` +
              `failed ${d.failed} (asked again next run) · still to fetch ${d.pending}` +
              (d.stoppedEarly ? ` · stopped early (${d.stopReason})` : ''),
            ...list('No PDF at the source', d.missing, d.examples.missing),
            ...list('Failed', d.failed, d.examples.failed),
          ]
        : []),
    ].join('\n');
  }
}

/** `O'ZAK.SL.0001 (Example MChJ)`, or the register id when it has no number. */
function labelOf(
  r: Pick<AccreditationRecord, 'source_id' | 'number' | 'legal_entity_name'>,
): string {
  const name = r.legal_entity_name ? ` (${r.legal_entity_name})` : '';
  return `${r.number ?? `#${r.source_id}`}${name}`;
}
