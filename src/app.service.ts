import { BirdarchaService } from './birdarcha/birdarcha.service';
import { Injectable } from '@nestjs/common';
import { StatRegistryService } from './stat-registry/stat-registry.service';
import { CourtCasesService } from './court-cases/court-cases.service';
import { LicenseService } from './license/license.service';
import { DavreestrService } from './davreestr/davreestr.service';
import { TaxRiskService } from './tax-risk/tax-risk.service';
import { TaxDebtorService } from './tax-debtor/tax-debtor.service';
import { GarovService } from './garov/garov.service';
import { SertScriptService } from './sert/sert.service';
import { MibScriptService } from './mib/mib.service';
import { LargeTaxpayerService } from './large-taxpayer/large-taxpayer.service';

@Injectable()
export class AppService {
  constructor(
    private readonly statRegistry: StatRegistryService,
    private readonly courtCases: CourtCasesService,
    private readonly license: LicenseService,
    private readonly davreestr: DavreestrService,
    private readonly taxRisk: TaxRiskService,
    private readonly taxDebtor: TaxDebtorService,
    private readonly garov: GarovService,
    private readonly sert: SertScriptService,
    private readonly mib: MibScriptService,
    private readonly largeTaxpayer: LargeTaxpayerService,
    private readonly birdarcha: BirdarchaService,
  ) {}

  getFromStatus(inn: string) {
    return this.statRegistry.getFromStatus(inn);
  }

  getCourtCases(tin?: string, caseNumber?: string) {
    return this.courtCases.getCourtCases(tin, caseNumber);
  }

  getLicensesByTin(tin: string) {
    return this.license.getLicensesByTin(tin);
  }

  /**
   * Counters the license scraper has accumulated since boot. This box runs
   * unattended in an office, so the state has to be readable over the network
   * rather than by reading its console.
   */
  getLicenseStats() {
    return this.license.getStats();
  }

  /**
   * Cheap liveness probe. `degraded` is deliberately not an error: the service
   * is still answering, it is just failing its lookups, which is exactly the
   * state worth alerting on before anyone notices missing data.
   */
  getHealth() {
    const s = this.license.getStats();
    const degraded = s.failStreak >= 3;
    return {
      status: degraded ? 'degraded' : 'ok',
      reason: degraded ? `${s.failStreak} consecutive license failures` : null,
      uptimeSec: Math.round(process.uptime()),
      startedAt: s.startedAt,
      license: {
        total: s.total,
        ok: s.ok,
        failed: s.failed,
        failStreak: s.failStreak,
        avgMs: s.avgMs,
        browserAlive: s.browserAlive,
        queueBusy: s.queueBusy,
        lastOkAt: s.lastOkAt,
        lastError: s.lastError,
      },
    };
  }

  // ─── Scrapers moved off the production server ──────────────────────────
  //
  // These sources rate-limit or geo-restrict by IP, or sit behind a captcha.
  // Running them here spends this machine's address instead of production's,
  // and none of them touch a database — the backend persists what it wants.

  /** Cadastre by company TIN. Hard-limited to ~15 req/min by davreestr.uz. */
  getCadastreByTin(tin: string) {
    return this.davreestr.searchByTin(tin);
  }

  /** Cadastre by cadastre number. */
  getCadastreByNumber(cadNumber: string) {
    return this.davreestr.searchByCadNumber(cadNumber);
  }

  /** Tax-risk register. Accepts a PINFL, which is how an individual is listed. */
  getTaxRisk(tin?: string, pinfl?: string) {
    return pinfl
      ? this.taxRisk.checkByPinfl(pinfl)
      : this.taxRisk.checkByInn(tin as string);
  }

  /** Tax-debtor register. Same PINFL/TIN split as tax-risk. */
  getTaxDebt(tin?: string, pinfl?: string) {
    return pinfl
      ? this.taxDebtor.checkByPinfl(pinfl)
      : this.taxDebtor.checkByInn(tin as string);
  }

  /** Collateral register. An individual's pledges are found by PINFL, not TIN. */
  getGarov(inn?: string, pinfl?: string) {
    return pinfl ? this.garov.getByPinfl(pinfl) : this.garov.getByInn(inn as string);
  }

  /** Conformity certificates from sert2.standart.uz. */
  getCertificates(tin: string) {
    return this.sert.getByInn(tin);
  }

  /** Enforcement debts from mib.uz — captcha-gated and Uzbekistan-only. */
  getMibDebts(tin?: string, pinfl?: string) {
    return pinfl
      ? this.mib.checkDebtByPinfl(pinfl)
      : this.mib.checkDebtByInn(tin as string);
  }

  /** Large-taxpayer register membership. */
  getLargeTaxpayer(tin: string) {
    return this.largeTaxpayer.checkByInn(tin);
  }

  /** One trader from the Ministry of Justice registration register. */
  getBirdarcha(pin: string) {
    return this.birdarcha.getTraderByPinfl(pin);
  }
}
