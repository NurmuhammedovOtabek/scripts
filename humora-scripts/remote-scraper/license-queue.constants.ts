import { redisKeyPrefix } from '../../common/redis/redis-keys';

/** Queue that carries licence fetches to the scraper box. */
export const LICENSE_QUEUE = 'remote-licenses';

export interface LicenseJob {
  inn: string;
}

/** Who wants the fetch: a company page, or a partner API request. */
export type LicenseRequester = 'site' | 'partner';

/**
 * Where a partner's fetch waits.
 *
 * The box runs one fetch at a time, 35–107s each, so a partner checking a
 * thousand companies would otherwise put hours of work ahead of the next
 * person opening a company page. BullMQ runs every job without a priority —
 * the site's — before any job with one, so this only has to be set; among
 * partner jobs, which all share it, the order stays first come first served.
 */
export const PARTNER_JOB_PRIORITY = 10;

/**
 * One job per company, so the same INN cannot sit in the queue twice however
 * many people open its page at once. BullMQ treats a repeated jobId as already
 * present and drops the duplicate — across instances, which the previous
 * in-process queue could not do.
 */
/**
 * One id per attempt, not one per company.
 *
 * `stamp` is the moment the company's daily slot was claimed, so every id is
 * unique to one attempt. That matters because BullMQ keeps completed and
 * failed job records for diagnosis, and a surviving record silently refuses a
 * new job under the same id — retention was therefore doing the throttling as
 * a side effect, for as long as it happened to keep the record.
 *
 * Concurrency is still covered: only the caller that claims the slot enqueues
 * at all, so two requests in the same instant cannot produce two jobs.
 *
 * The separator is a dash, not a colon: BullMQ rejects a colon in a custom job
 * id, since it uses colons for its own Redis key structure.
 */
export const licenseJobId = (inn: string, stamp?: string): string =>
  stamp ? `licenses-${inn}-${Date.parse(stamp)}` : `licenses-${inn}`;

/**
 * How many licence fetches may run at once across the entire deployment.
 *
 * One, because the scraper box drives a single browser. This is enforced in
 * Redis (`Queue.setGlobalConcurrency`), unlike the processor's `concurrency`
 * option, which each worker applies to itself alone.
 */
export const GLOBAL_CONCURRENCY = 1;

/**
 * How long one licence fetch may hold the worker.
 *
 * Above the 600s axios timeout on the call to the scraper box, so a slow walk
 * still fails through the normal path with its own message. This only catches
 * a hang that timeout cannot see — a database write that never returns, or a
 * promise that never settles — and stops it holding the only worker slot.
 */
export const LICENSE_JOB_TIMEOUT_MS = parseInt(
  process.env.LICENSE_JOB_TIMEOUT_MS || String(11 * 60 * 1000),
  10,
);

/**
 * How long one company is left alone after we have asked about it.
 *
 * Whatever came back — permits, none, or a failure — the box is not asked
 * again about that company inside this window. The registry publishes no rate
 * limit and refuses without saying why, so the only lever we hold is how often
 * we knock; this is that lever, and it is deliberately one number rather than
 * one per outcome.
 *
 * A separate marker rather than a property of the job, because the two things
 * were tangled before: job retention was doing the throttling as a side
 * effect, which meant a failed lookup was locked out for the seven days its
 * record was kept for diagnosis, while a successful one was free after a day.
 */
export const LICENSE_ATTEMPT_TTL_SEC = parseInt(
  process.env.LICENSE_ATTEMPT_TTL_SEC || String(24 * 3600),
  10,
);

/** Redis key holding the outcome of the last attempt for a company. */
export const licenseAttemptKey = (inn: string): string =>
  `${redisKeyPrefix()}licenses:attempted:${inn}`;

/**
 * How old stored permits may be before they are refreshed behind the page.
 *
 * There was no refresh at all: a company whose permits were once stored was
 * served from the table for ever, so anything the registry changed afterwards
 * never arrived — and neither did anything an older, buggier fetch had missed.
 * INN 202099756 sat at ten rows, the exact size of one page, from before
 * pagination worked; the registry holds forty-six.
 *
 * A week rather than a day: permits move slowly, and the refresh is bounded by
 * LICENSE_ATTEMPT_TTL_SEC anyway, so the cost of being generous is small.
 */
export const LICENSE_REFRESH_AFTER_DAYS = parseInt(
  process.env.LICENSE_REFRESH_AFTER_DAYS || '7',
  10,
);

/**
 * Whether stored permits are old enough to be worth fetching again.
 *
 * A function rather than an inline comparison so the decision can be tested
 * without standing up OrgService and its thirty dependencies — and because
 * "no timestamp" is a case worth being explicit about: rows that predate the
 * column would otherwise read as infinitely old and refetch every company on
 * its next view.
 */
export function licencesAreStale(
  newest: Date | null,
  now: number = Date.now(),
  afterDays: number = LICENSE_REFRESH_AFTER_DAYS,
): boolean {
  if (!newest || isNaN(newest.getTime())) return false;
  return (now - newest.getTime()) / 86_400_000 >= afterDays;
}
