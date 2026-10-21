import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { AuctionSyncService } from './auction-sync.service';

/**
 * Admin triggers for the auction catalogue.
 *
 * The nightly job keeps the table current by itself; these exist for the
 * one-off first load, which is 219k rows and roughly 440 pages. `backfill`
 * takes a bounded number of pages per call and moves a cursor, so it can be
 * driven to completion by calling it repeatedly without any call running for
 * an hour or losing its place if it fails halfway.
 *
 * `x-admin-secret` is what makes "admin trigger" true rather than a comment:
 * an unguarded loop here would walk a government catalogue as fast as the
 * network allows.
 */
@UseGuards(AdminSecretGuard)
@Controller('auction')
export class AuctionController {
  constructor(private readonly sync: AuctionSyncService) {}

  /**
   * Walk another slice of the backfill.
   *
   * `pages` is capped so a mistyped value cannot turn one call into a run long enough to
   * outlive the request that started it — twenty pages is about three
   * minutes; `done` in the reply says whether it is finished.
   */
  @Post('backfill')
  async backfill(@Query('pages') pages?: string) {
    const requested = Number(pages);
    const bounded = Number.isFinite(requested)
      ? Math.min(Math.max(Math.trunc(requested), 1), 20)
      : undefined;
    try {
      return { success: true, ...(await this.sync.backfill(bounded)) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /** The nightly pass, on demand — the last two days plus anything new. */
  @Post('increment')
  async increment() {
    try {
      return { success: true, ...(await this.sync.increment()) };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /** Where the backfill has got to. */
  @Get('cursor')
  async cursor() {
    return this.sync.cursor();
  }

  /** Start the backfill again from the top. */
  @Post('cursor/reset')
  async reset() {
    await this.sync.resetCursor();
    return { success: true };
  }
}
