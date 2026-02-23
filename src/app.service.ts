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
}
