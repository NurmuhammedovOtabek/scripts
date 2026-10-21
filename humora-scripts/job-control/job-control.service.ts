import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recentJobRuns, recordJobRun } from '../common/job-runs';
import {
  LockHolder,
  advisoryLockHolder,
  requestJobStop,
} from '../common/job-control';
import {
  CompanyMahallaService,
  RUN_LOCK,
  WEEKLY_JOB,
  WEEKLY_LOCK,
} from '../company-mahalla/company-mahalla.service';
import {
  JOB as NS_JOB,
  LOCK_ID as NS_LOCK,
} from '../ns-soato-map/ns-soato-map-sync.service';
import { LOCK_ID as BANK_LOCK } from '../bank-registry/bank-registry-sync.service';
import {
  JOB as OKED_JOB,
  LOCK_ID as OKED_LOCK,
} from '../oked-sync/oked-sync.service';
import { WATCH_JOB, WATCH_LOCK_ID } from '../postcode/postcode-watch.service';
import {
  JOB as ACCREDITATION_JOB,
  LOCK_ID as ACCREDITATION_LOCK,
} from '../accreditation/accreditation-sync.service';
import {
  JOB as REGISTRIES_JOB,
  LOCK_ID as REGISTRIES_LOCK,
} from '../registries/registries-sync.service';

export interface ControlledJob {
  job: string;
  label: string;
  lock: number;
  /** Held longer than this, the lock may be released without `force`. */
  stuckAfterMinutes: number;
  /** How a stop reaches it; null when a run takes seconds and has no checkpoint. */
  stop: 'flag' | 'mahalla' | null;
  /** Its rows in `job_runs`. */
  runs: string[];
}

/**
 * The jobs behind the bank reports, each run under a session advisory lock
 * so one replica of three runs it. A run normally ends well inside
 * `stuckAfterMinutes` (prod estimates: mahalla run 5–10 min, the map and the
 * bank sync seconds).
 */
export const CONTROLLED_JOBS: ControlledJob[] = [
  {
    job: WEEKLY_JOB,
    label:
      'Sunday 04:30 chain: banks → OKED → accreditation register → open registers → postal network → tax office map → mahallas',
    lock: WEEKLY_LOCK,
    stuckAfterMinutes: 180,
    stop: 'flag',
    runs: [],
  },
  {
    job: 'company_mahalla',
    label: 'Company mahalla full run',
    lock: RUN_LOCK,
    stuckAfterMinutes: 120,
    stop: 'mahalla',
    runs: ['company_mahalla'],
  },
  {
    job: NS_JOB,
    label: 'Tax office → SOATO map sync',
    lock: NS_LOCK,
    stuckAfterMinutes: 30,
    stop: 'flag',
    runs: [NS_JOB],
  },
  {
    job: 'bank_registry',
    label: 'Bank registry sync',
    lock: BANK_LOCK,
    stuckAfterMinutes: 30,
    stop: null,
    runs: ['bank_registry'],
  },
  {
    job: OKED_JOB,
    label: 'OKED classifier sync',
    lock: OKED_LOCK,
    stuckAfterMinutes: 30,
    stop: null,
    runs: [OKED_JOB],
  },
  {
    job: ACCREDITATION_JOB,
    label: 'Accreditation register sync (akkred.uz)',
    lock: ACCREDITATION_LOCK,
    // Seconds on a normal night; the documents may take up to their 2 h budget.
    stuckAfterMinutes: 150,
    stop: null,
    runs: [ACCREDITATION_JOB],
  },
  {
    job: WATCH_JOB,
    label: 'Postal network check (UzPost, EMU)',
    lock: WATCH_LOCK_ID,
    stuckAfterMinutes: 30,
    stop: null,
    runs: [WATCH_JOB],
  },
  {
    job: REGISTRIES_JOB,
    label: 'Open registers sync (licences, certificates, members)',
    lock: REGISTRIES_LOCK,
    // A whole read is ~150 paced requests; the first fill of a big register
    // (35k rows) takes minutes. Stops between two registers.
    stuckAfterMinutes: 120,
    stop: 'flag',
    runs: [REGISTRIES_JOB],
  },
];

const CONTROL_JOB = 'job_control';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Hands for a run that will not end (GET/POST /api/jobs, x-admin-secret).
 *
 * - **stop** asks a running job to end at its next checkpoint, on whichever
 *   replica runs it: the mahalla run after its batch, the map sync before the
 *   company check or before writing (never half-way through the writes), the
 *   Sunday chain before its next step — and stopping the chain stops the step
 *   it is on too. Nothing written is undone; a stopped run reports as such.
 * - **unlock** is for a lock nobody is using any more: a container killed
 *   mid-run (a deploy, the memory limit) can leave its database session, and
 *   with it the lock, alive until Postgres notices the client is gone —
 *   hours, meanwhile every run on every replica answers "another replica is
 *   running it". Unlock ends the session holding the lock. It refuses while
 *   the lock is younger than the job's normal run time unless `force=1`: on a
 *   live run that would pull the connection out from under it.
 *
 * Every stop and unlock goes to Telegram and `job_runs` (`job_control`).
 */
@Injectable()
export class JobControlService {
  private readonly logger = new Logger(JobControlService.name);

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly telegram: TelegramAlertService,
    private readonly mahalla: CompanyMahallaService,
  ) {}

  find(job: string): ControlledJob {
    const found = CONTROLLED_JOBS.find((j) => j.job === job);
    if (!found) {
      throw new BadRequestException(
        `job must be one of ${CONTROLLED_JOBS.map((j) => j.job).join(', ')}`,
      );
    }
    return found;
  }

  /** Each job: who holds its lock and for how long, stop requests, last run. */
  async status(): Promise<Record<string, unknown>> {
    const stops: Array<{ job: string; stop_requested_at: string }> =
      await this.db
        .query(`SELECT job, stop_requested_at FROM public.job_controls`)
        .catch(() => []);
    const [mahallaState] = await this.db
      .query(
        `SELECT stop_requested, run_started_at, progress
           FROM public.company_mahalla_state WHERE id = 1`,
      )
      .catch(() => [undefined]);
    const jobs = [];
    for (const j of CONTROLLED_JOBS) {
      const holder = await advisoryLockHolder(this.db, j.lock);
      jobs.push({
        job: j.job,
        label: j.label,
        running: holder !== null,
        lock_holder: holder,
        stuck_after_minutes: j.stuckAfterMinutes,
        looks_stuck:
          holder !== null && (holder.held_minutes ?? 0) >= j.stuckAfterMinutes,
        stoppable: j.stop !== null,
        stop_requested_at:
          stops.find((s) => s.job === j.job)?.stop_requested_at ?? null,
        ...(j.stop === 'mahalla'
          ? {
              stop_requested: mahallaState?.stop_requested ?? null,
              run_started_at: mahallaState?.run_started_at ?? null,
              progress: mahallaState?.progress ?? null,
            }
          : {}),
        last_run: j.runs.length
          ? ((await recentJobRuns(this.db, j.runs, 1))[0] ?? null)
          : null,
      });
    }
    return {
      jobs,
      recent_controls: await recentJobRuns(this.db, [CONTROL_JOB], 10),
    };
  }

  /** Asks the job to stop at its next checkpoint. */
  async stop(job: string): Promise<Record<string, unknown>> {
    const j = this.find(job);
    if (!j.stop) {
      throw new BadRequestException(
        `${j.job} takes seconds and has no checkpoint to stop at; if its lock is stuck, POST /api/jobs/${j.job}/unlock`,
      );
    }
    if (j.job === WEEKLY_JOB) {
      // The chain and whichever step it is on.
      await requestJobStop(this.db, WEEKLY_JOB);
      await requestJobStop(this.db, NS_JOB);
      await requestJobStop(this.db, REGISTRIES_JOB);
      await this.mahalla.requestStop();
    } else if (j.stop === 'mahalla') {
      await this.mahalla.requestStop();
    } else {
      await requestJobStop(this.db, j.job);
    }
    const holder = await advisoryLockHolder(this.db, j.lock);
    const text =
      `⏹ <b>Stop requested by hand — ${escapeHtml(j.label)}</b>\n` +
      (holder
        ? `Running (pid ${holder.pid}, ${holder.held_minutes ?? '?'} min); it stops at its next checkpoint.`
        : 'Nothing was running; the next run is not affected.');
    await this.report(`stop ${j.job}`, text, { job: j.job, holder });
    return {
      job: j.job,
      stop_requested: true,
      running: holder !== null,
      lock_holder: holder,
    };
  }

  /**
   * Releases a lock that is held but not in use, by ending the database
   * session that holds it.
   */
  async unlock(job: string, force: boolean): Promise<Record<string, unknown>> {
    const j = this.find(job);
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const holder: LockHolder | null = await advisoryLockHolder(
        runner,
        j.lock,
      );
      if (!holder) {
        return { job: j.job, released: false, reason: 'the lock is not held' };
      }
      const held = holder.held_minutes ?? 0;
      if (!force && held < j.stuckAfterMinutes) {
        return {
          job: j.job,
          released: false,
          lock_holder: holder,
          reason:
            `held for ${held} min by pid ${holder.pid} (${holder.state ?? 'unknown state'}); ` +
            `a run normally ends within ${j.stuckAfterMinutes} min. Stop it first ` +
            `(POST /api/jobs/${j.job}/stop), or pass force=1 if it is really stuck.`,
        };
      }
      const [{ pid: own }] = await runner.query(
        'SELECT pg_backend_pid() AS pid',
      );
      let released: boolean;
      if (Number(own) === holder.pid) {
        // The pool handed us the very session that kept the lock (an unlock
        // that failed earlier): release it here instead of ending ourselves.
        const [{ ok }] = await runner.query(
          'SELECT pg_advisory_unlock($1) AS ok',
          [j.lock],
        );
        released = ok === true;
      } else {
        const [{ ok }] = await runner.query(
          'SELECT pg_terminate_backend($1) AS ok',
          [holder.pid],
        );
        released = ok === true;
      }
      const text =
        `🔓 <b>Lock released by hand — ${escapeHtml(j.label)}</b>\n` +
        `pid ${holder.pid} · ${holder.state ?? '?'} · held ${held} min` +
        `${force ? ' · force' : ''}${released ? '' : ' · Postgres did not confirm'}\n` +
        (holder.query ? `<code>${escapeHtml(holder.query)}</code>` : '');
      await this.report(`unlock ${j.job}`, text, {
        job: j.job,
        holder,
        force,
        released,
      });
      return { job: j.job, released, lock_holder: holder };
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  private async report(
    trigger: string,
    text: string,
    report: unknown,
  ): Promise<void> {
    this.logger.warn(`[jobs] ${trigger}: ${text.replace(/<[^>]+>/g, '')}`);
    const alertSent = await this.telegram.deliver(text, { tag: 'job_control' });
    await recordJobRun(this.db, {
      job: CONTROL_JOB,
      trigger,
      startedAt: new Date(),
      ok: true,
      summary: text,
      report,
      alertSent,
    });
  }
}
