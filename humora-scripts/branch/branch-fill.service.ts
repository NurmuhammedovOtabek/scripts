import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import axios from 'axios';
import { TelegramAlertService } from '../common/telegram-alert.service';
import {
  getMysoliqCredentials,
  missingMysoliqCredentialsMessage,
} from '../../common/mysoliq-credentials';
import { sourceDeletedFlag } from './branch-state';
import { parseSourceDay } from '../../common/tashkent-time';

// import soatoRaw from '../../../data/uz_ns_soato_final_v2.json';

// "ns10Code:ns11Code" → soato string (null if not mapped)
// const SOATO_MAP = new Map<string, string | null>();
// for (const region of soatoRaw) {
//   for (const d of region.districts) {
//     SOATO_MAP.set(`${region.ns10Code}:${d.ns11Code}`, d.soato ?? null);
//   }
// }

/**
 * Branch fill — fetches yur-branchs for every company in company_info
 * and upserts them into company_branches.
 *
 * 4 concurrent workers, each pinned to a specific proxy:
 *   worker 0, 2 → s0.rouming.uz
 *   worker 1, 3 → s1.rouming.uz
 *
 * Follows the bank-sync pattern:
 *   - BATCH_SIZE rows fetched from DB per iteration
 *   - concurrency pool drains the batch
 *   - cursor advances to highest contiguous success (bank-sync style)
 *   - retry pass for failed rows at end of batch
 */

const PROXIES = [
  'https://s0.rouming.uz/mysoliq/services',
  'https://s1.rouming.uz/mysoliq/services',
];
const CONCURRENCY = 4;
const BATCH_SIZE = 200;

@Injectable()
export class BranchFillService {
  private readonly logger = new Logger(BranchFillService.name);
  private readonly CURSOR = 'branch_fill_cursor';
  private isRunning = false;
  private isBackfilling = false;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly tg: TelegramAlertService,
  ) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  async start(
    opts: { resetCursor?: boolean } = {},
  ): Promise<Record<string, any>> {
    if (this.isRunning) return { status: 'already_running' };
    // Checked before the loop starts, not per row: without credentials every
    // one of the 200 rows in a batch would fail the same way, and the operator
    // who pressed start would read the reason in the thousandth log line
    // instead of in the response.
    if (!getMysoliqCredentials()) {
      return {
        status: 'not_configured',
        error: missingMysoliqCredentialsMessage(),
      };
    }
    if (opts.resetCursor) await this.resetCursor();

    this.isRunning = true;
    this.runLoop()
      .catch((err) => {
        this.logger.error(`[branch-fill] crashed: ${err.message}`);
        this.tg.send(
          `🚨 <b>branch-fill CRASHED</b>\nError: <code>${err.message}</code>`,
          { tag: 'branch_fill' },
        );
      })
      .finally(() => {
        this.isRunning = false;
      });

    return { status: 'started', cursor: await this.getCursor() };
  }

  stop(): { stopped: boolean } {
    if (!this.isRunning) return { stopped: false };
    this.isRunning = false;
    return { stopped: true };
  }

  async getCursor() {
    const r = await this.db.query(
      `SELECT * FROM public.${this.CURSOR} WHERE id = 1`,
    );
    return { ...r[0], is_running: this.isRunning };
  }

  // ── Loop ───────────────────────────────────────────────────────────────────

  private async runLoop(): Promise<void> {
    let totalProcessed = 0,
      totalOk = 0,
      totalFail = 0,
      totalBranches = 0;
    const driverStart = Date.now();

    const init = await this.db.query(
      `SELECT last_id, completed_cycles FROM public.${this.CURSOR} WHERE id = 1`,
    );
    const initLastId = Number(init[0]?.last_id) || 0;
    const cycle = (Number(init[0]?.completed_cycles) || 0) + 1;

    await this.tg.send(
      `▶️ <b>branch-fill started</b>\n` +
        `Cycle: <b>${cycle}</b> · From id: <code>${initLastId}</code>\n` +
        `Workers: <b>${CONCURRENCY}</b> · Batch: ${BATCH_SIZE}\n` +
        `Proxies: ${PROXIES.map(
          (p, i) => `w${i}→${p.includes('s0') ? 's0' : 's1'}`,
        )
          .slice(0, CONCURRENCY)
          .join(', ')}`,
      { tag: 'branch_fill' },
    );

    let stuckCount = 0;
    let lastSeenCursorId = initLastId;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!this.isRunning) {
        await this.tg.send(
          `⏹ <b>branch-fill stopped</b>\n` +
            `Processed: <b>${totalProcessed}</b> · ok=${totalOk} · fail=${totalFail}\n` +
            `Branches: ${totalBranches}`,
          { tag: 'branch_fill' },
        );
        return;
      }

      const result = await this.processOneBatch();
      totalProcessed += result.processed;
      totalOk += result.ok;
      totalFail += result.fail;
      totalBranches += result.branches;

      this.logger.log(
        `[branch-fill] batch done — proc=${result.processed} ok=${result.ok} fail=${result.fail} branches=${result.branches} last_id=${result.toId}`,
      );

      // Stuck detection: kursor 3 marta surilmasa, birinchi failed rowni skip qilib o'tamiz
      if (result.toId === lastSeenCursorId && !result.cycleComplete) {
        stuckCount++;
        this.logger.warn(
          `[branch-fill] cursor stuck at id=${result.toId} (${stuckCount}/3)`,
        );
        if (stuckCount >= 3) {
          const skipped = await this.forceAdvanceCursor(result.toId);
          if (skipped) {
            await this.tg.send(
              `⚠️ <b>branch-fill: cursor stuck</b>\n` +
                `Skipped permanently failing id=${result.toId}\n` +
                `Forced advance to id=${skipped}`,
              { tag: 'branch_fill' },
            );
            lastSeenCursorId = skipped;
          } else {
            // Hech narsa qolmagan — cycle complete
            this.logger.log(
              '[branch-fill] force-advance found no more rows, treating as cycle complete',
            );
            return;
          }
          stuckCount = 0;
        }
      } else {
        stuckCount = 0;
        lastSeenCursorId = result.toId;
      }

      if (result.cycleComplete) {
        const elapsed = ((Date.now() - driverStart) / 1000 / 3600).toFixed(2);
        await this.tg.send(
          `🏁 <b>branch-fill cycle complete</b>\n` +
            `Processed: <b>${totalProcessed}</b>\n` +
            `With branches: ${totalOk} · Fail: ${totalFail}\n` +
            `Total branches saved: <b>${totalBranches}</b>\n` +
            `Wall clock: ${elapsed}h`,
          { tag: 'branch_fill' },
        );
        return;
      }

      if (totalProcessed % (BATCH_SIZE * 20) === 0) {
        await this.tg.send(
          `⏳ <b>branch-fill progress</b>\n` +
            `Processed: <b>${totalProcessed}</b> · ok=${totalOk} · fail=${totalFail}\n` +
            `Branches: ${totalBranches}\n` +
            `Last id: <code>${result.toId}</code>`,
          { tag: 'branch_fill' },
        );
      }

      await this.sleep(200); // brief pause between batches
    }
  }

  /**
   * Processes one batch of BATCH_SIZE rows with a 4-worker concurrency pool.
   * Worker i uses proxy PROXIES[i % PROXIES.length] — load-balances across s0/s1.
   *
   * After the pool drains, walks rows ASC and advances the cursor to the
   * highest contiguous success/skip — same as bank-sync cursor placement.
   */
  private async processOneBatch(): Promise<{
    processed: number;
    ok: number;
    fail: number;
    branches: number;
    fromId: number;
    toId: number;
    cycleComplete: boolean;
  }> {
    const cursor = await this.db.query(
      `SELECT last_id, completed_cycles, cycle_processed
         FROM public.${this.CURSOR} WHERE id = 1`,
    );
    const lastId = Number(cursor[0]?.last_id) || 0;
    const cycleProc = Number(cursor[0]?.cycle_processed) || 0;

    const rows: { id: number; inn: string }[] = await this.db.query(
      `SELECT id, inn FROM public.company_info
        WHERE id > $1 AND inn IS NOT NULL
        ORDER BY id ASC
        LIMIT $2`,
      [lastId, BATCH_SIZE],
    );

    if (rows.length === 0) {
      await this.db.query(
        `UPDATE public.${this.CURSOR}
            SET last_id = 0, cycle_started_at = now(), cycle_processed = 0,
                completed_cycles = completed_cycles + 1, updated_at = now()
          WHERE id = 1`,
      );
      return {
        processed: 0,
        ok: 0,
        fail: 0,
        branches: 0,
        fromId: lastId,
        toId: lastId,
        cycleComplete: true,
      };
    }

    const fromId = lastId;
    const status = new Map<number, 'pending' | 'done' | 'fail'>();
    for (const r of rows) status.set(r.id, 'pending');

    let ok = 0,
      fail = 0,
      branches = 0,
      processed = 0;

    // ── Main pass: 4 workers ──────────────────────────────────────────────────
    const processRow = async (
      row: { id: number; inn: string },
      workerIdx: number,
    ) => {
      const proxyUrl = PROXIES[workerIdx % PROXIES.length];
      try {
        const data = await this.fetchBranches(row.inn, proxyUrl);
        if (data.length > 0) await this.saveBranches(row.inn, data);
        status.set(row.id, 'done');
        ok++;
        branches += data.length;
      } catch (err: any) {
        status.set(row.id, 'fail');
        fail++;
        this.logger.warn(
          `[branch-fill] inn=${row.inn} proxy=${proxyUrl.includes('s0') ? 's0' : 's1'}: ${err?.message}`,
        );
      }
    };

    let nextIdx = 0;
    const inFlight = new Set<Promise<void>>();
    const freeSlots = new Set<number>(
      Array.from({ length: CONCURRENCY }, (_, i) => i),
    );

    while ((nextIdx < rows.length && this.isRunning) || inFlight.size > 0) {
      while (nextIdx < rows.length && freeSlots.size > 0 && this.isRunning) {
        const row = rows[nextIdx++];
        const slot = freeSlots.values().next().value as number;
        freeSlots.delete(slot);
        const p = processRow(row, slot);
        inFlight.add(p);
        p.finally(() => {
          freeSlots.add(slot);
          inFlight.delete(p);
          processed++;
        });
      }
      if (inFlight.size > 0) await Promise.race(inFlight);
    }

    // ── Retry pass: failed rows, once more ───────────────────────────────────
    const failedRows = rows.filter((r) => status.get(r.id) === 'fail');
    if (failedRows.length > 0 && this.isRunning) {
      this.logger.log(`[branch-fill] retry pass — ${failedRows.length} rows`);
      for (const row of failedRows) {
        if (!this.isRunning) break;
        try {
          const proxyUrl = PROXIES[row.id % PROXIES.length];
          const data = await this.fetchBranches(row.inn, proxyUrl);
          if (data.length > 0) await this.saveBranches(row.inn, data);
          status.set(row.id, 'done');
          ok++;
          fail--;
          branches += data.length;
        } catch {
          // stays 'fail' — will retry next cycle
        }
      }
    }

    // ── Cursor placement (bank-sync style) ────────────────────────────────────
    let cursorId = lastId;
    let cursorInn: string | null = null;
    for (const r of rows) {
      const s = status.get(r.id);
      if (s !== 'done') break; // stop at first non-success
      cursorId = r.id;
      cursorInn = r.inn;
    }

    await this.db.query(
      `UPDATE public.${this.CURSOR}
          SET last_id        = $1,
              last_inn       = $2,
              last_synced_at = now(),
              cycle_processed= $3,
              total_ok       = total_ok + $4,
              total_fail     = total_fail + $5,
              updated_at     = now()
        WHERE id = 1`,
      [cursorId, cursorInn, cycleProc + processed, ok, fail],
    );

    return {
      processed,
      ok,
      fail,
      branches,
      fromId,
      toId: cursorId,
      cycleComplete: false,
    };
  }

  // ── Fetch from proxy ────────────────────────────────────────────────────────

  private async fetchBranches(tin: string, proxyUrl: string): Promise<any[]> {
    const auth = getMysoliqCredentials();
    if (!auth) throw new Error(missingMysoliqCredentialsMessage());

    const resp = await axios.get(`${proxyUrl}/yur-branchs/getdatabytin`, {
      params: { tin },
      auth,
      timeout: 15_000,
    });
    return Array.isArray(resp.data) ? resp.data : [];
  }

  // ── Save branches (transaction) ─────────────────────────────────────────────

  private async saveBranches(
    parentInn: string,
    branches: any[],
  ): Promise<void> {
    const qr = this.db.createQueryRunner();
    await qr.connect();
    await qr.startTransaction();
    try {
      // Remove legacy rows that predate branch_num column (one-time cleanup)
      await qr.query(
        `DELETE FROM public.company_branches WHERE parent_inn = $1 AND branch_num IS NULL`,
        [parentInn],
      );

      const returnedNums: string[] = [];

      for (const b of branches) {
        const ns10 = b.ns10Code != null ? Number(b.ns10Code) : null;
        const ns11 = b.ns11Code != null ? Number(b.ns11Code) : null;
        const soate_code = await qr.query(
          `select soato from public.ns_soato_map where ns10_code = $1 and ns11_code = $2`,
          [ns10, ns11],
        );
        const soato = soate_code[0]?.soato ?? null;
        const branchNum = b.branchNum ? String(b.branchNum) : null;

        if (branchNum) returnedNums.push(branchNum);

        await qr.query(
          `INSERT INTO public.company_branches
             (parent_inn, branch_tin, branch_num, branch_name,
              name, address, director,
              oked_code, ns10_code, ns11_code, soato_code,
              reg_date, status_code, status_name,
              is_deleted, created_date, deleted_date,
              mfo, account, director_pinfl, accountant_name, accountant_pinfl,
              created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::date,$13,$14,
                   COALESCE($22::smallint, 0),$15,$16,$17,$18,$19,$20,$21,now(),now())
           ON CONFLICT (parent_inn, branch_num) WHERE branch_num IS NOT NULL
           DO UPDATE SET
             branch_tin       = EXCLUDED.branch_tin,
             branch_name      = EXCLUDED.branch_name,
             name             = EXCLUDED.name,
             address          = EXCLUDED.address,
             director         = EXCLUDED.director,
             oked_code        = EXCLUDED.oked_code,
             ns10_code        = EXCLUDED.ns10_code,
             ns11_code        = EXCLUDED.ns11_code,
             soato_code       = EXCLUDED.soato_code,
             reg_date         = EXCLUDED.reg_date,
             status_code      = EXCLUDED.status_code,
             status_name      = EXCLUDED.status_name,
             -- The source's own flag; kept as stored when it does not say.
             is_deleted       = COALESCE($22::smallint, company_branches.is_deleted),
             created_date     = EXCLUDED.created_date,
             deleted_date     = EXCLUDED.deleted_date,
             mfo              = EXCLUDED.mfo,
             account          = EXCLUDED.account,
             director_pinfl   = EXCLUDED.director_pinfl,
             accountant_name  = EXCLUDED.accountant_name,
             accountant_pinfl = EXCLUDED.accountant_pinfl,
             updated_at       = now()`,
          [
            parentInn,
            b.tin || null,
            branchNum,
            b.branchName || null,
            b.name || null,
            b.address || null,
            b.directorName || b.director || null,
            b.oked || null,
            ns10,
            ns11,
            soato,
            // Day first (`18.02.2019`): as text, Postgres reads it month first.
            parseSourceDay(b.regDate),
            b.statusCode != null ? Number(b.statusCode) : null,
            b.statusName || null,
            b.createdDate || null,
            b.deletedDate || null,
            b.mfo || null,
            b.account || null,
            b.directorPinfl ? String(b.directorPinfl) : null,
            b.accountantName || null,
            b.accountantPinfl ? String(b.accountantPinfl) : null,
            sourceDeletedFlag(b),
          ],
        );
      }

      // Mark branches absent from this API response as inactive
      if (returnedNums.length > 0) {
        await qr.query(
          `UPDATE public.company_branches
              SET is_deleted = 1, updated_at = now()
            WHERE parent_inn = $1
              AND is_deleted = 0
              AND branch_num IS NOT NULL
              AND branch_num != ALL($2::varchar[])`,
          [parentInn, returnedNums],
        );
      }

      await qr.commitTransaction();
    } catch (err) {
      await qr.rollbackTransaction();
      throw err;
    } finally {
      await qr.release();
    }
  }

  // ── Soato backfill ──────────────────────────────────────────────────────────
  // Re-fetches branches for all INNs already in company_branches and updates
  // ns10_code, ns11_code, soato_code. Resumable via soato_last_inn in cursor.

  async startBackfillSoato(
    opts: { reset?: boolean } = {},
  ): Promise<Record<string, any>> {
    if (this.isBackfilling) return { status: 'already_running' };
    if (opts.reset) {
      await this.db.query(
        `UPDATE public.branch_fill_cursor
            SET soato_last_inn = NULL, soato_processed = 0, soato_completed = false
          WHERE id = 1`,
      );
    }
    this.isBackfilling = true;
    this.runSoatoBackfill()
      .catch((err) => {
        this.logger.error(`[soato-backfill] crashed: ${err.message}`);
        this.tg.send(
          `🚨 <b>soato-backfill CRASHED</b>\n<code>${err.message}</code>`,
          { tag: 'branch_fill' },
        );
      })
      .finally(() => {
        this.isBackfilling = false;
      });
    return { status: 'started' };
  }

  stopBackfillSoato(): { stopped: boolean } {
    if (!this.isBackfilling) return { stopped: false };
    this.isBackfilling = false;
    return { stopped: true };
  }

  async getBackfillSoatoStatus(): Promise<Record<string, any>> {
    const r = await this.db.query(
      `SELECT soato_last_inn, soato_processed, soato_completed FROM public.branch_fill_cursor WHERE id = 1`,
    );
    return { ...r[0], is_running: this.isBackfilling };
  }

  private async runSoatoBackfill(): Promise<void> {
    const BATCH = 500;
    let totalProcessed = 0;
    let totalOk = 0;
    let totalFail = 0;

    const cur = await this.db.query(
      `SELECT soato_last_inn, soato_processed FROM public.branch_fill_cursor WHERE id = 1`,
    );
    let lastInn: string = cur[0]?.soato_last_inn ?? '';
    totalProcessed = Number(cur[0]?.soato_processed) || 0;

    const [{ total }] = await this.db.query(
      `SELECT COUNT(DISTINCT parent_inn)::int AS total FROM public.company_branches`,
    );

    await this.tg.send(
      `▶️ <b>soato-backfill started</b>\n` +
        `Total unique INNs: <b>${total}</b>\n` +
        `Resume from: <code>${lastInn || 'beginning'}</code>`,
      { tag: 'branch_fill' },
    );

    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (!this.isBackfilling) {
        await this.tg.send(
          `⏹ <b>soato-backfill stopped</b>\nProcessed: <b>${totalProcessed}</b>`,
          { tag: 'branch_fill' },
        );
        return;
      }

      const inns: { parent_inn: string }[] = await this.db.query(
        `SELECT DISTINCT parent_inn FROM public.company_branches
          WHERE parent_inn > $1
          ORDER BY parent_inn ASC
          LIMIT $2`,
        [lastInn, BATCH],
      );

      if (inns.length === 0) {
        await this.db.query(
          `UPDATE public.branch_fill_cursor
              SET soato_completed = true, updated_at = now()
            WHERE id = 1`,
        );
        await this.tg.send(
          `🏁 <b>soato-backfill complete</b>\n` +
            `Total processed: <b>${totalProcessed}</b>\n` +
            `ok=${totalOk} · fail=${totalFail}`,
          { tag: 'branch_fill' },
        );
        return;
      }

      const status = new Map<string, 'pending' | 'done' | 'fail'>();
      for (const { parent_inn } of inns) status.set(parent_inn, 'pending');

      let nextIdx = 0;
      let processed = 0;
      const inFlight = new Set<Promise<void>>();
      const freeSlots = new Set<number>(
        Array.from({ length: CONCURRENCY }, (_, i) => i),
      );

      const processInn = async (inn: string, workerIdx: number) => {
        const proxyUrl = PROXIES[workerIdx % PROXIES.length];
        try {
          const data = await this.fetchBranches(inn, proxyUrl);
          if (data.length > 0) await this.saveBranches(inn, data);
          status.set(inn, 'done');
          totalOk++;
        } catch (err: any) {
          status.set(inn, 'fail');
          totalFail++;
          this.logger.warn(`[soato-backfill] inn=${inn}: ${err?.message}`);
        }
      };

      while (
        (nextIdx < inns.length && this.isBackfilling) ||
        inFlight.size > 0
      ) {
        while (
          nextIdx < inns.length &&
          freeSlots.size > 0 &&
          this.isBackfilling
        ) {
          const { parent_inn } = inns[nextIdx++];
          const slot = freeSlots.values().next().value as number;
          freeSlots.delete(slot);
          const p = processInn(parent_inn, slot);
          inFlight.add(p);
          p.finally(() => {
            freeSlots.add(slot);
            inFlight.delete(p);
            processed++;
          });
        }
        if (inFlight.size > 0) await Promise.race(inFlight);
      }

      // Advance cursor to highest contiguous success
      let newLastInn = lastInn;
      for (const { parent_inn } of inns) {
        if (status.get(parent_inn) !== 'done') break;
        newLastInn = parent_inn;
      }
      lastInn = newLastInn;
      totalProcessed += processed;

      await this.db.query(
        `UPDATE public.branch_fill_cursor
            SET soato_last_inn  = $1,
                soato_processed = $2,
                updated_at      = now()
          WHERE id = 1`,
        [lastInn, totalProcessed],
      );

      this.logger.log(
        `[soato-backfill] batch=${inns.length} ok=${totalOk} fail=${totalFail} total=${totalProcessed}/${total}`,
      );

      if (totalProcessed % (BATCH * 10) === 0 && totalProcessed > 0) {
        await this.tg.send(
          `⏳ <b>soato-backfill progress</b>\n` +
            `${totalProcessed}/${total} INNs · ok=${totalOk} fail=${totalFail}\n` +
            `Last: <code>${lastInn}</code>`,
          { tag: 'branch_fill' },
        );
      }

      await this.sleep(100);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** Stuck bo'lgan cursor ID dan keyingi mavjud rowga o'tkazadi. Yangi ID qaytaradi, yo'q bo'lsa null. */
  private async forceAdvanceCursor(stuckAtId: number): Promise<number | null> {
    const next = await this.db.query(
      `SELECT id FROM public.company_info
        WHERE id > $1 AND inn IS NOT NULL
        ORDER BY id ASC LIMIT 1`,
      [stuckAtId],
    );
    if (!next[0]) return null;
    const nextId = Number(next[0].id);
    await this.db.query(
      `UPDATE public.${this.CURSOR}
          SET last_id = $1, updated_at = now()
        WHERE id = 1`,
      [nextId - 1],
    );
    return nextId - 1;
  }

  private async resetCursor(): Promise<void> {
    await this.db.query(
      `UPDATE public.${this.CURSOR}
          SET last_id = 0, cycle_processed = 0,
              cycle_started_at = now(), updated_at = now()
        WHERE id = 1`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
