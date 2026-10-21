import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { ContactFillService } from './contact-fill.service';

@UseGuards(AdminSecretGuard)
@Controller('contact-fill')
export class ContactFillController {
  constructor(private readonly fill: ContactFillService) {}

  /**
   * Runs the fill now rather than waiting for the next new-company scan; the
   * report arrives in Telegram.
   *
   * By default every company without a contact, newest STIR first; `days`
   * narrows that to recent registrations. `limit` caps how many companies are
   * asked about (at most 2000), and `fromInn` restarts the walk at a STIR rather than at the
   * cursor — how a stretch a failed run left behind gets picked up again.
   * `recheckDays=3` runs the twice-daily recheck now: every contactless
   * company of the last N days, newest first, the cursor left alone.
   */
  @Post('run')
  async run(
    @Query('days') days?: string,
    @Query('limit') limit?: string,
    @Query('fromInn') fromInn?: string,
    @Query('recheckDays') recheckDays?: string,
  ) {
    const parsed = {
      recheckDays: this.num(recheckDays, 'recheckDays', 1, 30),
      days: this.num(days, 'days', 1, 3650),
      limit: this.num(limit, 'limit', 1, 2000),
      fromInn,
    };
    if (fromInn !== undefined && !/^\d{9}$/.test(fromInn)) {
      throw new BadRequestException('fromInn must be nine digits');
    }

    const run = await this.fill.start(parsed, 'by hand');
    return { started: run.started, reason: run.reason };
  }

  @Get('status')
  status() {
    return this.fill.status();
  }

  private num(
    raw: string | undefined,
    name: string,
    min: number,
    max: number,
  ): number | undefined {
    if (raw === undefined) return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new BadRequestException(`${name} must be an integer ${min}–${max}`);
    }
    return n;
  }
}
