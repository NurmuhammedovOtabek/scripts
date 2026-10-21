import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { scoreToGrade } from './rating-grade';

export interface ChamberRatingFields {
  /** Letter grade — the 0-100 `score` run through the chamber scale. */
  trust: string | null;
  score: number | null;
  is_large_taxpayer: boolean;
  oked_description: string | null;
  rating_type: string | null;
}

@Injectable()
export class ChamberScriptService {
  private readonly logger = new Logger(ChamberScriptService.name);

  async getByInn(inn: string): Promise<ChamberRatingFields> {
    this.logger.log(`chamber.uz: INN=${inn}`);

    const response = await axios.get(
      `https://admin.chamber.uz/api/GetCompanyCriteries/${inn}`,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
          Accept: 'application/json',
          Referer: 'https://chamber.uz/oz/contractor-rating',
        },
        timeout: 15000,
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
      },
    );

    const data = response.data;

    if (!data || !data.tin) {
      this.logger.warn(`chamber.uz: INN=${inn} — ma'lumot topilmadi`);
      return {
        trust: null,
        score: null,
        is_large_taxpayer: false,
        oked_description: null,
        rating_type: null,
      };
    }

    this.logger.log(
      `chamber.uz: INN=${inn} — reyting: ${data.type}, ball: ${data.criteriaAll}`,
    );

    // chamber sends one number. `score` keeps it; `trust` carries the letter
    // it maps to, which is what the company page shows and what myorg already
    // publishes directly — so both sources now speak the same shape.
    //
    // `|| null` rather than `?? null` on purpose: chamber has always used 0
    // to mean "no rating computed" here, and treating it as a genuine score
    // would start grading those companies 'D'. Changing that is a decision
    // about the data, not about this refactor.
    const score = data.criteriaAll || null;

    return {
      trust: scoreToGrade(score),
      score: score,
      is_large_taxpayer: data.taxpayerType === 3,
      oked_description: data.okedDetail?.name || null,
      rating_type: data.type || null,
    };
  }
}
