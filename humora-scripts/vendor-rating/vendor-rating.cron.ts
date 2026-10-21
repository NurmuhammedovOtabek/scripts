import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { VendorRatingService } from './vendor-rating.service';

/**
 * Copies the UZEX supplier rating once a day.
 *
 * The source publishes a month at a time and says nothing when a new month
 * lands, so checking daily is how a new list is picked up within a day. A run
 * is about thirty requests.
 */
@Injectable()
export class VendorRatingCronService {
  private readonly logger = new Logger(VendorRatingCronService.name);
  /** Any number no other advisory lock in this database uses. */
  private readonly LOCK_ID = 7_461_203;

  constructor(
    private readonly ratings: VendorRatingService,
    @InjectDataSource('flottDb') private readonly db: DataSource,
  ) {}

  @Cron('30 4 * * *', { timeZone: 'Asia/Tashkent' })
  async daily(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      this.logger.warn(
        `[CRON] vendor rating skipped — NODE_ENV="${process.env.NODE_ENV ?? 'undefined'}"`,
      );
      return;
    }

    // Every replica wakes for a @Cron. A session-held advisory lock lets
    // exactly one of them run, and frees itself if that container dies. It
    // must be taken and released on one pinned connection.
    const runner = this.db.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const rows = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [this.LOCK_ID],
      );
      locked = rows?.[0]?.locked === true;
      if (!locked) {
        this.logger.log(
          '[CRON] vendor rating skipped — another replica has it',
        );
        return;
      }

      const result = await this.ratings.syncAll();
      this.logger.log(
        `[CRON] vendor rating: ${result.saved} saved for ${result.period ?? '?'}`,
      );
    } catch (err: any) {
      this.logger.error(`[CRON] vendor rating failed: ${err?.message ?? err}`);
    } finally {
      try {
        if (locked) {
          await runner.query('SELECT pg_advisory_unlock($1)', [this.LOCK_ID]);
        }
      } catch {
        // Releasing the connection below drops the lock anyway.
      }
      await runner.release().catch(() => undefined);
    }
  }
}
