import {
  Controller,
  Post,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { StateAssetsService } from './state-assets.service';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { UserQuotaGuard } from '../../user/limits/user-quota.guard';
import { UserEndpoint } from '../../user/limits/user-endpoint.decorator';
import { UserRateLimitInterceptor } from '../../user/interceptors/user-rate-limit.interceptor';

/**
 * Two audiences, so two gates.
 *
 * The import rewrites the table and can be told to truncate it first; that is
 * an operator's action and takes the x-admin-secret header the other batch
 * endpoints use. The lookup is what the company page reads, so it takes a
 * session like every other read the site makes.
 *
 * Neither had any gate until 2026-08-30, which meant `?truncate=1` was a
 * request anyone could send.
 */
@Controller('state-assets')
export class StateAssetsController {
  constructor(private readonly stateAssets: StateAssetsService) {}

  @Post('import')
  @UseGuards(AdminSecretGuard)
  async runImport(
    @Query('limit') limit?: string,
    @Query('truncate') truncate?: string,
  ) {
    const opts = {
      limit: limit ? parseInt(limit, 10) : undefined,
      truncate: truncate === '1' || truncate === 'true',
    };
    try {
      const result = await this.stateAssets.runImport(opts);
      return { success: true, ...result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Read by the company page through myorgApi.getStateAssets. Counted
   * against the account's limits; the company is `?inn=`.
   */
  @Get('inn')
  @UseGuards(JwtAuthGuard, UserQuotaGuard)
  @UseInterceptors(UserRateLimitInterceptor)
  @UserEndpoint('state-assets')
  async getByInn(@Query('inn') inn: string) {
    if (!inn) return { success: false, error: 'inn kiritilmadi' };
    const data = await this.stateAssets.getByInn(inn);
    return { success: true, count: data.length, data };
  }
}
