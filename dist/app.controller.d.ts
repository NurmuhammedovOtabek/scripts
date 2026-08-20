import { AppService } from './app.service';
export declare class AppController {
    private readonly appService;
    constructor(appService: AppService);
    getFromStatus(inn?: string): Promise<import("./parser").RegistrDto>;
    getLitsens(tin?: string): Promise<any[]>;
    getSud(tin?: string, caseNumber?: string): Promise<any[] | {
        message: string;
        tin: string | undefined;
        caseNumber: string | undefined;
    }>;
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
    getStats(): import("./license/license.service").LicenseStats & {
        queueBusy: boolean;
        browserAlive: boolean;
        avgMs: number | null;
    };
    getCadastre(tin: string): Promise<any>;
    getCadastreByNumber(cad: string): Promise<any>;
    getTaxRisk(tin?: string, pinfl?: string): Promise<import("./tax-risk/tax-risk.service").TaxRiskResult>;
    getTaxDebt(tin?: string, pinfl?: string): Promise<import("./tax-debtor/tax-debtor.service").TaxDebtorResult>;
    getGarov(inn?: string, pinfl?: string): Promise<import("./garov/garov.service").GarovRecord[]>;
    getSert(tin: string): Promise<import("./sert/sert.service").CertificateFields[]>;
    getMib(tin?: string, pinfl?: string): Promise<import("./mib/mib-debt.parser").MibDebtResultDto>;
    getLargeTaxpayer(tin: string): Promise<import("./large-taxpayer/large-taxpayer.service").LargeTaxpayerResult>;
}
