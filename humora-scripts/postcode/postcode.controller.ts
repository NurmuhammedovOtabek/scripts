import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { PostcodeSeedService } from './postcode-seed.service';
import { PostcodeWatchService } from './postcode-watch.service';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';

/**
 * The postal-code reference tables by hand. They load themselves from the
 * bundled file after boot when its version is new; `reload` loads it again
 * now. `status?coverage=1` also counts companies by the kind of code they get.
 * `watch` runs the weekly postal-network check now (`dry=1` writes nothing).
 */
@UseGuards(AdminSecretGuard)
@Controller('postcode')
export class PostcodeController {
  constructor(
    private readonly seed: PostcodeSeedService,
    private readonly watch: PostcodeWatchService,
  ) {}

  @Post('reload')
  async reload() {
    try {
      const result = await this.seed.run('manual');
      if (!result) {
        return { success: false, error: 'another replica is loading' };
      }
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  @Get('status')
  status(@Query('coverage') coverage?: string) {
    return this.seed.status(coverage === '1' || coverage === 'true');
  }

  @Post('watch')
  async runWatch(@Query('dry') dry?: string) {
    const isDry = dry === '1' || dry === 'true';
    const result = await this.watch.run(
      { dry: isDry },
      isDry ? 'manual, dry run' : 'manual',
    );
    if (!result)
      return { success: false, error: 'another replica is checking' };
    return { success: true, ...result };
  }

  @Get('watch/status')
  watchStatus() {
    return this.watch.status();
  }
}
