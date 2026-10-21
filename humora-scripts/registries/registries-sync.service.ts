import {
  Injectable,
  Optional,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  comparable,
  logFieldChanges,
  presentOnly,
} from '../../common/change-log';
import { tashkentToday } from '../../common/tashkent-time';
import { jobStopRequested } from '../common/job-control';
import { recentJobRuns, recordJobRun } from '../common/job-runs';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { S3Service } from '../../s3/s3.service';
import { REGISTRY_ADAPTERS } from './registry-catalog';
import { registryBucket, sourceFileKey } from './registry-documents';
import { HostPacer, RegistryHttp, SourceRefusedError } from './registry-http';
import { matchRegistryNames, NameMatchResult } from './registry-name-match';
import {
  contentHash,
  looksLikeOrganisation,
  nameKey,
} from './registry-normalize';
import {
  FetchResult,
  isSkip,
  MapContext,
  MappedEntry,
  RegistryAdapter,
} from './registry-types';

/** Held by a session; the replica that takes it runs and reports. */
export const LOCK_ID = 8_150_944;
export const JOB = 'registries';

/** How long after boot an empty store is filled — the app settles first. */
const FIRST_FILL_DELAY_MS = 60_000;
const INSERT_BATCH = 200;
const SEEN_BATCH = 500;
const EXAMPLES = 5;
/**
 * A complete read that would take more than this share of a register's listed
 * entries off it is not trusted: a register does not halve in a week, a
 * broken page or a changed layout does.
 */
const MAX_DELIST_SHARE = 0.5;

/**
 * Whether the registers are synced here: on a deployment (TG_WEBHOOK_URL set —
 * dev and prod), not on a laptop. `REGISTRIES_SYNC_ENABLED=1|0` overrides.
 */
export function registriesSyncEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.REGISTRIES_SYNC_ENABLED === '1') return true;
  if (env.REGISTRIES_SYNC_ENABLED === '0') return false;
  return Boolean(env.TG_WEBHOOK_URL);
}

/**
 * Which registers a run reads: `nightly` the daily ones; `weekly` the daily
 * and weekly ones, and the monthly ones on the first Sunday of the month;
 * `all` every register that is read from the web.
 */
export type RegistryRunScope = 'nightly' | 'weekly' | 'all';

export interface RegistryRunOptions {
  scope?: RegistryRunScope;
  /** These registers only (codes), whatever their cadence. */
  sources?: string[];
  /** Trial: at most this many requests per register; nothing is delisted. */
  limit?: number;
  dry?: boolean;
  /** Read every file again, ignoring what the last read already took. */
  reread?: boolean;
  /** A file an admin posted for a manual register: its rows, read whole. */
  upload?: { rows: unknown[] };
}

export interface RegistrySourceResult {
  code: string;
  ok: boolean;
  error: string | null;
  /** The source answered 403/429. */
  refused: boolean;
  requests: number;
  /** Rows the source sent. */
  read: number;
  /** Rows it says it holds, when it says. */
  expected: number | null;
  /** Read whole (not a trial, nothing missing): only then is anything delisted. */
  complete: boolean;
  /** Distinct entries mapped from the rows. */
  entries: number;
  inserted: number;
  /** Changed in a way a reader sees. */
  updated: number;
  unchanged: number;
  delisted: number;
  relisted: number;
  /** Listed entries of periods this read left alone (`heldPeriods`). */
  held: number;
  /** The adapter's own lines for the report. */
  notes: string[];
  /** Rows left out, by reason. */
  skipped: Record<string, number>;
  /**
   * Rows that mapped to an entry already read with other values (the later
   * one kept) — worth a look. Repeats of a row as it was are `copies`.
   */
  duplicates: number;
  /** Rows the source sends more than once, unchanged (dropped quietly). */
  copies: number;
  editionDate: string | null;
  period: string | null;
  examples: { inserted: string[]; updated: string[]; delisted: string[] };
  elapsedMs: number;
}

export interface RegistriesRunResult {
  scope: string;
  sources: RegistrySourceResult[];
  /** A stop was asked for; the registers after it wait for the next run. */
  stoppedEarly: boolean;
  /** Phase C: rows tied to a company by name, per register. */
  matches: NameMatchResult[];
  elapsedMs: number;
  dry: boolean;
  /** The trial's request limit, or null for a real read. */
  trial: number | null;
}

/** The columns both stores share, and how each is cast. */
const COMMON_COLUMNS: Array<[string, string]> = [
  ['source', 'text'],
  ['source_key', 'text'],
  ['name', 'text'],
  ['kind', 'text'],
  ['number', 'text'],
  ['status', 'text'],
  ['is_active', 'boolean'],
  ['valid_from', 'date'],
  ['valid_to', 'date'],
  ['amount', 'numeric'],
  ['amount_unit', 'text'],
  ['fields', 'jsonb'],
  ['raw', 'jsonb'],
  ['content_hash', 'text'],
  ['as_of', 'date'],
];
const ENTRY_COLUMNS: Array<[string, string]> = [
  ['inn', 'text'],
  ['pinfl', 'text'],
  ['raw_tin', 'text'],
];
const NAME_COLUMNS: Array<[string, string]> = [
  ['name_key', 'text'],
  ['region', 'text'],
];

/** The data a reader sees, as compared and logged (`fields.<key>` flattened). */
function visibleValues(m: {
  name: string | null;
  number: string | null;
  status: string | null;
  is_active: boolean | null;
  valid_from: string | null;
  valid_to: string | null;
  amount: unknown;
  fields: Record<string, unknown> | null;
}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: m.name,
    number: m.number,
    status: m.status,
    is_active: m.is_active,
    valid_from: m.valid_from,
    valid_to: m.valid_to,
    amount: m.amount,
  };
  for (const [k, v] of Object.entries(m.fields ?? {})) out[`fields.${k}`] = v;
  return out;
}

const columnsOf = (m: MappedEntry) => ({
  name: m.name,
  number: m.number,
  status: m.status,
  is_active: m.isActive,
  valid_from: m.validFrom,
  valid_to: m.validTo,
  amount: m.amount,
  fields: m.fields,
});

/** What a change is: the entry minus its source row and its edition day. */
export function entryHash(m: MappedEntry): string {
  return contentHash({
    inn: m.inn,
    pinfl: m.pinfl,
    rawTin: m.rawTin,
    name: m.name,
    number: m.number,
    status: m.status,
    isActive: m.isActive,
    validFrom: m.validFrom,
    validTo: m.validTo,
    amount: m.amount,
    amountUnit: m.amountUnit,
    fields: m.fields,
    region: m.region ?? null,
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** How an entry is named in a report: never a PINFL (person keys are hashed). */
function labelOf(m: {
  name?: string | null;
  number?: string | null;
  sourceKey?: string;
  source_key?: string;
}): string {
  const key = m.sourceKey ?? m.source_key ?? '';
  return [m.number, m.name].filter(Boolean).join(' ') || key;
}

interface StoredRow {
  source_key: string;
  content_hash: string;
  delisted_at: Date | string | null;
  inn?: string | null;
  name: string | null;
  number: string | null;
  status: string | null;
  is_active: boolean | null;
  valid_from: string | null;
  valid_to: string | null;
  amount: string | null;
  fields: Record<string, unknown> | null;
}

/**
 * Keeps `company_registry_entries` (and, for registers without a STIR,
 * `registry_name_rows`) to the open registers in `registry-catalog.ts`:
 * licence and certificate holders, members, benefit recipients — one store,
 * one engine, an adapter per register that only fetches and maps.
 *
 * - **03:10 (Tashkent), Monday to Saturday** the daily registers (pharmacy
 *   certificates).
 * - **Sunday, in the weekly chain** after the accreditation register, the
 *   daily and weekly ones, and the monthly ones on the first Sunday.
 * - **A minute after boot when the store is empty**, every register.
 * - By hand: POST /registries-sync/run[?source=…&limit=…&dry=1].
 *
 * The rules are the accreditation sync's: a register read in part writes
 * nothing as removed; an entry no longer listed gets `delisted_at` and is
 * kept; a blank the source sends never replaces a stored value; a changed
 * entry logs the values it replaces (`company_change_log`). Requests are paced
 * per host (≥1.5 s); a refusal (403/429) stops that register for the run.
 * One register failing is a line in the report — the others still run.
 */
@Injectable()
export class RegistriesSyncService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RegistriesSyncService.name);
  private firstFill: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly telegram: TelegramAlertService,
    @Optional() private readonly s3?: S3Service,
  ) {}

  onApplicationBootstrap(): void {
    if (!registriesSyncEnabled()) return;
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
        'SELECT count(*)::int AS n FROM public.company_registry_entries',
      );
      if (n > 0) return;
      await this.run({ scope: 'all' }, 'first fill');
    } catch (err) {
      this.logger.warn(`[registries] first fill: ${(err as Error).message}`);
    }
  }

  /** The daily registers, Monday to Saturday; Sunday is the weekly chain's. */
  @Cron('10 3 * * 1-6', { timeZone: 'Asia/Tashkent' })
  async nightly(): Promise<void> {
    if (!registriesSyncEnabled()) return;
    try {
      await this.run({ scope: 'nightly' }, 'nightly');
    } catch {
      // Reported by `run`.
    }
  }

  /** The Sunday step of the weekly chain (`CompanyMahallaService.weekly`). */
  async weekly(): Promise<RegistriesRunResult | null> {
    return this.run({ scope: 'weekly' }, 'weekly');
  }

  /** The registers a run reads, in catalogue order. */
  selectAdapters(
    opts: RegistryRunOptions,
    today: string = tashkentToday(),
  ): RegistryAdapter[] {
    if (opts.sources?.length) {
      const unknown = opts.sources.filter(
        (c) => !REGISTRY_ADAPTERS.some((a) => a.meta.code === c),
      );
      if (unknown.length) {
        throw new Error(`unknown register(s): ${unknown.join(', ')}`);
      }
      return REGISTRY_ADAPTERS.filter((a) =>
        opts.sources!.includes(a.meta.code),
      );
    }
    const scope = opts.scope ?? 'all';
    const firstSunday = Number(today.slice(8, 10)) <= 7;
    return REGISTRY_ADAPTERS.filter((a) => {
      const c = a.meta.cadence;
      if (c === 'manual') return false;
      if (scope === 'all') return true;
      if (scope === 'nightly') return c === 'daily';
      return (
        c === 'daily' || c === 'weekly' || (c === 'monthly' && firstSunday)
      );
    });
  }

  /**
   * One run under the lock, reported to Telegram and kept in `job_runs`. Null
   * when another replica holds the lock. Throws after reporting when the run
   * itself failed (one register failing is not that).
   */
  async run(
    opts: RegistryRunOptions,
    trigger: string,
  ): Promise<RegistriesRunResult | null> {
    return (await this.start(opts, trigger)).done;
  }

  /** Takes the lock and starts a run; `done` settles when it has reported. */
  async start(
    opts: RegistryRunOptions,
    trigger: string,
  ): Promise<{
    started: boolean;
    reason: string | null;
    done: Promise<RegistriesRunResult | null>;
  }> {
    const idle = Promise.resolve(null);
    // A wrong register code is the caller's mistake, not a run's.
    this.selectAdapters(opts);
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
        `[registries] ${trigger}: could not take the lock — ${(err as Error).message}`,
      );
      return { started: false, reason: (err as Error).message, done: idle };
    }
    if (!locked) {
      await runner.release().catch(() => undefined);
      this.logger.log(
        `[registries] ${trigger}: skipped — another replica is syncing`,
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
    opts: RegistryRunOptions,
    trigger: string,
  ): Promise<RegistriesRunResult> {
    const startedAt = new Date();
    try {
      const result = await this.syncAll(opts, startedAt);
      const text = this.describe(result, trigger);
      const alertSent = await this.telegram.deliver(text, {
        tag: 'registries',
      });
      await recordJobRun(this.db, {
        job: JOB,
        trigger,
        dry: result.dry,
        startedAt,
        ok: result.sources.every((s) => s.ok),
        summary: text,
        report: result,
        alertSent,
      });
      return result;
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`[registries] ${trigger}: run failed — ${message}`);
      const text = [
        `❌ <b>Registers (${escapeHtml(trigger)}) — run failed</b>`,
        `<code>${escapeHtml(message)}</code>`,
        'The stored registers are untouched. Retry by hand: POST /api/registries-sync/run',
      ].join('\n');
      const alertSent = await this.telegram.deliver(text, {
        tag: 'registries',
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

  /** Every selected register, one after another; then the name matching. */
  async syncAll(
    opts: RegistryRunOptions,
    startedAt: Date = new Date(),
  ): Promise<RegistriesRunResult> {
    const start = Date.now();
    const dry = opts.dry === true;
    const trial = opts.limit && opts.limit > 0 ? Math.floor(opts.limit) : null;
    const adapters = this.selectAdapters(opts);
    if (!dry) await this.seedSources();
    const disabled = new Set<string>(
      (
        await this.db.query(
          'SELECT code FROM public.registry_sources WHERE enabled = false',
        )
      ).map((r: { code: string }) => r.code),
    );
    const pacer = new HostPacer();
    const sources: RegistrySourceResult[] = [];
    let stoppedEarly = false;
    for (const adapter of adapters) {
      if (disabled.has(adapter.meta.code) && !opts.sources?.length) continue;
      if (await jobStopRequested(this.db, JOB, startedAt)) {
        stoppedEarly = true;
        break;
      }
      const source = opts.upload
        ? {
            ...adapter,
            fetchAll: () =>
              Promise.resolve({
                rows: opts.upload!.rows,
                complete: true,
                expected: null,
              }),
          }
        : adapter;
      sources.push(
        await this.syncSource(source, pacer, {
          dry,
          trial,
          reread: opts.reread === true,
        }),
      );
    }
    const nameSources = sources
      .filter((s) => s.ok && s.complete)
      .map((s) => s.code)
      .filter(
        (code) =>
          REGISTRY_ADAPTERS.find((a) => a.meta.code === code)?.meta.nameOnly,
      );
    let matches: NameMatchResult[] = [];
    if (nameSources.length && !trial) {
      try {
        matches = await matchRegistryNames(this.db, nameSources, { dry });
      } catch (err) {
        this.logger.warn(
          `[registries] name matching: ${(err as Error).message}`,
        );
      }
    }
    return {
      scope: opts.sources?.length
        ? opts.sources.join(',')
        : (opts.scope ?? 'all'),
      sources,
      stoppedEarly,
      matches,
      elapsedMs: Date.now() - start,
      dry,
      trial,
    };
  }

  /**
   * The files a register was read from, kept as read (the edition a PDF
   * register stood at). A file already kept is not written again; storage
   * that fails is a line in the report, never a failed register.
   */
  private async keepFiles(
    code: string,
    files: NonNullable<FetchResult['files']>,
  ): Promise<string[]> {
    if (!this.s3) return [];
    const bucket = registryBucket();
    let kept = 0;
    try {
      await this.s3.ensureBucket(bucket);
      for (const f of files) {
        const key = sourceFileKey(code, f.url, f.day);
        if (await this.s3.exists(bucket, key)) continue;
        await this.s3.upload(bucket, key, f.data, 'application/pdf');
        kept++;
      }
    } catch (err) {
      this.logger.warn(
        `[registries] ${code}: source file not kept — ${(err as Error).message}`,
      );
      return [`source file not kept: ${(err as Error).message}`];
    }
    return kept ? [`kept ${kept} source file(s) in ${bucket}`] : [];
  }

  /** What the adapter kept from its last written read; none when unreadable. */
  private async adapterState(code: string): Promise<unknown> {
    const rows = await this.db
      .query(
        `SELECT adapter_state FROM public.registry_sources WHERE code = $1`,
        [code],
      )
      .catch(() => []);
    return Array.isArray(rows)
      ? (rows[0]?.adapter_state ?? undefined)
      : undefined;
  }

  /** Listed entries of the periods a read left alone. */
  private async heldEntries(
    meta: RegistryAdapter['meta'],
    periods: string[],
  ): Promise<number> {
    const table = meta.nameOnly
      ? 'public.registry_name_rows'
      : 'public.company_registry_entries';
    const [{ n }] = await this.db.query(
      `SELECT count(*)::int AS n FROM ${table}
        WHERE source = $1 AND delisted_at IS NULL
          AND fields->>'period' = ANY($2::text[])`,
      [meta.code, periods],
    );
    return n;
  }

  /** Every register of the catalogue in `registry_sources` (titles follow the code). */
  async seedSources(): Promise<void> {
    const rows = REGISTRY_ADAPTERS.map((a) => ({
      code: a.meta.code,
      sector: a.meta.sector,
      kind: a.meta.kind,
      title_uz: a.meta.title.uz,
      title_ru: a.meta.title.ru,
      title_en: a.meta.title.en,
      cadence: a.meta.cadence,
      display: a.meta.display,
      name_only: a.meta.nameOnly === true,
      field_labels: a.meta.fieldLabels,
    }));
    await this.db.query(
      `INSERT INTO public.registry_sources
         (code, sector, kind, title_uz, title_ru, title_en, cadence, display, name_only, field_labels)
       SELECT code, sector, kind, title_uz, title_ru, title_en, cadence, display, name_only, field_labels
         FROM jsonb_to_recordset($1::jsonb) AS x(
           code text, sector text, kind text, title_uz text, title_ru text, title_en text,
           cadence text, display boolean, name_only boolean, field_labels jsonb)
       ON CONFLICT (code) DO UPDATE SET
         sector = EXCLUDED.sector, kind = EXCLUDED.kind,
         title_uz = EXCLUDED.title_uz, title_ru = EXCLUDED.title_ru, title_en = EXCLUDED.title_en,
         cadence = EXCLUDED.cadence, display = EXCLUDED.display, name_only = EXCLUDED.name_only,
         field_labels = EXCLUDED.field_labels, updated_at = now()`,
      [JSON.stringify(rows)],
    );
  }

  /** One register: read, map, compare, write. Never throws — a failure is its result. */
  async syncSource(
    adapter: RegistryAdapter,
    pacer: HostPacer,
    opts: { dry: boolean; trial: number | null; reread?: boolean },
  ): Promise<RegistrySourceResult> {
    const started = Date.now();
    const { meta } = adapter;
    const res: RegistrySourceResult = {
      code: meta.code,
      ok: false,
      error: null,
      refused: false,
      requests: 0,
      read: 0,
      expected: null,
      complete: false,
      entries: 0,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      delisted: 0,
      relisted: 0,
      held: 0,
      notes: [],
      skipped: {},
      duplicates: 0,
      copies: 0,
      editionDate: null,
      period: null,
      examples: { inserted: [], updated: [], delisted: [] },
      elapsedMs: 0,
    };
    const http = new RegistryHttp(pacer, opts.trial);
    try {
      const fetched = await adapter.fetchAll(http, {
        limit: opts.trial ?? undefined,
        state:
          opts.trial === null && !opts.reread
            ? await this.adapterState(meta.code)
            : undefined,
      });
      res.notes = fetched.notes ?? [];
      const held = fetched.heldPeriods ?? [];
      res.requests = http.requests;
      res.read = fetched.rows.length;
      res.expected = fetched.expected;
      res.editionDate = fetched.editionDate ?? null;
      res.period = fetched.period ?? null;
      res.complete =
        fetched.complete &&
        opts.trial === null &&
        (fetched.expected === null || fetched.rows.length >= fetched.expected);
      if (opts.trial === null && !res.complete) {
        throw new Error(
          `read ${fetched.rows.length} of ${fetched.expected ?? '?'} rows — incomplete, nothing written`,
        );
      }

      const ctx: MapContext = {
        editionDate: res.editionDate,
        period: res.period,
        today: tashkentToday(),
      };
      const entries = new Map<string, MappedEntry>();
      for (const row of fetched.rows) {
        let mapped;
        try {
          mapped = adapter.map(row, ctx);
        } catch (err) {
          mapped = { skip: `mapper error: ${(err as Error).message}` };
        }
        // A register without a STIR is kept by name only, and a name with no
        // legal form is a person's (an individual entrepreneur): not kept.
        if (
          !isSkip(mapped) &&
          meta.nameOnly &&
          !looksLikeOrganisation(mapped.name)
        ) {
          mapped = { skip: 'no legal form, may be a person — not kept' };
        }
        if (isSkip(mapped)) {
          res.skipped[mapped.skip] = (res.skipped[mapped.skip] ?? 0) + 1;
          continue;
        }
        const earlier = entries.get(mapped.sourceKey);
        if (earlier) {
          if (entryHash(earlier) === entryHash(mapped)) {
            res.copies++;
            continue;
          }
          res.duplicates++;
        }
        entries.set(mapped.sourceKey, mapped);
      }
      res.entries = entries.size;
      if (held.length) res.held = await this.heldEntries(meta, held);
      if (opts.trial === null && entries.size + res.held < meta.minRows) {
        throw new Error(
          `only ${entries.size + res.held} entries (at least ${meta.minRows} expected) — nothing written`,
        );
      }

      await this.writeSource(adapter, [...entries.values()], res, {
        dry: opts.dry,
        delist: res.complete,
        held,
      });
      res.ok = true;
      if (!opts.dry && fetched.files?.length) {
        res.notes.push(...(await this.keepFiles(meta.code, fetched.files)));
      }
      if (!opts.dry) {
        await this.db.query(
          `UPDATE public.registry_sources SET
             last_ok_at = CASE WHEN $2 THEN now() ELSE last_ok_at END,
             last_rows = CASE WHEN $2 THEN $3 ELSE last_rows END,
             edition_date = COALESCE($4::date, edition_date),
             period_label = COALESCE($5, period_label),
             adapter_state = CASE WHEN $2 AND $6::jsonb IS NOT NULL
                                  THEN $6::jsonb ELSE adapter_state END,
             last_error = NULL, last_error_at = NULL, updated_at = now()
           WHERE code = $1`,
          [
            meta.code,
            res.complete,
            res.entries + res.held,
            res.editionDate,
            res.period,
            fetched.state === undefined ? null : JSON.stringify(fetched.state),
          ],
        );
      }
    } catch (err) {
      res.ok = false;
      res.error = (err as Error).message;
      res.refused = err instanceof SourceRefusedError;
      res.requests = http.requests;
      this.logger.warn(`[registries] ${meta.code}: ${res.error}`);
      if (!opts.dry) {
        await this.db
          .query(
            `UPDATE public.registry_sources
                SET last_error = $2, last_error_at = now(), updated_at = now()
              WHERE code = $1`,
            [meta.code, res.error.slice(0, 1000)],
          )
          .catch(() => undefined);
      }
    }
    res.elapsedMs = Date.now() - started;
    this.logger.log(
      `[registries] ${meta.code}${opts.dry ? ' (dry)' : ''}: ${res.ok ? 'ok' : 'failed'} — ` +
        `read ${res.read}${res.expected !== null ? ` of ${res.expected}` : ''} in ${res.requests} request(s), ` +
        `+${res.inserted} ~${res.updated} =${res.unchanged} −${res.delisted} in ${res.elapsedMs} ms`,
    );
    return res;
  }

  /**
   * The entries compared with what we hold and — unless `dry` — written in
   * one transaction: new rows inserted; changed rows updated with the values
   * they replace logged; unchanged rows touched only when listed again or
   * their source row moved; on a complete read, rows no longer listed
   * delisted (never deleted).
   */
  private async writeSource(
    adapter: RegistryAdapter,
    list: MappedEntry[],
    res: RegistrySourceResult,
    opts: { dry: boolean; delist: boolean; held?: string[] },
  ): Promise<void> {
    const { meta } = adapter;
    const nameOnly = meta.nameOnly === true;
    const table = nameOnly
      ? 'public.registry_name_rows'
      : 'public.company_registry_entries';
    const hashes = new Map(list.map((m) => [m.sourceKey, entryHash(m)]));
    const keys = list.map((m) => m.sourceKey);

    const stored: StoredRow[] = keys.length
      ? await this.db.query(
          `SELECT source_key, content_hash, delisted_at, ${nameOnly ? '' : 'inn,'}
                  name, number, status, is_active,
                  to_char(valid_from, 'YYYY-MM-DD') AS valid_from,
                  to_char(valid_to, 'YYYY-MM-DD') AS valid_to,
                  amount::text AS amount, fields
             FROM ${table}
            WHERE source = $1 AND source_key = ANY($2::text[])`,
          [meta.code, keys],
        )
      : [];
    const byKey = new Map(stored.map((s) => [s.source_key, s]));

    const inserted: MappedEntry[] = [];
    const changed: Array<{ m: MappedEntry; was: StoredRow; visible: boolean }> =
      [];
    const unchanged: MappedEntry[] = [];
    for (const m of list) {
      const was = byKey.get(m.sourceKey);
      if (!was) {
        inserted.push(m);
        continue;
      }
      if (was.delisted_at) res.relisted++;
      if (was.content_hash === hashes.get(m.sourceKey)) {
        unchanged.push(m);
        continue;
      }
      const before = visibleValues(was);
      const after = visibleValues(columnsOf(m));
      const visible = Object.keys(after).some(
        (k) =>
          comparable(after[k]) !== '' &&
          comparable(after[k]) !== comparable(before[k]),
      );
      changed.push({ m, was, visible });
      if (visible) {
        res.updated++;
        if (res.examples.updated.length < EXAMPLES) {
          res.examples.updated.push(labelOf(m));
        }
      } else {
        res.unchanged++;
      }
    }
    res.inserted = inserted.length;
    res.unchanged += unchanged.length;
    res.examples.inserted = inserted.slice(0, EXAMPLES).map(labelOf);

    let delisted: Array<{
      source_key: string;
      name: string | null;
      number: string | null;
    }> = [];
    if (opts.delist) {
      // Entries of a period the read left alone are not its to delist.
      delisted = await this.db.query(
        `SELECT source_key, name, number FROM ${table}
          WHERE source = $1 AND delisted_at IS NULL
            AND NOT (source_key = ANY($2::text[]))
            AND NOT (coalesce(fields->>'period', '') = ANY($3::text[]))`,
        [meta.code, keys, opts.held ?? []],
      );
      const [{ listed }] = await this.db.query(
        `SELECT count(*)::int AS listed FROM ${table}
          WHERE source = $1 AND delisted_at IS NULL`,
        [meta.code],
      );
      if (
        !meta.periodic &&
        delisted.length > 10 &&
        delisted.length > listed * MAX_DELIST_SHARE
      ) {
        throw new Error(
          `the read would take ${delisted.length} of ${listed} listed entries off the register — not trusted, nothing written`,
        );
      }
      res.delisted = delisted.length;
      res.examples.delisted = delisted.slice(0, EXAMPLES).map(labelOf);
    }

    if (opts.dry) return;
    await this.db.transaction(async (m) => {
      await this.insertEntries(
        m,
        table,
        nameOnly,
        meta.code,
        meta.kind,
        inserted,
        hashes,
      );
      for (const c of changed) {
        await this.updateEntry(
          m,
          table,
          nameOnly,
          meta.code,
          c.m,
          c.was,
          hashes.get(c.m.sourceKey)!,
          c.visible,
        );
      }
      await this.markSeen(m, table, meta.code, unchanged);
      if (delisted.length) {
        await m.query(
          `UPDATE ${table} SET delisted_at = now()
            WHERE source = $1 AND delisted_at IS NULL
              AND source_key = ANY($2::text[])`,
          [meta.code, delisted.map((d) => d.source_key)],
        );
      }
    });
  }

  private rowValues(
    m: MappedEntry,
    source: string,
    kind: string,
    hash: string,
  ): Record<string, unknown> {
    return {
      source,
      source_key: m.sourceKey,
      name: m.name,
      kind,
      number: m.number,
      status: m.status,
      is_active: m.isActive,
      valid_from: m.validFrom,
      valid_to: m.validTo,
      amount: m.amount,
      amount_unit: m.amountUnit,
      fields: JSON.stringify(m.fields ?? {}),
      raw: JSON.stringify(m.raw ?? {}),
      content_hash: hash,
      as_of: m.asOf,
      inn: m.inn,
      pinfl: m.pinfl,
      raw_tin: m.rawTin,
      name_key: nameKey(m.name) ?? '',
      region: m.region ?? null,
    };
  }

  private async insertEntries(
    m: EntityManager,
    table: string,
    nameOnly: boolean,
    source: string,
    kind: string,
    list: MappedEntry[],
    hashes: Map<string, string>,
  ): Promise<void> {
    const cols = [
      ...COMMON_COLUMNS,
      ...(nameOnly ? NAME_COLUMNS : ENTRY_COLUMNS),
    ];
    for (let i = 0; i < list.length; i += INSERT_BATCH) {
      const params: unknown[] = [];
      const tuples = list.slice(i, i + INSERT_BATCH).map((e) => {
        const values = this.rowValues(
          e,
          source,
          kind,
          hashes.get(e.sourceKey)!,
        );
        const at = params.length;
        for (const [c] of cols) params.push(values[c] ?? null);
        return `(${cols.map(([, cast], j) => `$${at + j + 1}::${cast}`).join(', ')})`;
      });
      await m.query(
        `INSERT INTO ${table} (${cols.map(([c]) => c).join(', ')})
         VALUES ${tuples.join(', ')}
         ON CONFLICT (source, source_key) DO NOTHING`,
        params,
      );
    }
  }

  /**
   * One entry that changed at the source: the values it replaces logged first
   * (company entries), a blank sent keeps the stored value, a new status keeps
   * the one before it. `updated_at` moves only when a reader sees a change.
   */
  private async updateEntry(
    m: EntityManager,
    table: string,
    nameOnly: boolean,
    source: string,
    e: MappedEntry,
    was: StoredRow,
    hash: string,
    visible: boolean,
  ): Promise<void> {
    if (!nameOnly) {
      const after = presentOnly(
        visibleValues(columnsOf(e)),
        Object.keys(visibleValues(columnsOf(e))),
      );
      await logFieldChanges(
        m,
        {
          entity: 'company_registry_entries',
          inn: e.inn ?? was.inn ?? null,
          key: `${source}:${e.sourceKey}`,
          source,
        },
        visibleValues(was),
        after,
        Object.keys(after),
      );
    }
    const params: unknown[] = [source, e.sourceKey];
    const p = (value: unknown, cast: string) => {
      params.push(value === undefined ? null : value);
      return `$${params.length}::${cast}`;
    };
    const keep = (col: string, value: unknown, cast: string) =>
      `${col} = COALESCE(${p(value, cast)}, ${col})`;
    const status = p(e.status, 'text');
    const sets = [
      keep('name', e.name, 'text'),
      keep('number', e.number, 'text'),
      keep('is_active', e.isActive, 'boolean'),
      keep('valid_from', e.validFrom, 'date'),
      keep('valid_to', e.validTo, 'date'),
      keep('amount', e.amount, 'numeric'),
      keep('amount_unit', e.amountUnit, 'text'),
      keep('as_of', e.asOf, 'date'),
      `fields = fields || ${p(JSON.stringify(e.fields ?? {}), 'jsonb')}`,
      `previous_status = CASE WHEN ${status} IS NOT NULL AND status IS DISTINCT FROM ${status} THEN status ELSE previous_status END`,
      `status_changed_seen_at = CASE WHEN ${status} IS NOT NULL AND status IS DISTINCT FROM ${status} THEN now() ELSE status_changed_seen_at END`,
      `status = COALESCE(${status}, status)`,
      `raw = ${p(JSON.stringify(e.raw ?? {}), 'jsonb')}`,
      `content_hash = ${p(hash, 'text')}`,
      'delisted_at = NULL',
      'last_seen_at = now()',
      `updated_at = CASE WHEN ${p(visible, 'boolean')} THEN now() ELSE updated_at END`,
      ...(nameOnly
        ? [
            keep('name_key', nameKey(e.name), 'text'),
            keep('region', e.region ?? null, 'text'),
          ]
        : [
            keep('inn', e.inn, 'text'),
            keep('pinfl', e.pinfl, 'text'),
            keep('raw_tin', e.rawTin, 'text'),
          ]),
    ];
    await m.query(
      `UPDATE ${table} SET ${sets.join(',\n ')}
        WHERE source = $1 AND source_key = $2`,
      params,
    );
  }

  /**
   * Entries listed as we hold them. Written only when listed again or when
   * their source row or edition moved — the rest are not touched, so a quiet
   * week rewrites nothing.
   */
  private async markSeen(
    m: EntityManager,
    table: string,
    source: string,
    list: MappedEntry[],
  ): Promise<void> {
    for (let i = 0; i < list.length; i += SEEN_BATCH) {
      const rows = list.slice(i, i + SEEN_BATCH).map((e) => ({
        source_key: e.sourceKey,
        raw: e.raw ?? {},
        as_of: e.asOf,
      }));
      await m.query(
        `UPDATE ${table} t
            SET last_seen_at = now(),
                delisted_at = NULL,
                raw = x.raw,
                as_of = COALESCE(x.as_of, t.as_of)
           FROM jsonb_to_recordset($2::jsonb) AS x(source_key text, raw jsonb, as_of date)
          WHERE t.source = $1 AND t.source_key = x.source_key
            AND (t.delisted_at IS NOT NULL
                 OR t.raw IS DISTINCT FROM x.raw
                 OR t.as_of IS DISTINCT FROM COALESCE(x.as_of, t.as_of))`,
        [source, JSON.stringify(rows)],
      );
    }
  }

  /** Registers, what each holds, its last read, and the last runs. */
  async status(): Promise<Record<string, unknown>> {
    const sources = await this.db.query(
      `SELECT s.code, s.sector, s.kind, s.title_uz, s.cadence, s.display, s.name_only,
              s.enabled, s.edition_date, s.period_label, s.last_ok_at, s.last_rows,
              s.last_error, s.last_error_at,
              coalesce(e.listed, n.listed, 0) AS listed,
              coalesce(e.delisted, n.delisted, 0) AS delisted,
              e.companies, e.persons, n.matched
         FROM public.registry_sources s
         LEFT JOIN (
           SELECT source,
                  count(*) FILTER (WHERE delisted_at IS NULL)::int AS listed,
                  count(*) FILTER (WHERE delisted_at IS NOT NULL)::int AS delisted,
                  count(DISTINCT inn)::int AS companies,
                  count(DISTINCT pinfl)::int AS persons
             FROM public.company_registry_entries GROUP BY source
         ) e ON e.source = s.code
         LEFT JOIN (
           SELECT source,
                  count(*) FILTER (WHERE delisted_at IS NULL)::int AS listed,
                  count(*) FILTER (WHERE delisted_at IS NOT NULL)::int AS delisted,
                  count(*) FILTER (WHERE match_inn IS NOT NULL)::int AS matched
             FROM public.registry_name_rows GROUP BY source
         ) n ON n.source = s.code
        ORDER BY s.code`,
    );
    return {
      enabled: registriesSyncEnabled(),
      schedule:
        '03:10 Asia/Tashkent Mon–Sat (daily registers); Sunday weekly chain (daily + weekly, monthly on the first Sunday)',
      catalogue: REGISTRY_ADAPTERS.length,
      sources,
      recent_runs: await recentJobRuns(this.db, [JOB], 10),
    };
  }

  /** Phase C by hand: rows of name-only registers tied to companies. */
  async matchNames(
    codes: string[] | null,
    dry: boolean,
  ): Promise<NameMatchResult[]> {
    const nameOnly = REGISTRY_ADAPTERS.filter((a) => a.meta.nameOnly).map(
      (a) => a.meta.code,
    );
    const pick = codes?.length
      ? nameOnly.filter((c) => codes.includes(c))
      : nameOnly;
    return matchRegistryNames(this.db, pick, { dry });
  }

  private describe(r: RegistriesRunResult, trigger: string): string {
    const failed = r.sources.filter((s) => !s.ok);
    const changed = r.sources.reduce(
      (n, s) => n + s.inserted + s.updated + s.delisted,
      0,
    );
    const head =
      r.dry || r.trial ? '🧪' : failed.length ? '⚠️' : changed ? '📚' : '✅';
    const lines = [
      `${head} <b>Registers — ${escapeHtml(trigger)}</b>` +
        (r.dry ? ' (dry run, nothing written)' : '') +
        (r.trial
          ? ` (trial: ≤${r.trial} request(s) per register, nothing delisted)`
          : ''),
      `Took: ${Math.round(r.elapsedMs / 1000)} s · registers: ${r.sources.length}` +
        (failed.length ? ` · failed: ${failed.length}` : '') +
        (r.stoppedEarly ? ' · stopped on request' : ''),
    ];
    for (const s of r.sources) {
      if (!s.ok) {
        lines.push(
          `❌ ${s.code}: ${escapeHtml(s.error ?? 'failed')}${s.refused ? ' (refused — next run)' : ''}`,
        );
        continue;
      }
      const skipped = Object.entries(s.skipped)
        .map(([why, n]) => `${n} ${why}`)
        .join(', ');
      lines.push(
        `${s.inserted + s.updated + s.delisted ? '•' : '·'} ${s.code}: ${s.entries} entries` +
          ` (read ${s.read}${s.expected !== null && s.expected !== s.read ? ` of ${s.expected}` : ''}, ${s.requests} req)` +
          ` · +${s.inserted} ~${s.updated} =${s.unchanged}` +
          (s.complete ? ` −${s.delisted}` : '') +
          (s.relisted ? ` · listed again ${s.relisted}` : '') +
          (s.duplicates
            ? ` · same key, other values ${s.duplicates} (later kept)`
            : '') +
          (s.copies ? ` · repeated rows ${s.copies}` : '') +
          (skipped ? ` · left out: ${escapeHtml(skipped)}` : '') +
          (s.held ? ` · kept unread ${s.held} (file unchanged)` : '') +
          (s.period ? ` · period ${s.period}` : ''),
      );
      for (const note of s.notes ?? []) lines.push(`    ${escapeHtml(note)}`);
      for (const [label, xs] of [
        ['new', s.examples.inserted],
        ['changed', s.examples.updated],
        ['no longer listed', s.examples.delisted],
      ] as const) {
        if (xs.length && (label !== 'new' || s.inserted <= 50)) {
          lines.push(`    ${label}: ${xs.map(escapeHtml).join('; ')}`);
        }
      }
    }
    for (const m of r.matches) {
      lines.push(
        `🔗 ${m.source}: matched by name ${m.matched} of ${m.rows} (several companies ${m.ambiguous}, none ${m.unmatched})`,
      );
    }
    return lines.join('\n');
  }
}
