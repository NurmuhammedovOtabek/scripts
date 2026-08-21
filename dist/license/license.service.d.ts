import { type OnModuleDestroy } from '@nestjs/common';
type LicenseDetail = any;
export interface LicenseStats {
    startedAt: string;
    total: number;
    ok: number;
    failed: number;
    emptyResult: number;
    turnstileSolved: number;
    turnstileTimeout: number;
    chromeSpawns: number;
    apiStatus: Record<string, number>;
    lastOkAt: string | null;
    lastFailAt: string | null;
    lastError: string | null;
    recentMs: number[];
    failStreak: number;
    worstFailStreak: number;
}
export declare class LicenseService implements OnModuleDestroy {
    private licenseQueue;
    private browser;
    private chromeProc;
    private idleTimer;
    private readonly logger;
    private readonly stats;
    onModuleDestroy(): Promise<void>;
    getStats(): LicenseStats & {
        queueBusy: boolean;
        browserAlive: boolean;
        avgMs: number | null;
    };
    private busy;
    getLicensesByTin(tin: string): Promise<LicenseDetail[]>;
    private _doGetLicenses;
    private findChromePath;
    private waitForCdpReady;
    private pushDuration;
    private recordOk;
    private recordFail;
    private ensureBrowser;
    private isCdpUp;
    private disposeBrowser;
    private scheduleIdleShutdown;
    private killChromeProcess;
    private fetchPage;
    private captureTokenFromBrowser;
    private extractTurnstileToken;
    private isTokenBearingResponse;
    private clickFirstResult;
    private extractUuids;
    private buildApiHeaders;
    private fetchLicenseCertificates;
}
export {};
