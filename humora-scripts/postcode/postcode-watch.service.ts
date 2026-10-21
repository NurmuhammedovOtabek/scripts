import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recentJobRuns, recordJobRun } from '../common/job-runs';
import {
  KeyedDiff,
  WatchedOffice,
  diffKeyed,
  parseEmuZones,
  parseUzpostOffices,
} from './postcode-watch-parse';

export const WATCH_LOCK_ID = 8_150_943;
export const WATCH_JOB = 'postcode_watch';

export const UZPOST_OFFICES_URL =
  'https://new.pochta.uz/api/v1/maps/post/offices/';
export const EMU_ZONES_URL = 'https://emu.uz/data/indeks-hududlar.json';

const TIMEOUT_MS = 60_000;
/** Fewer than these is a cut-off answer: 1,737 offices, 1,735 zones on 2026-10-12. */
const MIN_OFFICES = 1000;
const MIN_ZONES = 1000;
const EXAMPLES = 10;

/**
 * Whether the weekly check runs here: on a deployment (TG_WEBHOOK_URL set),
 * not on a laptop. `POSTCODE_WATCH_ENABLED=1|0` overrides.
 */
export function postcodeWatchEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.POSTCODE_WATCH_ENABLED === '1') return true;
  if (env.POSTCODE_WATCH_ENABLED === '0') return false;
  return Boolean(env.TG_WEBHOOK_URL);
}

export interface Failed {
  error: string;
}

export interface OfficesCheck extends KeyedDiff {
  read: number;
  baseline: boolean;
}

export interface ZonesCheck extends KeyedDiff {
  read: number;
  baseline: boolean;
}

export interface PostcodeWatchResult {
  offices: OfficesCheck | Failed;
  zones: ZonesCheck | Failed;
  /** Service areas moved: the mahalla → index table may be out of date. */
  needsNewExport: boolean;
  elapsedMs: number;
  dry: boolean;
}

const failed = (x: unknown): x is Failed =>
  Boolean(x && typeof x === 'object' && 'error' in (x as object));

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Humora/1.0)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * The weekly look at the postal network behind `mahalla_postcode` — Sunday
 * 04:30, in the weekly chain, two requests: UzPost's offices and EMU's zone
 * map, and what was added, closed or redrawn in them. Nothing is recomputed
 * from them — that needs a map point per mahalla, which only the export has —
 * so a change says "ask OPdata for a new export" in the report.
 *
 * The first run records what it saw as the baseline. A source that fails is
 * reported and the others still run; a cut-off answer writes nothing for that
 * source. Telegram + `job_runs` (`postcode_watch`).
 */
@Injectable()
export class PostcodeWatchService {
  private readonly logger = new Logger(PostcodeWatchService.name);

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly telegram: TelegramAlertService,
  ) {}

  /** One check under the lock, reported. Null when another replica runs it. */
  async run(
    opts: { dry?: boolean },
    trigger: string,
  ): Promise<PostcodeWatchResult | null> {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [WATCH_LOCK_ID],
      );
      if (!locked) return null;
      const startedAt = new Date();
      try {
        const result = await this.check(opts);
        const text = this.describe(result, trigger);
        const alertSent = await this.telegram.deliver(text, {
          tag: 'postcode',
        });
        const allFailed = failed(result.offices) && failed(result.zones);
        await recordJobRun(this.db, {
          job: WATCH_JOB,
          trigger,
          dry: result.dry,
          startedAt,
          ok: !allFailed,
          summary: text,
          report: result,
          error: allFailed ? 'every source failed' : null,
          alertSent,
        });
        return result;
      } finally {
        await runner
          .query('SELECT pg_advisory_unlock($1)', [WATCH_LOCK_ID])
          .catch(() => undefined);
      }
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  async check(opts: { dry?: boolean } = {}): Promise<PostcodeWatchResult> {
    const start = Date.now();
    const dry = opts.dry === true;
    const attempt = async <T>(what: string, fn: () => Promise<T>) => {
      try {
        return await fn();
      } catch (err) {
        this.logger.warn(`[postcode-watch] ${what}: ${(err as Error).message}`);
        return { error: (err as Error).message } as Failed;
      }
    };
    const offices = await attempt('UzPost offices', () =>
      this.checkOffices(dry),
    );
    const zones = await attempt('EMU zones', () => this.checkZones(dry));
    const moved = (c: OfficesCheck | ZonesCheck | Failed) =>
      !failed(c) &&
      !c.baseline &&
      c.added.length + c.gone.length + c.changed.length > 0;
    return {
      offices,
      zones,
      needsNewExport: moved(offices) || moved(zones),
      elapsedMs: Date.now() - start,
      dry,
    };
  }

  private async checkOffices(dry: boolean): Promise<OfficesCheck> {
    const fresh = parseUzpostOffices(
      JSON.parse(await fetchText(UZPOST_OFFICES_URL)),
    );
    if (fresh.length < MIN_OFFICES) {
      throw new Error(`${fresh.length} offices, fewer than ${MIN_OFFICES}`);
    }
    const held: Array<{ postcode: string; area_hash: string | null }> =
      await this.db.query(
        `SELECT postcode, area_hash FROM public.postcode_watch_office
          WHERE gone_at IS NULL`,
      );
    const diff = diffKeyed(
      new Map(held.map((h) => [h.postcode, h.area_hash])),
      new Map(fresh.map((o) => [o.postcode, o.areaHash])),
    );
    if (!dry) await this.writeOffices(fresh, diff.gone);
    return { ...diff, read: fresh.length, baseline: held.length === 0 };
  }

  private async writeOffices(fresh: WatchedOffice[], gone: string[]) {
    await this.db.transaction(async (m) => {
      await m.query(
        `INSERT INTO public.postcode_watch_office
           (postcode, name, region, district, mfy, lat, lng, area_hash)
         SELECT x.postcode, x.name, x.region, x.district, x.mfy, x.lat, x.lng, x.area_hash
           FROM jsonb_to_recordset($1::jsonb) AS x(
             postcode text, name text, region text, district text, mfy text,
             lat double precision, lng double precision, area_hash text)
         ON CONFLICT (postcode) DO UPDATE SET
           name = EXCLUDED.name, region = EXCLUDED.region,
           district = EXCLUDED.district, mfy = EXCLUDED.mfy,
           lat = EXCLUDED.lat, lng = EXCLUDED.lng,
           changed_at = CASE WHEN postcode_watch_office.area_hash IS DISTINCT FROM EXCLUDED.area_hash
                             THEN now() ELSE postcode_watch_office.changed_at END,
           area_hash = EXCLUDED.area_hash,
           last_seen_at = now(), gone_at = NULL`,
        [
          JSON.stringify(
            fresh.map((o) => ({
              postcode: o.postcode,
              name: o.name,
              region: o.region,
              district: o.district,
              mfy: o.mfy,
              lat: o.lat,
              lng: o.lng,
              area_hash: o.areaHash,
            })),
          ),
        ],
      );
      if (gone.length) {
        await m.query(
          `UPDATE public.postcode_watch_office SET gone_at = now()
            WHERE postcode = ANY($1::text[]) AND gone_at IS NULL`,
          [gone],
        );
      }
    });
  }

  private async checkZones(dry: boolean): Promise<ZonesCheck> {
    const fresh = parseEmuZones(JSON.parse(await fetchText(EMU_ZONES_URL)));
    if (fresh.size < MIN_ZONES) {
      throw new Error(`${fresh.size} zone indexes, fewer than ${MIN_ZONES}`);
    }
    const held: Array<{ postcode: string; area_hash: string }> =
      await this.db.query(
        `SELECT postcode, area_hash FROM public.postcode_watch_zone
          WHERE gone_at IS NULL`,
      );
    const diff = diffKeyed(
      new Map(held.map((h) => [h.postcode, h.area_hash])),
      fresh,
    );
    if (!dry) {
      await this.db.transaction(async (m) => {
        await m.query(
          `INSERT INTO public.postcode_watch_zone (postcode, area_hash)
           SELECT * FROM unnest($1::text[], $2::text[])
           ON CONFLICT (postcode) DO UPDATE SET
             changed_at = CASE WHEN postcode_watch_zone.area_hash IS DISTINCT FROM EXCLUDED.area_hash
                               THEN now() ELSE postcode_watch_zone.changed_at END,
             area_hash = EXCLUDED.area_hash,
             last_seen_at = now(), gone_at = NULL`,
          [[...fresh.keys()], [...fresh.values()]],
        );
        if (diff.gone.length) {
          await m.query(
            `UPDATE public.postcode_watch_zone SET gone_at = now()
              WHERE postcode = ANY($1::text[]) AND gone_at IS NULL`,
            [diff.gone],
          );
        }
      });
    }
    return { ...diff, read: fresh.size, baseline: held.length === 0 };
  }

  /** What the two tables hold, and the last runs. */
  async status(): Promise<Record<string, unknown>> {
    const [counts] = await this.db.query(
      `SELECT (SELECT count(*) FROM public.postcode_watch_office WHERE gone_at IS NULL)::int AS offices,
              (SELECT count(*) FROM public.postcode_watch_zone WHERE gone_at IS NULL)::int AS zones`,
    );
    return {
      enabled: postcodeWatchEnabled(),
      schedule: 'Sunday 04:30 Asia/Tashkent, in the weekly chain',
      ...counts,
      recent_runs: await recentJobRuns(this.db, [WATCH_JOB], 5),
    };
  }

  private describe(r: PostcodeWatchResult, trigger: string): string {
    const list = (label: string, xs: string[]) =>
      xs.length
        ? [
            `${label}${xs.length > EXAMPLES ? ` (${EXAMPLES} of ${xs.length})` : ''}: ` +
              xs.slice(0, EXAMPLES).map(escapeHtml).join(', '),
          ]
        : [];
    const keyed = (label: string, c: OfficesCheck | ZonesCheck | Failed) => {
      if (failed(c)) return [`${label}: ❌ ${escapeHtml(c.error)}`];
      if (c.baseline) return [`${label}: ${c.read} read — baseline recorded`];
      return [
        `${label}: ${c.read} read · new ${c.added.length} · gone ${c.gone.length} · ` +
          `area changed ${c.changed.length}`,
        ...list('  new', c.added),
        ...list('  gone', c.gone),
        ...list('  area changed', c.changed),
      ];
    };
    const anyFailed = failed(r.offices) || failed(r.zones);
    const head = r.dry ? '🧪' : anyFailed || r.needsNewExport ? '⚠️' : '✅';
    return [
      `${head} <b>Postal network — ${escapeHtml(trigger)}</b>${r.dry ? ' (dry run, nothing written)' : ''}`,
      ...keyed('UzPost offices', r.offices),
      ...keyed('EMU zones', r.zones),
      ...(r.needsNewExport
        ? [
            'Service areas changed: the mahalla → index table may be out of date. Ask OPdata for a new export.',
          ]
        : []),
      ...(r.needsNewExport || anyFailed ? [] : ['No changes.']),
    ].join('\n');
  }
}
