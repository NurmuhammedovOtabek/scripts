import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';

/**
 * The slice of ioredis we need beyond what BullMQ's client interface types.
 * Its `set` takes only `{PX, EX}`; the NX flag needs the variadic form.
 */
interface NxClient {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    seconds: number,
    nx: 'NX',
  ): Promise<string | null>;
}
import {
  GLOBAL_CONCURRENCY,
  LICENSE_ATTEMPT_TTL_SEC,
  LICENSE_QUEUE,
  LicenseJob,
  LicenseRequester,
  PARTNER_JOB_PRIORITY,
  licenseAttemptKey,
  licenseJobId,
} from './license-queue.constants';

/**
 * Puts licence fetches on the queue.
 *
 * Callers use this instead of fetching inline: a walk takes minutes, and no
 * page should wait on one. The first view of a company returns what is stored
 * and leaves a job behind; the next view is served complete from the database.
 */
@Injectable()
export class LicenseQueueService implements OnModuleInit {
  private readonly logger = new Logger(LicenseQueueService.name);

  constructor(
    @InjectQueue(LICENSE_QUEUE) private readonly queue: Queue<LicenseJob>,
  ) {}

  /**
   * Cap the whole queue at one job at a time, not one per instance.
   *
   * The `concurrency: 1` on the processor is a *per-worker* limit: every
   * instance that loads this module becomes a worker and enforces its own. Two
   * instances would therefore drive two fetches at once, and the scraper box
   * has one browser. This limit lives in Redis, so it holds however many
   * instances run.
   *
   * Set on every boot rather than once by hand: an operator scaling the
   * deployment should not have to remember a Redis command.
   */
  async onModuleInit(): Promise<void> {
    try {
      await this.queue.setGlobalConcurrency(GLOBAL_CONCURRENCY);
      this.logger.log(
        `[licenses] global concurrency set to ${GLOBAL_CONCURRENCY} (all instances share it)`,
      );
    } catch (err) {
      // Worth saying loudly: without this the queue still runs, but a
      // multi-instance deployment quietly sends the box parallel work.
      this.logger.error(
        `[licenses] could not set global concurrency — with more than one ` +
          `instance the box may be driven in parallel: ${(err as Error).message}`,
      );
    }
  }

  /**
   * When we last asked the box about this company, if it was recently.
   *
   * Returns the stored timestamp when the company is still inside its window,
   * or null after claiming the slot. Read-then-write rather than an atomic
   * `SET NX`: two instances racing in the same instant would both claim, and
   * the jobId already collapses that into one fetch. This gate is the daily
   * throttle, not the de-duplicator.
   */
  private async claimAttempt(
    inn: string,
  ): Promise<{ heldSince: Date } | { stamp: string }> {
    const client = (await this.queue.backend.client) as unknown as NxClient;
    const key = licenseAttemptKey(inn);
    const stamp = new Date().toISOString();

    // `SET … EX … NX` — Redis decides the winner, in one round trip.
    //
    // Atomic on purpose. Read-then-write would let two instances asking about
    // the same company in the same instant both see nothing and both claim,
    // and since the job id now carries the claim they would no longer collide
    // on it — two fetches of one company, which is the load this exists to
    // prevent. The connection is ioredis (see BullRootModule); this signature
    // is its own, wider than the interface BullMQ exposes.
    const won = await client.set(
      key,
      stamp,
      'EX',
      LICENSE_ATTEMPT_TTL_SEC,
      'NX',
    );
    if (won) return { stamp };

    const held = await client.get(key);
    const at = held ? new Date(held) : new Date();
    return { heldSince: isNaN(at.getTime()) ? new Date() : at };
  }

  /** The stamp of the attempt currently holding this company, if any. */
  private async currentStamp(inn: string): Promise<string | null> {
    const client = await this.queue.backend.client;
    return client.get(licenseAttemptKey(inn));
  }

  /** A partner's fetch of this company, still waiting, joins the site's line. */
  private async moveToSiteLine(inn: string): Promise<void> {
    const stamp = await this.currentStamp(inn);
    if (!stamp) return;
    const job = await this.queue.getJob(licenseJobId(inn, stamp));
    if (!job || (await job.getState()) !== 'prioritized') return;
    // Priority 0 is no priority: BullMQ moves the job to the end of the
    // site's line.
    await job.changePriority({ priority: 0 });
    this.logger.log(
      `[licenses] inn=${inn} opened on the site — its partner fetch moved ahead of partner requests`,
    );
  }

  /**
   * Queue a fetch of this company's permits.
   *
   * `from` sets the place in line: a partner's fetch waits behind every
   * site fetch (PARTNER_JOB_PRIORITY). When a company page asks for a company
   * a partner already queued, that job moves up to the site's line instead of
   * leaving the reader behind the partner's backlog.
   */
  async enqueue(inn: string, from: LicenseRequester = 'site'): Promise<void> {
    try {
      // One request per company per day, whatever last time came to.
      //
      // Held separately from the job so that throttling and diagnosis stop
      // fighting: a failed job is kept for a week to be looked at, and that
      // retention used to double as a week-long lockout on retrying it.
      const claim = await this.claimAttempt(inn);
      if ('heldSince' in claim) {
        if (from === 'site') await this.moveToSiteLine(inn);
        const agoMin = Math.round(
          (Date.now() - claim.heldSince.getTime()) / 60000,
        );
        this.logger.log(
          `[licenses] inn=${inn} was asked ${agoMin}m ago — not asking again ` +
            `for another ${Math.round(LICENSE_ATTEMPT_TTL_SEC / 3600)}h`,
        );
        return;
      }

      const job = await this.queue.add(
        'fetch',
        { inn },
        {
          // Same company, same id — a second request while one is pending is
          // dropped by BullMQ rather than doubling the work.
          jobId: licenseJobId(inn, claim.stamp),

          ...(from === 'partner' ? { priority: PARTNER_JOB_PRIORITY } : {}),

          // Two attempts, well spaced. A failure here usually means the box is
          // unreachable or a browser challenge did not resolve, and neither
          // clears in seconds. Retrying sooner would just spend another ten
          // minutes failing.
          attempts: 2,
          backoff: { type: 'fixed', delay: 5 * 60 * 1000 },

          // Keep the tail for diagnosis, not the whole history.
          removeOnComplete: { age: 24 * 3600, count: 500 },
          removeOnFail: { age: 7 * 24 * 3600, count: 200 },
        },
      );

      // Depth on every enqueue: a licence walk runs into minutes, so a line of
      // ten is nearly an hour of work, and that is worth seeing without having
      // to go and look for it. Partner fetches wait apart, as `prioritized`.
      const counts = await this.stats();
      const waiting = counts.waiting ?? 0;
      const line =
        `[licenses] queued inn=${inn} (job ${job.id}, ${from}) ` +
        `waiting=${waiting} partner=${counts.prioritized ?? 0} ` +
        `active=${counts.active ?? 0} failed=${counts.failed ?? 0}`;
      if (waiting >= 10) this.logger.warn(`${line} — backlog building`);
      else this.logger.log(line);
    } catch (err) {
      // Redis being down must not break the page that triggered this. The
      // company simply stays unfilled and is queued again on the next view —
      // but say so, or licences quietly stop filling with nothing to show why.
      this.logger.warn(
        `[licenses] could not queue inn=${inn}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Whether a fetch for this company is still coming.
   *
   * An empty licence table means one of two things and the page has to say
   * which: nobody has looked yet, or the registry was asked and holds none.
   * Answering "no permits" for the first is the same defect the YaTT snapshot
   * route was just fixed for — a credit analyst reads «Нет данных» as a fact
   * about the company rather than about us.
   *
   * A completed job is kept for 24 hours (`removeOnComplete`), which is what
   * makes "asked already" answerable at all. Past that the record is gone and
   * the company is simply queued again, so the worst case is one redundant
   * fetch a day for a company that genuinely holds nothing.
   */
  async fetchState(inn: string): Promise<'pending' | 'failed' | 'done'> {
    try {
      // Keyed to the attempt that holds this company right now. Looking up a
      // bare `licenses-<inn>` finds nothing since the id gained its stamp, and
      // "nothing" reads as done — the page would go straight back to claiming
      // no permits while a fetch was still running.
      const stamp = await this.currentStamp(inn);
      if (!stamp) return 'done';

      const job = await this.queue.getJob(licenseJobId(inn, stamp));
      if (!job) return 'done';

      const state = await job.getState();
      if (state === 'completed') return 'done';
      if (state === 'failed') return 'failed';
      return 'pending';
    } catch (err) {
      // Redis unreachable. "Done" is the wrong answer and "pending" would
      // leave the page polling something that cannot arrive, so say failed —
      // the page offers a retry, which is the truthful option here.
      this.logger.warn(
        `[licenses] could not read job state for inn=${inn}: ${(err as Error).message}`,
      );
      return 'failed';
    }
  }

  /** Depth and health, for /health or an admin view. */
  async stats(): Promise<Record<string, number>> {
    try {
      return await this.queue.getJobCounts(
        'waiting',
        'prioritized',
        'active',
        'delayed',
        'failed',
        'completed',
      );
    } catch {
      return {};
    }
  }
}
