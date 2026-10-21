import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { OpeninfoSyncMode, OpeninfoSyncService } from './openinfo-sync.service';

const MODES: OpeninfoSyncMode[] = ['daily', 'weekly', 'full', 'company'];

/**
 * openinfo.uz by hand; otherwise it runs at 03:20 daily and Sunday 00:30.
 *
 * - `mode=daily|weekly|full|company` (default daily); `company` takes
 *   `inn=<STIR>` and reads that company's facts, every content and its
 *   statements.
 * - `details=N` reads at most N fact contents this run (`0`: none).
 * - The run answers at once and reports to Telegram and `job_runs`;
 *   `wait=1` holds the answer until it ends.
 */
@UseGuards(AdminSecretGuard)
@Controller('openinfo-sync')
export class OpeninfoSyncController {
  constructor(private readonly sync: OpeninfoSyncService) {}

  @Post('run')
  async run(
    @Query('mode') mode?: string,
    @Query('inn') inn?: string,
    @Query('details') details?: string,
    @Query('wait') wait?: string,
  ) {
    const m = (MODES as string[]).includes(mode ?? '')
      ? (mode as OpeninfoSyncMode)
      : 'daily';
    if (m === 'company' && !/^\d{9}$/.test(inn ?? '')) {
      return { success: false, error: 'mode=company needs inn=<9-digit STIR>' };
    }
    const limit =
      details !== undefined && /^\d+$/.test(details)
        ? Number(details)
        : undefined;
    const opts = {
      mode: m,
      inn: m === 'company' ? inn : undefined,
      detailLimit: limit,
    };
    const trigger = `manual, ${m}`;
    if (wait === '1' || wait === 'true') {
      try {
        const result = await this.sync.run(opts, trigger);
        if (!result)
          return { success: false, error: 'another replica is syncing' };
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }
    const started = await this.sync.start(opts, trigger);
    if (!started.started) return { success: false, error: started.reason };
    started.done.catch(() => undefined);
    return {
      success: true,
      started: true,
      mode: m,
      report: 'Telegram, and GET /openinfo-sync/status',
    };
  }

  /** Ends the walk running on this replica at its next request. */
  @Post('stop')
  stop() {
    this.sync.requestStop();
    return { success: true };
  }

  @Get('status')
  status() {
    return this.sync.status();
  }
}
