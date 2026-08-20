import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

const BASE_URL = 'https://old.soliq.uz';
const LIST_URL = `${BASE_URL}/activities/list`;
const PAGE_URL = `${BASE_URL}/activities/large-taxpayers?lang=latn`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

export interface LargeTaxpayerResult {
  inn: string;
  is_large_taxpayer: boolean;
  data?: {
    tin: string;
    name: string;
    region: string | null;
    district: string | null;
  };
}

/**
 * old.soliq.uz "Yirik soliq to'lovchi" registry — public JSON endpoint,
 * no captcha. Returns whether the given INN is a large taxpayer.
 */
@Injectable()
export class LargeTaxpayerService {
  private readonly logger = new Logger(LargeTaxpayerService.name);

  constructor(
    private readonly httpService: HttpService,
  ) {}

  async checkByInn(inn: string): Promise<LargeTaxpayerResult> {
    this.logger.log(`[large-taxpayer] INN=${inn}`);

    const resp = await firstValueFrom(
      this.httpService.get(LIST_URL, {
        params: { tin: inn, sEcho: 1, iDisplayStart: 0, iDisplayLength: 10 },
        headers: {
          'User-Agent': UA,
          Referer: PAGE_URL,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json',
        },
        timeout: 15000,
        validateStatus: () => true,
      }),
    );

    const rows = resp.data?.data || [];
    const match = rows.find((r: any) => String(r.tin) === inn) || rows[0];

    if (!match) {
      this.logger.log(`[large-taxpayer] INN=${inn} — not a large taxpayer`);
      return { inn, is_large_taxpayer: false };
    }

    this.logger.log(`[large-taxpayer] INN=${inn} — ✅ YES (${match.name})`);
    return {
      inn,
      is_large_taxpayer: true,
      data: {
        tin: String(match.tin),
        name: match.name,
        region: match.ns10Name ?? null,
        district: match.ns11Name ?? null,
      },
    };
  }

}
