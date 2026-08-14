import { Injectable } from '@nestjs/common';
import { StatRegistryService } from './stat-registry/stat-registry.service';
import { CourtCasesService } from './court-cases/court-cases.service';
import { LicenseService } from './license/license.service';

@Injectable()
export class AppService {
  constructor(
    private readonly statRegistry: StatRegistryService,
    private readonly courtCases: CourtCasesService,
    private readonly license: LicenseService,
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
}
