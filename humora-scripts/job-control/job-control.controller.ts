import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { JobControlService } from './job-control.service';

/**
 * By hand, for a run that will not end (x-admin-secret):
 * - `GET /jobs` — each job's lock holder and for how long, stop requests,
 *   last run;
 * - `POST /jobs/:job/stop` — stop at the next checkpoint (weekly,
 *   company_mahalla, ns_soato_map);
 * - `POST /jobs/:job/unlock[?force=1]` — release a lock left by a session
 *   that is gone (weekly, company_mahalla, ns_soato_map, bank_registry,
 *   oked_tree, company_accreditations).
 */
@UseGuards(AdminSecretGuard)
@Controller('jobs')
export class JobControlController {
  constructor(private readonly jobs: JobControlService) {}

  @Get()
  status() {
    return this.jobs.status();
  }

  @Post(':job/stop')
  stop(@Param('job') job: string) {
    return this.jobs.stop(job);
  }

  @Post(':job/unlock')
  unlock(@Param('job') job: string, @Query('force') force?: string) {
    return this.jobs.unlock(job, force === '1' || force === 'true');
  }
}
