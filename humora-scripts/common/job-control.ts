interface Exec {
  query(sql: string, params?: unknown[]): Promise<any>;
}

/**
 * Asks a job to stop at its next checkpoint, on whichever replica runs it.
 * Kept in `job_controls`; a run obeys only a request newer than its start.
 */
export async function requestJobStop(db: Exec, job: string): Promise<void> {
  await db.query(
    `INSERT INTO public.job_controls (job, stop_requested_at)
     VALUES ($1, now())
     ON CONFLICT (job) DO UPDATE SET stop_requested_at = now()`,
    [job],
  );
}

/**
 * Whether a stop was asked for after `since` (the run's start). A read that
 * fails answers false: a checkpoint must not stop a run by itself.
 */
export async function jobStopRequested(
  db: Exec,
  job: string,
  since: Date,
): Promise<boolean> {
  try {
    const rows = await db.query(
      `SELECT 1 FROM public.job_controls
        WHERE job = $1 AND stop_requested_at >= $2`,
      [job, since],
    );
    return Array.isArray(rows) && rows.length > 0;
  } catch {
    return false;
  }
}

export interface LockHolder {
  pid: number;
  state: string | null;
  /**
   * When the holding session last changed state. A job takes its lock on a
   * connection of its own and leaves it idle until it unlocks, so for an idle
   * holder this is when the lock was taken.
   */
  since: string | null;
  held_minutes: number | null;
  application: string | null;
  client: string | null;
  query: string | null;
}

/** Who holds a session advisory lock taken with pg_try_advisory_lock(id). */
export async function advisoryLockHolder(
  db: Exec,
  lockId: number,
): Promise<LockHolder | null> {
  const rows = await db.query(
    `SELECT l.pid, a.state, a.state_change AS since,
            floor(extract(epoch FROM now() - a.state_change) / 60)::int AS held_minutes,
            a.application_name AS application, a.client_addr::text AS client,
            left(a.query, 200) AS query
       FROM pg_locks l
       LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted
        AND l.classid = 0 AND l.objid = $1 AND l.objsubid = 1
      LIMIT 1`,
    [lockId],
  );
  const r = rows?.[0];
  if (!r) return null;
  return {
    pid: Number(r.pid),
    state: r.state ?? null,
    since: r.since ? new Date(r.since).toISOString() : null,
    held_minutes: r.held_minutes == null ? null : Number(r.held_minutes),
    application: r.application ?? null,
    client: r.client ?? null,
    query: r.query ?? null,
  };
}
