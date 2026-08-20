import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CaptchaSolverClient } from '../common/captcha-solver.client';

const BASE_URL = 'https://old.soliq.uz';
const PAGE_URL = `${BASE_URL}/activities/tax-risk-analysis?lang=latn`;
const CAPTCHA_URL = `${BASE_URL}/activities/captcha`;
const SUBMIT_URL = `${BASE_URL}/activities/analysis/item`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const WRONG_CAPTCHA_PATTERN = /noto.?g.?ri kiritilgan|неправ|incorrect/i;

export interface TaxRiskResult {
  success: boolean;
  in_risk_list: boolean;
  reason?: string;
  attempts: number;
  data?: {
    tin: string;
    name: string | null;
    region: string | null;
    ns11_name: string | null;
    status: number;
    status_text: 'Ishonchli' | 'Shubhali';
    obnal: number | null;
    obnal_text: 'Ha' | "Yo'q" | null;
    sum_debt: number | null;
    vat_state: number | null;
    tax_gap: number | null;
    reg_date: string | null;
    founders: any;
    personal_data: any;
  };
  raw?: any;
}

@Injectable()
export class TaxRiskService {
  private readonly logger = new Logger(TaxRiskService.name);

  // Serial queue keeps session cookies consistent per-instance.
  private queue: Promise<any> = Promise.resolve();

  constructor(
    private readonly httpService: HttpService,
    private readonly solver: CaptchaSolverClient,
  ) {}

  async checkByInn(inn: string, maxAttempts = 10): Promise<TaxRiskResult> {
    const job = this.queue.then(() => this.runCheck(inn, maxAttempts, true));
    this.queue = job.catch(() => {});
    return job;
  }

  /**
   * The same check for a person, by PINFL.
   *
   * The form field is `tin` either way — old.soliq.uz accepts a PINFL in it
   * and answers with that person's record. Verified against the live source:
   * PINFL 30512966580023 comes back naming IRGASHEV ANVARJON OLIM O'G'LI,
   * while the same trader's STIR is rejected by the debtor form outright.
   *
   * Nothing is written to `company_tax`: that table is keyed by INN, and a
   * PINFL lookup is about a person, not a company. The answer is returned and
   * not stored.
   */
  async checkByPinfl(pinfl: string, maxAttempts = 10): Promise<TaxRiskResult> {
    const job = this.queue.then(() => this.runCheck(pinfl, maxAttempts, false));
    this.queue = job.catch(() => {});
    return job;
  }

  private async runCheck(
    inn: string,
    maxAttempts: number,
    persist: boolean,
  ): Promise<TaxRiskResult> {
    this.logger.log(
      `[tax-risk] ${persist ? 'INN' : 'PINFL'}=${inn} — starting (maxAttempts=${maxAttempts})`,
    );

    // Cookie jar mutated across requests. /activities/captcha sets CAPTCHA_ID —
    // without persisting it, every submit fails with "noto'g'ri kiritilgan".
    const jar = new Map<string, string>();
    await this.initSession(jar);
    let attempt = 0;
    let lastReason = '';

    while (attempt < maxAttempts) {
      attempt++;

      const imgBuf = await this.fetchCaptcha(jar);
      const code = await this.solver.solve(imgBuf, {
        type: 'digits',
        length: 4,
      });
      if (!code) {
        this.logger.debug(
          `[tax-risk] attempt ${attempt}: solver returned no 4-digit code`,
        );
        continue;
      }

      const result = await this.submitForm(inn, code, jar);
      const reason = result?.reason || '';

      if (result?.success) {
        this.logger.log(
          `[tax-risk] ✅ INN=${inn} on risk list, solved in ${attempt} attempt(s)`,
        );
        const data = this.mapResponse(result.data);
        return {
          success: true,
          in_risk_list: true,
          attempts: attempt,
          data,
          raw: result,
        };
      }

      if (!WRONG_CAPTCHA_PATTERN.test(reason)) {
        this.logger.log(
          `[tax-risk] ℹ️ INN=${inn} not on risk list (captcha OK in ${attempt} attempt(s)): "${reason}"`,
        );
        return {
          success: true,
          in_risk_list: false,
          reason,
          attempts: attempt,
          raw: result,
        };
      }

      lastReason = reason;
    }

    this.logger.warn(
      `[tax-risk] ❌ INN=${inn} — exhausted ${maxAttempts} attempts`,
    );
    return {
      success: false,
      in_risk_list: false,
      reason: `Captcha not solved after ${maxAttempts} attempts (last: ${lastReason})`,
      attempts: maxAttempts,
    };
  }

  private absorbSetCookie(
    jar: Map<string, string>,
    setCookie: string[] | undefined,
  ): void {
    if (!setCookie) return;
    for (const header of setCookie) {
      const pair = header.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) {
        jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  private jarToHeader(jar: Map<string, string>): string {
    return Array.from(jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  private async initSession(jar: Map<string, string>): Promise<void> {
    const resp = await firstValueFrom(
      this.httpService.get(PAGE_URL, {
        headers: { 'User-Agent': UA },
        maxRedirects: 0,
        validateStatus: () => true,
      }),
    );
    this.absorbSetCookie(jar, resp.headers['set-cookie']);
  }

  private async fetchCaptcha(jar: Map<string, string>): Promise<Buffer> {
    const resp = await firstValueFrom(
      this.httpService.get(CAPTCHA_URL, {
        headers: {
          'User-Agent': UA,
          Cookie: this.jarToHeader(jar),
          Referer: PAGE_URL,
          'X-Requested-With': 'XMLHttpRequest',
        },
        timeout: 10000,
      }),
    );
    this.absorbSetCookie(jar, resp.headers['set-cookie']);
    const imgSrc = resp.data?.imgSrc as string;
    if (!imgSrc) throw new Error('Captcha response has no imgSrc');
    const b64 = imgSrc.split(',')[1].trim();
    return Buffer.from(b64, 'base64');
  }

  private async submitForm(
    inn: string,
    captcha: string,
    jar: Map<string, string>,
  ): Promise<any> {
    const body = new URLSearchParams({ tin: inn, captcha });
    const resp = await firstValueFrom(
      this.httpService.post(SUBMIT_URL, body.toString(), {
        headers: {
          'User-Agent': UA,
          Cookie: this.jarToHeader(jar),
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          Referer: PAGE_URL,
          'X-Requested-With': 'XMLHttpRequest',
          Accept: 'application/json, text/javascript, */*; q=0.01',
        },
        timeout: 15000,
        validateStatus: () => true,
      }),
    );
    this.absorbSetCookie(jar, resp.headers['set-cookie']);
    return resp.data;
  }


  private mapResponse(r: any): TaxRiskResult['data'] {
    const status = typeof r?.status === 'number' ? r.status : 0;
    const obnal = r?.obnal;
    return {
      tin: String(r?.tin ?? ''),
      name: r?.name ?? null,
      region: r?.ns10Name ?? null,
      ns11_name: r?.ns11Name ?? null,
      status,
      status_text: status === 1 ? 'Ishonchli' : 'Shubhali',
      obnal: obnal ?? null,
      obnal_text: obnal === 1 ? 'Ha' : obnal === 0 ? "Yo'q" : null,
      sum_debt: r?.sumDebt ?? null,
      vat_state: r?.vatState ?? null,
      tax_gap: r?.taxGap ?? null,
      reg_date: r?.regDate ?? null,
      founders: r?.founders ?? null,
      personal_data: r?.personalData ?? null,
    };
  }
}
