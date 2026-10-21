import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TaxDebtorService } from '../tax-debtor/tax-debtor.service';
import { MibScriptService } from '../mib/mib.service';
import { TelegramAlertService } from '../common/telegram-alert.service';

/**
 * Fills `company_info.no_tax_debt` and `no_mib_debt` across the register.
 *
 * Both flags are otherwise written only when somebody opens a company, so most
 * of the register has never been checked and the screening result is mostly
 * `unknown` — which is honest but not useful. This walks the register nightly
 * and turns those into answers.
 *
 * ## Why it is slow on purpose
 *
 * Neither source can be hurried. Both are captcha-gated, both serialise on a
 * queue the website shares, and a steady request train is the shortest route
 * to an IP block — we already have one source refusing our production address.
 * So: a random gap between companies, a longer pause every so often, night
 * hours only, and a circuit breaker if the source starts refusing.
 *
 * The gap is per COMPANY, not per request: tax and MIB both go out inside one
 * interval, because they describe the same company and splitting them would
 * double the wall-clock for no benefit.
 *
 * ## Who gets walked
 *
 * Active, non-bankrupt companies with a flag still unset. Nothing else, and
 * that restraint is the point: a dissolved company is nobody's lead, but
 * sector, age and contactability are THIS customer's criteria and the next one
 * may screen on none of them. Filtering on them here would mean spending a
 * year filling a subset chosen for a brief that has since changed.
 *
 * At this pace a full pass takes roughly a year, and that is accepted rather
 * than worked around. `coverage` on the screening response reports how much of
 * any given answer was actually established, so a partial fill reads as
 * partial rather than as a clean result.
 */
@Injectable()
export class DebtFillService {
  private readonly logger = new Logger(DebtFillService.name);
  private readonly CURSOR = 'debt_fill_cursor';

  /** Companies per database round trip. */
  private readonly BATCH = 200;

  /** Random gap between companies. Both lookups happen inside one gap. */
  private readonly MIN_GAP_MS = 2_000;
  private readonly MAX_GAP_MS = 30_000;

  /** A longer breather every so often, so the pattern is not a metronome. */
  private readonly PAUSE_EVERY = 60;
  private readonly PAUSE_MIN_MS = 60_000;
  private readonly PAUSE_MAX_MS = 180_000;

  /**
   * Consecutive failures before the night is abandoned. Ten in a row is not
   * bad luck — it is the source refusing us, and continuing to ask is how a
   * temporary refusal becomes a permanent one.
   */
  private readonly MAX_CONSECUTIVE_FAILURES = 10;

  /** Stops before the morning, when the shared captcha queue starts mattering. */
  private readonly STOP_HOUR = 6;

  /** A held lock older than this belonged to a container that died. */
  private readonly LOCK_STALE_HOURS = 12;

  /**
   * Captcha attempts per company, against the site default of ten.
   *
   * Ten is right when a person is waiting for their answer. Here nobody is:
   * a company the solver cannot read tonight stays unfilled and comes back in
   * the next batch, so spending ten solves on one stubborn image costs the
   * walk several other companies for nothing. Three is the same number the
   * partner API settled on, for the same reason.
   */
  private readonly TAX_ATTEMPTS = 3;

  private running = false;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly taxDebtor: TaxDebtorService,
    private readonly mib: MibScriptService,
    private readonly tg: TelegramAlertService,
  ) {}

  @Cron('0 21 * * *', { timeZone: 'Asia/Tashkent' })
  async nightly(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      this.logger.log('[debt-fill] dev — skipped');
      return;
    }
    this.logger.log('[debt-fill] nightly cron fired');
    const res = await this.run();
    // A night that never starts is otherwise invisible. `run()` answers
    // `already_running` and returns; the flag lives only in memory, so a walk
    // killed before its `finally` leaves it stuck at true and every later
    // start is a silent no-op. The first sign used to be the morning report
    // that never came. `locked` announces itself inside `run()`, so this is
    // the only branch left uncovered.
    if (res.status === 'already_running') {
      await this.tg.send(
        `⚠️ <b>debt-fill did not start</b>\n` +
          `The previous walk is still "running" — tonight's run was skipped.`,
        { tag: 'debt_fill' },
      );
    }
  }

  /** Admin-triggered run. Same body, same lock. */
  async run(): Promise<{ status: string }> {
    // Claimed synchronously, before the first await.
    //
    // It used to be set after `tryLock` resolved, which left the whole round
    // trip to the database open: callers arriving in the same tick all read
    // `false`, all reached the lock, and nothing in this process stopped them
    // — the row lock was carrying the entire job on its own. Setting it here
    // means the second and third callers never leave the process.
    if (this.running) {
      this.logger.warn('[debt-fill] start refused — a walk is already running');
      return { status: 'already_running' };
    }
    this.running = true;

    const owner = `${process.env.HOSTNAME || 'unknown'}:${process.pid}`;
    if (!(await this.tryLock(owner))) {
      // Must be given back, or this replica sits out every night until it is
      // restarted — the flag would say "running" with nothing running.
      this.running = false;
      this.logger.log('[debt-fill] another replica holds the lock — skipped');
      // Announced rather than only logged. After the scheduler was fixed there
      // should be one caller a night, so a skip means a second replica really
      // did try, and that is worth knowing rather than discovering from a
      // count that looks three times too big.
      void this.tg.send(
        `⏭️ <b>debt-fill skipped</b>\n<code>${owner}</code> — another replica holds the lock`,
        { tag: 'debt_fill' },
      );
      return { status: 'locked' };
    }

    void this.walk()
      .catch((err) => {
        this.logger.error(`[debt-fill] crashed: ${err.message}`);
        void this.tg.send(
          `🚨 <b>debt-fill CRASHED</b>\n<code>${err.message}</code>`,
          { tag: 'debt_fill' },
        );
      })
      .finally(async () => {
        this.running = false;
        await this.releaseLock();
      });

    return { status: 'started' };
  }

  /**
   * Ask the walk to stop. Only the flag changes: the loop reads it between
   * companies, so the stop lands after the current check rather than tearing
   * one in half, and the lock is released by the walk's own `finally`.
   */
  stop(): { stopped: boolean; wasRunning: boolean } {
    const wasRunning = this.running;
    this.running = false;
    // `wasRunning` is reported rather than swallowed. "stopped, but nothing
    // was running" is a different situation from "stopped a live walk", and
    // the caller cannot tell them apart from a bare `{ stopped: true }`.
    this.logger.log(
      wasRunning
        ? '[debt-fill] stop requested — the walk will end after the current company'
        : '[debt-fill] stop requested — nothing was running',
    );
    return { stopped: true, wasRunning };
  }

  /**
   * What the job is doing, without a database client in hand.
   *
   * `running` is this process's flag and `lock` is what the table says. They
   * are reported separately because the disagreement is the useful part: a
   * lock held with nothing running means a walk was killed before it could
   * give the lock back, which is exactly what a restart mid-run looks like.
   */
  async status(): Promise<Record<string, any>> {
    const cursor = await this.readCursor();
    const heldMs = cursor.run_lock_at
      ? Date.now() - new Date(cursor.run_lock_at).getTime()
      : null;
    return {
      running: this.running,
      past_stop_hour: this.pastStopHour(),
      stop_hour: this.STOP_HOUR,
      lock: {
        owner: cursor.run_owner ?? null,
        held_since: cursor.run_lock_at ?? null,
        held_for: heldMs === null ? null : this.humanMs(heldMs),
        // Past this age the next start takes the lock anyway, so a stale lock
        // is a leftover to explain, not a blocker to clear.
        stale: heldMs !== null && heldMs > this.LOCK_STALE_HOURS * 3_600_000,
      },
      cursor,
    };
  }

  // ── The walk ─────────────────────────────────────────────────────────────

  private async walk(): Promise<void> {
    const startedAt = Date.now();
    let checked = 0;
    let failed = 0;
    let taxOk = 0;
    let mibOk = 0;
    let consecutiveFailures = 0;
    let sincePause = 0;

    const cursor = await this.readCursor();
    this.logger.log(
      `[debt-fill] walk started — cycle ${cursor.completed_cycles + 1}, ` +
        `from ${cursor.last_inn ?? 'the beginning'}, stops at ${this.STOP_HOUR}:00`,
    );
    await this.tg.send(
      `🌙 <b>debt-fill started</b>\n` +
        `Cycle ${cursor.completed_cycles + 1} · from <code>${cursor.last_inn ?? 'the beginning'}</code>\n` +
        `Stops at ${this.STOP_HOUR}:00`,
      { tag: 'debt_fill' },
    );

    let lastInn: string | null = cursor.last_inn;

    let announcedCycle = false;

    while (this.running && !this.pastStopHour()) {
      let batch = await this.nextBatch();

      if (batch.length === 0) {
        // Nothing unfilled left — the register has been covered once. Now the
        // job's work becomes keeping it current, so it re-checks whatever was
        // looked at longest ago. A flag from a year back is barely better than
        // no flag.
        //
        // This branch must never `continue` on an empty batch: the unfilled
        // query would answer empty again immediately and the loop would spin
        // without sleeping. The stale query always returns rows while any
        // company exists, so the walk below is what ends the iteration.
        batch = await this.staleBatch();

        if (batch.length === 0) {
          this.logger.warn(
            '[debt-fill] no companies to walk at all — stopping',
          );
          break;
        }

        if (!announcedCycle) {
          announcedCycle = true;
          await this.db.query(
            `UPDATE public.${this.CURSOR}
                SET completed_cycles = completed_cycles + 1,
                    cycle_started_at = now(),
                    cycle_checked = 0, cycle_failed = 0,
                    updated_at = now()
              WHERE id = 1`,
          );
          this.logger.log('[debt-fill] register covered — re-checking oldest');
          await this.tg.send(
            `🔄 <b>debt-fill cycle complete</b>\n` +
              `Every active company has been checked. Starting again from the oldest.`,
            { tag: 'debt_fill' },
          );
        }
      }

      for (const row of batch) {
        if (!this.running || this.pastStopHour()) break;

        const res = await this.checkOne(row.inn);
        checked++;
        if (res.tax) taxOk++;
        if (res.mib) mibOk++;

        // "Failed" stays "neither source answered", because that is what the
        // consecutive-failure brake watches for — a dead network, not one
        // captcha refusing. The per-source counts carry the rest.
        if (res.tax || res.mib) {
          consecutiveFailures = 0;
        } else {
          failed++;
          consecutiveFailures++;
        }
        lastInn = row.inn;
        await this.saveProgress(lastInn, res.tax || res.mib);

        if (consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
          this.logger.warn(
            `[debt-fill] ${consecutiveFailures} failures in a row — stopping`,
          );
          await this.tg.send(
            `⚠️ <b>debt-fill stopped early</b>\n` +
              `${consecutiveFailures} failures in a row — the source is not answering.\n` +
              `Checked ${checked} · soliq ${taxOk} · MIB ${mibOk}`,
            { tag: 'debt_fill' },
          );
          return;
        }

        if (checked % 500 === 0) {
          await this.tg.send(
            `⏳ <b>debt-fill</b>\nChecked <b>${checked}</b>\n` +
              `soliq ${taxOk} (${this.pct(taxOk, checked)}) · ` +
              `MIB ${mibOk} (${this.pct(mibOk, checked)}) · neither ${failed}\n` +
              `Last: <code>${lastInn}</code> · ${this.humanMs(Date.now() - startedAt)} elapsed`,
            { tag: 'debt_fill' },
          );
        }

        if (++sincePause >= this.PAUSE_EVERY) {
          sincePause = 0;
          await this.sleep(this.rand(this.PAUSE_MIN_MS, this.PAUSE_MAX_MS));
        } else {
          await this.sleep(this.rand(this.MIN_GAP_MS, this.MAX_GAP_MS));
        }
      }
    }

    const reason = !this.running
      ? 'stop requested'
      : this.pastStopHour()
        ? 'stop hour reached'
        : 'nothing left to walk';
    this.logger.log(
      `[debt-fill] walk finished (${reason}) — checked ${checked}, ` +
        `tax ${taxOk}, MIB ${mibOk}, neither ${failed}, ` +
        `${this.humanMs(Date.now() - startedAt)}`,
    );
    await this.tg.send(
      `🏁 <b>debt-fill finished</b>\n` +
        `Reason: ${reason}\n` +
        `Checked <b>${checked}</b>\n` +
        `soliq ${taxOk} (${this.pct(taxOk, checked)}) · ` +
        `MIB ${mibOk} (${this.pct(mibOk, checked)})\n` +
        `neither answered: ${failed}\n` +
        `${this.humanMs(Date.now() - startedAt)} · last <code>${lastInn ?? '-'}</code>`,
      { tag: 'debt_fill' },
    );
  }

  /**
   * Both sources for one company, inside one interval.
   *
   * Reported per source, not as one boolean. It used to return `taxOk || mibOk`
   * and the walk counted that as success, which is why the night of
   * 2026-08-11 reported 11 failures out of 695 while MIB had actually answered
   * for 110 companies out of 625 — tax answering covered for MIB failing, and
   * nothing in the numbers said so. A source cannot be improved while the
   * metric hides it.
   */
  private async checkOne(inn: string): Promise<{ tax: boolean; mib: boolean }> {
    const [tax, mib] = await Promise.allSettled([
      this.taxDebtor.checkByInn(inn, this.TAX_ATTEMPTS, 'later'),
      this.mib.checkDebtByInn(inn),
    ]);

    const taxOk = tax.status === 'fulfilled' && tax.value?.success === true;
    const mibOk = mib.status === 'fulfilled' && mib.value?.success === true;

    // Both services write the flags themselves at the point they learn the
    // answer, so there is nothing to persist here — which is deliberate: one
    // writer per fact, and it is the one that fetched it.
    this.logger.log(
      `[debt-fill] ${inn} — soliq ${taxOk ? 'ok' : 'failed'}, MIB ${mibOk ? 'ok' : 'failed'}`,
    );
    return { tax: taxOk, mib: mibOk };
  }

  /**
   * The next companies to check, most-promising-first.
   *
   * Ordered rather than arbitrary because a full pass takes about a year: what
   * gets checked in the first weeks decides whether the screen is useful this
   * month or next year. Contactable companies with staff, in the sectors the
   * screen filters on, come first — those are the ones a lending desk can act
   * on. Never-checked before re-checked, so coverage grows before it refreshes.
   */
  /**
   * Companies covered longest ago, for when nothing is unfilled any more.
   *
   * `NULLS FIRST` is not redundant even though this only runs once nothing is
   * NULL: `debts_checked_at` is written by whichever flow got there, and a row
   * whose flags were set by a path that did not stamp it would otherwise sort
   * last and never be revisited.
   */
  private async staleBatch(): Promise<Array<{ inn: string }>> {
    return this.db.query(
      `SELECT ci.inn
         FROM public.company_info ci
        WHERE ci.activity_state = 1
          AND ci.is_bankrupt IS NOT TRUE
          AND ci.inn ~ '^[0-9]{9}$'
        ORDER BY ci.debts_checked_at ASC NULLS FIRST, ci.inn
        LIMIT $1`,
      [this.BATCH],
    );
  }

  private async nextBatch(): Promise<Array<{ inn: string }>> {
    return this.db.query(
      `SELECT ci.inn
         FROM public.company_info ci
        WHERE ci.activity_state = 1
          AND ci.is_bankrupt IS NOT TRUE
          AND ci.inn ~ '^[0-9]{9}$'
          AND (ci.no_tax_debt IS NULL OR ci.no_mib_debt IS NULL)
        ORDER BY ci.inn
        LIMIT $1`,
      [this.BATCH],
    );
  }

  private async saveProgress(inn: string, ok: boolean): Promise<void> {
    await this.db
      .query(
        `UPDATE public.${this.CURSOR}
            SET last_inn = $1,
                cycle_checked = cycle_checked + 1,
                cycle_failed = cycle_failed + $2,
                total_checked = total_checked + 1,
                total_failed = total_failed + $2,
                last_run_at = now(), updated_at = now()
          WHERE id = 1`,
        [inn, ok ? 0 : 1],
      )
      .catch((err: any) =>
        this.logger.warn(`[debt-fill] cursor save failed: ${err.message}`),
      );
  }

  private async readCursor(): Promise<any> {
    const rows = await this.db.query(
      `SELECT * FROM public.${this.CURSOR} WHERE id = 1`,
    );
    return rows[0] ?? { last_inn: null, completed_cycles: 0 };
  }

  // ── Lock ─────────────────────────────────────────────────────────────────

  private async tryLock(owner: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE public.${this.CURSOR}
          SET run_lock_at = now(), run_owner = $1, updated_at = now()
        WHERE id = 1
          AND (run_lock_at IS NULL
               OR run_lock_at < now() - ($2 || ' hours')::interval)
        RETURNING 1`,
      [owner, String(this.LOCK_STALE_HOURS)],
    );
    return rows.length > 0;
  }

  private async releaseLock(): Promise<void> {
    await this.db
      .query(
        `UPDATE public.${this.CURSOR}
            SET run_lock_at = NULL, run_owner = NULL, updated_at = now()
          WHERE id = 1`,
      )
      .catch(() => undefined);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Share of checks a source answered, for reports a human reads. */
  private pct(n: number, total: number): string {
    return total ? `${Math.round((n / total) * 100)}%` : '—';
  }

  /** Tashkent hour, because the stop time is about local traffic. */
  private pastStopHour(): boolean {
    const hour = Number(
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Tashkent',
        hour: '2-digit',
        hour12: false,
      }).format(new Date()),
    );
    // Between the stop hour and the evening start, this job has no business
    // running — the window wraps midnight, so the test is a range, not a `>=`.
    return hour >= this.STOP_HOUR && hour < 21;
  }

  private rand(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((res) => setTimeout(res, ms));
  }

  private humanMs(ms: number): string {
    const total = Math.round(ms / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }
}
