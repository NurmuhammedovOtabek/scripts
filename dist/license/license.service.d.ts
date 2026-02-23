type LicenseDetail = any;
export declare class LicenseService {
    private licenseQueue;
    getLicensesByTin(tin: string): Promise<LicenseDetail[]>;
    private _doGetLicenses;
    private findChromePath;
    private waitForCdpReady;
    private killChromeProcess;
    private captureTokenFromBrowser;
    private extractTurnstileToken;
    private isTokenBearingResponse;
    private clickFirstResult;
    private extractUuids;
    private buildApiHeaders;
    private fetchLicenseList;
    private fetchLicenseDetails;
}
export {};
