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
export declare class AppService {
    private readonly statRegistry;
    private readonly courtCases;
    private readonly license;
    private readonly davreestr;
    private readonly taxRisk;
    private readonly taxDebtor;
    private readonly garov;
    private readonly sert;
    private readonly mib;
    private readonly largeTaxpayer;
    constructor(statRegistry: StatRegistryService, courtCases: CourtCasesService, license: LicenseService, davreestr: DavreestrService, taxRisk: TaxRiskService, taxDebtor: TaxDebtorService, garov: GarovService, sert: SertScriptService, mib: MibScriptService, largeTaxpayer: LargeTaxpayerService);
    getFromStatus(inn: string): Promise<import("./parser").RegistrDto>;
    getCourtCases(tin?: string, caseNumber?: string): Promise<any[] | {
        message: string;
        tin: string | undefined;
        caseNumber: string | undefined;
    }>;
    getLicensesByTin(tin: string): Promise<any[]>;
    getLicenseStats(): import("./license/license.service").LicenseStats & {
        queueBusy: boolean;
        browserAlive: boolean;
        avgMs: number | null;
    };
    getHealth(): {
        status: string;
        reason: string | null;
        uptimeSec: number;
        startedAt: string;
        license: {
            total: number;
            ok: number;
            failed: number;
            failStreak: number;
            avgMs: number | null;
            browserAlive: boolean;
            queueBusy: boolean;
            lastOkAt: string | null;
            lastError: string | null;
        };
    };
    getCadastreByTin(tin: string): Promise<any>;
    getCadastreByNumber(cadNumber: string): Promise<any>;
    getTaxRisk(tin?: string, pinfl?: string): Promise<import("./tax-risk/tax-risk.service").TaxRiskResult>;
    getTaxDebt(tin?: string, pinfl?: string): Promise<import("./tax-debtor/tax-debtor.service").TaxDebtorResult>;
    getGarov(inn?: string, pinfl?: string): Promise<import("./garov/garov.service").GarovRecord[]>;
    getCertificates(tin: string): Promise<import("./sert/sert.service").CertificateFields[]>;
    getMibDebts(tin?: string, pinfl?: string): Promise<import("./mib/mib-debt.parser").MibDebtResultDto>;
    getLargeTaxpayer(tin: string): Promise<import("./large-taxpayer/large-taxpayer.service").LargeTaxpayerResult>;
}
