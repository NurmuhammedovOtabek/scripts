import {
  Controller,
  Get,
  Param,
  Post,
  UnauthorizedException,
  Headers,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AdminSecretGuard } from '../../common/guards/admin-secret.guard';
import { UserQuotaGuard } from '../../user/limits/user-quota.guard';
import { UserEndpoint } from '../../user/limits/user-endpoint.decorator';
import { UserRateLimitInterceptor } from '../../user/interceptors/user-rate-limit.interceptor';
import { ConstructionRatingService } from './construction-rating.service';

@ApiTags('Construction Rating')
@Controller('scripts/construction-rating')
export class ConstructionRatingController {
  constructor(private readonly service: ConstructionRatingService) {}

  /**
   * What the company page's rating tab shows (one row per category). Open to
   * anyone until 2026-10-13 although only the signed-in company page calls it,
   * and a cache miss asks reyting.mc.uz — so it is signed-in and counted by
   * the site account limits now (docs/USER_LIMITS.md).
   */
  @Get('inn/:inn')
  @UseGuards(JwtAuthGuard, UserQuotaGuard)
  @UseInterceptors(UserRateLimitInterceptor)
  @UserEndpoint('rating')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get construction rating from DB by INN.' })
  async getByInn(@Param('inn') inn: string) {
    return this.service.getByInn(inn);
  }

  /**
   * Live API check (per-INN, includes the "developer" category). The site
   * never calls it, and every call goes to reyting.mc.uz, so it is an
   * operator's tool: x-admin-secret since 2026-10-13, open before.
   */
  @Get('inn/:inn/fresh')
  @UseGuards(AdminSecretGuard)
  @ApiOperation({
    summary:
      'Live check against japi-reyting.mc.uz/api/v1/statistic/check-inn (no DB write).',
  })
  async getByInnFresh(@Param('inn') inn: string) {
    return this.service.getByInnFresh(inn);
  }

  /** Sync ALL categories (0..3) — bulk upsert. Auth via x-admin-secret. */
  @Post('sync')
  @ApiOperation({
    summary: 'Bulk-sync all rated companies (4 categories) into DB.',
  })
  async syncAll(@Headers('x-admin-secret') secret: string) {
    if (secret !== process.env.ADMIN_SECRET) {
      throw new UnauthorizedException('Bad x-admin-secret');
    }
    return this.service.syncAll();
  }

  /** Sync a single category. */
  @Post('sync/:type')
  @ApiOperation({
    summary: 'Sync a single category (0=umum, 1=yol, 2=mel, 3=loyiha).',
  })
  async syncType(
    @Param('type') type: string,
    @Headers('x-admin-secret') secret: string,
  ) {
    if (secret !== process.env.ADMIN_SECRET) {
      throw new UnauthorizedException('Bad x-admin-secret');
    }
    const t = Number(type);
    if (![0, 1, 2, 3].includes(t)) {
      return { error: 'type must be 0, 1, 2, or 3' };
    }
    return this.service.syncType(t);
  }
}
