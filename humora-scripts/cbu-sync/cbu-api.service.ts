// src/scripts/cbu-sync/cbu-api.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import axios from 'axios';
import { CbuAuthService } from './cbu-auth.service';
import { buildProxyAgents } from './cbu-proxy.util';

/** `err.code` on the error thrown while the CBU breaker is open. */
export const CBU_CIRCUIT_OPEN = 'CBU_CIRCUIT_OPEN';

/**
 * True when a call was short-circuited rather than attempted. Retry loops
 * should stop on this: nothing was sent, so retrying cannot learn anything the
 * breaker's own probe will not.
 */
export function isCbuCircuitOpenError(err: unknown): boolean {
  return (err as { code?: string } | undefined)?.code === CBU_CIRCUIT_OPEN;
}

export interface CbuPerson {
  lastName: string | null;
  firstName: string | null;
  middleName: string | null;
  gender: number | null;
  nationality: string | null;
  citizenship: string | null;
  passportSeries: string | null;
  passportNumber: string | null;
  pinfl: string | null;
  tin: string | null;
  birthDate: string | null; // "DD.MM.YYYY"
  individualId: number | null;
  countryCode: string | null;
}

export interface CbuFounderIndividual extends CbuPerson {
  founderSharePercent: number | null;
  founderShareSum: number | null;
}

export interface CbuFounderLegal {
  tin: string | null;
  name: string | null;
  regCountry: number | null;
  countryCode: string | null;
  founderSharePercent: number | null;
  founderShareSum: number | null;
}

/** Structured address — same shape for company billing/shipping and person addresses. */
export interface CbuAddress {
  countryCode: number | null;
  sectorCode: number | null;
  villageCode: string | null;
  streetName: string | null;
  house: string | null;
  flat: string | null;
  soato: number | null;
  cadastreNumber: string | null;
  postcode: string | null;
}

export interface CbuContact {
  phone: string | null;
  email: string | null;
}

export interface CbuBank {
  mfo: string | null;
  paymentAccount: string | null;
  status: number | null;
  openDate: string | null;
  closeDate: string | null;
  attribute: number | null;
}

export interface CbuFounder {
  founderIndividual: CbuFounderIndividual | null;
  founderLegal: CbuFounderLegal | null;
  founderContact: CbuContact | null;
  founderAddress: CbuAddress | null;
}

/** Parent / subsidiary links between companies. */
export interface CbuCompanyLink {
  parentTin: string | null;
  childrenTin: string[] | null;
  typeReg: number | null;
}

export interface CbuCompanyData {
  company: {
    name: string | null;
    shortName: string | null;
    opf: number | null;
    kfs: number | null;
    tin: string | null;
    oked: string | null;
    soogu: string | null;
    sooguRegistrator: string | null;
    registrationDate: string | null; // "DD.MM.YYYY"
    registrationNumber: string | null;
    reregistrationDate: string | null;
    status: number | null;
    statusUpdated: string | null;
    taxStatus: number | null;
    liquidationDate: string | null;
    liquidationReason: number | null;
    suspensionDate: string | null;
    suspensionReason: number | null;
    taxMode: number | null;
    vatNumber: number | null;
    vatRegistrationDate: string | null;
    taxpayerType: number | null;
    businessType: number | null;
    businessFund: number | null;
    businessStructure: number | null;
    businessFundCurrency: string | null;
    createdSysDate: string | null;
    updatedSysDate: string | null;
    taxModeBeginDate: string | null;
    taxModeEndDate: string | null;
    activityTypes: unknown;
  };
  director: CbuPerson | null;
  directorAddress: CbuAddress | null;
  directorContact: CbuContact | null;
  accountant: CbuPerson | null;
  accountantAddress: CbuAddress | null;
  accountantContact: CbuContact | null;
  companyBillingAddress: CbuAddress | null;
  companyShippingAddresses: CbuAddress[] | null;
  companyExtraInfo: {
    avgNumberEmployees: number | null;
    monthlyNumberEmployees: number | null;
  } | null;
  argos: unknown;
  companyBanks: CbuBank[] | null;
  founders: CbuFounder[] | null;
  companyLink: CbuCompanyLink | null;
}

export interface CbuCompanyResponse {
  success: boolean;
  data: CbuCompanyData | null;
  error: { code: number; message: string; cause: string } | null;
}

export interface CbuFinancialReportResponse {
  success: boolean;
  data: Record<string, unknown> | null;
  error: { code: number; message: string; cause: string } | null;
}

@Injectable()
export class CbuApiService {
  private readonly logger = new Logger(CbuApiService.name);
  private readonly baseUrl = process.env.FACTORING_BASE_URL ?? '';

  // ─── faktoring.cbu.uz circuit breaker ────────────────────────────────────
  //
  // On 2026-08-04 CBU's whole /integration/api/* surface wedged: it accepted
  // the TCP connection and never wrote a byte, for 7+ hours. This service was
  // the biggest single contributor to the resulting storm — 4,671 aborted
  // company/info calls at 20s each, ~93,000 socket-seconds in one day — because
  // nothing stopped it retrying a known-dead upstream.
  //
  // Shaped to match the myorg breaker in OrgDataService: consecutive-failure
  // threshold + cooldown, and only "could not answer" counts. Two deliberate
  // choices come straight from the incident:
  //
  //   • The breaker is checked BEFORE the token fetch. getToken() is cache-
  //     backed, but on a cold cache it falls through to a 15s login — another
  //     hung socket during an outage. An open circuit must cost zero.
  //   • Auth is never the recovery signal. /integration/auth/login answered
  //     401 in 19ms all through the outage while every data route hung, so
  //     probing auth would have declared CBU healthy and resumed the storm.
  //     The probe re-issues the real company/info call instead.
  private readonly breakerEnabled = !['false', '0', 'no', 'off'].includes(
    String(process.env.CBU_BREAKER_ENABLED ?? 'true')
      .trim()
      .toLowerCase(),
  );
  private readonly CBU_BREAKER_THRESHOLD = Number(
    process.env.CBU_BREAKER_THRESHOLD ?? 3,
  );
  private readonly CBU_BREAKER_COOLDOWN_MS = Number(
    process.env.CBU_BREAKER_COOLDOWN_MS ?? 60_000,
  );
  private cbuConsecutiveFailures = 0;
  private cbuBreakerOpenUntil = 0;

  constructor(private readonly auth: CbuAuthService) {}

  /** True while CBU is treated as unhealthy and calls fail fast. */
  get circuitOpen(): boolean {
    return Date.now() < this.cbuBreakerOpenUntil;
  }

  /**
   * Decides whether this call may touch the network.
   *
   * When the cooldown has just expired, exactly one caller is let through as a
   * probe and the cooldown is immediately re-armed, so a burst of concurrent
   * callers cannot all pile onto an upstream that is probably still dead. A
   * successful probe clears it in `recordCbuSuccess`.
   */
  private tryAcquireSlot(): boolean {
    if (!this.breakerEnabled) return true;
    if (Date.now() < this.cbuBreakerOpenUntil) return false;
    if (this.cbuConsecutiveFailures >= this.CBU_BREAKER_THRESHOLD) {
      this.cbuBreakerOpenUntil = Date.now() + this.CBU_BREAKER_COOLDOWN_MS;
    }
    return true;
  }

  /**
   * Only "the upstream could not answer" counts toward the breaker: no HTTP
   * response at all (the 2026-08-04 signature), a 5xx, or a 429. Every other
   * 4xx is CBU answering — a run of 404s for unknown TINs, or a 401 from a
   * rotated password, must not present as an outage and take unrelated callers
   * down with it.
   */
  private isCbuOutage(error: unknown): boolean {
    const status = (error as { response?: { status?: number } } | undefined)
      ?.response?.status;
    if (typeof status !== 'number') return true;
    return status >= 500 || status === 429;
  }

  private recordCbuSuccess(): void {
    if (this.cbuConsecutiveFailures > 0) {
      this.logger.log('[cbu] responding again — breaker reset');
    }
    this.cbuConsecutiveFailures = 0;
    this.cbuBreakerOpenUntil = 0;
  }

  private recordCbuFailure(reason: string): void {
    // With the breaker disabled, tryAcquireSlot() always lets calls through, so
    // tracking state here would only make `circuitOpen` report a block that
    // never happens.
    if (!this.breakerEnabled) return;
    this.cbuConsecutiveFailures += 1;
    if (this.cbuConsecutiveFailures >= this.CBU_BREAKER_THRESHOLD) {
      this.cbuBreakerOpenUntil = Date.now() + this.CBU_BREAKER_COOLDOWN_MS;
      this.logger.error(
        `[cbu] breaker OPEN for ${this.CBU_BREAKER_COOLDOWN_MS / 1000}s after ` +
          `${this.cbuConsecutiveFailures} consecutive failures (${reason})`,
      );
    }
  }

  /**
   * Fetch company info by TIN.
   * Throws with err.response.status set for HTTP errors.
   * On 401: invalidates cached token before throwing (caller can retry).
   * While the CBU breaker is open, throws immediately with
   * `err.code === CBU_CIRCUIT_OPEN` without contacting CBU at all.
   */
  async getCompanyInfo(tin: string): Promise<CbuCompanyResponse> {
    return this.get<CbuCompanyResponse>(
      '/integration/api/tax/company/info',
      { tin },
      20000,
    );
  }

  /**
   * Форма №2 — moliyaviy natijalar to'g'risida hisobot — for one period.
   *
   * Lines arrive as `s010`…`s270`, in THOUSANDS of sum, beside filing metadata
   * (`datesent`, `titul`, `ns10code`…). `data` is null when nothing was filed
   * for the period. Each call is paid (15 000 so'm), so callers must not retry.
   * CBU answers this route slowly — about 45s on production (2026-10-09) — so
   * the timeout leaves headroom yet stays under the edge proxy's 60s.
   */
  async getFinancialForm2(
    tin: string,
    year: number,
    quarter: number,
  ): Promise<CbuFinancialReportResponse> {
    return this.get<CbuFinancialReportResponse>(
      '/integration/api/tax/financial-report/form-v2',
      { tin, year, quarter },
      55000,
    );
  }

  private async get<T>(
    path: string,
    params: Record<string, string | number>,
    timeout: number,
  ): Promise<T> {
    const tin = params.tin;
    if (!this.tryAcquireSlot()) {
      this.logger.warn(`[cbu] breaker open — skipping live fetch for ${tin}`);
      throw Object.assign(
        new Error('CBU circuit open — upstream is unhealthy'),
        { code: CBU_CIRCUIT_OPEN },
      );
    }

    // CBU support locates a request in their own logs by X-Trace-Id; without
    // one they cannot correlate our failures with theirs at all.
    const traceId = randomUUID();

    try {
      const token = await this.auth.getToken();
      const res = await axios.get(`${this.baseUrl}${path}`, {
        params,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Trace-Id': traceId,
          'X-Correlation-ID': traceId,
        },
        timeout,
        ...buildProxyAgents(),
      });
      this.recordCbuSuccess();
      return res.data as T;
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 401) {
        await this.auth.invalidate();
      }
      if (this.isCbuOutage(err)) {
        this.recordCbuFailure(
          `${(err as { code?: string })?.code ?? '?'} ${(err as Error)?.message ?? String(err)} trace=${traceId}`,
        );
      } else {
        // A definite answer, even a negative one, means CBU is alive.
        this.recordCbuSuccess();
      }
      throw err;
    }
  }
}
