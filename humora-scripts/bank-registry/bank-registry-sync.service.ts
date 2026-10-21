import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import axios from 'axios';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recentJobRuns, recordJobRun } from '../common/job-runs';

interface CellWrapper {
  text?: string | null;
  number?: number | null;
  data?: string | null;
  default?: string | null;
}
interface RawRow {
  id?: string;
  tableColumn?: Record<string, CellWrapper>;
}
interface ApiResponse {
  result?: { isSuccess?: boolean; count?: number; data?: RawRow[] };
  statusCode?: number;
}

export interface BankRow {
  bank_type: string;
  bank_name: string | null;
  date_open: string | null; // ISO YYYY-MM-DD
  date_close: string | null;
  date_act: string | null;
  date_deact: string | null;
  active: string | null; // 'A' | 'P' | null
}

export interface BankBranchRow {
  bank_id: string;
  bank_type: string | null;
  region_id: string | null;
  header_id: string | null;
  union_id: string | null;
  tcc_id: string | null;
  ccc_id: string | null;
  bank_name: string | null;
  bank_adres: string | null;
  bank_statu: string | null;
  date_open: string | null;
  date_close: string | null;
  date_act: string | null;
  date_deact: string | null;
  active: string | null;
  distr: string | null;
  kol_obm: string | null;
  inn: string | null;
}

const BANK_COLUMNS = [
  'bank_type',
  'bank_name',
  'date_open',
  'date_close',
  'date_act',
  'date_deact',
  'active',
] as const;

const BRANCH_COLUMNS = [
  'bank_id',
  'bank_type',
  'region_id',
  'header_id',
  'union_id',
  'tcc_id',
  'ccc_id',
  'bank_name',
  'bank_adres',
  'bank_statu',
  'date_open',
  'date_close',
  'date_act',
  'date_deact',
  'active',
  'distr',
  'kol_obm',
  'inn',
] as const;

/** A parent bank with its full ordered list of branches embedded. */
export interface BankWithBranches extends BankRow {
  branches: BankBranchRow[];
}

/** A branch joined with the parent bank it belongs to. */
export interface BranchWithBank extends BankBranchRow {
  parent_bank: BankRow | null;
}

/** What one dataset's sync found, compared with what we held. */
export interface DatasetDiff {
  fetched: number;
  /** Of the fetched rows, those the source marks active ('A'). */
  active: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Held here, absent from this fetch. Kept, never deleted — only counted. */
  notInSource: number;
  /**
   * A few of each for the report: "MFO name", and for a changed row what
   * changed — "00451 NAME: active A→P, date_close —→2026-09-01".
   */
  examples: { inserted: string[]; updated: string[]; notInSource: string[] };
}

export interface BankRegistrySyncResult {
  banks: DatasetDiff;
  branches: DatasetDiff;
  elapsedMs: number;
  dry: boolean;
}

/** Held by a session; the replica that takes it runs and reports. */
export const LOCK_ID = 8_150_933;
const JOB = 'bank_registry';
const EXAMPLES = 10;

/**
 * Whether the weekly sync (Sunday 04:30, ridden by the company mahalla run)
 * happens here: on a deployment (TG_WEBHOOK_URL set — dev and prod), not on a
 * laptop. `BANK_REGISTRY_SYNC_ENABLED=1|0` overrides.
 */
export function bankRegistrySyncEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.BANK_REGISTRY_SYNC_ENABLED === '1') return true;
  if (env.BANK_REGISTRY_SYNC_ENABLED === '0') return false;
  return Boolean(env.TG_WEBHOOK_URL);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Bulk-syncs the Central Bank reference registries from cs.egov.uz into
 * our own DB so lookups stay fast and offline-resilient instead of hitting
 * the live POST API on every request.
 *
 *   public.banks         ← 72 parent banks
 *   public.bank_branches ← ~3600 filiallar (key = MFO = company_info.bank_code)
 *
 * The bank reports decide which bank a company belongs to through these two
 * tables (company_info.bank_code → bank_branches → banks). They are kept
 * current by the weekly Sunday 04:30 run behind those reports
 * (`CompanyMahallaService.weekly`, which calls `run` before the mahalla
 * fill) — no cron of its own — and by hand with POST /bank-registry/sync
 * (`?dry=1` to see the differences first). GET /bank-registry/status shows
 * the last runs.
 *
 * Both datasets fit in a single POST. Each is compared with what we hold
 * before anything is written: new and changed rows are written, unchanged
 * ones only have `fetched_at` moved (the last time the source listed them),
 * and a row the source stopped listing is kept and reported, never deleted —
 * a closed branch still explains the companies that banked there. An empty
 * or failed answer from the source is an error, not "no banks".
 *
 * Every run is kept in `job_runs` with its report, whether or not Telegram
 * took it.
 */
@Injectable()
export class BankRegistrySyncService {
  private readonly logger = new Logger(BankRegistrySyncService.name);
  private readonly API_URL = 'https://cs.egov.uz/apiData/MainData/Get';
  private readonly BANKS_ID = '61a60296b83d3e9e6a91d8c8';
  private readonly BRANCHES_ID = '61a5af415e335967803edc8b';
  private readonly httpTimeout = 60_000;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly telegram: TelegramAlertService,
  ) {}

  /**
   * One sync under the lock, reported to Telegram and kept in `job_runs`
   * whatever happened. Null when another replica holds the lock (that one
   * reports). Throws after reporting when the sync failed.
   */
  async run(
    opts: { dry?: boolean },
    trigger: string,
  ): Promise<BankRegistrySyncResult | null> {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [LOCK_ID],
      );
      if (!locked) {
        this.logger.log(
          `[bank-registry] ${trigger}: skipped — another replica is syncing`,
        );
        return null;
      }
      const startedAt = new Date();
      try {
        const result = await this.syncAll(opts);
        const text = this.describe(result, trigger);
        const alertSent = await this.telegram.deliver(text, {
          tag: 'bank_registry',
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
          `[bank-registry] ${trigger}: sync failed — ${message}`,
        );
        const text = [
          `❌ <b>Bank registry (${escapeHtml(trigger)}) — sync failed</b>`,
          `<code>${escapeHtml(message)}</code>`,
          'Stored banks and branches are untouched. Retry by hand: POST /api/bank-registry/sync',
        ].join('\n');
        const alertSent = await this.telegram.deliver(text, {
          tag: 'bank_registry',
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
      } finally {
        await runner
          .query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
          .catch(() => undefined);
      }
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  /** What we hold, when it last changed, and the last runs. */
  async status(): Promise<Record<string, unknown>> {
    const [banks] = await this.db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE active = 'A')::int AS active,
              max(updated_at) AS last_changed, max(fetched_at) AS last_seen
         FROM public.banks`,
    );
    const [branches] = await this.db.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE active = 'A')::int AS active,
              max(updated_at) AS last_changed, max(fetched_at) AS last_seen,
              count(*) FILTER (WHERE fetched_at < (SELECT max(fetched_at) FROM public.bank_branches) - interval '1 day')::int
                AS not_in_last_fetch
         FROM public.bank_branches`,
    );
    return {
      weekly_enabled: bankRegistrySyncEnabled(),
      schedule: 'Sunday 04:30 Asia/Tashkent, before the company mahalla run',
      banks,
      branches,
      recent_runs: await recentJobRuns(this.db, [JOB], 10),
    };
  }

  private describe(r: BankRegistrySyncResult, trigger: string): string {
    const fmt = (n: number) => n.toLocaleString('en-US');
    const line = (label: string, d: DatasetDiff) =>
      `${label}: ${fmt(d.fetched)} (active ${fmt(d.active)}) · new ${d.inserted} · ` +
      `changed ${d.updated} · gone from the source ${d.notInSource}`;
    const list = (label: string, total: number, xs: string[]) =>
      xs.length
        ? [
            `${label}${total > xs.length ? ` (${xs.length} of ${total})` : ''}:`,
            ...xs.map((x) => `  • ${escapeHtml(x)}`),
          ]
        : [];
    const changed =
      r.banks.inserted +
      r.banks.updated +
      r.banks.notInSource +
      r.branches.inserted +
      r.branches.updated +
      r.branches.notInSource;
    return [
      `${r.dry ? '🧪' : changed ? '🏦' : '✅'} <b>Bank registry — ${escapeHtml(trigger)}</b>` +
        `${r.dry ? ' (dry run, nothing written)' : ''}`,
      `Took: ${Math.round(r.elapsedMs / 1000)} s · source: cs.egov.uz`,
      line('Banks', r.banks),
      line('Branches', r.branches),
      ...(changed ? [] : ['No changes.']),
      ...list('New banks', r.banks.inserted, r.banks.examples.inserted),
      ...list('Changed banks', r.banks.updated, r.banks.examples.updated),
      ...list(
        'New branches',
        r.branches.inserted,
        r.branches.examples.inserted,
      ),
      ...list(
        'Changed branches',
        r.branches.updated,
        r.branches.examples.updated,
      ),
      ...list(
        'Branches gone from the source (kept here)',
        r.branches.notInSource,
        r.branches.examples.notInSource,
      ),
    ].join('\n');
  }

  /**
   * Fetch the full dataset for the given id. Both datasets are small enough
   * (<= 4k rows) to come back in a single POST — we ask for a huge `limit`
   * and rely on the server's `fullCount` being below that.
   */
  private async fetchAll(id: string): Promise<RawRow[]> {
    const resp = await axios.post<ApiResponse>(
      this.API_URL,
      { id, offset: 0, limit: 100000, query: {} },
      {
        timeout: this.httpTimeout,
        headers: { 'Content-Type': 'application/json' },
        validateStatus: () => true,
      },
    );
    // validateStatus lets every answer through, so read it: an error page
    // parsed as "no rows" is how an outage passes for an empty registry.
    // Not `isSuccess` — the source sends false with the full dataset (seen
    // 2026-09-28: isSuccess=false, count 72, 72 rows).
    const body: any = resp.data;
    if (resp.status !== 200 || body?.error) {
      throw new Error(
        `cs.egov.uz answered HTTP ${resp.status}` +
          (body?.error
            ? ` with error ${JSON.stringify(body.error).slice(0, 200)}`
            : '') +
          ` for dataset ${id}`,
      );
    }
    const rows = body?.result?.data;
    if (!Array.isArray(rows)) {
      throw new Error(
        `cs.egov.uz answered without a row list for dataset ${id}`,
      );
    }
    // Fewer rows than the source says it has is a cut-off answer, not a
    // registry that shrank.
    const count = Number(body?.result?.count);
    if (Number.isFinite(count) && count > rows.length) {
      throw new Error(
        `cs.egov.uz sent ${rows.length} of ${count} rows for dataset ${id}`,
      );
    }
    return rows;
  }

  /** "DD.MM.YYYY" → ISO "YYYY-MM-DD". Blank " " and empty → null. */
  private parseDate(raw: string | null | undefined): string | null {
    const s = (raw ?? '').trim();
    if (!s) return null;
    const m = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
  }

  /**
   * Pull the displayed string from a cs.egov.uz cell wrapper. Trims trailing
   * spaces (the source pads many fixed-width fields) and treats blank/single-
   * space values as null — the API uses " " for nulls.
   */
  private cell(
    cols: Record<string, CellWrapper> | undefined,
    key: string,
  ): string | null {
    const c = cols?.[key];
    const raw = c?.data ?? c?.default ?? null;
    const v = typeof raw === 'string' ? raw.trim() : raw;
    return v ? String(v) : null;
  }

  private parseBanks(raw: RawRow[]): BankRow[] {
    const rows: BankRow[] = [];
    for (const r of raw) {
      const c = r.tableColumn;
      const bank_type = this.cell(c, 'BANK_TYPE');
      if (!bank_type) continue;
      rows.push({
        bank_type,
        bank_name: this.cell(c, 'BANK_NAME'),
        date_open: this.parseDate(this.cell(c, 'DATE_OPEN')),
        date_close: this.parseDate(this.cell(c, 'DATE_CLOSE')),
        date_act: this.parseDate(this.cell(c, 'DATE_ACT')),
        date_deact: this.parseDate(this.cell(c, 'DATE_DEACT')),
        active: this.cell(c, 'ACTIVE'),
      });
    }
    return rows;
  }

  private parseBranches(raw: RawRow[]): BankBranchRow[] {
    const rows: BankBranchRow[] = [];
    for (const r of raw) {
      const c = r.tableColumn;
      const bank_id = this.cell(c, 'BANK_ID');
      if (!bank_id) continue;
      rows.push({
        bank_id,
        bank_type: this.cell(c, 'BANK_TYPE'),
        region_id: this.cell(c, 'REGION_ID'),
        header_id: this.cell(c, 'HEADER_ID'),
        union_id: this.cell(c, 'UNION_ID'),
        tcc_id: this.cell(c, 'TCC_ID'),
        ccc_id: this.cell(c, 'CCC_ID'),
        bank_name: this.cell(c, 'BANK_NAME'),
        bank_adres: this.cell(c, 'BANK_ADRES'),
        bank_statu: this.cell(c, 'BANK_STATU'),
        date_open: this.parseDate(this.cell(c, 'DATE_OPEN')),
        date_close: this.parseDate(this.cell(c, 'DATE_CLOSE')),
        date_act: this.parseDate(this.cell(c, 'DATE_ACT')),
        date_deact: this.parseDate(this.cell(c, 'DATE_DEACT')),
        active: this.cell(c, 'ACTIVE'),
        distr: this.cell(c, 'DISTR'),
        kol_obm: this.cell(c, 'KOL_OBM'),
        inn: this.cell(c, 'INN'),
      });
    }
    return rows;
  }

  /**
   * Both registries fetched, compared with what we hold and — unless `dry` —
   * written. Throws when the source answers with nothing: a registry of zero
   * banks is an outage, and treating it as data is how a sync reports
   * "no changes" for a month.
   */
  async syncAll(opts: { dry?: boolean } = {}): Promise<BankRegistrySyncResult> {
    const start = Date.now();
    const dry = opts.dry === true;
    const [rawBanks, rawBranches] = await Promise.all([
      this.fetchAll(this.BANKS_ID),
      this.fetchAll(this.BRANCHES_ID),
    ]);
    const banks = this.parseBanks(rawBanks);
    const branches = this.parseBranches(rawBranches);
    if (banks.length === 0 || branches.length === 0) {
      throw new Error(
        `cs.egov.uz returned ${banks.length} banks and ${branches.length} ` +
          'branches — nothing written',
      );
    }

    const bankDiff = await this.apply(
      'banks',
      'bank_type',
      BANK_COLUMNS,
      banks,
      dry,
    );
    const branchDiff = await this.apply(
      'bank_branches',
      'bank_id',
      BRANCH_COLUMNS,
      branches,
      dry,
    );
    const elapsedMs = Date.now() - start;
    this.logger.log(
      `[bank-registry] ${dry ? 'dry run' : 'sync'} done in ${elapsedMs}ms — ` +
        `banks +${bankDiff.inserted} ~${bankDiff.updated} missing ${bankDiff.notInSource}, ` +
        `branches +${branchDiff.inserted} ~${branchDiff.updated} missing ${branchDiff.notInSource}`,
    );
    return { banks: bankDiff, branches: branchDiff, elapsedMs, dry };
  }

  /**
   * One dataset against its table. Values are compared as the table would
   * store them — dates as YYYY-MM-DD, everything else as text — so a row the
   * source repeats unchanged is not counted, or rewritten, as a change.
   */
  private async apply(
    table: 'banks' | 'bank_branches',
    key: string,
    columns: readonly string[],
    fresh: Array<Record<string, any>>,
    dry: boolean,
  ): Promise<DatasetDiff> {
    const select = columns
      .map((c) =>
        c.startsWith('date_')
          ? `to_char(${c}, 'YYYY-MM-DD') AS ${c}`
          : `${c}::text AS ${c}`,
      )
      .join(', ');
    const stored: Array<Record<string, any>> = await this.db.query(
      `SELECT ${select} FROM public.${table}`,
    );
    const storedByKey = new Map(stored.map((s) => [String(s[key]), s]));
    const freshByKey = new Map(fresh.map((r) => [String(r[key]), r]));

    const inserted: Array<Record<string, any>> = [];
    const updated: Array<Record<string, any>> = [];
    const unchanged: string[] = [];
    const asText = (v: unknown) => (v == null ? null : String(v));
    for (const [k, row] of freshByKey) {
      const was = storedByKey.get(k);
      if (!was) inserted.push(row);
      else if (columns.some((c) => asText(was[c]) !== asText(row[c]))) {
        updated.push(row);
      } else unchanged.push(k);
    }
    const missing = stored.filter((s) => !freshByKey.has(String(s[key])));

    if (!dry) {
      await this.upsert(table, key, columns, [...inserted, ...updated]);
      if (unchanged.length) {
        await this.db.query(
          `UPDATE public.${table} SET fetched_at = now() WHERE ${key} = ANY($1::text[])`,
          [unchanged],
        );
      }
    }

    const label = (r: Record<string, any>) =>
      [r[key], r.bank_name].filter(Boolean).join(' ');
    const whatChanged = (r: Record<string, any>) => {
      const was = storedByKey.get(String(r[key])) ?? {};
      const fields = columns
        .filter((c) => asText(was[c]) !== asText(r[c]))
        .slice(0, 4)
        .map((c) => `${c} ${asText(was[c]) ?? '—'}→${asText(r[c]) ?? '—'}`);
      return `${label(r)}: ${fields.join(', ')}`;
    };
    return {
      fetched: freshByKey.size,
      active: [...freshByKey.values()].filter((r) => r.active === 'A').length,
      inserted: inserted.length,
      updated: updated.length,
      unchanged: unchanged.length,
      notInSource: missing.length,
      examples: {
        inserted: inserted.slice(0, EXAMPLES).map(label),
        updated: updated.slice(0, EXAMPLES).map(whatChanged),
        notInSource: missing.slice(0, EXAMPLES).map(label),
      },
    };
  }

  /** New and changed rows, batched; `updated_at` marks a real change. */
  private async upsert(
    table: 'banks' | 'bank_branches',
    key: string,
    columns: readonly string[],
    rows: Array<Record<string, any>>,
  ): Promise<void> {
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const params: unknown[] = [];
      const tuples = chunk.map((r) => {
        const start = params.length;
        for (const c of columns) params.push(r[c] ?? null);
        return `(${columns.map((_, j) => `$${start + j + 1}`).join(', ')})`;
      });
      await this.db.query(
        `INSERT INTO public.${table} (${columns.join(', ')})
         VALUES ${tuples.join(', ')}
         ON CONFLICT (${key}) DO UPDATE SET
           ${columns
             .filter((c) => c !== key)
             .map((c) => `${c} = EXCLUDED.${c}`)
             .join(', ')},
           fetched_at = now(),
           updated_at = now()`,
        params,
      );
    }
  }

  // ---- Internal joins (parent bank ↔ branches). No HTTP endpoint —
  // ---- other services (e.g. org.service) call these directly. The link
  // ---- is bank_branches.bank_type → banks.bank_type, no FK constraint;
  // ---- idx_bank_branches_bank_type keeps the join cheap.

  /**
   * Parent bank by 3-digit code, joined with the full ordered list of its
   * branches. Returns null if the bank_type is unknown.
   */
  async getBankWithBranches(
    bankType: string,
  ): Promise<BankWithBranches | null> {
    const bankRows: BankRow[] = await this.db.query(
      `SELECT bank_type, bank_name, date_open, date_close,
              date_act, date_deact, active
         FROM public.banks WHERE bank_type = $1 LIMIT 1`,
      [bankType],
    );
    const bank = bankRows[0];
    if (!bank) return null;

    const branches: BankBranchRow[] = await this.db.query(
      `SELECT bank_id, bank_type, region_id, header_id, union_id, tcc_id,
              ccc_id, bank_name, bank_adres, bank_statu, date_open, date_close,
              date_act, date_deact, active, distr, kol_obm, inn
         FROM public.bank_branches
        WHERE bank_type = $1
        ORDER BY bank_id ASC`,
      [bankType],
    );
    return { ...bank, branches };
  }

  /**
   * Branch by 5-digit MFO (the value stored in company_info.bank_code),
   * merged with its parent bank. Both lookups are PK hits, sub-ms.
   */
  async getBranchByMfo(mfo: string): Promise<BranchWithBank | null> {
    const branchRows: BankBranchRow[] = await this.db.query(
      `SELECT bank_id, bank_type, region_id, header_id, union_id, tcc_id,
              ccc_id, bank_name, bank_adres, bank_statu, date_open, date_close,
              date_act, date_deact, active, distr, kol_obm, inn
         FROM public.bank_branches WHERE bank_id = $1 LIMIT 1`,
      [mfo],
    );
    const branch = branchRows[0];
    if (!branch) return null;

    let parent_bank: BankRow | null = null;
    if (branch.bank_type) {
      const parentRows: BankRow[] = await this.db.query(
        `SELECT bank_type, bank_name, date_open, date_close,
                date_act, date_deact, active
           FROM public.banks WHERE bank_type = $1 LIMIT 1`,
        [branch.bank_type],
      );
      parent_bank = parentRows[0] ?? null;
    }
    return { ...branch, parent_bank };
  }
}
