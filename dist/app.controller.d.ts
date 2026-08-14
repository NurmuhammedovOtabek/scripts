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
}
