import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { SoatoSeedService } from './soato-seed.service';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';

/**
 * Admin trigger for the SOATO seeder. The data set is static (~3 200 rows
 * shipped as a versioned JSON in the repo), so this endpoint is intended to
 * be called once after the migration runs — and again only when the seed
 * JSON is regenerated from a newer PDF revision.
 *
 * "Admin trigger" was the intent from the start; until 2026-08-30 nothing
 * enforced it, and reset-and-seed — which truncates three reference tables
 * before refilling them — answered anyone who found the path. If the refill
 * had then failed, /api/regions and every branch SOATO lookup would have been
 * left reading empty tables.
 */
@UseGuards(AdminSecretGuard)
@Controller('soato')
export class SoatoSeedController {
  constructor(private readonly seeder: SoatoSeedService) {}

  @Post('seed')
  async runSeed() {
    try {
      const result = await this.seeder.seedFromFile();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /** Truncates regions/districts/settlements then re-seeds from JSON. */
  @Post('reset-and-seed')
  @HttpCode(200)
  async resetAndSeed() {
    try {
      const result = await this.seeder.resetAndSeed();
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }
}
