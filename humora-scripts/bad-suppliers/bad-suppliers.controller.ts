import {
  Controller,
  Get,
  Query,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { BadSuppliersService } from './bad-suppliers.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { UserQuotaGuard } from '../../user/limits/user-quota.guard';
import { UserEndpoint } from '../../user/limits/user-endpoint.decorator';
import { UserRateLimitInterceptor } from '../../user/interceptors/user-rate-limit.interceptor';

/**
 * The xt-xarid blacklist is public and small — around fourteen companies —
 * so the session is not protecting the data. It is protecting the source and
 * our own table.
 *
 * `check` calls xt-xarid live and upserts the answer into
 * company_bad_suppliers on every request, including the negative ones, so
 * ungated it was an unauthenticated writer that a list of STIRs could fill.
 * `list` reads nothing of ours and calls xt-xarid each time, which makes an
 * ungated copy a free proxy pointed at them. Losing that source would also
 * take the blacklist warning off company pages, which reach it through
 * OrgService rather than through these routes.
 *
 * Signed-in reads count against the account's limits (docs/USER_LIMITS.md).
 */
@Controller('bad-suppliers')
@UseGuards(JwtAuthGuard, UserQuotaGuard)
@UseInterceptors(UserRateLimitInterceptor)
export class BadSuppliersController {
  constructor(private readonly service: BadSuppliersService) {}

  /** GET /bad-suppliers/check?inn=310569955 */
  @Get('check')
  @UserEndpoint('bad-suppliers')
  async check(@Query('inn') inn: string) {
    if (!inn || !/^\d{9,14}$/.test(inn)) {
      return {
        success: false,
        error: "INN (STIR) 9-14 raqamdan iborat bo'lishi kerak",
      };
    }
    return this.service.checkByInn(inn);
  }

  /** GET /bad-suppliers/list */
  @Get('list')
  @UserEndpoint('bad-suppliers')
  async list() {
    const [rows, total] = await Promise.all([
      this.service.listAll(),
      this.service.count(),
    ]);
    return { total, rows };
  }
}
