import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { InnParamPipe } from '../../common/pipes/inn-param.pipe';
import { UserQuotaGuard } from '../../user/limits/user-quota.guard';
import { UserEndpoint } from '../../user/limits/user-endpoint.decorator';
import { UserRateLimitInterceptor } from '../../user/interceptors/user-rate-limit.interceptor';
import { VendorRating, VendorRatingService } from './vendor-rating.service';

@ApiTags('Vendor Rating')
@Controller('scripts/vendor-rating')
export class VendorRatingController {
  constructor(private readonly service: VendorRatingService) {}

  /**
   * What the company page shows. Reads our copy only. Counted by the site
   * account limits (docs/USER_LIMITS.md).
   */
  @Get('inn/:inn')
  @UseGuards(JwtAuthGuard, UserQuotaGuard)
  @UseInterceptors(UserRateLimitInterceptor)
  @UserEndpoint('rating')
  @ApiOperation({
    summary:
      'Latest UZEX supplier rating for a company; data is null when the company is not rated.',
  })
  @ApiParam({ name: 'inn', description: 'Company INN', required: true })
  async getByInn(
    @Param('inn', InnParamPipe) inn: string,
  ): Promise<{ data: VendorRating | null }> {
    return { data: await this.service.getLatestByInn(inn) };
  }

  /** Copies the whole current list. Auth via x-admin-secret. */
  @Post('sync')
  @UseGuards(AdminSecretGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Copy the whole UZEX supplier rating into company_vendor_ratings.',
  })
  async sync() {
    return this.service.syncAll();
  }
}
