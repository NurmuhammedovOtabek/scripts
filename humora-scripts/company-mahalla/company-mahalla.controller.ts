import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { CompanyMahallaService } from './company-mahalla.service';
import { VillageMapStatus } from './company-mahalla.resolver';

const STATUSES: VillageMapStatus[] = ['auto', 'review', 'manual', 'none'];
/** The reasons a name was given and still matched nothing. */
const UNMATCHED_REASONS = ['not_found', 'ambiguous', 'unknown_district'];

/**
 * The company mahalla fill, for operators (`x-admin-secret`). Messages are
 * English like every other secret-gated script route.
 */
@UseGuards(AdminSecretGuard)
@Controller('company-mahalla')
export class CompanyMahallaController {
  constructor(private readonly mahalla: CompanyMahallaService) {}

  /**
   * Starts a full run; the report arrives in Telegram and in `status`.
   * `dry=1` computes everything and writes nothing — the way to read the
   * numbers on a database before letting it write.
   */
  @Post('run')
  async run(@Query('dry') dry?: string) {
    const isDry = dry === '1' || dry === 'true';
    const run = await this.mahalla.start(
      { dry: isDry },
      isDry ? 'manual, dry run' : 'manual',
    );
    return { started: run.started, reason: run.reason, dry: isDry };
  }

  /** Stops the running full run after the batch it is on. */
  @Post('stop')
  stop() {
    return this.mahalla.requestStop();
  }

  @Get('status')
  status() {
    return this.mahalla.status();
  }

  /** Every step tried for one company, and what is stored for it. */
  @Get('inn/:inn')
  explain(@Param('inn') inn: string) {
    CompanyMahallaController.assertInn(inn);
    return this.mahalla.explain(inn);
  }

  /** Resolves one company now and stores it if it changed. */
  @Post('inn/:inn/refresh')
  refresh(@Param('inn') inn: string) {
    CompanyMahallaController.assertInn(inn);
    return this.mahalla.refreshInns([inn]);
  }

  private static assertInn(inn: string): void {
    if (!/^\d{9,14}$/.test(inn ?? '')) {
      throw new BadRequestException('inn must be 9 to 14 digits');
    }
  }

  /**
   * The names that most often matched nothing, grouped by district and name:
   * `reason` not_found (default) · ambiguous · unknown_district, optionally
   * one `district` (7-digit SOATO), `limit` groups (default 100).
   */
  @Get('unmatched')
  unmatched(
    @Query('reason') reason?: string,
    @Query('district') district?: string,
    @Query('limit') limit?: string,
  ) {
    const r = reason ?? 'not_found';
    if (!UNMATCHED_REASONS.includes(r)) {
      throw new BadRequestException(
        `reason must be one of ${UNMATCHED_REASONS.join(', ')}`,
      );
    }
    if (district !== undefined && !/^\d{7}$/.test(district)) {
      throw new BadRequestException('district must be a 7-digit SOATO');
    }
    const n = limit === undefined ? 100 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      throw new BadRequestException('limit must be an integer from 1 to 1000');
    }
    return this.mahalla.listUnmatched(r, n, district ?? null);
  }

  /**
   * The village-code map, most-used first. `status=review` lists the
   * proposals nobody has confirmed; `none` the codes nothing was found for.
   */
  @Get('village-map')
  villageMap(@Query('status') status?: string, @Query('limit') limit?: string) {
    if (status && !STATUSES.includes(status as VillageMapStatus)) {
      throw new BadRequestException(
        `status must be one of ${STATUSES.join(', ')}`,
      );
    }
    const n = limit === undefined ? 200 : Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > 5000) {
      throw new BadRequestException('limit must be an integer from 1 to 5000');
    }
    return this.mahalla.listVillageMap((status as VillageMapStatus) ?? null, n);
  }

  /**
   * A person's decision for village codes:
   * `{ "items": [{ "villageCode": "8096", "mahallaCode": "1730401016" }] }`.
   * `mahallaCode: null` marks a code as no nameable mahalla; `reset: true`
   * hands it back to the fill. The companies carrying the codes are resolved
   * again before this answers.
   */
  @Put('village-map')
  async setVillageMap(@Body() body: any) {
    const items = body?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 1000) {
      throw new BadRequestException(
        'items must be an array of 1 to 1000 entries',
      );
    }
    const parsed = items.map((it: any, i: number) => {
      const villageCode = String(it?.villageCode ?? '').trim();
      if (!/^\d{1,16}$/.test(villageCode)) {
        throw new BadRequestException(`items[${i}].villageCode must be digits`);
      }
      const reset = it?.reset === true;
      const mahallaCode =
        it?.mahallaCode === null || it?.mahallaCode === undefined
          ? null
          : String(it.mahallaCode).trim();
      if (!reset && it?.mahallaCode === undefined) {
        throw new BadRequestException(
          `items[${i}] needs mahallaCode (a code or null) or reset: true`,
        );
      }
      if (mahallaCode !== null && !/^\d{10}$/.test(mahallaCode)) {
        throw new BadRequestException(
          `items[${i}].mahallaCode must be 10 digits or null`,
        );
      }
      return { villageCode, mahallaCode, reset };
    });

    const wanted = parsed
      .map((p) => p.mahallaCode)
      .filter((c): c is string => c !== null);
    const known = await this.mahalla.existingMahallas(wanted);
    const unknown = wanted.filter((c) => !known.has(c));
    if (unknown.length) {
      throw new BadRequestException(
        `not a mahalla in public.territory: ${unknown.join(', ')}`,
      );
    }
    return this.mahalla.setVillageMappings(parsed);
  }
}
