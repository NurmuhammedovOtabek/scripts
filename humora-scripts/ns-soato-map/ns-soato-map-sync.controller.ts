import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { NsSoatoMapSyncService } from './ns-soato-map-sync.service';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';

/**
 * Admin trigger for the ns10/ns11 → SOATO sync, which otherwise runs every
 * Sunday at 04:30 with the company mahalla run. `dry=1` fetches the two
 * classifiers and compares, writes nothing. The report goes to Telegram and
 * `job_runs` either way; `status` reads them back.
 */
@UseGuards(AdminSecretGuard)
@Controller('ns-soato-map')
export class NsSoatoMapSyncController {
  constructor(private readonly sync: NsSoatoMapSyncService) {}

  @Post('sync')
  async runSync(@Query('dry') dry?: string) {
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

  /** How many pairs have a district, and the last ten runs. */
  @Get('status')
  status() {
    return this.sync.status();
  }
}
