import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { MibRegistryService } from './mib-registry.service';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recordJobRun } from '../common/job-runs';

/**
 * Daily copy of mib.uz's alimony-debtor and wanted-person lists
 * (`person_mib_registry`), which the company page's person checks read
 * (FLT-415 A5). Until 2026-10-09 the lists were synced by hand only.
 *
 * mib.uz answers the top 3 000 rows of each list and never says which rows
 * left, so a row is current only while a recent sync still sees it — the
 * reader trusts rows seen in the last `REGISTRY_FRESH_DAYS` and calls a list
 * whose newest row is older "unavailable". A daily run keeps both true.
 *
 * Runs where TG_WEBHOOK_URL is set (dev and prod) unless
 * MIB_REGISTRY_SYNC_ENABLED says otherwise; one replica (advisory lock).
 * mib.uz only answers Uzbek addresses. Failures reach Telegram (English) and
 * `job_runs` (`mib_registry`).
 */
@Injectable()
export class MibRegistryCronService {
  private readonly logger = new Logger(MibRegistryCronService.name);
  private static readonly LOCK = 8_151_041;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly registry: MibRegistryService,
    private readonly alerts: TelegramAlertService,
  ) {}

  private enabled(): boolean {
    const flag = process.env.MIB_REGISTRY_SYNC_ENABLED;
    if (flag === '1') return true;
    if (flag === '0') return false;
    return !!process.env.TG_WEBHOOK_URL;
  }

  @Cron('0 6 * * *', { timeZone: 'Asia/Tashkent' })
  async daily(): Promise<void> {
    if (!this.enabled()) return;
    const runner = this.db.createQueryRunner();
    await runner.connect();
    const startedAt = new Date();
    try {
      const [{ ok }] = await runner.query(
        `SELECT pg_try_advisory_lock($1) AS ok`,
        [MibRegistryCronService.LOCK],
      );
      if (!ok) return; // another replica runs it
      try {
        const results = await this.registry.syncAll();
        const summary = results
          .map(
            (r) =>
              `${r.registry}: ${r.fetched} rows (new ${r.inserted}, updated ${r.updated}, removed ${r.removed}${r.truncated ? ', truncated' : ''})`,
          )
          .join('; ');
        this.logger.log(`[mib-registry] daily sync — ${summary}`);
        // A list that came back empty is a broken answer, not an empty list.
        const empty = results.filter((r) => r.fetched === 0);
        if (empty.length) {
          const msg = `⚠️ MIB registry sync: ${empty.map((r) => r.registry).join(', ')} came back empty — person checks will call the list unavailable after 8 days`;
          this.logger.error(`[mib-registry] ${msg}`);
          await this.alerts
            .send(msg, { tag: 'mib_registry' })
            .catch(() => undefined);
        }
        await recordJobRun(this.db, {
          job: 'mib_registry',
          trigger: 'cron',
          startedAt,
          finishedAt: new Date(),
          ok: empty.length === 0,
          summary,
          report: results,
        });
      } catch (err) {
        const msg = `❌ MIB registry sync failed: ${(err as Error).message}`;
        this.logger.error(`[mib-registry] ${msg}`, (err as Error).stack);
        const alertSent = await this.alerts
          .send(msg, { tag: 'mib_registry' })
          .catch(() => false);
        await recordJobRun(this.db, {
          job: 'mib_registry',
          trigger: 'cron',
          startedAt,
          finishedAt: new Date(),
          ok: false,
          error: (err as Error).message,
          alertSent,
        });
      } finally {
        await runner
          .query(`SELECT pg_advisory_unlock($1)`, [MibRegistryCronService.LOCK])
          .catch(() => undefined);
      }
    } finally {
      await runner.release();
    }
  }
}
