export interface BirdarchaLookup {
    pinfl: string;
    found: boolean;
    data: Record<string, unknown> | null;
    tookMs: number;
}
export declare class BirdarchaService {
    private readonly logger;
    private browser;
    private chromeProc;
    private queue;
    private stats;
    getStats(): {
        total: number;
        ok: number;
        notFound: number;
        failed: number;
        challengeLost: number;
    };
    getTraderByPinfl(pinfl: string): Promise<BirdarchaLookup>;
    private lookup;
    private submitSearch;
    private waitForRegisterResponse;
    private unwrap;
    private ensureBrowser;
    private isCdpUp;
    private findChromePath;
}
