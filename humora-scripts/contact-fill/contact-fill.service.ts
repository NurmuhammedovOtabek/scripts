import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { StatQueueService } from '../stat-registry/stat-queue.service';
import {
  StatRegistryNotFoundError,
  StatRegistryThrottledError,
} from '../stat-registry/stat-registry.service';
import { CompanyInfoFields } from '../stat-registry/stat-registry.parser';

/**
 * Companies per run, and the most a run may take (user decision 2026-10-05).
 * At one lookup per five seconds, 2000 is about 2 h 50 min.
 */
const DEFAULT_LIMIT = 2000;
const MAX_LIMIT = 2000;

/** A long walk looks this often whether the recheck wants the slot. */
const YIELD_CHECK_EVERY = 20;

/**
 * How long to stand down when the queue says it is full.
 *
 * A page view waiting on stat.uz matters more than a backfill row, so a full
 * queue is a reason to wait rather than to give up: the run resumes when the
 * people using the site have been served.
 */
const BACKOFF_MS = 60_000;

/** Consecutive refusals that mean the queue is not going to clear this run. */
const GIVE_UP_AFTER_BACKOFFS = 5;

/**
 * The twice-daily recheck looks this far back. stat.uz lists a company a day
 * or so after it is registered (measured 2026-09-15), so the scan's own
 * attempt — minutes after registration — usually finds nothing; three days
 * gives every new company about six more tries.
 */
const RECHECK_DAYS = 3;

/** Enough for three days of registrations (~244 a day) in one run. */
const RECHECK_LIMIT = 1000;

/**
 * A recheck that finds a walk running asks it to step aside, then tries this
 * often, this many times. The walk checks every 20 companies (~2 minutes).
 */
const RECHECK_WAIT_MS = 60_000;
const RECHECK_TRIES = 20;

/** A lock older than this was left by a process that died mid-run. */
const LOCK_STALE_HOURS = 6;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * The rows an UPDATE … RETURNING gave back.
 *
 * TypeORM answers an UPDATE with `[rows, count]`, not with the rows, so
 * `.length` on the raw answer is always 2. Until 2026-09-28 that made the run
 * lock always look taken by us — replicas could run the fill side by side —
 * and every contact UPDATE look like it changed a row. A plain array (what a
 * hand-written mock returns) is taken as the rows themselves.
 */
export function returnedRows<T = unknown>(res: unknown): T[] {
  if (
    Array.isArray(res) &&
    res.length === 2 &&
    Array.isArray(res[0]) &&
    typeof res[1] === 'number'
  ) {
    return res[0] as T[];
  }
  return Array.isArray(res) ? (res as T[]) : [];
}

/**
 * Whether the scheduled fill runs here: production only, by default.
 *
 * Dev shares registr.stat.uz's one-search-per-five-seconds budget with
 * production and fills a database nobody sells from, so a run there only
 * slows production's lookups (user decision, 2026-09-26). The environment is
 * SERVICE_ENVIRONMENT, which CI bakes into the image — `production` for
 * main.* tags, `development` for test.* — and a laptop leaves unset.
 * CONTACT_FILL_ENABLED overrides it either way: `0` switches production off,
 * `1` switches it on elsewhere. The admin endpoint is not affected.
 */
export function scheduledFillEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.CONTACT_FILL_ENABLED === '0') return false;
  if (env.CONTACT_FILL_ENABLED === '1') return true;
  return env.SERVICE_ENVIRONMENT === 'production';
}

export interface ContactFillOptions {
  /**
   * Only companies registered in the last N days. Unset — the default — is
   * every company without a contact, newest STIR first.
   */
  days?: number;
  /** How many companies to ask about. Defaults to, and at most, 2000. */
  limit?: number;
  /** Start from this STIR instead of where the last run stopped. */
  fromInn?: string;
  /** STIRs the scan has just listed; asked about before the cursor walk. */
  justAdded?: string[];
  /**
   * Ask every company registered in the last N days that still has no
   * contact, newest first, ignoring the cursor and leaving it where it is —
   * the twice-daily recheck of companies asked before stat.uz listed them.
   */
  recheckDays?: number;
}

export interface ContactFillReport {
  trigger: string;
  asked: number;
  filled: number;
  phones: number;
  emails: number;
  absent: number;
  failed: number;
  lastInn: string | null;
  startedAt: string;
  tookMs: number;
  gaveUp: boolean;
  /** Stopped early so the twice-daily recheck could run; resumes next run. */
  yielded: boolean;
}

/**
 * Fills the contacts the new-company scan cannot.
 *
 * The scan lists a company from what mysoliq publishes, and mysoliq carries no
 * phone and no e-mail — the INSERT in `company-listing.ts` has no such columns.
 * Those two fields come from registr.stat.uz, which until now was only ever
 * fetched by a page view on humora.uz. Sales screens companies nobody has
 * opened, so it saw `phone: null` on every newly registered company, and the
 * one view built for them — "Yangi ochilganlar" — listed leads with no way to
 * reach them.
 *
 * This walks every active company that still has neither field — newest STIR first,
 * whatever its age (user decision 2026-10-05; it was the last 30 days) — and
 * asks stat.uz for each, through the same Redis-paced queue page views use.
 * At most 2000 a run. Sharing the
 * queue is the point: the pacing is a property of the source, not of a caller,
 * and a backfill with its own budget would simply race the site for slots.
 *
 * Every write is a fill, never an overwrite — `COALESCE(existing, new)`. A
 * value a page view already stored is the same value from the same source, and
 * a backfill is the wrong place to relitigate one that differs.
 */
@Injectable()
export class ContactFillService {
  private readonly logger = new Logger(ContactFillService.name);
  private readonly CURSOR = 'contact_fill_cursor';
  private running = false;
  private lastReport: ContactFillReport | null = null;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly stat: StatQueueService,
    private readonly telegram: TelegramAlertService,
  ) {}

  /**
   * Twice a day (07:30 and 19:30 Tashkent) — the only times the fill runs on
   * its own (user decision 2026-10-19; until then the walk also rode every
   * two-hourly new-company scan, so it ran nearly around the clock):
   *
   * 1. every company registered in the last RECHECK_DAYS days that still has
   *    no phone or e-mail is asked again (user decision 2026-10-05);
   * 2. then the walk over every contactless company carries on from its
   *    cursor, at most 2000.
   *
   * The scan asks about a company minutes after it is registered, and stat.uz
   * lists it only a day or so later, so that first answer is usually "not in
   * the register", and the cursor walk — every contactless company, oldest
   * last — would not come back to it for weeks. Production only, like the
   * rest of the scheduled fill. A walk holding the fill is asked to step
   * aside (`yield_requested`); it stops within ~20 companies, keeps its
   * cursor, and the next run carries on.
   */
  @Cron('30 7,19 * * *', { timeZone: 'Asia/Tashkent' })
  async twiceDaily(): Promise<void> {
    if (!scheduledFillEnabled()) {
      this.logger.log(
        `[contact-fill] recheck skipped — scheduled fill runs in production only`,
      );
      return;
    }
    for (let attempt = 1; attempt <= RECHECK_TRIES; attempt++) {
      const run = await this.start(
        { recheckDays: RECHECK_DAYS, limit: RECHECK_LIMIT },
        'twice-daily recheck',
      );
      if (run.started) {
        await run.done;
        await this.walkAfterRecheck();
        return;
      }
      // A walk of up to 2000 companies holds the fill for hours; ask it to
      // step aside. It saves its cursor and the next run carries on.
      if (attempt === 1) await this.setYield(true);
      this.logger.log(
        `[contact-fill] recheck waiting — ${run.reason} (${attempt}/${RECHECK_TRIES})`,
      );
      if (attempt < RECHECK_TRIES) await sleep(RECHECK_WAIT_MS);
    }
    await this.setYield(false);
    const waited = (RECHECK_TRIES * RECHECK_WAIT_MS) / 60_000;
    this.logger.warn(
      `[contact-fill] recheck skipped — the fill stayed busy for ${waited} min`,
    );
    await this.telegram
      .send(
        `⚠️ <b>Contact fill (twice-daily recheck) — skipped</b>\n` +
          `The fill did not step aside in ${waited} min; the next recheck is in 12 hours.`,
        { tag: 'contact_fill' },
      )
      .catch(() => undefined);
  }

  /** The walk, straight after the recheck, in the same twice-daily slot. */
  private async walkAfterRecheck(): Promise<void> {
    const walk = await this.start({}, 'twice-daily walk');
    if (walk.started) await walk.done;
    else
      this.logger.log(
        `[contact-fill] twice-daily walk not started — ${walk.reason}`,
      );
  }

  /**
   * Fills the given STIRs first, then walks on. Not scheduled since
   * 2026-10-19 (the scan no longer calls it; the fill runs twice a day).
   * Kept for a run by hand with freshly listed STIRs.
   *
   * The scan is what produces the work, so riding it means a company is
   * asked within the same two-hour tick that found it. stat.uz often has not
   * listed it yet — the twice-daily recheck above asks again.
   *
   * `justAdded` goes first because those are the newest and the cursor has
   * never seen them; whatever budget is left then continues down the window,
   * which is how the backlog that predates this gets worked through.
   */
  async afterScan(justAdded: string[], trigger: string): Promise<void> {
    if (!scheduledFillEnabled()) {
      this.logger.log(
        `[contact-fill] skipped — scheduled fill runs in production only ` +
          `(SERVICE_ENVIRONMENT=${process.env.SERVICE_ENVIRONMENT ?? 'unset'}, ` +
          `CONTACT_FILL_ENABLED=${process.env.CONTACT_FILL_ENABLED ?? 'unset'})`,
      );
      return;
    }
    const run = await this.start({ justAdded }, trigger);
    await run.done;
  }

  /**
   * Takes the lock and starts a run. `done` settles when the run has reported.
   *
   * Returning before the walk finishes lets the admin endpoint answer at once —
   * a full batch takes about half an hour — while the cron awaits `done`.
   */
  async start(
    options: ContactFillOptions,
    trigger: string,
  ): Promise<{ started: boolean; reason: string | null; done: Promise<void> }> {
    const idle = Promise.resolve();
    if (this.running) {
      this.logger.log('[contact-fill] skipped — already running here');
      return { started: false, reason: 'already running', done: idle };
    }

    const owner = `${process.env.HOSTNAME ?? 'local'}:${process.pid}`;
    if (!(await this.tryLock(owner))) {
      this.logger.log('[contact-fill] skipped — another instance holds it');
      return {
        started: false,
        reason: 'another instance holds the lock',
        done: idle,
      };
    }

    this.running = true;
    const done = this.walk(options, trigger)
      .catch((err: any) => {
        const message = String(err?.message ?? err);
        this.logger.error(
          `[contact-fill] ${trigger}: run failed — ${err?.stack ?? message}`,
        );
        return this.telegram
          .send(
            [
              `❌ <b>Contact fill (${escapeHtml(trigger)}) — run failed</b>`,
              `<code>${escapeHtml(message)}</code>`,
              'The cursor stays where the last finished run left it; the next scan tick tries again.',
            ].join('\n'),
            { tag: 'contact_fill' },
          )
          .catch(() => undefined);
      })
      .then(async () => {
        this.running = false;
        await this.releaseLock(owner);
      });

    return { started: true, reason: null, done };
  }

  status() {
    return { running: this.running, last: this.lastReport };
  }

  // ── The walk ───────────────────────────────────────────────────────────

  private async walk(
    options: ContactFillOptions,
    trigger: string,
  ): Promise<void> {
    const recheck = options.recheckDays !== undefined;
    const windowDays = options.recheckDays ?? options.days;
    const days =
      windowDays === undefined ? null : Math.min(Math.max(windowDays, 1), 3650);
    const limit = Math.min(
      Math.max(options.limit ?? DEFAULT_LIMIT, 1),
      MAX_LIMIT,
    );
    // The recheck is the one the flag was raised for; it must not yield to it.
    if (recheck) await this.setYield(false);
    const startedAt = new Date();
    const began = Date.now();

    // A recheck reads the newest from the top and leaves the cursor alone.
    const cursor = recheck ? { last_inn: null } : await this.readCursor();
    const after = recheck ? null : (options.fromInn ?? cursor.last_inn ?? null);

    // The scan's own list first — brand-new companies the cursor is below and
    // would otherwise not reach for a full pass of the window.
    const fresh = (options.justAdded ?? []).filter((inn) =>
      /^\d{9}$/.test(inn),
    );
    const walked = await this.contactless(
      days,
      Math.max(limit - fresh.length, 0),
      after,
    );
    // A STIR listed this tick cannot already be further down the walk, but the
    // guard costs nothing and a duplicate would spend a slot twice.
    const seen = new Set(fresh);
    const targets = [...fresh, ...walked.filter((inn) => !seen.has(inn))];

    if (walked.length === 0 && after) {
      // The end of the window: start the next run from the top rather than
      // sitting on a cursor that can only ever return nothing.
      await this.saveCursor(null, null);
      this.logger.log(
        `[contact-fill] window walked to the end — cursor reset, next run starts from the newest`,
      );
    }

    let asked = 0;
    let filled = 0;
    let phones = 0;
    let emails = 0;
    let absent = 0;
    let failed = 0;
    let backoffs = 0;
    let gaveUp = false;
    let lastInn: string | null = after;
    let yielded = false;

    for (let i = 0; i < targets.length; i += 1) {
      if (!recheck && i > 0 && i % YIELD_CHECK_EVERY === 0) {
        if (await this.yieldRequested()) {
          yielded = true;
          await this.setYield(false);
          this.logger.log(
            `[contact-fill] stepping aside for the twice-daily recheck after ${i} companies`,
          );
          break;
        }
      }
      const inn = targets[i];
      let record: CompanyInfoFields | null = null;
      try {
        asked += 1;
        record = await this.stat.fetch(inn);
      } catch (err) {
        if (err instanceof StatRegistryNotFoundError) {
          // The register has no such company. Not a failure: a STIR the scan
          // listed from mysoliq can simply be absent from stat.uz.
          absent += 1;
          if (!seen.has(inn)) lastInn = inn;
          continue;
        }
        if (err instanceof StatRegistryThrottledError) {
          // Page views are queued ahead of us. Wait and ask about the same
          // company again — moving on would skip it for the whole run and
          // make the wait pointless, since the queue is just as full for the
          // next STIR as it was for this one.
          asked -= 1;
          backoffs += 1;
          if (backoffs >= GIVE_UP_AFTER_BACKOFFS) {
            gaveUp = true;
            this.logger.warn(
              `[contact-fill] giving up this run — queue still full after ` +
                `${backoffs} waits`,
            );
            break;
          }
          this.logger.log(
            `[contact-fill] queue full — waiting ${BACKOFF_MS / 1000}s ` +
              `(${backoffs}/${GIVE_UP_AFTER_BACKOFFS})`,
          );
          await sleep(BACKOFF_MS);
          i -= 1;
          continue;
        }
        failed += 1;
        if (!seen.has(inn)) lastInn = inn;
        this.logger.warn(
          `[contact-fill] ${inn} — ${(err as Error)?.message ?? err}`,
        );
        continue;
      }

      backoffs = 0;
      if (!seen.has(inn)) lastInn = inn;

      // One bad answer or one refused write costs that company, not the run.
      // A record-less "success" is what crashed production on 2026-09-28
      // (the stat queue handed back a stale null — fixed there too).
      if (!record) {
        failed += 1;
        this.logger.warn(
          `[contact-fill] ${inn} — the register answered with no record`,
        );
        continue;
      }
      let wrote: { phone: boolean; email: boolean };
      try {
        wrote = await this.fill(inn, record);
      } catch (err) {
        failed += 1;
        this.logger.warn(
          `[contact-fill] ${inn} — write failed: ${(err as Error)?.message ?? err}`,
        );
        continue;
      }
      if (wrote.phone || wrote.email) filled += 1;
      if (wrote.phone) phones += 1;
      if (wrote.email) emails += 1;
    }

    if (!recheck)
      await this.saveCursor(lastInn, {
        trigger,
        asked,
        filled,
        phones,
        emails,
        absent,
        failed,
        gaveUp,
        yielded,
        at: startedAt.toISOString(),
      });

    const report: ContactFillReport = {
      trigger,
      asked,
      filled,
      phones,
      emails,
      absent,
      failed,
      lastInn,
      startedAt: startedAt.toISOString(),
      tookMs: Date.now() - began,
      gaveUp,
      yielded,
    };
    this.lastReport = report;
    await this.report(report, days, targets.length, fresh.length);
  }

  /**
   * Active companies with neither a phone nor an e-mail, newest STIR
   * first — every one of them, or those registered in the last `days` days.
   *
   * By STIR rather than by registration date: the counter is the order of
   * registration, the index `company_info_contactless_active_inn_idx` serves it,
   * and a company with no registration date is still reached. `after` walks
   * down from where the last run stopped, so a resumed run never asks a
   * company twice.
   */
  private async contactless(
    days: number | null,
    limit: number,
    after: string | null,
  ): Promise<string[]> {
    const params: any[] = [];
    const where: string[] = [
      // Active only (user decision 2026-10-05): a closed company's phone is
      // nobody's lead, and stat.uz's slots are shared with the site.
      `ci.activity_state = 1`,
      `nullif(btrim(ci.phone), '') IS NULL`,
      `nullif(btrim(ci.email), '') IS NULL`,
      `ci.inn ~ '^[0-9]{9}$'`,
    ];
    if (days !== null) {
      params.push(String(days));
      where.push(
        `ci.registration_date >= (now() AT TIME ZONE 'Asia/Tashkent')::date - ($${params.length} || ' days')::interval`,
      );
    }
    if (after) {
      params.push(after);
      where.push(`ci.inn < $${params.length}`);
    }
    params.push(limit);

    const rows: Array<{ inn: string }> = await this.db.query(
      `SELECT ci.inn
         FROM public.company_info ci
        WHERE ${where.join(' AND ')}
        ORDER BY ci.inn DESC
        LIMIT $${params.length}`,
      params,
    );
    return rows.map((r) => r.inn);
  }

  /**
   * Writes the two contact fields, and the region text that arrives with them.
   *
   * COALESCE both ways: a field the register left empty does not erase what we
   * hold, and a field we already hold is not replaced. The WHERE means a row
   * that needs nothing is not written at all, so `updated_at` still says when
   * the company last actually changed.
   */
  private async fill(
    inn: string,
    record: CompanyInfoFields,
  ): Promise<{ phone: boolean; email: boolean }> {
    const phone = this.clean(record.phone);
    const email = this.clean(record.email);
    const region = this.clean(record.region);
    const city = this.clean(record.city);

    if (!phone && !email && !region && !city)
      return { phone: false, email: false };

    const rows = await this.db.query(
      `UPDATE public.company_info
          SET phone      = COALESCE(nullif(btrim(phone), ''), $2),
              email      = COALESCE(nullif(btrim(email), ''), $3),
              region     = COALESCE(nullif(btrim(region), ''), $4),
              city       = COALESCE(nullif(btrim(city), ''), $5),
              updated_at = now()
        WHERE inn = $1
          AND ( (nullif(btrim(phone),  '') IS NULL AND $2::text IS NOT NULL)
             OR (nullif(btrim(email),  '') IS NULL AND $3::text IS NOT NULL)
             OR (nullif(btrim(region), '') IS NULL AND $4::text IS NOT NULL)
             OR (nullif(btrim(city),   '') IS NULL AND $5::text IS NOT NULL) )
        RETURNING phone, email`,
      [inn, phone, email, region, city],
    );

    if (returnedRows(rows).length === 0) return { phone: false, email: false };
    // Whether, not what: contacts are often a person's own phone and mail,
    // and every log line is shipped to Kibana.
    this.logger.log(
      `[contact-fill] ${inn} — phone=${phone ? 'yes' : 'no'} email=${email ? 'yes' : 'no'}`,
    );
    return { phone: !!phone, email: !!email };
  }

  private clean(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s === '' ? null : s;
  }

  // ── Report ─────────────────────────────────────────────────────────────

  private async report(
    r: ContactFillReport,
    days: number | null,
    candidates: number,
    fresh: number,
  ): Promise<void> {
    const mins = Math.round(r.tookMs / 60000);
    const head = r.yielded
      ? `⏸ <b>Contact fill (${escapeHtml(r.trigger)}) — paused for the twice-daily recheck</b>`
      : r.gaveUp
        ? `⚠️ <b>Contact fill (${escapeHtml(r.trigger)}) — stat.uz queue busy, stopped early</b>`
        : r.failed
          ? `⚠️ <b>Contact fill (${escapeHtml(r.trigger)}) — finished with failures</b>`
          : `📇 <b>Contact fill (${escapeHtml(r.trigger)})</b>`;

    const lines = [
      head,
      '',
      `${days === null ? 'All companies without contacts' : `Window: last ${days} days`} · ${candidates} candidates (${fresh} just listed by the scan)`,
      `Asked stat.uz: ${r.asked}`,
      `Filled: ${r.filled} (phone ${r.phones}, email ${r.emails})`,
      `Not in the register: ${r.absent}`,
      `Failed: ${r.failed}${r.failed ? ' — per-company reasons are in the log ([contact-fill] <STIR> — …)' : ''}`,
      `Took: ${mins} min`,
    ];
    if (r.lastInn) lines.push(`Cursor: ${r.lastInn}`);

    this.logger.log(
      `[contact-fill] ${r.trigger} — asked=${r.asked} filled=${r.filled} ` +
        `(phone=${r.phones} email=${r.emails}) absent=${r.absent} ` +
        `failed=${r.failed} in ${mins}m`,
    );
    await this.telegram
      .send(lines.join('\n'), { tag: 'contact_fill' })
      .catch(() => undefined);
  }

  // ── Cursor and lock ────────────────────────────────────────────────────

  private async readCursor(): Promise<{ last_inn: string | null }> {
    const rows = await this.db.query(
      `SELECT * FROM public.${this.CURSOR} WHERE id = 1`,
    );
    return rows[0] ?? { last_inn: null };
  }

  private async saveCursor(lastInn: string | null, run: any): Promise<void> {
    await this.db
      .query(
        `UPDATE public.${this.CURSOR}
            SET last_inn = $1, last_run = $2, last_run_at = now(), updated_at = now()
          WHERE id = 1`,
        [lastInn, run === null ? null : JSON.stringify(run)],
      )
      .catch((err: any) =>
        this.logger.warn(`[contact-fill] cursor save failed: ${err.message}`),
      );
  }

  private async yieldRequested(): Promise<boolean> {
    try {
      const rows = await this.db.query(
        `SELECT yield_requested FROM public.${this.CURSOR} WHERE id = 1`,
      );
      return rows?.[0]?.yield_requested === true;
    } catch {
      return false;
    }
  }

  private async setYield(value: boolean): Promise<void> {
    await this.db
      .query(
        `UPDATE public.${this.CURSOR}
            SET yield_requested = $1, updated_at = now()
          WHERE id = 1`,
        [value],
      )
      .catch((err: any) =>
        this.logger.warn(`[contact-fill] yield flag not set: ${err.message}`),
      );
  }

  private async tryLock(owner: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE public.${this.CURSOR}
          SET run_lock_at = now(), run_owner = $1, updated_at = now()
        WHERE id = 1
          AND (run_lock_at IS NULL
               OR run_lock_at < now() - ($2 || ' hours')::interval)
        RETURNING 1`,
      [owner, String(LOCK_STALE_HOURS)],
    );
    return returnedRows(rows).length > 0;
  }

  /**
   * Only our own lock. A run that outlived LOCK_STALE_HOURS has had its lock
   * taken over by another instance; clearing it on the way out would let a
   * third one start beside that one.
   */
  private async releaseLock(owner: string): Promise<void> {
    await this.db
      .query(
        `UPDATE public.${this.CURSOR}
            SET run_lock_at = NULL, run_owner = NULL, updated_at = now()
          WHERE id = 1 AND run_owner = $1`,
        [owner],
      )
      .catch(() => undefined);
  }
}
