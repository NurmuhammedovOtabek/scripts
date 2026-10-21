import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import {
  AccreditationSyncMode,
  AccreditationSyncService,
} from './accreditation-sync.service';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';

/**
 * The accreditation register sync by hand; otherwise it reads the newest
 * changes at 03:40 Monday to Saturday and the whole register in the Sunday
 * 04:30 chain.
 *
 * - `mode=full` reads the whole register now (the default is the newest
 *   changes; an empty table is always read whole).
 * - `dry=1` reads and compares, writes nothing and fetches no documents —
 *   seconds, so the answer is the report itself.
 * - A real run answers at once and carries on: the first copy of the
 *   documents takes about half an hour. `wait=1` holds the answer until it
 *   ends. The report goes to Telegram and `job_runs` either way; `status`
 *   reads them back.
 */
@UseGuards(AdminSecretGuard)
@Controller('accreditation-sync')
export class AccreditationSyncController {
  constructor(private readonly sync: AccreditationSyncService) {}

  @Post('run')
  async run(
    @Query('mode') mode?: string,
    @Query('dry') dry?: string,
    @Query('wait') wait?: string,
  ) {
    const isDry = dry === '1' || dry === 'true';
    const opts: { mode: AccreditationSyncMode; dry: boolean } = {
      mode: mode === 'full' ? 'full' : 'nightly',
      dry: isDry,
    };
    const trigger = `manual${opts.mode === 'full' ? ', whole register' : ''}${isDry ? ', dry run' : ''}`;

    if (isDry || wait === '1' || wait === 'true') {
      try {
        const result = await this.sync.run(opts, trigger);
        if (!result) {
          return { success: false, error: 'another replica is syncing' };
        }
        return { success: true, ...result };
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    }

    const started = await this.sync.start(opts, trigger);
    if (!started.started) return { success: false, error: started.reason };
    // The run reports its own failure; nothing is left to throw here.
    started.done.catch(() => undefined);
    return {
      success: true,
      started: true,
      mode: opts.mode,
      report: 'Telegram, and GET /accreditation-sync/status',
    };
  }

  /** Units and documents held, by status, and the last ten runs. */
  @Get('status')
  status() {
    return this.sync.status();
  }
}
