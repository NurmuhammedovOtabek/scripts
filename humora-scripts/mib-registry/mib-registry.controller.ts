import {
  Controller,
  Get,
  Param,
  Post,
  Headers,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { MibRegistryService, MibRegistry } from './mib-registry.service';

const REGISTRIES: readonly MibRegistry[] = ['alimony', 'wanted'];

@ApiTags('MIB Registry')
@Controller('scripts/mib-registry')
export class MibRegistryController {
  constructor(private readonly service: MibRegistryService) {}

  /** Read from DB — which lists this STIR is currently on. */
  @Get('inn/:inn')
  @ApiOperation({
    summary:
      'Which mib.uz list (alimony / wanted) this STIR is currently on, from DB. ' +
      'Admin only.',
  })
  async getByInn(
    @Param('inn') inn: string,
    @Headers('x-admin-secret') secret?: string,
  ) {
    // Admin-gated despite being a read: "is this person an alimony debtor or
    // on the wanted list" is exactly the kind of answer that must not be
    // available to anyone who can guess a STIR.
    this.assertAdmin(secret);
    const rows = await this.service.findByInn(inn);
    return { total: rows.length, rows };
  }

  /**
   * Live fetch with no DB write. For checking that the source still answers
   * and still has the shape we parse — the page carries the data URL inline,
   * so a page redesign breaks the import silently rather than loudly.
   */
  @Get(':registry/fresh')
  @ApiOperation({
    summary:
      'Live fetch of one list from mib.uz (no DB write). Uzbekistan IP ' +
      'required. Admin only.',
  })
  async fresh(
    @Param('registry') registry: string,
    @Headers('x-admin-secret') secret?: string,
  ) {
    this.assertAdmin(secret);
    const r = this.assertRegistry(registry);
    const { rows, truncated } = await this.service.fetch(r);
    return {
      registry: r,
      fetched: rows.length,
      truncated,
      sample: rows.slice(0, 5),
    };
  }

  /** Bulk import both lists into `person_mib_registry`. */
  @Post('sync')
  @ApiOperation({ summary: 'Sync both mib.uz lists into the DB.' })
  async syncAll(@Headers('x-admin-secret') secret: string) {
    this.assertAdmin(secret);
    return this.service.syncAll();
  }

  /** Bulk import one list. */
  @Post('sync/:registry')
  @ApiOperation({ summary: 'Sync one list (alimony | wanted) into the DB.' })
  async sync(
    @Param('registry') registry: string,
    @Headers('x-admin-secret') secret: string,
  ) {
    this.assertAdmin(secret);
    return this.service.sync(this.assertRegistry(registry));
  }

  private assertAdmin(secret: string): void {
    if (secret !== process.env.ADMIN_SECRET) {
      throw new UnauthorizedException('Bad x-admin-secret');
    }
  }

  private assertRegistry(value: string): MibRegistry {
    if (!REGISTRIES.includes(value as MibRegistry)) {
      throw new BadRequestException(
        `registry must be one of: ${REGISTRIES.join(', ')}`,
      );
    }
    return value as MibRegistry;
  }
}
