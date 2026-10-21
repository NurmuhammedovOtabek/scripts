import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import * as fs from 'fs';
import * as path from 'path';
import { DataSource, EntityManager } from 'typeorm';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recentJobRuns, recordJobRun } from '../common/job-runs';

/** Held by a session; the replica that takes it loads, the others wait a boot. */
export const LOCK_ID = 8_150_942;
export const JOB = 'postcode_dataset';

/** After boot, so the app settles first. Reference data, so every environment. */
const LOAD_DELAY_MS = 30_000;
const BATCH = 1000;
/** 7,447 mahallas in the 2026-10-02 build. */
const MIN_MAHALLAS = 5000;
const EXAMPLES = 10;

/**
 * The bundled file: `[mahalla_code, postcode, source]`. The export's district
 * main offices are not kept — no approximate codes (user decision 2026-10-12).
 */
export interface PostcodeDataset {
  version: string;
  exported?: string;
  mahallas: Array<[string, string, string]>;
}

export interface PartCount {
  inFile: number;
  inserted: number;
  updated: number;
  unchanged: number;
  /** Held here, not in the file. Kept: a snapshot that misses a mahalla is a gap. */
  notInFile: number;
}

export interface PostcodeLoadResult {
  version: string;
  previousVersion: string | null;
  mahallas: PartCount;
  examples: { changed: string[] };
  elapsedMs: number;
}

export function bundledDatasetPath(): string {
  return path.join(__dirname, 'postcodes.json');
}

/** The bundled dataset, read and checked. Throws on a file that is not one. */
export function readDataset(file = bundledDatasetPath()): PostcodeDataset {
  const data = JSON.parse(fs.readFileSync(file, 'utf-8')) as PostcodeDataset;
  const problems = datasetProblems(data);
  if (problems.length) {
    throw new Error(`postcode dataset ${file}: ${problems.join('; ')}`);
  }
  return data;
}

/** What is wrong with a dataset — an empty list when nothing is. */
export function datasetProblems(d: PostcodeDataset): string[] {
  const out: string[] = [];
  if (!d || typeof d.version !== 'string' || !d.version) {
    return ['no version'];
  }
  if (!Array.isArray(d.mahallas)) return ['no mahalla list'];
  if (d.mahallas.length < MIN_MAHALLAS) {
    out.push(`${d.mahallas.length} mahallas, fewer than ${MIN_MAHALLAS}`);
  }
  const badM = d.mahallas.filter(
    (m) => !/^\d{10}$/.test(m?.[0]) || !/^\d{6}$/.test(m?.[1]),
  ).length;
  if (badM) out.push(`${badM} mahalla rows not shaped like a code`);
  if (new Set(d.mahallas.map((m) => m[0])).size !== d.mahallas.length) {
    out.push('a mahalla listed twice');
  }
  return out;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Keeps `mahalla_postcode` to the dataset bundled with the code
 * (`scripts/postcode/postcodes.json`). The `company_postcode` view reads it;
 * nothing stores a company's code.
 *
 * Thirty seconds after boot it compares the file's version with the one
 * loaded (`postcode_dataset`) and loads the file when they differ — so a new
 * export is a new file in a deploy, in every environment, and nobody writes
 * to a database by hand. New and changed rows are written; a row the file no
 * longer has is kept and counted (a later snapshot missing a mahalla is a gap,
 * not a closure). Loads under an advisory lock in one transaction, reported to
 * Telegram and `job_runs`. By hand: POST /postcode/reload, GET /postcode/status.
 */
@Injectable()
export class PostcodeSeedService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PostcodeSeedService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly telegram: TelegramAlertService,
  ) {}

  onApplicationBootstrap(): void {
    if (process.env.POSTCODE_SEED_ENABLED === '0') return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.loadIfNewer();
    }, LOAD_DELAY_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** Loads the bundled file when it is not the version held. Never throws. */
  async loadIfNewer(): Promise<PostcodeLoadResult | null> {
    try {
      const data = readDataset();
      const [held] = await this.db.query(
        'SELECT version FROM public.postcode_dataset WHERE id = 1',
      );
      if (held?.version === data.version) return null;
      return await this.run('boot', data);
    } catch (err) {
      // `run` has reported a failed load; this is the file or the read.
      this.logger.warn(`[postcode] boot load: ${(err as Error).message}`);
      return null;
    }
  }

  /**
   * One load under the lock, reported whatever happened. Null when another
   * replica holds the lock. Throws after reporting when the load failed.
   */
  async run(
    trigger: string,
    data: PostcodeDataset = readDataset(),
  ): Promise<PostcodeLoadResult | null> {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [LOCK_ID],
      );
      if (!locked) {
        this.logger.log(`[postcode] ${trigger}: another replica is loading`);
        return null;
      }
      const startedAt = new Date();
      try {
        const result = await this.load(data);
        const text = this.describe(result, trigger);
        const alertSent = await this.telegram.deliver(text, {
          tag: 'postcode',
        });
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
        this.logger.error(`[postcode] ${trigger}: load failed — ${message}`);
        const text = [
          `❌ <b>Postal codes (${escapeHtml(trigger)}) — load failed</b>`,
          `<code>${escapeHtml(message)}</code>`,
          'The tables are untouched. Retry by hand: POST /api/postcode/reload',
        ].join('\n');
        const alertSent = await this.telegram.deliver(text, {
          tag: 'postcode',
        });
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
      } finally {
        await runner
          .query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
          .catch(() => undefined);
      }
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  /** The file compared with what is held and written in one transaction. */
  async load(data: PostcodeDataset): Promise<PostcodeLoadResult> {
    const start = Date.now();
    const problems = datasetProblems(data);
    if (problems.length) throw new Error(problems.join('; '));

    const [held] = await this.db.query(
      'SELECT version FROM public.postcode_dataset WHERE id = 1',
    );
    const heldM: Array<{
      mahalla_code: string;
      postcode: string;
      source: string | null;
    }> = await this.db.query(
      'SELECT mahalla_code, postcode, source FROM public.mahalla_postcode',
    );

    const changed: string[] = [];
    const mByCode = new Map(heldM.map((r) => [r.mahalla_code, r]));
    const mWrite: Array<[string, string, string]> = [];
    const mCount: PartCount = {
      inFile: data.mahallas.length,
      inserted: 0,
      updated: 0,
      unchanged: 0,
      notInFile: 0,
    };
    for (const row of data.mahallas) {
      const was = mByCode.get(row[0]);
      if (!was) {
        mCount.inserted++;
        mWrite.push(row);
      } else if (was.postcode !== row[1] || (was.source ?? '') !== row[2]) {
        mCount.updated++;
        mWrite.push(row);
        if (was.postcode !== row[1]) {
          changed.push(`mahalla ${row[0]}: ${was.postcode} → ${row[1]}`);
        }
      } else mCount.unchanged++;
    }
    const inFileM = new Set(data.mahallas.map((m) => m[0]));
    mCount.notInFile = heldM.filter((r) => !inFileM.has(r.mahalla_code)).length;

    await this.db.transaction(async (m) => {
      await this.writeMahallas(m, mWrite);
      await m.query(
        `INSERT INTO public.postcode_dataset (id, version, loaded_at, mahallas)
         VALUES (1, $1, now(), (SELECT count(*) FROM public.mahalla_postcode))
         ON CONFLICT (id) DO UPDATE
           SET version = EXCLUDED.version, loaded_at = now(),
               mahallas = EXCLUDED.mahallas`,
        [data.version],
      );
    });

    const elapsedMs = Date.now() - start;
    this.logger.log(
      `[postcode] loaded ${data.version} in ${elapsedMs}ms — mahallas +${mCount.inserted} ~${mCount.updated} ` +
        `=${mCount.unchanged} kept ${mCount.notInFile}`,
    );
    return {
      version: data.version,
      previousVersion: held?.version ?? null,
      mahallas: mCount,
      examples: { changed: changed.slice(0, EXAMPLES) },
      elapsedMs,
    };
  }

  private async writeMahallas(
    m: EntityManager,
    rows: Array<[string, string, string]>,
  ): Promise<void> {
    for (let i = 0; i < rows.length; i += BATCH) {
      const part = rows.slice(i, i + BATCH);
      await m.query(
        `INSERT INTO public.mahalla_postcode (mahalla_code, postcode, source)
         SELECT * FROM unnest($1::text[], $2::text[], $3::text[])
         ON CONFLICT (mahalla_code) DO UPDATE
           SET postcode = EXCLUDED.postcode, source = EXCLUDED.source,
               updated_at = now()`,
        [part.map((r) => r[0]), part.map((r) => r[1]), part.map((r) => r[2])],
      );
    }
  }

  /**
   * The version held, the table size, the last runs — and, with `coverage`,
   * how many companies get a code (a scan of every company, so only on
   * request).
   */
  async status(coverage = false): Promise<Record<string, unknown>> {
    const [held] = await this.db.query(
      'SELECT version, loaded_at, mahallas FROM public.postcode_dataset WHERE id = 1',
    );
    let bundled: string | null = null;
    try {
      bundled = readDataset().version;
    } catch (err) {
      bundled = `unreadable: ${(err as Error).message}`;
    }
    const out: Record<string, unknown> = {
      bundled_version: bundled,
      loaded: held ?? null,
      recent_runs: await recentJobRuns(this.db, [JOB], 5),
    };
    if (coverage) {
      const [row] = await this.db.query(
        `SELECT (SELECT count(*) FROM public.company_info)::int AS companies,
                (SELECT count(*) FROM public.company_postcode)::int AS with_postcode`,
      );
      out.coverage = row;
    }
    return out;
  }

  private describe(r: PostcodeLoadResult, trigger: string): string {
    const part = (label: string, c: PartCount) =>
      `${label}: ${c.inFile} in the file · new ${c.inserted} · changed ${c.updated} · ` +
      `unchanged ${c.unchanged}` +
      (c.notInFile ? ` · held but not in the file ${c.notInFile} (kept)` : '');
    return [
      `📮 <b>Postal codes — ${escapeHtml(trigger)}</b>`,
      `Version ${escapeHtml(r.version)}${r.previousVersion ? ` (was ${escapeHtml(r.previousVersion)})` : ' (first load)'} · took ${Math.round(r.elapsedMs / 1000)} s`,
      part('Mahallas', r.mahallas),
      ...(r.examples.changed.length
        ? ['Changed:', ...r.examples.changed.map((x) => `  • ${escapeHtml(x)}`)]
        : []),
    ].join('\n');
  }
}
