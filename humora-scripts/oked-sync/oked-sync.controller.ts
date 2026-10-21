import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { OkedSyncService } from './oked-sync.service';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';

/**
 * The OKED classifier sync by hand; otherwise it runs every Sunday at 04:30
 * with the bank registry. `dry=1` fetches and compares, writes nothing. The
 * report goes to Telegram and `job_runs` either way; `status` reads them back.
 */
@UseGuards(AdminSecretGuard)
@Controller('oked-sync')
export class OkedSyncController {
  constructor(private readonly sync: OkedSyncService) {}

  @Post('run')
  async run(@Query('dry') dry?: string) {
    const isDry = dry === '1' || dry === 'true';
    try {
      const result = await this.sync.run(
        { dry: isDry },
        isDry ? 'manual, dry run' : 'manual',
      );
      if (!result) {
        return { success: false, error: 'another replica is syncing' };
      }
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /** Nodes held per level, when the table last changed, the last ten runs. */
  @Get('status')
  status() {
    return this.sync.status();
  }
}
