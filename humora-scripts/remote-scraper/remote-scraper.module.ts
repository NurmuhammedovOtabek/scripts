import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RemoteScraperService } from './remote-scraper.service';
import { GovLicenseStore } from './gov-license.store';
import { LicenseProcessor } from './license.processor';
import { LicenseQueueService } from './license-queue.service';
import { LICENSE_QUEUE } from './license-queue.constants';
import { ScraperLogsController } from './scraper-logs.controller';
import { TelegramAlertService } from '../common/telegram-alert.service';

/**
 * The scraper box and the queue that feeds it.
 *
 * Jobs live in Redis, which means they survive a restart and are shared across
 * instances — the previous in-process promise chain did neither, so a deploy
 * dropped whatever was waiting and a second instance would have run its own
 * parallel queue against a box that can only do one thing at a time.
 *
 * The Redis connection itself comes from BullRootModule.
 */
@Module({
  imports: [BullModule.registerQueue({ name: LICENSE_QUEUE })],
  controllers: [ScraperLogsController],
  providers: [
    RemoteScraperService,
    TelegramAlertService,
    GovLicenseStore,
    LicenseProcessor,
    LicenseQueueService,
  ],
  exports: [RemoteScraperService, LicenseQueueService],
})
export class RemoteScraperModule {}
