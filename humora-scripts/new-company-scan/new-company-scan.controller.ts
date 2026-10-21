import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { NewCompanyScanService } from './new-company-scan.service';
import {
  BackfillOptions,
  MAX_CONCURRENCY,
  NewCompanyBackfillService,
} from './new-company-backfill.service';
import { LEGAL_ENTITY_SEQUENCE, sequenceOfInn } from './inn-sequence';

@UseGuards(AdminSecretGuard)
@Controller('new-company-scan')
export class NewCompanyScanController {
  constructor(
    private readonly scan: NewCompanyScanService,
    private readonly backfill: NewCompanyBackfillService,
  ) {}

  /**
   * Runs the scan now instead of at 00:30; the report arrives in Telegram.
   *
   * `fromInn` walks from that STIR rather than from a week behind the frontier
   * — how a stretch the nightly lookback no longer reaches gets filled.
   */
  @Post('run')
  async run(@Query('fromInn') fromInn?: string) {
    if (fromInn !== undefined) {
      const sequence = sequenceOfInn(fromInn);
      if (
        sequence === null ||
        sequence < LEGAL_ENTITY_SEQUENCE.first ||
        sequence > LEGAL_ENTITY_SEQUENCE.last
      ) {
        throw new BadRequestException(
          'fromInn must be a legal-entity STIR: nine digits starting with 3, with a valid check digit',
        );
      }
    }
    const run = await this.scan.start(
      { fromInn },
      fromInn ? `by hand, from ${fromInn}` : 'by hand',
    );
    return { started: run.started, reason: run.reason };
  }

  @Get('status')
  status() {
    return this.scan.status();
  }

  /**
   * What a backfill would walk and roughly how long it would take — one
   * query, nothing asked from mysoliq. Same parameters as `backfill/run`.
   */
  @Get('backfill/plan')
  async backfillPlan(
    @Query('fromInn') fromInn?: string,
    @Query('toInn') toInn?: string,
    @Query('afterMonth') afterMonth?: string,
    @Query('limit') limit?: string,
  ) {
    const options = this.backfillOptions({ fromInn, toInn, afterMonth, limit });
    try {
      return await this.backfill.plan(options);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  /**
   * Fills the stretch of the counter the two-hourly scan never walked: by
   * default from the last company registered in April to the scan's
   * frontier. Answers at once; progress goes to Telegram and to
   * `backfill/status`.
   *
   * With no `fromInn`/`toInn` an unfinished run is continued where it
   * stopped; `fresh=1` starts over. `concurrency` (1..5, default 2) is how
   * many mysoliq lookups run at a time. `limit=20` walks only the first 20
   * numbers — a trial; a later run without it starts over, and the numbers
   * the trial listed are held by then, so they are not asked again.
   */
  @Post('backfill/run')
  async backfillRun(
    @Query('fromInn') fromInn?: string,
    @Query('toInn') toInn?: string,
    @Query('afterMonth') afterMonth?: string,
    @Query('concurrency') concurrency?: string,
    @Query('fresh') fresh?: string,
    @Query('limit') limit?: string,
  ) {
    const options = this.backfillOptions({
      fromInn,
      toInn,
      afterMonth,
      concurrency,
      fresh,
      limit,
    });
    const run = await this.backfill.start(options, 'manual');
    return {
      started: run.started,
      reason: run.reason,
      runId: run.runId,
      resumed: run.resumed,
      range: run.range,
    };
  }

  /** Stops the walk after its current chunk, on whichever replica runs it. */
  @Post('backfill/stop')
  backfillStop() {
    return this.backfill.requestStop();
  }

  @Get('backfill/status')
  backfillStatus() {
    return this.backfill.status();
  }

  private backfillOptions(query: {
    fromInn?: string;
    toInn?: string;
    afterMonth?: string;
    concurrency?: string;
    fresh?: string;
    limit?: string;
  }): BackfillOptions {
    for (const [name, inn] of [
      ['fromInn', query.fromInn],
      ['toInn', query.toInn],
    ] as const) {
      if (inn === undefined) continue;
      const sequence = sequenceOfInn(inn);
      if (
        sequence === null ||
        sequence < LEGAL_ENTITY_SEQUENCE.first ||
        sequence > LEGAL_ENTITY_SEQUENCE.last
      ) {
        throw new BadRequestException(
          `${name} must be a legal-entity STIR: nine digits starting with 3, with a valid check digit`,
        );
      }
    }
    if (
      query.afterMonth !== undefined &&
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(query.afterMonth)
    ) {
      throw new BadRequestException('afterMonth must be YYYY-MM');
    }
    let concurrency: number | undefined;
    if (query.concurrency !== undefined) {
      concurrency = Number(query.concurrency);
      if (
        !Number.isInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > MAX_CONCURRENCY
      ) {
        throw new BadRequestException(
          `concurrency must be 1..${MAX_CONCURRENCY}`,
        );
      }
    }
    let limit: number | undefined;
    if (query.limit !== undefined) {
      limit = Number(query.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1_000_000) {
        throw new BadRequestException('limit must be a positive integer');
      }
    }
    return {
      limit,
      fromInn: query.fromInn,
      toInn: query.toInn,
      afterMonth: query.afterMonth,
      concurrency,
      fresh: query.fresh === '1' || query.fresh === 'true',
    };
  }
}
