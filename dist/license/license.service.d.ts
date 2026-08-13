import { type OnModuleDestroy } from '@nestjs/common';
type LicenseDetail = any;
export declare class LicenseService implements OnModuleDestroy {
    private licenseQueue;
    private browser;
    private chromeProc;
    private idleTimer;
    onModuleDestroy(): Promise<void>;
    getLicensesByTin(tin: string): Promise<LicenseDetail[]>;
    private _doGetLicenses;
    private findChromePath;
    private waitForCdpReady;
    private ensureBrowser;
    private isCdpUp;
    private disposeBrowser;
    private scheduleIdleShutdown;
    private killChromeProcess;
    private captureTokenFromBrowser;
    private extractTurnstileToken;
    private isTokenBearingResponse;
    private clickFirstResult;
    private extractUuids;
    private buildApiHeaders;
    private fetchLicenseCertificates;
}
export {};
