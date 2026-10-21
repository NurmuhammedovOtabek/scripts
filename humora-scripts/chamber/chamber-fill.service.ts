import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ChamberScriptService } from './chamber.service';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recordRating } from './rating-history';

@Injectable()
export class ChamberFillService {
  private readonly logger = new Logger(ChamberFillService.name);
  private readonly CURSOR = 'chamber_fill_cursor';
  private isRunning = false;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly chamber: ChamberScriptService,
    private readonly tg: TelegramAlertService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  async start(
    opts: { resetCursor?: boolean } = {},
  ): Promise<Record<string, any>> {
    if (this.isRunning) return { status: 'already_running' };
    if (opts.resetCursor) await this.resetCursor();
    this.isRunning = true;
    this.runLoop()
      .catch((err) => {
        this.logger.error(`[chamber-fill] crashed: ${err.message}`);
        this.tg.send(
          `🚨 <b>chamber-fill CRASHED</b>\nError: <code>${err.message}</code>`,
          { tag: 'chamber' },
        );
      })
      .finally(() => {
        this.isRunning = false;
      });
    return { status: 'started', cursor: await this.getCursor() };
  }

  stop() {
    this.isRunning = false;
    return { stopped: true };
  }

  async getCursor() {
    const r = await this.db.query(
      `SELECT * FROM public.${this.CURSOR} WHERE id=1`,
    );
    return { ...r[0], is_running: this.isRunning };
  }

  // ── Loop ───────────────────────────────────────────────────────────────────

  // Block recovery time confirmed by test: ~172s. We wait 3 min to be safe.
  private readonly BLOCK_PAUSE_MS = 3 * 60 * 1000;

  private async runLoop(): Promise<void> {
    let processed = 0,
      rated = 0,
      notRated = 0,
      fail = 0;

    const init = await this.db.query(
      `SELECT last_id, completed_cycles FROM public.${this.CURSOR} WHERE id=1`,
    );
    let lastId = Number(init[0]?.last_id) || 0;
    const cycle = (Number(init[0]?.completed_cycles) || 0) + 1;

    await this.tg.send(
      `▶️ <b>chamber-fill started</b>\n` +
        `Cycle: <b>${cycle}</b> · From id: <code>${lastId}</code>\n` +
        `<i>Filter: trust IS NULL</i>`,
      { tag: 'chamber' },
    );

    while (this.isRunning) {
      const rows: { id: number; inn: string }[] = await this.db.query(
        `SELECT id, inn FROM public.company_info
          WHERE id > $1 AND trust IS NULL AND inn IS NOT NULL
          ORDER BY id ASC LIMIT 1`,
        [lastId],
      );

      if (rows.length === 0) {
        await this.db.query(
          `UPDATE public.${this.CURSOR}
              SET last_id=0, cycle_started_at=now(), cycle_processed=0,
                  completed_cycles=completed_cycles+1,
                  total_ok=total_ok+$1, total_fail=total_fail+$2, updated_at=now()
            WHERE id=1`,
          [rated + notRated, fail],
        );
        await this.tg.send(
          `🏁 <b>chamber-fill cycle complete</b>\n` +
            `Processed: <b>${processed}</b>\n` +
            `Rated: ${rated} · Not rated: ${notRated} · Fail: ${fail}`,
          { tag: 'chamber' },
        );
        break;
      }

      const { id, inn } = rows[0];
      const advanceCursor = await this.processRow(inn, id, {
        onRated: () => {
          rated++;
        },
        onNotRated: () => {
          notRated++;
        },
        onFail: () => {
          fail++;
        },
      });

      // advanceCursor = false means IP block → cursor stays, loop retries same INN
      if (advanceCursor) {
        processed++;
        lastId = id;
        await this.db.query(
          `UPDATE public.${this.CURSOR}
              SET last_id=$1, last_inn=$2, last_synced_at=now(), cycle_processed=$3, updated_at=now()
            WHERE id=1`,
          [id, inn, processed],
        );

        if (processed % 1000 === 0) {
          this.logger.log(
            `[chamber-fill] processed=${processed} rated=${rated} not_rated=${notRated} fail=${fail} last_id=${id}`,
          );
          await this.tg.send(
            `⏳ <b>chamber-fill progress</b>\n` +
              `Processed: <b>${processed}</b>\n` +
              `Rated: ${rated} · Not rated: ${notRated} · Fail: ${fail}\n` +
              `Last id: <code>${id}</code>`,
            { tag: 'chamber' },
          );
        }
      }
    }

    if (!this.isRunning && processed > 0) {
      await this.tg.send(
        `⏹ <b>chamber-fill stopped</b>\n` +
          `Processed: <b>${processed}</b>\n` +
          `Rated: ${rated} · Not rated: ${notRated} · Fail: ${fail}\n` +
          `Last id: <code>${lastId}</code>`,
        { tag: 'chamber' },
      );
    }
  }

  /**
   * Processes one INN. Returns true if cursor should advance, false if blocked.
   *
   * HTTP 200                → save trust/score, advance ✅
   * HTTP 500 (not rated)    → skip, advance ✅
   * Connection error (000)  → wait 3 min, do NOT advance ❌ (retry same INN)
   * Other errors (3 retries)→ log, advance ✅
   */
  private async processRow(
    inn: string,
    id: number,
    counters: {
      onRated: () => void;
      onNotRated: () => void;
      onFail: () => void;
    },
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= 3 && this.isRunning; attempt++) {
      try {
        const data = await this.chamber.getByInn(inn);
        if (data.trust !== null || data.score !== null) {
          await this.db.query(
            `UPDATE public.company_info SET trust=$1, score=$2, updated_at=now() WHERE inn=$3`,
            [data.trust, data.score, inn],
          );
          await recordRating(this.db, inn, this.logger);
          counters.onRated();
        } else {
          counters.onNotRated();
        }
        return true; // advance cursor
      } catch (err: any) {
        const status = err?.response?.status;

        // 500 = company not in chamber, not a real error
        if (status === 500) {
          counters.onNotRated();
          return true; // advance cursor
        }

        // No HTTP response = connection refused / IP block
        const isBlock = !status;
        if (isBlock) {
          this.logger.warn(
            `[chamber-fill] IP block detected on inn=${inn} id=${id} — pausing ${this.BLOCK_PAUSE_MS / 1000}s`,
          );
          await this.tg.send(
            `⚠️ <b>chamber-fill: IP block</b>\n` +
              `Pausing <b>3 min</b> then retrying inn=<code>${inn}</code>\n` +
              `(Block duration confirmed ~172s by test)`,
            { tag: 'chamber' },
          );
          await this.sleep(this.BLOCK_PAUSE_MS);
          return false; // do NOT advance cursor — retry same INN
        }

        // Other HTTP errors — retry with backoff
        this.logger.warn(
          `[chamber-fill] attempt ${attempt}/3 inn=${inn} status=${status}: ${err.message}`,
        );
        if (attempt < 3) await this.sleep(3000 * attempt);
      }
    }

    // All 3 attempts failed with non-block errors
    counters.onFail();
    return true; // advance cursor anyway — will be retried next cycle if trust still NULL
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private async resetCursor(): Promise<void> {
    await this.db.query(
      `UPDATE public.${this.CURSOR}
          SET last_id=0, cycle_processed=0, cycle_started_at=now(), updated_at=now()
        WHERE id=1`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
