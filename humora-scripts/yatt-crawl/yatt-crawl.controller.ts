import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { YattCrawlService } from './yatt-crawl.service';

@UseGuards(AdminSecretGuard)
@Controller('yatt-crawl')
export class YattCrawlController {
  constructor(private readonly crawl: YattCrawlService) {}

  /**
   * Starts the walk now; it answers at once and reports to Telegram.
   * `limit=20` walks 20 ids (a trial), `fromId` starts elsewhere (1 = a new
   * cycle after the end was reached), `hours` stops it sooner than the next
   * 06:00 Tashkent.
   */
  @Post('run')
  async run(
    @Query('limit') limit?: string,
    @Query('fromId') fromId?: string,
    @Query('hours') hours?: string,
  ) {
    const positive = (name: string, v?: string) => {
      if (v === undefined) return undefined;
      const num = Number(v);
      if (!Number.isFinite(num) || num <= 0) {
        throw new BadRequestException(`${name} must be a positive number`);
      }
      return num;
    };
    const lim = positive('limit', limit);
    const from = positive('fromId', fromId);
    const h = positive('hours', hours);
    if (from !== undefined && !Number.isInteger(from)) {
      throw new BadRequestException('fromId must be an integer');
    }
    const run = await this.crawl.start(
      {
        limit: lim !== undefined ? Math.floor(lim) : undefined,
        fromId: from,
        deadline: h ? new Date(Date.now() + h * 3_600_000) : undefined,
      },
      lim ? `manual, ${Math.floor(lim)} ids` : 'manual',
    );
    return { started: run.started, reason: run.reason };
  }

  /** Stops after the id in hand, on whichever replica runs it. */
  @Post('stop')
  stop() {
    return this.crawl.requestStop();
  }

  @Get('status')
  status() {
    return this.crawl.status();
  }
}
