import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  LICENSE_JOB_TIMEOUT_MS,
  LICENSE_QUEUE,
  LicenseJob,
} from './license-queue.constants';
import { withJobTimeout } from '../../queue/job-timeout';
import { RemoteScraperService } from './remote-scraper.service';
import { GovLicenseStore } from './gov-license.store';
import { TelegramAlertService } from '../common/telegram-alert.service';

/**
 * Runs licence fetches, one at a time.
 *
 * Concurrency is 1 on purpose: the scraper box drives a single browser and
 * serialises internally, so sending it parallel work would only move the queue
 * to the far side where it cannot be seen or measured. Holding the line here
 * keeps the wait visible in Redis.
 *
 * The work itself is slow — ~35s for a small company, ~107s for one holding 138
 * permits — but it is all waiting on the network, so it costs the process
 * almost nothing while it runs.
 */
@Processor(LICENSE_QUEUE, { concurrency: 1 })
export class LicenseProcessor extends WorkerHost {
  private readonly logger = new Logger(LicenseProcessor.name);

  constructor(
    private readonly remote: RemoteScraperService,
    private readonly store: GovLicenseStore,
    private readonly tg: TelegramAlertService,
  ) {
    super();
  }

  async process(job: Job<LicenseJob>): Promise<{ stored: number }> {
    // Ceiling on the whole job, not just the call to the box — see
    // withJobTimeout. At concurrency 1 one hung job is the whole queue.
    return withJobTimeout(
      this.run(job),
      LICENSE_JOB_TIMEOUT_MS,
      `[licenses] inn=${job.data.inn}`,
    );
  }

  private async run(job: Job<LicenseJob>): Promise<{ stored: number }> {
    const { inn } = job.data;
    const waited = Date.now() - job.timestamp;
    const startedAt = Date.now();
    this.logger.log(
      `[licenses] inn=${inn} start attempt=${job.attemptsMade + 1} waited=${waited}ms`,
    );

    const rows = await this.remote.getLicenses(inn);

    // null means the box could not answer. Throwing hands the job back to
    // BullMQ to retry later rather than recording "this company holds no
    // permits", which is a false negative nothing would ever revisit.
    if (rows === null) {
      throw new Error(`scraper box did not answer for inn=${inn}`);
    }

    if (rows.length === 0) {
      this.logger.log(
        `[licenses] inn=${inn} done fetched=0 stored=0 took=${Date.now() - startedAt}ms ` +
          `— the registry holds none`,
      );
      return { stored: 0 };
    }

    const stored = await this.store.save(inn, rows);

    // Both numbers, not just the one: they differ when a record arrives with
    // no uuid to key on, and a gap between them is the only sign of that.
    this.logger.log(
      `[licenses] inn=${inn} done fetched=${rows.length} stored=${stored} ` +
        `took=${Date.now() - startedAt}ms`,
    );
    return { stored };
  }

  /**
   * A job that has run out of attempts.
   *
   * Worth its own line and its own alert: the retry already waited five
   * minutes, so reaching here means the box has been unreachable for a while,
   * and the company is now left with no permits stored and nothing scheduled
   * to try again. Only the *final* failure alerts — the first of two would
   * fire on every transient blip.
   */
  @OnWorkerEvent('failed')
  onFailed(job: Job<LicenseJob> | undefined, err: Error): void {
    const inn = job?.data?.inn ?? 'unknown';
    // Already incremented by the time this fires — counting it again here
    // made the first of two failures look like the last, so every transient
    // blip alerted and the retry went unmentioned.
    const made = job?.attemptsMade ?? 0;
    const max = job?.opts?.attempts ?? 1;

    if (made < max) {
      this.logger.warn(
        `[licenses] inn=${inn} attempt ${made}/${max} failed, will retry: ${err.message}`,
      );
      return;
    }

    this.logger.error(
      `[licenses] inn=${inn} GAVE UP after ${made} attempt(s): ${err.message} ` +
        `— nothing is stored and nothing is scheduled; the next view of this ` +
        `company will queue it again`,
    );
    void this.tg
      .send(
        `Licences not fetched: STIR ${inn} — gave up after ${made} attempts: ${err.message}`,
        { tag: 'license' },
      )
      .catch(() => undefined);
  }

  /**
   * The worker has connected and is consuming.
   *
   * BullMQ fires this once its blocking connection is up — the connection a
   * worker actually pulls jobs on, which is separate from the one `add` uses.
   * Without the line there is no way to tell a queue with nothing to do from a
   * queue whose worker never started: both are silent, and both show jobs
   * sitting in `waiting` with `active=0`. Seen on test — three jobs queued,
   * none picked up, and nothing in the logs said which of the two it was.
   */
  @OnWorkerEvent('ready')
  onReady(): void {
    this.logger.log('[licenses] worker ready — consuming jobs');
  }

  /**
   * The worker itself in trouble — a lost Redis connection, not one job.
   * Distinct from a failed job and much more serious: nothing is being
   * consumed at all while this is true.
   */
  @OnWorkerEvent('error')
  onWorkerError(err: Error): void {
    this.logger.error(
      `[licenses] worker error — jobs may not be consumed: ${err.message}`,
    );
  }
}
