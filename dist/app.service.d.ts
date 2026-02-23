import { StatRegistryService } from './stat-registry/stat-registry.service';
import { CourtCasesService } from './court-cases/court-cases.service';
import { LicenseService } from './license/license.service';
export declare class AppService {
    private readonly statRegistry;
    private readonly courtCases;
    private readonly license;
    constructor(statRegistry: StatRegistryService, courtCases: CourtCasesService, license: LicenseService);
    getFromStatus(inn: string): Promise<import("./parser").RegistrDto>;
    getCourtCases(tin?: string, caseNumber?: string): Promise<any[] | {
        message: string;
        tin: string | undefined;
        caseNumber: string | undefined;
    }>;
    getLicensesByTin(tin: string): Promise<any[]>;
}
