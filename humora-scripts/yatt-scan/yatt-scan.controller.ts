import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { sequenceOfInn } from '../new-company-scan/inn-sequence';
import { nextWindowEnd } from '../yatt-crawl/yatt-crawl.service';
import {
  MAX_COUNT,
  PERSON_SEQUENCE,
  YattScanService,
  nightlyIntervalMs,
} from './yatt-scan.service';

/** The trader STIR scan, by hand (x-admin-secret). */
@UseGuards(AdminSecretGuard)
@Controller('yatt-scan')
export class YattScanController {
  constructor(private readonly scan: YattScanService) {}

  /**
   * Asks soliq about `count` people's STIRs and keeps the ones with a bank
   * account. Sequential by default: from `fromInn`, else from where the last
   * run ended. `mode=random` samples instead (`prefix=4|5|6` narrows it).
   * Answers at once and reports to Telegram; `wait=1` answers with the
   * report.
   */
  @Post('run')
  async run(
    @Query('count') count?: string,
    @Query('mode') mode?: string,
    @Query('fromInn') fromInn?: string,
    @Query('prefix') prefix?: string,
    @Query('wait') wait?: string,
  ) {
    const howMany = Number(count);
    if (!Number.isInteger(howMany) || howMany < 1 || howMany > MAX_COUNT) {
      throw new BadRequestException(
        `count must be a whole number from 1 to ${MAX_COUNT}`,
      );
    }
    const scanMode = mode === 'random' ? 'random' : 'sequential';
    if (mode !== undefined && mode !== 'random' && mode !== 'sequential') {
      throw new BadRequestException('mode must be sequential or random');
    }
    if (fromInn !== undefined) {
      if (scanMode === 'random') {
        throw new BadRequestException('fromInn is for a sequential run');
      }
      const seq = sequenceOfInn(fromInn);
      if (
        seq === null ||
        seq < PERSON_SEQUENCE.first ||
        seq > PERSON_SEQUENCE.last
      ) {
        throw new BadRequestException(
          "fromInn must be a person's STIR that can exist: nine digits, 4, 5 or 6 first, a matching check digit",
        );
      }
    }
    let digit: 4 | 5 | 6 | undefined;
    if (prefix !== undefined) {
      if (scanMode !== 'random' || !['4', '5', '6'].includes(prefix)) {
        throw new BadRequestException('prefix is 4, 5 or 6, with mode=random');
      }
      digit = Number(prefix) as 4 | 5 | 6;
    }

    const started = await this.scan.start(
      { count: howMany, mode: scanMode, fromInn, prefix: digit },
      `manual, ${scanMode}, ${howMany}`,
    );
    if (!started.started) {
      return { started: false, reason: started.reason };
    }
    if (wait === '1') {
      return { started: true, report: await started.done };
    }
    return { started: true, reason: null };
  }

  /**
   * The nightly sweep now, by hand: from its own cursor, at its own pace,
   * until 06:00 Tashkent or for `hours`. Answers at once; Telegram reports.
   *
   * `count` makes it a sample of the night (user request 2026-10-20: try
   * the night's work by day before it goes to production): the same cursor,
   * pace, candidates, block tallies and Telegram, ending after `count`
   * STIRs. At two a second, `count=100` takes about 50 s; `wait=1` answers
   * with the report — past ~100 the proxy may give up waiting first, and
   * the run carries on regardless (`GET /yatt-scan/status`).
   */
  @Post('night')
  async night(
    @Query('hours') hours?: string,
    @Query('count') count?: string,
    @Query('wait') wait?: string,
  ) {
    let deadline = nextWindowEnd(new Date());
    if (hours !== undefined) {
      const h = Number(hours);
      if (!Number.isFinite(h) || h <= 0 || h > 12) {
        throw new BadRequestException('hours must be from 0 to 12');
      }
      deadline = new Date(Date.now() + h * 3_600_000);
    }
    let howMany: number | undefined;
    if (count !== undefined) {
      howMany = Number(count);
      if (!Number.isInteger(howMany) || howMany < 1 || howMany > MAX_COUNT) {
        throw new BadRequestException(
          `count must be a whole number from 1 to ${MAX_COUNT}`,
        );
      }
    }
    const run = await this.scan.start(
      {
        mode: 'nightly',
        deadline,
        count: howMany,
        intervalMs: nightlyIntervalMs(),
        concurrency: 1,
      },
      howMany !== undefined
        ? `sample night, ${howMany} STIRs`
        : hours
          ? `manual night, ${hours} h`
          : 'manual night',
    );
    if (run.started && wait === '1') {
      return { started: true, until: deadline, report: await run.done };
    }
    return { started: run.started, reason: run.reason, until: deadline };
  }

  /** The density map: `order=dense` (default) or `recent`, `limit` ≤ 500. */
  @Get('blocks')
  blocks(@Query('limit') limit?: string, @Query('order') order?: string) {
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      throw new BadRequestException('limit must be from 1 to 500');
    }
    if (order !== undefined && order !== 'dense' && order !== 'recent') {
      throw new BadRequestException('order is dense or recent');
    }
    return this.scan.blocks(n, order === 'recent' ? 'recent' : 'dense');
  }

  /** Stops after the STIRs in hand, on whichever replica runs it. */
  @Post('stop')
  stop() {
    return this.scan.requestStop();
  }

  @Get('status')
  status() {
    return this.scan.status();
  }

  /** The newest candidates (`limit`, default 50, at most 500). */
  @Get('candidates')
  candidates(@Query('limit') limit?: string) {
    const n = limit === undefined ? 50 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      throw new BadRequestException('limit must be from 1 to 500');
    }
    return this.scan.candidates(n);
  }
}
