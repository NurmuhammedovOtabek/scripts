import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { BankRegistrySyncService } from './bank-registry-sync.service';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';

/**
 * Admin trigger for the bank-registry sync, which otherwise runs every Sunday
 * at 04:30 with the company mahalla run. `dry=1` fetches and compares, writes
 * nothing. The report goes to Telegram and `job_runs` either way; `status`
 * reads them back.
 *
 * The x-admin-secret header is what makes "admin trigger" true; it was
 * only a description until 2026-08-30.
 */
@UseGuards(AdminSecretGuard)
@Controller('bank-registry')
export class BankRegistrySyncController {
  constructor(private readonly sync: BankRegistrySyncService) {}

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

  /** Counts, when the tables last changed, and the last ten runs. */
  @Get('status')
  status() {
    return this.sync.status();
  }
}
