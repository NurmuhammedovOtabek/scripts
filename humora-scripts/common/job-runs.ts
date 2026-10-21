import { Logger } from '@nestjs/common';

interface Exec {
  query(sql: string, params?: unknown[]): Promise<any>;
}

export interface JobRunRecord {
  job: string;
  trigger: string;
  dry?: boolean;
  startedAt: Date;
  finishedAt?: Date;
  ok: boolean;
  /** The report as sent, markup stripped. */
  summary?: string | null;
  report?: unknown;
  error?: string | null;
  /** Whether Telegram took it; null when nothing was sent. */
  alertSent?: boolean | null;
}

const logger = new Logger('JobRuns');

function plain(html: string | null | undefined): string | null {
  if (!html) return null;
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Keeps a run's report in `public.job_runs`. Never throws — it is the last
 * step of a job that already did its work — but a row it could not write is
 * logged with the report, so the report still exists somewhere.
 */
export async function recordJobRun(db: Exec, r: JobRunRecord): Promise<void> {
  const summary = plain(r.summary);
  try {
    await db.query(
      `INSERT INTO public.job_runs
         (job, trigger, dry, started_at, finished_at, ok, summary, report, error, alert_sent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        r.job,
        r.trigger,
        r.dry ?? false,
        r.startedAt,
        r.finishedAt ?? new Date(),
        r.ok,
        summary,
        r.report === undefined ? null : JSON.stringify(r.report),
        r.error ?? null,
        r.alertSent ?? null,
      ],
    );
  } catch (err) {
    logger.error(
      `[job-runs] could not record ${r.job} (${(err as Error).message}); report:\n${summary ?? r.error ?? ''}`,
    );
  }
}

/** The latest runs of one job, newest first, for a status endpoint. */
export async function recentJobRuns(
  db: Exec,
  jobs: string[],
  limit = 10,
): Promise<any[]> {
  try {
    return await db.query(
      `SELECT id, job, trigger, dry, started_at, finished_at, ok, alert_sent,
              summary, error
         FROM public.job_runs
        WHERE job = ANY($1::text[])
        ORDER BY started_at DESC
        LIMIT $2`,
      [jobs, limit],
    );
  } catch {
    return [];
  }
}
