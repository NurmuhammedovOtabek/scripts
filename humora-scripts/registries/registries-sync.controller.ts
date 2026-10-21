import {
  BadRequestException,
  Controller,
  Get,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes } from '@nestjs/swagger';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { uploadedRows } from './adapters/manual.adapters';
import { adapterByCode } from './registry-catalog';
import {
  RegistriesSyncService,
  RegistryRunOptions,
  RegistryRunScope,
} from './registries-sync.service';

const SCOPES: RegistryRunScope[] = ['nightly', 'weekly', 'all'];
const truthy = (v?: string) => v === '1' || v === 'true';

/**
 * The register sync by hand; otherwise the daily registers run at 03:10
 * Monday to Saturday and the rest in the Sunday chain.
 *
 * - `source=a,b` reads those registers (any cadence); `scope=nightly|weekly|all`
 *   picks by cadence (default `all`).
 * - `limit=N` is a trial: at most N requests per register, nothing delisted.
 * - `dry=1` reads and compares, writes nothing; the answer is the report.
 * - `reread=1` reads every file again — by default a file the last run read
 *   (same address) is left alone and its entries kept (Sanepid's quarters).
 * - A real run answers at once and carries on (`wait=1` holds the answer).
 *   The report goes to Telegram (#registries) and `job_runs`; `status` reads
 *   them back.
 */
@UseGuards(AdminSecretGuard)
@Controller('registries-sync')
export class RegistriesSyncController {
  constructor(private readonly sync: RegistriesSyncService) {}

  private options(q: {
    source?: string;
    scope?: string;
    limit?: string;
    dry?: string;
    reread?: string;
  }): RegistryRunOptions {
    const sources = (q.source ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && s !== 'all');
    const scope = SCOPES.includes(q.scope as RegistryRunScope)
      ? (q.scope as RegistryRunScope)
      : 'all';
    const limit = q.limit ? Number(q.limit) : undefined;
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      throw new BadRequestException('limit must be a positive whole number');
    }
    return {
      scope,
      sources: sources.length ? sources : undefined,
      limit,
      dry: truthy(q.dry),
      reread: truthy(q.reread),
    };
  }

  @Post('run')
  async run(
    @Query('source') source?: string,
    @Query('scope') scope?: string,
    @Query('limit') limit?: string,
    @Query('dry') dry?: string,
    @Query('wait') wait?: string,
    @Query('reread') reread?: string,
  ) {
    const opts = this.options({ source, scope, limit, dry, reread });
    const trigger =
      `manual, ${opts.sources?.join(',') ?? opts.scope}` +
      (opts.limit ? `, trial ≤${opts.limit}` : '') +
      (opts.reread ? ', every file again' : '') +
      (opts.dry ? ', dry run' : '');
    try {
      if (opts.dry || truthy(wait)) {
        const result = await this.sync.run(opts, trigger);
        if (!result)
          return { success: false, error: 'another replica is syncing' };
        return { success: true, ...result };
      }
      const started = await this.sync.start(opts, trigger);
      if (!started.started) return { success: false, error: started.reason };
      started.done.catch(() => undefined);
      return {
        success: true,
        started: true,
        report: 'Telegram #registries, and GET /registries-sync/status',
      };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /** Registers, what each holds, the last read and error, the last runs. */
  @Get('status')
  status() {
    return this.sync.status();
  }

  /**
   * A file for a register published only as a document (cadence `manual`):
   * XLSX or CSV, first row the column names, a `stir` column required.
   */
  @Post('upload')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 30 * 1024 * 1024 } }),
  )
  @ApiConsumes('multipart/form-data')
  async upload(
    @Query('source') source: string,
    @Query('dry') dry: string | undefined,
    @UploadedFile() file: Express.Multer.File | undefined,
  ) {
    const adapter = adapterByCode(source ?? '');
    if (!adapter) throw new BadRequestException(`unknown register: ${source}`);
    if (adapter.meta.cadence !== 'manual') {
      throw new BadRequestException(
        `${source} is read from the web; use POST /registries-sync/run?source=${source}`,
      );
    }
    if (!file?.buffer?.length) throw new BadRequestException('no file');
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await uploadedRows(file.buffer, file.originalname ?? '');
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    const result = await this.sync.run(
      { sources: [source], dry: truthy(dry), upload: { rows } },
      `upload ${source}${truthy(dry) ? ', dry run' : ''}`,
    );
    if (!result) return { success: false, error: 'another replica is syncing' };
    return { success: true, ...result };
  }

  /** Phase C: ties rows of name-only registers to a company by exact name. */
  @Post('match')
  async match(@Query('source') source?: string, @Query('dry') dry?: string) {
    const codes = (source ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    return {
      success: true,
      matches: await this.sync.matchNames(
        codes.length ? codes : null,
        truthy(dry),
      ),
    };
  }
}
