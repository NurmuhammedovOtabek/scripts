import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { CaptchaSolverClient } from '../common/captcha-solver.client';

const BASE_URL = 'https://old.soliq.uz';
const PAGE_URL = `${BASE_URL}/activities/debtor?lang=latn`;
const CAPTCHA_URL = `${BASE_URL}/activities/captcha`;
const SUBMIT_URL = `${BASE_URL}/activities/debtor/item`;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

const WRONG_CAPTCHA_PATTERN = /noto.?g.?ri kiritilgan|неправ|incorrect/i;

export interface TaxDebtorResult {
  success: boolean;
  in_debtor_list: boolean;
  reason?: string;
  attempts: number;
  data?: {
    tin: string;
    name: string | null;
    region: string | null;
    ns11_name: string | null;
    /** 2 = legal entity, else = individual entrepreneur (YTT) */
    entity_type: number;
    entity_type_text: 'legal' | 'entrepreneur';
    sum_debt: number | null;
  };
  raw?: any;
}

@Injectable()
export class TaxDebtorService {
  private readonly logger = new Logger(TaxDebtorService.name);
  private queue: Promise<any> = Promise.resolve();

  constructor(
    private readonly httpService: HttpService,
    private readonly solver: CaptchaSolverClient,
  ) {}

  async checkByInn(inn: string, maxAttempts = 10): Promise<TaxDebtorResult> {
    const job = this.queue.then(() => this.runCheck(inn, maxAttempts, true));
    this.queue = job.catch(() => {});
    return job;
  }

  /**
   * The same check for a person, by PINFL.
   *
   * The debtor form takes the key in `tin` whichever it is, and for a trader
   * the PINFL is the one that works: asked for STIR 536778826 the source
   * answers "Субъект предпринимательства с таким ИНН не найден", while the
   * same person's PINFL is accepted.
   *
   * Nothing is written to `company_tax` — it is keyed by INN, and this is a
   * person.
   */
  async checkByPinfl(
    pinfl: string,
    maxAttempts = 10,
  ): Promise<TaxDebtorResult> {
    const job = this.queue.then(() => this.runCheck(pinfl, maxAttempts, false));
    this.queue = job.catch(() => {});
    return job;
  }

  private async runCheck(
    inn: string,
    maxAttempts: number,
    persist: boolean,
  ): Promise<TaxDebtorResult> {
    this.logger.log(
      `[tax-debtor] ${persist ? 'INN' : 'PINFL'}=${inn} — starting`,
    );

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
      if (!code) continue;

      const result = await this.submitForm(inn, code, jar);
      const reason = result?.reason || '';

      if (result?.success) {
        const data = this.mapResponse(result.data);
        const sum = Number(data?.sum_debt ?? 0);
        this.logger.log(
          `[tax-debtor] ✅ INN=${inn} found, sum_debt=${sum}, solved in ${attempt} attempt(s)`,
        );
        if (persist) {
        }
        return {
          success: true,
          in_debtor_list: true,
          attempts: attempt,
          data,
          raw: result,
        };
      }

      if (!WRONG_CAPTCHA_PATTERN.test(reason)) {
        this.logger.log(
          `[tax-debtor] ℹ️ INN=${inn} not on debtor list (captcha OK in ${attempt})`,
        );
        if (persist) {
        }
        return {
          success: true,
          in_debtor_list: false,
          reason,
          attempts: attempt,
          raw: result,
        };
      }

      lastReason = reason;
    }

    this.logger.warn(
      `[tax-debtor] ❌ INN=${inn} — exhausted ${maxAttempts} attempts`,
    );
    return {
      success: false,
      in_debtor_list: false,
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
      if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
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
    const b64 = resp.data?.imgSrc?.split(',')[1]?.trim();
    if (!b64) throw new Error('Captcha response has no imgSrc');
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




  private mapResponse(r: any): TaxDebtorResult['data'] {
    const status = typeof r?.status === 'number' ? r.status : 0;
    return {
      tin: String(r?.tin ?? ''),
      name: r?.name ?? null,
      region: r?.ns10Name ?? null,
      ns11_name: r?.ns11Name ?? null,
      entity_type: status,
      entity_type_text: status === 2 ? 'legal' : 'entrepreneur',
      sum_debt: r?.sumDebt ?? null,
    };
  }
}
