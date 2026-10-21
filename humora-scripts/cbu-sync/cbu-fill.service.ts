// src/scripts/cbu-sync/cbu-fill.service.ts
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import {
  CbuApiService,
  CbuCompanyData,
  CbuPerson,
  CbuAddress,
  CbuContact,
  isCbuCircuitOpenError,
} from './cbu-api.service';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { mapCbuToCompanyInfo } from './cbu-map.util';
import { persistCompanyAddresses } from './cbu-address.util';
import { companyLocationChanged } from '../../common/mahalla/company-location-events';
import { companyInfoValue } from '../../org/company-info-insert';
import { logFieldChanges, logRemoved } from '../../common/change-log';

/**
 * How long to idle when the CBU breaker is open, before retrying the same INN.
 * Tracks the breaker's own cooldown so we wake up roughly when it is ready to
 * probe again rather than hammering it or over-sleeping.
 */
const CBU_BREAKER_WAIT_MS = Number(
  process.env.CBU_BREAKER_COOLDOWN_MS ?? 60_000,
);

/** A founder row built from CBU data, with a natural key for diffing. */
interface DesiredFounder {
  key: string;
  founder_type: 'individual' | 'legal';
  person_uuid: string | null;
  founder_inn: string | null;
  founder_name: string | null;
  share_pct: number | null;
  share_sum: number | null;
  reg_country: string | null;
  individual_id: number | null;
}

/** A connection edge built from CBU data, keyed by `owner_id|role`. */
interface DesiredEdge {
  key: string;
  owner_id: string;
  owner_name: string | null;
  owner_type: 'person' | 'company';
  role: 'director' | 'founder';
  share_pct: number | null;
}

@Injectable()
export class CbuFillService {
  private readonly logger = new Logger(CbuFillService.name);
  private readonly CURSOR = 'cbu_sync_cursor';
  private isRunning = false;
  private rps = 2;
  // Per-run counters for our founder/connection graph ingest
  // (company_persons / company_founders / company_relations) — surfaced in
  // logs + Telegram alerts so we can confirm the graph code is actually writing.
  private graph = { companies: 0, persons: 0, founders: 0, edges: 0 };
  // Live progress of the residual backfill, exposed via the status endpoint so
  // it can be polled on demand (the bot only pushes every 1000 rows).
  private residual = {
    running: false,
    total: 0,
    processed: 0,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    fail: 0,
    startedAt: null as string | null,
    finishedAt: null as string | null,
    lastInn: null as string | null,
  };

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly api: CbuApiService,
    private readonly tg: TelegramAlertService,
    // Optional so the specs can build the service without a cache.
    @Optional() @Inject(CACHE_MANAGER) private readonly cache?: Cache,
  ) {}

  // ── Cron schedule ──────────────────────────────────────────────────────────

  @Cron('0 21 * * *', { timeZone: 'Asia/Tashkent' })
  async startNightly(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      this.logger.warn(
        `[cbu-sync] skipped — NODE_ENV="${process.env.NODE_ENV ?? 'undefined'}", only runs in production`,
      );
      return;
    }
    // Temporary kill-switch: set CBU_SYNC_DISABLED=true (env) to pause the
    // nightly full sync — e.g. while the residual backfill is running so the two
    // don't hit CBU at the same time. Flip the env var + restart to re-enable.
    if (this.syncDisabled()) {
      this.logger.warn(
        '[cbu-sync] nightly sync disabled via CBU_SYNC_DISABLED — skipping',
      );
      return;
    }
    this.logger.log('[cbu-sync] nightly cron triggered');
    await this.start();
  }

  private syncDisabled(): boolean {
    const v = (process.env.CBU_SYNC_DISABLED ?? '').toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }

  @Cron('0 6 * * *', { timeZone: 'Asia/Tashkent' })
  stopMorning(): void {
    this.logger.log('[cbu-sync] morning cron — stopping loop');
    this.stop();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async start(
    opts: { resetCursor?: boolean; rps?: number } = {},
  ): Promise<Record<string, any>> {
    if (this.isRunning) return { status: 'already_running' };
    if (opts.resetCursor) await this.resetCursor();
    if (opts.rps && opts.rps > 0) this.rps = opts.rps;
    this.isRunning = true;
    this.runLoop()
      .catch((err) => {
        this.logger.error(`[cbu-sync] crashed: ${err.message}`);
        this.tg.send(
          `🚨 <b>cbu-sync CRASHED</b>\nError: <code>${err.message}</code>`,
          { tag: 'cbu_sync' },
        );
      })
      .finally(() => {
        this.isRunning = false;
      });
    return { status: 'started', rps: this.rps, cursor: await this.getCursor() };
  }

  stop(): Record<string, any> {
    this.isRunning = false;
    return { stopped: true };
  }

  /**
   * One-off residual backfill: re-run the full per-company sync for companies
   * that ended up with NO rows in company_relations (the graph insert failed or
   * was skipped during an earlier run). The target set is computed live from the
   * DB at start (not a static file), so it's always current and safe to re-run —
   * companies that get fixed drop out of the query on the next run.
   *
   * Runs the EXACT same processRow() logic as the nightly sync. Shares the
   * `isRunning` guard, so it can't run at the same time as the nightly full sync
   * (pause that with CBU_SYNC_DISABLED while this runs). Not cursor-backed: it's
   * a bounded one-pass job over an in-memory snapshot.
   */
  async startResidual(
    opts: { rps?: number } = {},
  ): Promise<Record<string, any>> {
    if (this.isRunning) return { status: 'already_running' };
    if (opts.rps && opts.rps > 0) this.rps = opts.rps;
    this.isRunning = true;
    this.residualLoop()
      .catch((err) => {
        this.logger.error(`[cbu-sync] residual crashed: ${err.message}`);
        this.tg.send(
          `🚨 <b>cbu-sync RESIDUAL CRASHED</b>\nError: <code>${err.message}</code>`,
          { tag: 'cbu_sync' },
        );
      })
      .finally(() => {
        this.isRunning = false;
      });
    return { status: 'started', mode: 'residual', rps: this.rps };
  }

  async getCursor(): Promise<Record<string, any>> {
    const r = await this.db.query(
      `SELECT * FROM public.${this.CURSOR} WHERE id=1`,
    );
    return { ...r[0], is_running: this.isRunning };
  }

  /**
   * Reconciles one company's connection graph from a CBU payload the caller
   * already has, in its own transaction.
   *
   * The nightly cron is the only thing that ever wrote company_relations, and
   * it has not been running: every one of its 1,417,346 rows still carries
   * `updated_at = created_at`, all stamped between 18 June and 13 July. So a
   * company that changed director since keeps showing the old one on the
   * connections graph while its profile shows the new one — 137 companies were
   * in that state when this was added.
   *
   * The live company sync already calls the very same CBU endpoint
   * (`/integration/api/tax/company/info`) and already persists addresses off
   * that response, so the payload needed here costs nothing extra. Redis caches
   * the company profile for 30 minutes, which throttles this to at most one
   * reconcile per company per half hour.
   *
   * Same diff-reconcile as the batch, deletions included: a founder CBU no
   * longer reports is removed. That is the intent — the graph should mirror
   * CBU — but it does mean a partial payload would prune rows, exactly as it
   * would in the nightly run.
   */
  async syncGraphLive(inn: string, data: CbuCompanyData): Promise<void> {
    const touched = await this.db.transaction((m) =>
      this.syncGraph(m, inn, data),
    );
    await this.dropGraphCache(inn, touched);
  }

  /**
   * Drops the cached graph answers that a reconcile just made stale: the
   * company's own relations graph and, for every owner whose edge changed,
   * that owner's graph and connections list. Without this a company opened
   * for the first time stayed off its founder's "+" graph for the full 30
   * minutes of OrgService.TTL.CONNECTIONS.
   *
   * ponytail: depth is part of the key, so each id costs 10 deletes; graphs
   * of companies further up the chain that merely pass through this one are
   * left to expire. Move to a key-version per id if that ever matters.
   */
  private async dropGraphCache(inn: string, owners: string[]): Promise<void> {
    if (!this.cache || owners.length === 0) return;
    const keys: string[] = [];
    for (const id of [inn, ...owners]) {
      for (let d = 1; d <= 10; d++) keys.push(`org:relations:${id}:${d}`);
    }
    for (const o of owners) {
      keys.push(`org:connections:cbu:${o}`, `org:connections:${o}`);
    }
    try {
      await this.cache.mdel(keys);
    } catch (err) {
      this.logger.warn(
        `[cbu-graph] inn=${inn} cache drop failed: ${(err as Error).message}`,
      );
    }
  }

  // ── Loop ───────────────────────────────────────────────────────────────────

  private readonly RATE_LIMIT_PAUSE_MS = 60 * 1000; // 429 → pause 60s
  private readonly NETWORK_PAUSE_MS = 3 * 60 * 1000; // no response → pause 3 min

  private async runLoop(): Promise<void> {
    let processed = 0, // total rows fetched from company_info
      updated = 0, // rows where CBU data actually changed → DB written
      unchanged = 0, // rows where CBU returned data but nothing changed
      skipped = 0, // rows where CBU returned no data (404 / success=false)
      fail = 0; // rows that exhausted all retries
    this.graph = { companies: 0, persons: 0, founders: 0, edges: 0 };
    let consecutiveNetworkErrors = 0;
    const MAX_CONSECUTIVE_NETWORK_ERRORS = 5;

    const init = await this.db.query(
      `SELECT last_id, completed_cycles FROM public.${this.CURSOR} WHERE id=1`,
    );
    let lastId = Number(init[0]?.last_id) || 0;
    const cycle = (Number(init[0]?.completed_cycles) || 0) + 1;

    await this.tg.send(
      `▶️ <b>cbu-sync started</b>\n` +
        `Cycle: <b>${cycle}</b> · From id: <code>${lastId}</code> · RPS: ${this.rps}`,
      { tag: 'cbu_sync' },
    );

    while (this.isRunning) {
      const rows: { id: number; inn: string }[] = await this.db.query(
        `SELECT id, inn FROM public.company_info
          WHERE id > $1 AND inn IS NOT NULL
            AND (
              status IN ('0', 'ACTIVE', 'TAX_FREE', 'Faoliyat ko\`rsatayotgan', 'Действующие предприятия')
              OR status IS NULL
              OR status = ''
            )
          ORDER BY id ASC LIMIT 1`,
        [lastId],
      );

      if (rows.length === 0) {
        // Cycle complete — reset cursor for next run
        await this.db.query(
          `UPDATE public.${this.CURSOR}
              SET last_id=0, cycle_started_at=now(), cycle_processed=0,
                  completed_cycles=completed_cycles+1,
                  total_ok=total_ok+$1, total_fail=total_fail+$2, updated_at=now()
            WHERE id=1`,
          [updated, fail],
        );
        await this.tg.send(
          `🏁 <b>cbu-sync cycle complete</b>\n` +
            `Cycle: <b>${cycle}</b>\n` +
            `Processed: <b>${processed}</b> · Updated: ${updated} · Unchanged: ${unchanged} · Skipped: ${skipped} · Fail: ${fail}\n` +
            `📊 Graph: ${this.graph.companies} companies · ${this.graph.persons} persons · ${this.graph.founders} founders · ${this.graph.edges} edges`,
          { tag: 'cbu_sync' },
        );
        break;
      }

      const { id, inn } = rows[0];
      const advance = await this.processRow(inn, id, {
        onUpdated: () => {
          updated++;
          consecutiveNetworkErrors = 0;
        },
        onUnchanged: () => {
          unchanged++;
          consecutiveNetworkErrors = 0;
        },
        onSkipped: () => {
          skipped++;
          consecutiveNetworkErrors = 0;
        },
        onFail: () => fail++,
        onNetworkError: () => consecutiveNetworkErrors++,
      });

      // If API is completely unreachable, stop banging on it — abort the run
      if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
        this.logger.error(
          `[cbu-sync] ${MAX_CONSECUTIVE_NETWORK_ERRORS} consecutive network errors — API unreachable, stopping`,
        );
        await this.tg.send(
          `🚨 <b>cbu-sync: API unreachable</b>\n` +
            `${MAX_CONSECUTIVE_NETWORK_ERRORS} consecutive network errors on inn=<code>${inn}</code>\n` +
            `Stopping loop. Check if faktoring.cbu.uz is accessible from the server.`,
          { tag: 'cbu_sync' },
        );
        this.isRunning = false;
        break;
      }

      if (advance) {
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
            `[cbu-sync] processed=${processed} updated=${updated} unchanged=${unchanged} skipped=${skipped} fail=${fail} last_id=${id} | graph: ${this.graph.companies}c/${this.graph.persons}p/${this.graph.founders}f/${this.graph.edges}e`,
          );
          await this.tg.send(
            `⏳ <b>cbu-sync progress</b>\n` +
              `Processed: <b>${processed}</b> · Updated: ${updated} · Unchanged: ${unchanged} · Skipped: ${skipped} · Fail: ${fail}\n` +
              `📊 Graph: ${this.graph.companies} companies · ${this.graph.persons} persons · ${this.graph.founders} founders · ${this.graph.edges} edges\n` +
              `Last id: <code>${id}</code>`,
            { tag: 'cbu_sync' },
          );
        }

        // Rate control: sleep between requests based on rps setting
        await this.sleep(Math.floor(1000 / this.rps));
      }
    }

    if (!this.isRunning && processed > 0) {
      // Flush in-memory counters to DB so cursor reflects real stats on manual stop
      await this.db.query(
        `UPDATE public.${this.CURSOR}
            SET total_ok=total_ok+$1, total_fail=total_fail+$2, updated_at=now()
          WHERE id=1`,
        [updated, fail],
      );
      await this.tg.send(
        `⏹ <b>cbu-sync stopped</b>\n` +
          `Processed: <b>${processed}</b> · Updated: ${updated} · Unchanged: ${unchanged} · Skipped: ${skipped} · Fail: ${fail}\n` +
          `📊 Graph: ${this.graph.companies} companies · ${this.graph.persons} persons · ${this.graph.founders} founders · ${this.graph.edges} edges\n` +
          `Last id: <code>${lastId}</code>`,
        { tag: 'cbu_sync' },
      );
    }
  }

  // ── Residual backfill ───────────────────────────────────────────────────────

  // Companies still missing their connection graph: active (not liquidated) and
  // with no company_relations row. Recomputed live on each residual run.
  private readonly RESIDUAL_SQL = `
    SELECT ci.id, ci.inn
    FROM public.company_info ci
    WHERE ci.status NOT IN ('INACTIVE', 'Ликвидированные предприятия', 'LIQUIDATED')
      AND ci.inn IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM public.company_relations cr WHERE cr.owned_inn = ci.inn
      )
    ORDER BY ci.id ASC`;

  /**
   * Snapshot the missing-relations target set. The flottDb pool enforces a 5s
   * statement_timeout; this one-off anti-join over all of company_info needs
   * longer, so we lift the limit for just this query via a transaction-scoped
   * `SET LOCAL` (auto-resets on commit — the pool default is untouched for
   * everyone else).
   */
  private async loadResidualTargets(): Promise<{ id: number; inn: string }[]> {
    return this.db.transaction(async (m) => {
      await m.query(`SET LOCAL statement_timeout = 0`);
      return m.query(this.RESIDUAL_SQL);
    });
  }

  /** Snapshot of the residual backfill progress (polled via the status endpoint). */
  getResidualStatus(): Record<string, any> {
    return {
      ...this.residual,
      is_running: this.isRunning,
      remaining: Math.max(this.residual.total - this.residual.processed, 0),
      graph: this.graph,
    };
  }

  private async residualLoop(): Promise<void> {
    // Live counters live on this.residual so getResidualStatus() reflects the
    // run in real time (the bot only pushes every 1000 rows).
    const r = this.residual;
    r.running = true;
    r.total = 0;
    r.processed = 0;
    r.updated = 0;
    r.unchanged = 0;
    r.skipped = 0;
    r.fail = 0;
    r.startedAt = new Date().toISOString();
    r.finishedAt = null;
    r.lastInn = null;
    this.graph = { companies: 0, persons: 0, founders: 0, edges: 0 };
    let consecutiveNetworkErrors = 0;
    const MAX_CONSECUTIVE_NETWORK_ERRORS = 5;

    try {
      const targets = await this.loadResidualTargets();
      r.total = targets.length;

      this.logger.log(
        `[cbu-sync] residual backfill: ${targets.length} targets`,
      );
      await this.tg.send(
        `▶️ <b>cbu-sync RESIDUAL backfill started</b>\n` +
          `Targets: <b>${targets.length}</b> companies missing company_relations · RPS: ${this.rps}`,
        { tag: 'cbu_sync' },
      );

      let i = 0;
      while (this.isRunning && i < targets.length) {
        const { id, inn } = targets[i];
        const advance = await this.processRow(inn, id, {
          onUpdated: () => {
            r.updated++;
            consecutiveNetworkErrors = 0;
          },
          onUnchanged: () => {
            r.unchanged++;
            consecutiveNetworkErrors = 0;
          },
          onSkipped: () => {
            r.skipped++;
            consecutiveNetworkErrors = 0;
          },
          onFail: () => r.fail++,
          onNetworkError: () => consecutiveNetworkErrors++,
        });

        if (consecutiveNetworkErrors >= MAX_CONSECUTIVE_NETWORK_ERRORS) {
          this.logger.error(
            `[cbu-sync] residual: ${MAX_CONSECUTIVE_NETWORK_ERRORS} consecutive network errors — API unreachable, stopping`,
          );
          await this.tg.send(
            `🚨 <b>cbu-sync RESIDUAL: API unreachable</b>\n` +
              `${MAX_CONSECUTIVE_NETWORK_ERRORS} consecutive network errors on inn=<code>${inn}</code>. Stopping.`,
            { tag: 'cbu_sync' },
          );
          this.isRunning = false;
          break;
        }

        if (advance) {
          r.processed++;
          r.lastInn = inn;
          i++;
          if (r.processed % 1000 === 0) {
            this.logger.log(
              `[cbu-sync] residual processed=${r.processed}/${targets.length} updated=${r.updated} unchanged=${r.unchanged} skipped=${r.skipped} fail=${r.fail} | graph: ${this.graph.companies}c/${this.graph.persons}p/${this.graph.founders}f/${this.graph.edges}e`,
            );
            await this.tg.send(
              `⏳ <b>cbu-sync RESIDUAL progress</b>\n` +
                `Processed: <b>${r.processed}/${targets.length}</b> · Updated: ${r.updated} · Unchanged: ${r.unchanged} · Skipped: ${r.skipped} · Fail: ${r.fail}\n` +
                `📊 Graph: ${this.graph.companies} companies · ${this.graph.persons} persons · ${this.graph.founders} founders · ${this.graph.edges} edges`,
              { tag: 'cbu_sync' },
            );
          }
          await this.sleep(Math.floor(1000 / this.rps));
        }
        // advance === false → 429 / network pause already happened; retry same i.
      }

      const done = i >= targets.length;
      await this.tg.send(
        `${done ? '🏁' : '⏹'} <b>cbu-sync RESIDUAL ${done ? 'complete' : 'stopped'}</b>\n` +
          `Processed: <b>${r.processed}/${targets.length}</b> · Updated: ${r.updated} · Unchanged: ${r.unchanged} · Skipped: ${r.skipped} · Fail: ${r.fail}\n` +
          `📊 Graph: ${this.graph.companies} companies · ${this.graph.persons} persons · ${this.graph.founders} founders · ${this.graph.edges} edges`,
        { tag: 'cbu_sync' },
      );
    } finally {
      r.running = false;
      r.finishedAt = new Date().toISOString();
    }
  }

  /**
   * Process one INN. Returns true to advance cursor, false to retry same INN.
   *
   * 200        → update company_info, advance ✅
   * 404        → company not in CBU, skip, advance ✅
   * 429        → rate limited, pause 60s, do NOT advance ❌
   * 500        → retry 3x (1s/2s/3s backoff); if all fail → log, advance ✅
   * no response→ pause 3 min, do NOT advance ❌
   */
  private async processRow(
    inn: string,
    id: number,
    counters: {
      onUpdated: () => void;
      onUnchanged: () => void;
      onSkipped: () => void;
      onFail: () => void;
      onNetworkError: () => void;
    },
  ): Promise<boolean> {
    // Last HTTP failure seen across attempts, recorded if all retries are spent.
    let lastStatus: number | null = null;
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= 3 && this.isRunning; attempt++) {
      try {
        const res = await this.api.getCompanyInfo(inn);

        if (!res.success || !res.data) {
          // Visible (not debug): "CBU has no record" is a primary reason a
          // company ends up with no company_relations — must show in the logs.
          this.logger.log(
            `[cbu-sync] inn=${inn} SKIPPED — CBU returned no data (success=${res.success}), nothing to persist`,
          );
          counters.onSkipped();
          await this.recordFailedFetch(
            inn,
            200,
            res.error?.message ?? res.error?.cause ?? 'success=false / no data',
          );
          return true;
        }

        const data = res.data;
        try {
          let touched: string[] = [];
          await this.db.transaction(async (m) => {
            // 1) Flat company_info update — IS DISTINCT FROM only writes rows
            // where at least one field actually differs from the stored value.
            const changes = this.mapFields(data);
            let companyChanged = false;
            let changedFields = '';
            if (Object.keys(changes).length > 0) {
              const fields = Object.keys(changes);
              const setClauses = fields
                .map((f, i) => `${f} = $${i + 1}`)
                .join(', ');
              const distinctChecks = fields
                .map((f, i) => `${f} IS DISTINCT FROM $${i + 1}`)
                .join(' OR ');
              const values = fields.map((f) => companyInfoValue(f, changes[f]));
              values.push(inn);
              const result = await m.query(
                `UPDATE public.company_info
                    SET ${setClauses}, updated_at = now()
                  WHERE inn = $${values.length}
                    AND (${distinctChecks})`,
                values,
              );
              companyChanged = result.rowCount > 0;
              changedFields = fields.join(', ');
            }

            // 2) Founder / director connection graph (diff-reconcile).
            touched = await this.syncGraph(m, inn, data);

            // 3) Billing + shipping addresses.
            await this.syncAddresses(m, inn, data);

            // 4) Leftover CBU fields with no dedicated column → raw archive.
            await this.saveRaw(m, inn, data);

            if (companyChanged) {
              this.logger.debug(
                `[cbu-sync] inn=${inn} updated fields: ${changedFields}`,
              );
              counters.onUpdated();
            } else {
              this.logger.debug(`[cbu-sync] inn=${inn} company_info unchanged`);
              counters.onUnchanged();
            }
          });
          // Committed: the billing address was rewritten, so the company's
          // mahalla (company_mahalla) is resolved again.
          companyLocationChanged(inn);
          await this.dropGraphCache(inn, touched);
        } catch (dbErr: any) {
          // DB-side failure (not a CBU API error): log + advance so the batch
          // isn't blocked. The transaction rolls back; retried next cycle.
          // Log the FULL Postgres error so the root cause is visible in the
          // logs — e.g. "value too long for type character varying(8)" (a
          // varchar overflow) or "duplicate key value violates unique
          // constraint uq_company_relations_edge" (a duplicate edge). The whole
          // graph for this company was rolled back, so it stays out of
          // company_relations until the underlying cause is fixed.
          this.logger.error(
            `[cbu-sync] persist FAILED inn=${inn} — transaction rolled back, ` +
              `company_relations NOT written. ` +
              `message="${dbErr?.message}" code="${dbErr?.code ?? ''}" ` +
              `detail="${dbErr?.detail ?? ''}" constraint="${dbErr?.constraint ?? ''}" ` +
              `column="${dbErr?.column ?? ''}" table="${dbErr?.table ?? ''}"`,
          );
          counters.onFail();
          await this.recordFailedFetch(
            inn,
            200,
            `persist failed: ${dbErr?.message ?? 'unknown'}`,
          );
          return true;
        }

        return true;
      } catch (err: any) {
        const status = err?.response?.status;

        // Short-circuited by the CBU breaker: nothing was sent, so this is not
        // a network error and must not be reported as one. Falling through to
        // the `!status` branch below would fire a Telegram alert and a 3-minute
        // pause for every skipped call — roughly 140 alerts across an outage
        // like 2026-08-04's. Wait out the breaker cooldown quietly instead and
        // retry the same INN; the breaker's own probe decides when CBU is back.
        if (isCbuCircuitOpenError(err)) {
          this.logger.warn(
            `[cbu-sync] inn=${inn} — CBU breaker open, waiting ${CBU_BREAKER_WAIT_MS / 1000}s before retrying`,
          );
          await this.sleep(CBU_BREAKER_WAIT_MS);
          return false; // retry same INN, no attempt consumed
        }

        if (status === 404) {
          this.logger.log(
            `[cbu-sync] inn=${inn} CBU returned 404 — not in the CBU registry, nothing to persist (skipped)`,
          );
          counters.onSkipped();
          await this.recordFailedFetch(inn, 404, err?.message ?? 'not found');
          return true;
        }

        if (status === 429) {
          this.logger.warn(
            `[cbu-sync] 429 rate-limited on inn=${inn} — pausing ${this.RATE_LIMIT_PAUSE_MS / 1000}s`,
          );
          await this.tg.send(
            `⚠️ <b>cbu-sync: 429 rate limit</b>\nPausing 60s, retrying inn=<code>${inn}</code>`,
            { tag: 'cbu_sync' },
          );
          await this.sleep(this.RATE_LIMIT_PAUSE_MS);
          return false; // retry same INN
        }

        // No HTTP response = network/connection error
        if (!status) {
          counters.onNetworkError();
          this.logger.warn(
            `[cbu-sync] network error on inn=${inn} id=${id} — pausing ${this.NETWORK_PAUSE_MS / 1000}s`,
          );
          await this.tg.send(
            `⚠️ <b>cbu-sync: network error</b>\nPausing 3 min, retrying inn=<code>${inn}</code>`,
            { tag: 'cbu_sync' },
          );
          await this.sleep(this.NETWORK_PAUSE_MS);
          return false; // retry same INN
        }

        // 500 or other HTTP errors — retry with backoff
        lastStatus = status;
        lastError = err?.message ?? null;
        this.logger.warn(
          `[cbu-sync] attempt ${attempt}/3 inn=${inn} status=${status}: ${err.message}`,
        );
        if (attempt < 3) await this.sleep(1000 * attempt);
      }
    }

    // All 3 attempts exhausted
    this.logger.warn(
      `[cbu-sync] inn=${inn} failed after 3 attempts — skipping, will retry next cycle`,
    );
    counters.onFail();
    await this.recordFailedFetch(inn, lastStatus, lastError);
    return true; // advance cursor — will retry naturally next cycle
  }

  // ── Field mapping ──────────────────────────────────────────────────────────

  private mapFields(data: CbuCompanyData): Record<string, any> {
    // Shared with the live syncCompanyInfo path — see cbu-map.util.ts.
    return mapCbuToCompanyInfo(data);
  }

  // ── CBU graph ingest (company_persons / company_founders / company_relations) ──

  /**
   * Build the desired founders + connection edges from the CBU payload, then
   * diff-reconcile them against the DB for this company. Runs inside the caller's
   * transaction (`m`).
   */
  /** Resolves to the owner ids whose edges were inserted, changed or removed. */
  private async syncGraph(
    m: EntityManager,
    inn: string,
    data: CbuCompanyData,
  ): Promise<string[]> {
    const companyName = data.company?.name ?? null;
    const desiredFounders: DesiredFounder[] = [];
    const desiredEdges: DesiredEdge[] = [];
    let personsUpserted = 0;
    // Diagnostic counters — every graph-building outcome is tallied here and
    // dumped in one SUMMARY line per company below, so a company that ends up
    // with no company_relations rows can be explained straight from the logs.
    const g = {
      directorPresent: !!data.director,
      directorPinfl: !!data.director?.pinfl,
      directorEdged: false,
      foundersSeen: (data.founders ?? []).length,
      indQueued: 0,
      indSkippedNoPinfl: 0,
      indSkippedNoUuid: 0,
      legalQueued: 0,
      legalSkippedNoTin: 0,
      founderUnknownSkipped: 0,
      accountantPinfl: !!data.accountant?.pinfl,
    };

    // Director — edge only (not a founder row).
    if (data.director?.pinfl) {
      const uuid = await this.upsertPerson(
        m,
        data.director,
        data.directorContact,
        data.directorAddress,
      );
      if (uuid) {
        personsUpserted++;
        desiredEdges.push({
          key: `${uuid}|director`,
          owner_id: uuid,
          owner_type: 'person',
          owner_name: this.joinName(
            data.director.lastName,
            data.director.firstName,
            data.director.middleName,
          ),
          role: 'director',
          share_pct: null,
        });
        g.directorEdged = true;
        this.logger.log(
          `[cbu-graph] inn=${inn} director edge queued — pinfl=${data.director.pinfl} uuid=${uuid}`,
        );
      } else {
        this.logger.warn(
          `[cbu-graph] inn=${inn} director has pinfl=${data.director.pinfl} but upsertPerson returned NO uuid — director edge skipped`,
        );
      }
    } else if (data.director) {
      this.logger.warn(
        `[cbu-graph] inn=${inn} director SKIPPED — CBU returned a director name but NO pinfl (name="${this.joinName(
          data.director.lastName,
          data.director.firstName,
          data.director.middleName,
        )}")`,
      );
    } else {
      this.logger.warn(
        `[cbu-graph] inn=${inn} no director object in the CBU response`,
      );
    }

    // Founders — individual (person) or legal (company).
    for (const f of data.founders ?? []) {
      if (f.founderIndividual) {
        const fi = f.founderIndividual;
        // skip individuals without PINFL for now (~1%)
        if (!fi.pinfl) {
          g.indSkippedNoPinfl++;
          this.logger.warn(
            `[cbu-graph] inn=${inn} founder(individual) SKIPPED — no pinfl (name="${this.joinName(
              fi.lastName,
              fi.firstName,
              fi.middleName,
            )}")`,
          );
          continue;
        }
        const uuid = await this.upsertPerson(
          m,
          fi,
          f.founderContact,
          f.founderAddress,
        );
        if (!uuid) {
          g.indSkippedNoUuid++;
          this.logger.warn(
            `[cbu-graph] inn=${inn} founder(individual) SKIPPED — upsertPerson returned no uuid (pinfl=${fi.pinfl})`,
          );
          continue;
        }
        personsUpserted++;
        g.indQueued++;
        const name = this.joinName(fi.lastName, fi.firstName, fi.middleName);
        desiredFounders.push({
          key: `p:${uuid}`,
          founder_type: 'individual',
          person_uuid: uuid,
          founder_inn: null,
          // Denormalized copy of the person's name for read-without-join.
          // Source of truth stays company_persons.full_name.
          founder_name: name,
          share_pct: fi.founderSharePercent ?? null,
          share_sum: fi.founderShareSum ?? null,
          reg_country: fi.countryCode ?? null,
          individual_id: fi.individualId ?? null,
        });
        desiredEdges.push({
          key: `${uuid}|founder`,
          owner_id: uuid,
          owner_type: 'person',
          owner_name: name,
          role: 'founder',
          share_pct: fi.founderSharePercent ?? null,
        });
      } else if (f.founderLegal?.tin) {
        g.legalQueued++;
        const fl = f.founderLegal;
        desiredFounders.push({
          key: `l:${fl.tin}`,
          founder_type: 'legal',
          person_uuid: null,
          founder_inn: fl.tin,
          founder_name: fl.name ?? null,
          share_pct: fl.founderSharePercent ?? null,
          share_sum: fl.founderShareSum ?? null,
          reg_country:
            fl.regCountry != null
              ? String(fl.regCountry)
              : (fl.countryCode ?? null),
          individual_id: null,
        });
        desiredEdges.push({
          key: `${fl.tin}|founder`,
          owner_id: fl.tin,
          owner_type: 'company',
          owner_name: fl.name ?? null,
          role: 'founder',
          share_pct: fl.founderSharePercent ?? null,
        });
      } else if (f.founderLegal) {
        g.legalSkippedNoTin++;
        this.logger.warn(
          `[cbu-graph] inn=${inn} founder(legal) SKIPPED — no tin (name="${f.founderLegal.name ?? ''}")`,
        );
      } else {
        g.founderUnknownSkipped++;
        this.logger.warn(
          `[cbu-graph] inn=${inn} founder SKIPPED — entry has neither founderIndividual nor founderLegal`,
        );
      }
    }

    // Accountant — store as a person (full PII). Not an ownership edge, so it
    // stays out of company_relations; the link lives on company_info.accountant_pinfl
    // (written via mapFields). See docs/CBU.md.
    if (data.accountant?.pinfl) {
      const acc = await this.upsertPerson(
        m,
        data.accountant,
        data.accountantContact,
        data.accountantAddress,
      );
      if (acc) personsUpserted++;
    } else if (data.accountant) {
      this.logger.log(
        `[cbu-graph] inn=${inn} accountant present but no pinfl — not stored (accountant is never a relations edge anyway)`,
      );
    }

    // Dedupe by natural key before persisting. CBU sometimes lists the same
    // owner twice (same PINFL / legal TIN with the same role), which would make
    // reconcileEdges INSERT the same (owned_inn, owner_id, role) twice and trip
    // the uq_company_relations_edge unique constraint — rolling back the whole
    // company. Keep the first occurrence.
    const founders = this.dedupeByKey(desiredFounders);
    const edges = this.dedupeByKey(desiredEdges);

    // A payload that yields nothing at all is almost always a partial CBU
    // answer, not a company that genuinely lost its director and every founder.
    // Reconciling it would delete every row we hold. syncAddresses already
    // refuses to wipe to empty for the same reason; this does the same, and it
    // matters more now that the live company sync runs this on every profile
    // view rather than once a night. Filling an empty company is still allowed
    // — only clearing a populated one is refused.
    if (founders.length === 0 && edges.length === 0) {
      const [held] = await m.query(
        `SELECT (EXISTS (SELECT 1 FROM public.company_relations WHERE owned_inn = $1)
              OR EXISTS (SELECT 1 FROM public.company_founders  WHERE owned_inn = $1)) AS any_rows`,
        [inn],
      );
      if (held?.any_rows) {
        this.logger.warn(
          `[cbu-graph] inn=${inn} CBU returned no director and no founders — ` +
            'keeping the stored graph rather than wiping it',
        );
        return [];
      }
    }

    await this.reconcileFounders(m, inn, founders);
    const touched = await this.reconcileEdges(m, inn, companyName, edges);

    // One SUMMARY line per company covering every graph-building outcome.
    // Counts reflect the DEDUPED sets actually persisted.
    this.logger.log(
      `[cbu-graph] inn=${inn} SUMMARY ` +
        `director(present=${g.directorPresent},pinfl=${g.directorPinfl},edged=${g.directorEdged}) ` +
        `founders(seen=${g.foundersSeen},indQueued=${g.indQueued},indSkipNoPinfl=${g.indSkippedNoPinfl},` +
        `indSkipNoUuid=${g.indSkippedNoUuid},legalQueued=${g.legalQueued},legalSkipNoTin=${g.legalSkippedNoTin},` +
        `unknown=${g.founderUnknownSkipped}) accountantPinfl=${g.accountantPinfl} ` +
        `=> founders_persisted=${founders.length} edges_persisted=${edges.length}`,
    );

    // The key diagnostic: CBU returned data but NO graph edge was produced, so
    // this company stays missing from company_relations. Logged as a warning
    // with the exact reason so it can be grepped after a run.
    if (edges.length === 0) {
      this.logger.warn(
        `[cbu-graph] inn=${inn} ZERO EDGES — company will remain missing from ` +
          `company_relations. Reason: director pinfl=${g.directorPinfl}, ` +
          `founders seen=${g.foundersSeen} (individuals skipped no-pinfl=${g.indSkippedNoPinfl}, ` +
          `individuals skipped no-uuid=${g.indSkippedNoUuid}, legal skipped no-tin=${g.legalSkippedNoTin}, ` +
          `unknown=${g.founderUnknownSkipped}).`,
      );
    } else {
      this.graph.companies += 1;
      this.graph.persons += personsUpserted;
      this.graph.founders += founders.length;
      this.graph.edges += edges.length;
    }
    return touched;
  }

  /** Keep the first item per `key`, dropping later duplicates. */
  private dedupeByKey<T extends { key: string }>(items: T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const it of items) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      out.push(it);
    }
    return out;
  }

  /**
   * Upsert a person by PINFL (the natural key). The UUID is generated once on
   * first insert and preserved on conflict, so a person's UUID never changes.
   * Returns the UUID, or null if there's no PINFL.
   */
  private async upsertPerson(
    m: EntityManager,
    p: CbuPerson,
    contact: CbuContact | null,
    address: CbuAddress | null,
  ): Promise<string | null> {
    if (!p?.pinfl) return null;
    const hasAddress = address && Object.values(address).some((v) => v != null);
    const rows = await m.query(
      `INSERT INTO public.company_persons
         (pinfl, tin, full_name, last_name, first_name, middle_name, birth_date,
          gender, nationality, citizenship, passport_series, passport_number,
          phone, address, email, country_code, address_detail, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
       ON CONFLICT (pinfl) DO UPDATE SET
         tin             = COALESCE(EXCLUDED.tin,             company_persons.tin),
         full_name       = COALESCE(EXCLUDED.full_name,       company_persons.full_name),
         last_name       = COALESCE(EXCLUDED.last_name,       company_persons.last_name),
         first_name      = COALESCE(EXCLUDED.first_name,      company_persons.first_name),
         middle_name     = COALESCE(EXCLUDED.middle_name,     company_persons.middle_name),
         birth_date      = COALESCE(EXCLUDED.birth_date,      company_persons.birth_date),
         gender          = COALESCE(EXCLUDED.gender,          company_persons.gender),
         nationality     = COALESCE(EXCLUDED.nationality,     company_persons.nationality),
         citizenship     = COALESCE(EXCLUDED.citizenship,     company_persons.citizenship),
         passport_series = COALESCE(EXCLUDED.passport_series, company_persons.passport_series),
         passport_number = COALESCE(EXCLUDED.passport_number, company_persons.passport_number),
         phone           = COALESCE(EXCLUDED.phone,           company_persons.phone),
         address         = COALESCE(EXCLUDED.address,         company_persons.address),
         email           = COALESCE(EXCLUDED.email,           company_persons.email),
         country_code    = COALESCE(EXCLUDED.country_code,    company_persons.country_code),
         address_detail  = COALESCE(EXCLUDED.address_detail,  company_persons.address_detail),
         updated_at      = now()
       RETURNING uuid`,
      [
        p.pinfl,
        p.tin ?? null,
        this.joinName(p.lastName, p.firstName, p.middleName),
        p.lastName ?? null,
        p.firstName ?? null,
        p.middleName ?? null,
        this.parseDate(p.birthDate),
        p.gender ?? null,
        p.nationality ?? null,
        p.citizenship ?? null,
        p.passportSeries ?? null,
        p.passportNumber ?? null,
        contact?.phone ?? null,
        address?.streetName ?? null,
        contact?.email ?? null,
        p.countryCode ?? null,
        hasAddress ? JSON.stringify(address) : null,
      ],
    );
    return rows[0]?.uuid ?? null;
  }

  /** Diff-reconcile company_founders for one company against the CBU desired set. */
  private async reconcileFounders(
    m: EntityManager,
    inn: string,
    desired: DesiredFounder[],
  ): Promise<void> {
    const current: any[] = await m.query(
      `SELECT * FROM public.company_founders WHERE owned_inn = $1 AND source = 'cbu'`,
      [inn],
    );
    const curByKey = new Map<string, any>();
    for (const r of current) {
      curByKey.set(
        r.person_uuid ? `p:${r.person_uuid}` : `l:${r.founder_inn}`,
        r,
      );
    }
    const seen = new Set<string>();
    for (const d of desired) {
      seen.add(d.key);
      const ex = curByKey.get(d.key);
      if (!ex) {
        await m.query(
          `INSERT INTO public.company_founders
             (owned_inn, founder_type, person_uuid, founder_inn, founder_name,
              share_pct, share_sum, reg_country, individual_id, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'cbu')`,
          [
            inn,
            d.founder_type,
            d.person_uuid,
            d.founder_inn,
            d.founder_name,
            d.share_pct,
            d.share_sum,
            d.reg_country,
            d.individual_id,
          ],
        );
      } else if (
        !this.sameNum(ex.share_pct, d.share_pct, 4) ||
        !this.sameNum(ex.share_sum, d.share_sum, 2) ||
        (ex.founder_name ?? null) !== (d.founder_name ?? null)
      ) {
        // The share or name it replaces is kept (common/change-log.ts).
        await logFieldChanges(
          m,
          { entity: 'company_founders', inn, key: d.key, source: 'cbu' },
          ex,
          {
            share_pct: d.share_pct,
            share_sum: d.share_sum,
            founder_name: d.founder_name,
          },
          ['share_pct', 'share_sum', 'founder_name'],
        );
        await m.query(
          `UPDATE public.company_founders
           SET share_pct=$1, share_sum=$2, founder_name=$3, reg_country=$4,
               individual_id=$5, updated_at=now()
           WHERE id=$6`,
          [
            d.share_pct,
            d.share_sum,
            d.founder_name,
            d.reg_country,
            d.individual_id,
            ex.id,
          ],
        );
      }
    }
    for (const r of current) {
      const key = r.person_uuid ? `p:${r.person_uuid}` : `l:${r.founder_inn}`;
      if (!seen.has(key)) {
        // A founder CBU no longer lists leaves the table, but not the record.
        await logRemoved(
          m,
          { entity: 'company_founders', inn, key, source: 'cbu' },
          r,
        );
        await m.query(`DELETE FROM public.company_founders WHERE id=$1`, [
          r.id,
        ]);
      }
    }
  }

  /**
   * Diff-reconcile company_relations edges for one company against the CBU
   * desired set: INSERT new edges, UPDATE changed ones, DELETE departed ones.
   */
  private async reconcileEdges(
    m: EntityManager,
    inn: string,
    companyName: string | null,
    desired: DesiredEdge[],
  ): Promise<string[]> {
    const touched = new Set<string>();
    const current: any[] = await m.query(
      `SELECT * FROM public.company_relations WHERE owned_inn = $1`,
      [inn],
    );
    const curByKey = new Map<string, any>();
    for (const r of current) curByKey.set(`${r.owner_id}|${r.role}`, r);
    const seen = new Set<string>();
    for (const d of desired) {
      seen.add(d.key);
      const ex = curByKey.get(d.key);
      if (!ex) {
        touched.add(d.owner_id);
        await m.query(
          `INSERT INTO public.company_relations
             (owned_inn, owner_id, owner_type, owner_name, owned_name,
              role, share_pct, source)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'cbu')`,
          [
            inn,
            d.owner_id,
            d.owner_type,
            d.owner_name,
            companyName,
            d.role,
            d.share_pct,
          ],
        );
      } else if (
        !this.sameNum(ex.share_pct, d.share_pct, 4) ||
        (ex.owner_name ?? null) !== (d.owner_name ?? null)
      ) {
        touched.add(d.owner_id);
        await logFieldChanges(
          m,
          {
            entity: 'company_relations',
            inn,
            key: `${ex.owner_id}|${ex.role}`,
            source: 'cbu',
          },
          ex,
          { owner_name: d.owner_name, share_pct: d.share_pct },
          ['owner_name', 'share_pct'],
        );
        await m.query(
          `UPDATE public.company_relations
           SET owner_name=$1, owner_type=$2, owned_name=$3, share_pct=$4,
               updated_at=now()
           WHERE id=$5`,
          [d.owner_name, d.owner_type, companyName, d.share_pct, ex.id],
        );
      }
    }
    for (const r of current) {
      if (!seen.has(`${r.owner_id}|${r.role}`)) {
        touched.add(r.owner_id);
        // A former director or founder edge is kept as it was.
        await logRemoved(
          m,
          {
            entity: 'company_relations',
            inn,
            key: `${r.owner_id}|${r.role}`,
            source: 'cbu',
          },
          r,
        );
        await m.query(`DELETE FROM public.company_relations WHERE id=$1`, [
          r.id,
        ]);
      }
    }
    return [...touched];
  }

  /**
   * Replace the company's billing + shipping addresses (CBU source) with the
   * current CBU set. Delete + reinsert is used rather than diffing because the
   * shipping list has no stable natural key and can be large (30+ rows).
   * Skipped entirely when CBU returns no address data, so we never wipe to empty.
   */
  private async syncAddresses(
    m: EntityManager,
    inn: string,
    data: CbuCompanyData,
  ): Promise<void> {
    // Shared with the live search path (OrgService) — see cbu-address.util.
    await persistCompanyAddresses(m, inn, data);
  }

  /**
   * Persist two things for a company, one row overwritten each sync:
   *   - `payload`      — curated leftover CBU fields that have no dedicated
   *     column (see docs/CBU.md). companyBranches, person addresses and
   *     founderLegal extras are excluded (already stored elsewhere).
   *   - `raw_response` — the COMPLETE CBU company payload, verbatim, so nothing
   *     is ever lost and a sync can be inspected/replayed without re-fetching.
   */
  private async saveRaw(
    m: EntityManager,
    inn: string,
    data: CbuCompanyData,
  ): Promise<void> {
    const c = data.company;
    const payload = {
      company: {
        kfs: c.kfs ?? null,
        statusUpdated: c.statusUpdated ?? null,
        taxStatus: c.taxStatus ?? null,
        vatRegistrationDate: c.vatRegistrationDate ?? null,
        taxModeBeginDate: c.taxModeBeginDate ?? null,
        taxModeEndDate: c.taxModeEndDate ?? null,
        createdSysDate: c.createdSysDate ?? null,
        updatedSysDate: c.updatedSysDate ?? null,
      },
      argos: data.argos ?? null,
      // Full bank objects incl. status / openDate / closeDate / attribute and
      // any 2nd+ banks (company_info only keeps the first bank's mfo + account).
      companyBanks: data.companyBanks ?? null,
      // Parent / subsidiary links.
      companyLink: data.companyLink ?? null,
    };
    const lastFetch = JSON.stringify({
      success: true,
      status: 200,
      error: null,
      at: new Date().toISOString(),
    });
    // The bank list and the parent/subsidiary links live only here, and the
    // row is overwritten, so their previous value is kept. Not the whole
    // payload: its timestamps change on every fetch.
    const [stored] = await m.query(
      `SELECT payload FROM public.company_cbu_raw WHERE inn = $1`,
      [inn],
    );
    await logFieldChanges(
      m,
      { entity: 'company_cbu_raw', inn, key: null, source: 'cbu' },
      stored?.payload ?? null,
      payload,
      ['companyBanks', 'companyLink'],
    );
    await m.query(
      `INSERT INTO public.company_cbu_raw (inn, payload, raw_response, last_fetch, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (inn) DO UPDATE SET
         payload      = EXCLUDED.payload,
         raw_response = EXCLUDED.raw_response,
         last_fetch   = EXCLUDED.last_fetch,
         updated_at   = now()`,
      [inn, JSON.stringify(payload), JSON.stringify(data), lastFetch],
    );
  }

  /**
   * Record a FAILED fetch outcome for a company (404 / success=false / retries
   * exhausted / persist error). Overwrites only `last_fetch` so the failure is
   * saved and queryable, while any previously synced `payload` / `raw_response`
   * is preserved (a transient error must not wipe good data). For a company that
   * has only ever failed, `payload` is seeded to '{}' (the column is NOT NULL)
   * and `raw_response` stays null. Runs on its own connection (not the sync
   * transaction, which has already rolled back). Best-effort: never throws.
   */
  private async recordFailedFetch(
    inn: string,
    status: number | null,
    error: string | null,
  ): Promise<void> {
    try {
      const lastFetch = JSON.stringify({
        success: false,
        status,
        error,
        at: new Date().toISOString(),
      });
      await this.db.query(
        `INSERT INTO public.company_cbu_raw (inn, payload, last_fetch, updated_at)
         VALUES ($1, '{}'::jsonb, $2, now())
         ON CONFLICT (inn) DO UPDATE SET
           last_fetch = EXCLUDED.last_fetch,
           updated_at = now()`,
        [inn, lastFetch],
      );
    } catch (e: any) {
      this.logger.warn(
        `[cbu-sync] could not record failed fetch inn=${inn}: ${e?.message}`,
      );
    }
  }

  /** Compare two numeric-ish values at fixed precision (DB returns numeric as string). */
  private sameNum(a: any, b: any, decimals: number): boolean {
    const na = a == null ? null : Number(a);
    const nb = b == null ? null : Number(b);
    if (na == null && nb == null) return true;
    if (na == null || nb == null) return false;
    return na.toFixed(decimals) === nb.toFixed(decimals);
  }

  /** Parse "DD.MM.YYYY" → ISO date string "YYYY-MM-DD", or null */
  private parseDate(raw: string | null | undefined): string | null {
    if (!raw) return null;
    if (!/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) return null;
    const [day, month, year] = raw.split('.');
    return `${year}-${month}-${day}`;
  }

  /** Join name parts, return null if all parts are empty */
  private joinName(
    last?: string | null,
    first?: string | null,
    middle?: string | null,
  ): string | null {
    const parts = [last, first, middle].filter((p) => p && p.trim());
    return parts.length > 0 ? parts.join(' ') : null;
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  public async resetCursor(): Promise<Record<string, any>> {
    await this.db.query(
      `UPDATE public.${this.CURSOR}
          SET last_id=0, cycle_processed=0, cycle_started_at=now(), updated_at=now()
        WHERE id=1`,
    );
    return { reset: true, cursor: await this.getCursor() };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
