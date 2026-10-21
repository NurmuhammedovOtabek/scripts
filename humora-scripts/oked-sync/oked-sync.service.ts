import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recentJobRuns, recordJobRun } from '../common/job-runs';
import { fetchCsDataset } from '../common/cs-egov';
import {
  OKED_LEVELS,
  OKED_TREE_COLUMNS,
  OkedLevel,
  OkedTreeNode,
  dottedOkedCode,
} from '../../oked/oked-tree';
import { parseOkedDataset } from './oked-parse';

/** cs.egov.uz 082-3-004 — OKED rev.2, Statistics. */
export const OKED_DATASET_ID = '61a5d146b83d3e9e6a91c952';

/** Held by a session; the replica that takes it runs and reports. */
export const LOCK_ID = 8_150_937;
export const JOB = 'oked_tree';

const EXAMPLES = 10;
/**
 * Fewer than this is a cut-off answer, not the classifier: 21 sections and
 * 683 subclasses on 2026-10-08.
 */
const MIN_SECTIONS = 15;
const MIN_SUBCLASSES = 500;
/** How long after boot an empty table is filled — the app settles first. */
const FIRST_FILL_DELAY_MS = 60_000;

const PLURAL: Record<OkedLevel, string> = {
  section: 'sections',
  division: 'divisions',
  group: 'groups',
  class: 'classes',
  subclass: 'subclasses',
};

/**
 * Whether the classifier is synced here: on a deployment (TG_WEBHOOK_URL
 * set — dev and prod), not on a laptop. `OKED_SYNC_ENABLED=1|0` overrides.
 */
export function okedSyncEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.OKED_SYNC_ENABLED === '1') return true;
  if (env.OKED_SYNC_ENABLED === '0') return false;
  return Boolean(env.TG_WEBHOOK_URL);
}

export interface OkedSyncResult {
  /** Nodes read from the source, per level. */
  fetched: Record<OkedLevel, number>;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Held here, absent from this fetch. Kept, never deleted — only counted. */
  notInSource: number;
  /** Left out: the node above them is not in the source. */
  orphans: string[];
  duplicates: string[];
  unreadable: number;
  examples: { inserted: string[]; updated: string[]; notInSource: string[] };
  elapsedMs: number;
  dry: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Keeps `public.oked_tree` to Statistics' published OKED rev.2 (cs.egov.uz
 * 082-3-004) — every level, with its name in Uzbek (Latin and Cyrillic),
 * Russian and English. `OkedService` and the sales backend read it.
 *
 * It replaced `public.oked_classifier`, a copy that belonged to another
 * service (`streamlit-user`): Russian only, subclasses with three levels above
 * them (no division), never updated and present in production alone.
 *
 * Runs with the Sunday 04:30 chain (`CompanyMahallaService.weekly`), no cron
 * of its own, and by hand with POST /oked-sync/run (`?dry=1` to see the
 * differences first). An empty table is filled a minute after boot, so a new
 * environment has a classifier without waiting for Sunday.
 *
 * Compared before writing, like the bank registry: new and changed nodes are
 * written (`updated_at`), unchanged ones only get `fetched_at`, and a node the
 * source stopped listing is kept and reported — companies still carry the
 * code. An empty, failed or cut-off answer is an error, not "no classifier".
 */
@Injectable()
export class OkedSyncService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(OkedSyncService.name);
  private firstFill: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly telegram: TelegramAlertService,
  ) {}

  onApplicationBootstrap(): void {
    if (!okedSyncEnabled()) return;
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
        'SELECT count(*)::int AS n FROM public.oked_tree',
      );
      if (n > 0) return;
      await this.run({}, 'first fill');
    } catch (err) {
      // `run` has reported a failed sync; this is the count failing.
      this.logger.warn(`[oked-sync] first fill: ${(err as Error).message}`);
    }
  }

  /**
   * One sync under the lock, reported to Telegram and kept in `job_runs`
   * whatever happened. Null when another replica holds the lock (that one
   * reports). Throws after reporting when the sync failed.
   */
  async run(
    opts: { dry?: boolean },
    trigger: string,
  ): Promise<OkedSyncResult | null> {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [LOCK_ID],
      );
      if (!locked) {
        this.logger.log(
          `[oked-sync] ${trigger}: skipped — another replica is syncing`,
        );
        return null;
      }
      const startedAt = new Date();
      try {
        const result = await this.syncAll(opts);
        const text = this.describe(result, trigger);
        const alertSent = await this.telegram.deliver(text, { tag: 'oked' });
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
        this.logger.error(`[oked-sync] ${trigger}: sync failed — ${message}`);
        const text = [
          `❌ <b>OKED classifier (${escapeHtml(trigger)}) — sync failed</b>`,
          `<code>${escapeHtml(message)}</code>`,
          'The stored classifier is untouched. Retry by hand: POST /api/oked-sync/run',
        ].join('\n');
        const alertSent = await this.telegram.deliver(text, { tag: 'oked' });
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

  /** What we hold per level, when it last changed, and the last runs. */
  async status(): Promise<Record<string, unknown>> {
    const levels: Array<{ level: string; total: number }> = await this.db.query(
      `SELECT level, count(*)::int AS total
         FROM public.oked_tree GROUP BY level`,
    );
    const [times] = await this.db.query(
      `SELECT max(updated_at) AS last_changed, max(fetched_at) AS last_seen,
              count(*) FILTER (WHERE fetched_at < (SELECT max(fetched_at) FROM public.oked_tree) - interval '1 day')::int
                AS not_in_last_fetch
         FROM public.oked_tree`,
    );
    return {
      weekly_enabled: okedSyncEnabled(),
      schedule: 'Sunday 04:30 Asia/Tashkent, with the bank registry',
      source: `cs.egov.uz 082-3-004 (${OKED_DATASET_ID})`,
      levels: Object.fromEntries(
        OKED_LEVELS.map((l) => [
          l,
          levels.find((r) => r.level === l)?.total ?? 0,
        ]),
      ),
      ...times,
      recent_runs: await recentJobRuns(this.db, [JOB], 10),
    };
  }

  /**
   * The dataset fetched, read into nodes, compared with what we hold and —
   * unless `dry` — written in one transaction.
   */
  async syncAll(opts: { dry?: boolean } = {}): Promise<OkedSyncResult> {
    const start = Date.now();
    const dry = opts.dry === true;
    const rows = await fetchCsDataset(OKED_DATASET_ID);
    const parsed = parseOkedDataset(rows);

    const fetched = Object.fromEntries(
      OKED_LEVELS.map((l) => [l, 0]),
    ) as Record<OkedLevel, number>;
    for (const n of parsed.nodes) fetched[n.level]++;
    if (fetched.section < MIN_SECTIONS || fetched.subclass < MIN_SUBCLASSES) {
      throw new Error(
        `cs.egov.uz sent ${fetched.section} sections and ${fetched.subclass} ` +
          `subclasses (${rows.length} rows) — too few to trust, nothing written`,
      );
    }

    const stored: OkedTreeNode[] = await this.db.query(
      `SELECT ${OKED_TREE_COLUMNS.join(', ')} FROM public.oked_tree`,
    );
    const storedByCode = new Map(stored.map((s) => [s.code, s]));
    const freshByCode = new Map(parsed.nodes.map((n) => [n.code, n]));

    const inserted: OkedTreeNode[] = [];
    const updated: OkedTreeNode[] = [];
    const unchanged: string[] = [];
    for (const [code, node] of freshByCode) {
      const was = storedByCode.get(code);
      if (!was) inserted.push(node);
      else if (OKED_TREE_COLUMNS.some((c) => (was[c] ?? null) !== node[c])) {
        updated.push(node);
      } else unchanged.push(code);
    }
    const missing = stored.filter((s) => !freshByCode.has(s.code));

    if (!dry) {
      await this.db.transaction(async (m) => {
        await this.upsert(m, [...inserted, ...updated]);
        if (unchanged.length) {
          await m.query(
            `UPDATE public.oked_tree SET fetched_at = now()
              WHERE code = ANY($1::text[])`,
            [unchanged],
          );
        }
      });
    }

    const label = (n: OkedTreeNode) =>
      [dottedOkedCode(n.code), n.name_uz ?? n.name_ru]
        .filter(Boolean)
        .join(' ');
    const whatChanged = (n: OkedTreeNode) => {
      const was = storedByCode.get(n.code);
      const fields = OKED_TREE_COLUMNS.filter(
        (c) => (was?.[c] ?? null) !== n[c],
      )
        .slice(0, 3)
        .map((c) => `${c} ${was?.[c] ?? '—'}→${n[c] ?? '—'}`);
      return `${dottedOkedCode(n.code)}: ${fields.join(', ')}`;
    };

    const elapsedMs = Date.now() - start;
    this.logger.log(
      `[oked-sync] ${dry ? 'dry run' : 'sync'} done in ${elapsedMs}ms — ` +
        `${parsed.nodes.length} nodes, +${inserted.length} ~${updated.length} ` +
        `missing ${missing.length}, orphans ${parsed.orphans.length}`,
    );
    return {
      fetched,
      inserted: inserted.length,
      updated: updated.length,
      unchanged: unchanged.length,
      notInSource: missing.length,
      orphans: parsed.orphans,
      duplicates: parsed.duplicates,
      unreadable: parsed.unreadable,
      examples: {
        inserted: inserted.slice(0, EXAMPLES).map(label),
        updated: updated.slice(0, EXAMPLES).map(whatChanged),
        notInSource: missing.slice(0, EXAMPLES).map(label),
      },
      elapsedMs,
      dry,
    };
  }

  /** New and changed nodes, batched; `updated_at` marks a real change. */
  private async upsert(m: EntityManager, nodes: OkedTreeNode[]): Promise<void> {
    const cols = OKED_TREE_COLUMNS;
    const BATCH = 500;
    for (let i = 0; i < nodes.length; i += BATCH) {
      const params: unknown[] = [];
      const tuples = nodes.slice(i, i + BATCH).map((n) => {
        const start = params.length;
        for (const c of cols) params.push(n[c] ?? null);
        return `(${cols.map((_, j) => `$${start + j + 1}`).join(', ')})`;
      });
      await m.query(
        `INSERT INTO public.oked_tree (${cols.join(', ')})
         VALUES ${tuples.join(', ')}
         ON CONFLICT (code) DO UPDATE SET
           ${cols
             .filter((c) => c !== 'code')
             .map((c) => `${c} = EXCLUDED.${c}`)
             .join(', ')},
           fetched_at = now(),
           updated_at = now()`,
        params,
      );
    }
  }

  private describe(r: OkedSyncResult, trigger: string): string {
    const list = (label: string, total: number, xs: string[]) =>
      xs.length
        ? [
            `${label}${total > xs.length ? ` (${xs.length} of ${total})` : ''}:`,
            ...xs.map((x) => `  • ${escapeHtml(x)}`),
          ]
        : [];
    const changed = r.inserted + r.updated + r.notInSource;
    const warn = r.orphans.length > 0 || r.unreadable > 0;
    const head = r.dry ? '🧪' : warn ? '⚠️' : changed ? '📚' : '✅';
    return [
      `${head} <b>OKED classifier — ${escapeHtml(trigger)}</b>` +
        `${r.dry ? ' (dry run, nothing written)' : ''}`,
      `Took: ${Math.round(r.elapsedMs / 1000)} s · source: cs.egov.uz 082-3-004`,
      `Read: ${OKED_LEVELS.map((l) => `${r.fetched[l]} ${PLURAL[l]}`).join(' · ')}`,
      `New ${r.inserted} · changed ${r.updated} · gone from the source ${r.notInSource} (kept here)`,
      ...(changed ? [] : ['No changes.']),
      ...list('New', r.inserted, r.examples.inserted),
      ...list('Changed', r.updated, r.examples.updated),
      ...list('Gone from the source', r.notInSource, r.examples.notInSource),
      ...(r.orphans.length
        ? [
            `Left out — nothing above them in the source: ${r.orphans
              .slice(0, EXAMPLES)
              .map((c) => escapeHtml(dottedOkedCode(c)))
              .join(
                ', ',
              )}${r.orphans.length > EXAMPLES ? ` (+${r.orphans.length - EXAMPLES})` : ''}`,
          ]
        : []),
      ...(r.unreadable ? [`Rows with no code read: ${r.unreadable}`] : []),
    ].join('\n');
  }
}
