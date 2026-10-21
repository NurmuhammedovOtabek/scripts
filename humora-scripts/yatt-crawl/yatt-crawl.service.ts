import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { MysoliqService } from '../../mysoliq/mysoliq.service';
import {
  mapYattRegistry,
  writeYattRegistry,
} from '../../individual-entrepreneur/yatt-registry';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { MYORG_REQUESTS_OFF } from '../../org/myorg-failure';

/** Held by the session, so a container killed mid-walk frees it. */
const LOCK_ID = 8_151_020;

/** Ids per batch: the cursor moves, and soliq is asked, once per batch. */
const BATCH = 50;

/**
 * Missing ids in a row that mean the end of the list. Ids have gaps — near
 * the top (≈916k on 2026-10-05) found ids sit hundreds apart — so this is
 * generous; at the walk's pace it costs about half an hour once.
 */
const END_MISS_LIMIT = 3000;

/** Failed myorg calls in a row (after retries) that end the night. */
const ERROR_LIMIT = 10;

// myorg off since 2026-10-12 (user decision 2026-10-13): fetchRecord's attempts at one trader's record (/api/entrepreneur/{id})
// /** One id is tried this many times before it counts as failed. */
// const ATTEMPTS = 3;

/** Parallel soliq lookups. myorg itself is always one request at a time. */
const SOLIQ_CONCURRENCY = 2;

/** The night window, Tashkent: starts 21:00 (the cron), ends by 06:00. */
const END_HOUR_TASHKENT = 6;
const TASHKENT_OFFSET_H = 5;

/** A log line this often. */
const LOG_EVERY_MS = 15 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Whether the nightly walk runs here: production only by default — dev has
 * its own database, and every request from it would spend the same myorg
 * token for data nobody uses. `YATT_CRAWL_ENABLED=1|0` overrides.
 */
export function yattCrawlEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.YATT_CRAWL_ENABLED === '0') return false;
  if (env.YATT_CRAWL_ENABLED === '1') return true;
  return env.SERVICE_ENVIRONMENT === 'production';
}

/** The next 06:00 in Tashkent (UTC+5, no DST) after `now`. */
export function nextWindowEnd(now: Date = new Date()): Date {
  const end = new Date(now);
  end.setUTCHours(END_HOUR_TASHKENT - TASHKENT_OFFSET_H, 0, 0, 0);
  if (end.getTime() <= now.getTime()) end.setUTCDate(end.getUTCDate() + 1);
  return end;
}

export interface CrawlTotals {
  /** Ids asked from myorg. */
  walked: number;
  /** Ids myorg had a record for. */
  found: number;
  /** Ids myorg answered 404 — a gap, or past the end. */
  missing: number;
  /** Records written to individual_entrepreneurs. */
  saved: number;
  /** Records without a usable STIR, so nothing could be stored. */
  unusable: number;
  /** soliq answered with a bank account, and it was stored. */
  soliqBank: number;
  /** soliq answered with the trader's PINFL, and it was stored. */
  soliqPinfl: number;
  /** soliq answered, but with no bank account (or no such taxpayer). */
  soliqNoBank: number;
  /** soliq did not answer; the registry half is stored, the bank is not. */
  soliqFailed: number;
  /** Ids that failed after every attempt, and rows the table refused. */
  errors: number;
  /** Earlier failures asked again at the start of the night... */
  retried: number;
  /** ...and stored this time. */
  recovered: number;
}

const emptyTotals = (): CrawlTotals => ({
  walked: 0,
  found: 0,
  missing: 0,
  saved: 0,
  unusable: 0,
  soliqBank: 0,
  soliqPinfl: 0,
  soliqNoBank: 0,
  soliqFailed: 0,
  errors: 0,
  retried: 0,
  recovered: 0,
});

export interface CrawlOptions {
  /** Start here instead of at the cursor (1 starts a new cycle). */
  fromId?: number;
  /** Walk at most this many ids — a trial. */
  limit?: number;
  /** Stop by this time instead of the next 06:00 Tashkent. */
  deadline?: Date;
}

type Outcome =
  | { kind: 'found'; raw: any }
  | { kind: 'missing' }
  | { kind: 'denied'; status: number }
  | { kind: 'failed'; message: string };

class NightAborted extends Error {}

const n = (v: number) => v.toLocaleString('en-US');

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h ? `${h} h ${minutes % 60} min` : `${minutes} min`;
}

/**
 * Walks myorg's trader register id by id — `GET /api/entrepreneur/{id}` from
 * 1 upward — and keeps what matches `individual_entrepreneurs`, so the
 * register stays ours if myorg goes away (its records stopped moving in
 * April 2026: `actual_date` is 2026-04-16 on every one sampled).
 *
 * For each record:
 *  - the registry half (activity, registration, certificate, SOATO, status)
 *    is written at once with the profile path's own writer;
 *  - the STIR is then asked from soliq (`np1/bytin/factura-all`, one call)
 *    for the bank code and account and the PINFL (`personalNum` — myorg's
 *    record has none) — user decision 2026-10-05: the rest of the soliq half
 *    (VAT, taxpayer type, address) is collected when someone opens the
 *    trader. An empty answer never blanks a stored value.
 *
 * Nothing else from the response is kept.
 *
 * myorg gets one request a second (`YATT_CRAWL_INTERVAL_MS`, default 1000,
 * start to start — user decision 2026-10-05: slower is fine); soliq for one
 * batch runs while myorg serves the next. Every
 * night 21:00–06:00 Tashkent, continuing from the saved cursor; at the end of
 * the list it stops for good until started again by hand.
 */
@Injectable()
export class YattCrawlService {
  private readonly logger = new Logger(YattCrawlService.name);
  private running = false;
  private readonly baseUrl = (process.env.MYORG_BASE_URL || '').replace(
    /\/$/,
    '',
  );

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly http: HttpService,
    private readonly mysoliq: MysoliqService,
    private readonly telegram: TelegramAlertService,
  ) {}

  @Cron('0 21 * * *', { timeZone: 'Asia/Tashkent' })
  async nightly(): Promise<void> {
    if (!yattCrawlEnabled()) {
      this.logger.log(
        '[yatt-crawl] skipped — production only (YATT_CRAWL_ENABLED=1 runs it anyway)',
      );
      return;
    }
    const [cursor] = await this.db.query(
      `SELECT completed_at FROM public.yatt_crawl_cursor WHERE id = 1`,
    );
    if (cursor?.completed_at) {
      this.logger.log(
        '[yatt-crawl] skipped — the walk reached the end; POST /yatt-crawl/run?fromId=1 starts it again',
      );
      return;
    }
    const run = await this.start({}, 'nightly');
    await run.done;
  }

  async start(
    options: CrawlOptions,
    trigger: string,
  ): Promise<{ started: boolean; reason: string | null; done: Promise<void> }> {
    const idle = Promise.resolve();
    if (this.running) {
      return { started: false, reason: 'already running here', done: idle };
    }
    if (MYORG_REQUESTS_OFF) {
      // The register is myorg's: nothing to walk while requests to it are off.
      const reason = 'myorg requests are off (src/org/myorg-failure.ts)';
      this.logger.log(`[yatt-crawl] not started: ${reason}`);
      return { started: false, reason, done: idle };
    }
    if (!this.baseUrl || !this.token()) {
      const reason = 'MYORG_BASE_URL or MYORG_BEARER_TOKEN is not set';
      this.logger.error(`[yatt-crawl] not started: ${reason}`);
      await this.alert(`❌ <b>YaTT register walk not started</b>\n${reason}`);
      return { started: false, reason, done: idle };
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
        reason: 'another replica is running the walk',
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

  async requestStop(): Promise<{ requested: boolean }> {
    await this.db.query(
      `UPDATE public.yatt_crawl_cursor
          SET stop_requested = true, updated_at = now()
        WHERE id = 1`,
    );
    this.logger.log('[yatt-crawl] stop requested');
    return { requested: true };
  }

  async status(): Promise<Record<string, unknown>> {
    const [row] = await this.db.query(
      `SELECT * FROM public.yatt_crawl_cursor WHERE id = 1`,
    );
    const [lock] = await this.db.query(
      `SELECT EXISTS (
         SELECT 1 FROM pg_locks
          WHERE locktype = 'advisory' AND classid = 0 AND objid = $1
            AND objsubid = 1 AND granted
       ) AS held`,
      [LOCK_ID],
    );
    return {
      active: lock?.held === true,
      running_here: this.running,
      cursor: row ?? null,
    };
  }

  private async execute(options: CrawlOptions, trigger: string): Promise<void> {
    const startedAt = Date.now();
    const deadline = options.deadline ?? nextWindowEnd(new Date(startedAt));
    const intervalMs = Math.max(
      0,
      Number(process.env.YATT_CRAWL_INTERVAL_MS ?? 1000),
    );
    const night = emptyTotals();
    let next = 1;
    let lastFound: number | null = null;
    let missesInRow = 0;
    let failuresInRow = 0;
    let lastError: string | null = null;
    let ended: 'deadline' | 'limit' | 'end' | 'stopped' | 'aborted' =
      'deadline';
    let lastLogAt = Date.now();

    try {
      const [cursor] = await this.db.query(
        `SELECT next_id, last_found_id, cycle, completed_at, retry_ids
           FROM public.yatt_crawl_cursor WHERE id = 1`,
      );
      if (options.fromId !== undefined) {
        next = options.fromId;
        await this.db.query(
          `UPDATE public.yatt_crawl_cursor
              SET next_id = $1::bigint, completed_at = NULL, stop_requested = false,
                  cycle = cycle + CASE WHEN $1::bigint = 1 AND completed_at IS NOT NULL THEN 1 ELSE 0 END,
                  updated_at = now()
            WHERE id = 1`,
          [next],
        );
      } else {
        next = Number(cursor?.next_id ?? 1);
        await this.db.query(
          `UPDATE public.yatt_crawl_cursor
              SET stop_requested = false, updated_at = now() WHERE id = 1`,
        );
      }
      lastFound =
        cursor?.last_found_id != null ? Number(cursor.last_found_id) : null;
      const firstId = next;
      const lastAllowed =
        options.limit !== undefined ? firstId + options.limit - 1 : Infinity;

      this.logger.log(
        `[yatt-crawl] started at id ${firstId} · until ${deadline.toISOString()}` +
          `${options.limit ? ` · limit ${options.limit}` : ''} · every ${intervalMs} ms · ${trigger}`,
      );
      await this.alert(
        [
          `🔎 <b>YaTT register walk started</b> (${trigger})`,
          `From id ${n(firstId)}${options.limit ? ` · ${n(options.limit)} ids (trial)` : ''}`,
          `Until ${deadline.toISOString().slice(11, 16)} UTC`,
        ].join('\n'),
      );

      // Ids whose record could not be fetched or stored. The cursor moves on
      // past them; they are kept here and asked first the next night.
      const retry = new Set<number>(
        (cursor?.retry_ids ?? []).map((v: unknown) => Number(v)),
      );

      /**
       * One id: fetch, store the registry half, queue the STIR for the bank
       * half. 'end' when the run of missing ids says the list is over.
       */
      const walkId = async (
        id: number,
        foundInns: string[],
        retrying: boolean,
      ): Promise<'ok' | 'end'> => {
        const askedAt = Date.now();
        const outcome = await this.fetchRecord(id);
        night.walked++;
        // One request a second, start to start — myorg is not ours to load.
        const wait = intervalMs - (Date.now() - askedAt);
        if (wait > 0) await sleep(wait);
        if (outcome.kind === 'denied') {
          lastError = `myorg answered HTTP ${outcome.status} — token refused`;
          throw new NightAborted(lastError);
        }
        if (outcome.kind === 'failed') {
          night.errors++;
          failuresInRow++;
          retry.add(id);
          lastError = `id ${id}: ${outcome.message}`;
          if (failuresInRow >= ERROR_LIMIT) {
            throw new NightAborted(
              `${ERROR_LIMIT} ids failed in a row — ${lastError}`,
            );
          }
          return 'ok';
        }
        failuresInRow = 0;
        if (outcome.kind === 'missing') {
          night.missing++;
          retry.delete(id);
          if (retrying) return 'ok';
          missesInRow++;
          return missesInRow >= END_MISS_LIMIT ? 'end' : 'ok';
        }
        night.found++;
        if (!retrying) {
          missesInRow = 0;
          lastFound = id;
        }
        const record = mapYattRegistry(outcome.raw, null);
        if (!record) {
          night.unusable++;
          retry.delete(id);
          return 'ok';
        }
        try {
          await writeYattRegistry(this.db, record);
          // The register's spelling of the name, where none is held yet.
          await this.db.query(
            `UPDATE public.individual_entrepreneurs
                SET full_name = $2, updated_at = now()
              WHERE inn = $1 AND full_name IS NULL AND $2::text IS NOT NULL`,
            [record.inn, record.full_name],
          );
          night.saved++;
          if (retrying) night.recovered++;
          retry.delete(id);
          foundInns.push(record.inn);
        } catch (err) {
          night.errors++;
          retry.add(id);
          lastError =
            `id ${id} inn ${record.inn} refused: ${(err as Error).message}`.slice(
              0,
              200,
            );
        }
        return 'ok';
      };

      // Last night's failures first, while the night is young.
      if (retry.size) {
        const ids = [...retry].sort((x, y) => x - y);
        this.logger.log(
          `[yatt-crawl] asking ${ids.length} earlier failures again`,
        );
        const foundInns: string[] = [];
        try {
          for (const id of ids) {
            if (Date.now() >= deadline.getTime()) break;
            night.retried++;
            await walkId(id, foundInns, true);
          }
        } catch (err) {
          if (!(err instanceof NightAborted)) throw err;
          ended = 'aborted';
        }
        await this.bankHalf(foundInns, night);
        await this.saveRetries(retry);
      }

      let soliqPending: Promise<void> = Promise.resolve();

      while (ended !== 'aborted') {
        if (Date.now() >= deadline.getTime()) {
          ended = 'deadline';
          break;
        }
        if (next > lastAllowed) {
          ended = 'limit';
          break;
        }
        if (missesInRow >= END_MISS_LIMIT) {
          ended = 'end';
          break;
        }
        if (await this.stopRequested()) {
          ended = 'stopped';
          break;
        }

        const batchEnd = Math.min(next + BATCH - 1, lastAllowed);
        const foundInns: string[] = [];
        let id = next;
        try {
          for (; id <= batchEnd; id++) {
            if (Date.now() >= deadline.getTime()) break;
            if ((await walkId(id, foundInns, false)) === 'end') {
              id++;
              break;
            }
          }
        } catch (err) {
          if (!(err instanceof NightAborted)) throw err;
          // The failing id is asked again next time; what this batch found
          // before it gets its soliq half now, or the cursor would skip it.
          retry.delete(id);
          await soliqPending;
          await this.bankHalf(foundInns, night);
          await this.saveCursor(id, lastFound, night, lastError);
          await this.saveRetries(retry);
          ended = 'aborted';
          break;
        }

        // mysoliq for this batch runs while myorg serves the next one; the
        // cursor moves past a batch only once both halves are written.
        await soliqPending;
        const reached = id;
        const retrySnapshot = new Set(retry);
        soliqPending = this.bankHalf(foundInns, night)
          .then(() => this.saveCursor(reached, lastFound, night, lastError))
          .then(() => this.saveRetries(retrySnapshot));
        next = reached;

        if (Date.now() - lastLogAt >= LOG_EVERY_MS) {
          lastLogAt = Date.now();
          this.logger.log(
            `[yatt-crawl] at id ${next} · walked ${night.walked} · saved ${night.saved} ` +
              `· missing ${night.missing} · bank ${night.soliqBank} · errors ${night.errors}`,
          );
        }
      }
      await soliqPending;

      await this.db.query(
        `UPDATE public.yatt_crawl_cursor
            SET completed_at = CASE WHEN $1::boolean THEN now() ELSE completed_at END,
                stop_requested = false,
                totals = (
                  SELECT jsonb_object_agg(k, COALESCE((totals->>k)::bigint, 0) + v::bigint)
                    FROM jsonb_each_text($2::jsonb) AS e(k, v)
                ),
                last_run = $3::jsonb, last_run_at = now(), updated_at = now()
          WHERE id = 1`,
        [
          ended === 'end',
          JSON.stringify(night),
          JSON.stringify({ ...night, ended, lastError, trigger }),
        ],
      );
      await this.report(
        night,
        ended,
        next,
        lastFound,
        lastError,
        startedAt,
        trigger,
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`[yatt-crawl] crashed at id ${next}: ${message}`);
      await this.alert(
        `❌ <b>YaTT register walk crashed</b> at id ${n(next)}\n<code>${escapeHtml(message.slice(0, 300))}</code>`,
      );
    }
  }

  /**
   * One id, retried on timeouts and 5xx; 429 waits as long as asked.
   *
   * While myorg is off start() does not run the walk, and this asks
   * nothing: every id fails.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private async fetchRecord(id: number): Promise<Outcome> {
    // myorg off since 2026-10-12 (user decision 2026-10-13): one trader's record by myorg id (/api/entrepreneur/{id})
    // let lastMessage = '';
    // for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    //   try {
    //     const res = await firstValueFrom(
    //       this.http.get(`${this.baseUrl}/api/entrepreneur/${id}`, {
    //         headers: {
    //           accept: 'application/json',
    //           token: `Bearer ${this.token()}`,
    //         },
    //         timeout: 15_000,
    //         validateStatus: () => true,
    //       }),
    //     );
    //     if (res.status === 200 && res.data && typeof res.data === 'object') {
    //       return { kind: 'found', raw: res.data };
    //     }
    //     if (res.status === 404) return { kind: 'missing' };
    //     if (res.status === 401 || res.status === 403) {
    //       return { kind: 'denied', status: res.status };
    //     }
    //     if (res.status === 429) {
    //       const wait = Math.min(
    //         300_000,
    //         1000 * Number(res.headers?.['retry-after'] ?? 60) || 60_000,
    //       );
    //       this.logger.warn(`[yatt-crawl] 429 at id ${id}, waiting ${wait} ms`);
    //       await sleep(wait);
    //       attempt--; // a 429 is not the id's fault
    //       continue;
    //     }
    //     lastMessage = `HTTP ${res.status}`;
    //   } catch (err) {
    //     lastMessage = (err as Error).message;
    //   }
    //   if (attempt < ATTEMPTS) await sleep(2000 * attempt);
    // }
    // return { kind: 'failed', message: lastMessage.slice(0, 200) };
    return { kind: 'failed', message: 'myorg requests are off' };
  }

  /**
   * Bank code, account and PINFL from soliq; an empty answer never blanks a
   * value held. The PINFL is an identity — never replaced once stored, the
   * same rule the profile path keeps.
   */
  private async bankHalf(inns: string[], night: CrawlTotals): Promise<void> {
    const clean = (v: unknown) => {
      const text = v == null ? '' : String(v).trim();
      return text === '' ? null : text;
    };
    let index = 0;
    const worker = async () => {
      while (index < inns.length) {
        const inn = inns[index++];
        let data: any;
        try {
          data = await this.mysoliq.request('np1/bytin/factura-all', {
            tin: inn,
          });
        } catch (err) {
          night.soliqFailed++;
          this.logger.warn(
            `[yatt-crawl] soliq did not answer for ${inn}: ${(err as Error).message}`,
          );
          continue;
        }
        const bankCode = clean(data?.mfo);
        const account = clean(data?.account);
        const pinfl = clean(data?.personalNum);
        const validPinfl = pinfl && /^\d{14}$/.test(pinfl) ? pinfl : null;
        if (!account) night.soliqNoBank++;
        if (!account && !validPinfl) continue;
        try {
          await this.db.query(
            `UPDATE public.individual_entrepreneurs
                SET bank_code    = CASE WHEN $3::text IS NULL THEN bank_code
                                        ELSE COALESCE($2, bank_code) END,
                    bank_account = COALESCE($3, bank_account),
                    pinfl        = COALESCE(pinfl, $4),
                    updated_at   = now()
              WHERE inn = $1`,
            [inn, bankCode, account, validPinfl],
          );
          if (account) night.soliqBank++;
          if (validPinfl) night.soliqPinfl++;
        } catch (err) {
          night.errors++;
          this.logger.warn(
            `[yatt-crawl] soliq half of ${inn} not written: ${(err as Error).message}`,
          );
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(SOLIQ_CONCURRENCY, inns.length) }, worker),
    );
  }

  private async saveCursor(
    nextId: number,
    lastFound: number | null,
    night: CrawlTotals,
    lastError: string | null,
  ): Promise<void> {
    await this.db.query(
      `UPDATE public.yatt_crawl_cursor
          SET next_id = $1::bigint, last_found_id = COALESCE($2::bigint, last_found_id),
              last_run = $3::jsonb, updated_at = now()
        WHERE id = 1`,
      [
        nextId,
        lastFound,
        JSON.stringify({ ...night, lastError, running: true }),
      ],
    );
  }

  private async saveRetries(retry: Set<number>): Promise<void> {
    await this.db.query(
      `UPDATE public.yatt_crawl_cursor SET retry_ids = $1::bigint[] WHERE id = 1`,
      [[...retry].sort((x, y) => x - y)],
    );
  }

  private async stopRequested(): Promise<boolean> {
    const [row] = await this.db.query(
      `SELECT stop_requested FROM public.yatt_crawl_cursor WHERE id = 1`,
    );
    return row?.stop_requested === true;
  }

  private async report(
    t: CrawlTotals,
    ended: string,
    next: number,
    lastFound: number | null,
    lastError: string | null,
    startedAt: number,
    trigger: string,
  ): Promise<void> {
    const elapsed = Date.now() - startedAt;
    const head =
      ended === 'end'
        ? '✅ <b>YaTT register walk — reached the end of the list</b>'
        : ended === 'aborted'
          ? '❌ <b>YaTT register walk stopped — myorg is not answering</b>'
          : ended === 'stopped'
            ? '⏹ <b>YaTT register walk stopped on request</b>'
            : t.errors
              ? '⚠️ <b>YaTT register walk — night done, with errors</b>'
              : '✅ <b>YaTT register walk — night done</b>';
    const lines = [
      `${head} (${escapeHtml(trigger)})`,
      `Saved: <b>${n(t.saved)}</b> traders · from soliq: bank account ${n(t.soliqBank)}, PINFL ${n(t.soliqPinfl)}`,
      `Ids walked ${n(t.walked)} · found ${n(t.found)} · missing ${n(t.missing)} · no STIR ${n(t.unusable)}`,
      `Soliq: no bank ${n(t.soliqNoBank)} · not answering ${n(t.soliqFailed)} · errors ${n(t.errors)}`,
      ...(t.retried
        ? [
            `Earlier failures asked again: ${n(t.retried)} · stored ${n(t.recovered)}`,
          ]
        : []),
      `Next id: ${n(next)}${lastFound ? ` · last found ${n(lastFound)}` : ''}`,
      ...(lastError
        ? [`Last error: <code>${escapeHtml(lastError)}</code>`]
        : []),
      `Time: ${formatDuration(elapsed)}`,
    ];
    this.logger.log(
      `[yatt-crawl] ended (${ended}) at id ${next} · saved ${t.saved} · found ${t.found} ` +
        `· missing ${t.missing} · bank ${t.soliqBank} · pinfl ${t.soliqPinfl} · no bank ${t.soliqNoBank} · soliq failed ${t.soliqFailed} · errors ${t.errors}`,
    );
    await this.alert(lines.join('\n'));
  }

  private token(): string {
    const raw = process.env.MYORG_BEARER_TOKEN || '';
    return raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw;
  }

  private async alert(text: string): Promise<void> {
    try {
      await this.telegram.send(text, { tag: 'yatt_crawl' });
    } catch (err) {
      this.logger.warn(
        `[yatt-crawl] alert not sent: ${(err as Error).message}`,
      );
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
