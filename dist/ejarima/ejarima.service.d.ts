import { type EjarimaPassportResult } from './ejarima.parse';
export interface EjarimaLookup extends EjarimaPassportResult {
    tookMs: number;
    html?: string;
}
export declare class EjarimaService {
    private readonly logger;
    private browser;
    private chromeProc;
    private queue;
    private stats;
    getStats(): {
        total: number;
        found: number;
        none: number;
        failed: number;
        tokenLost: number;
    };
    getByPassport(serial: string, number: string, withHtml?: boolean): Promise<EjarimaLookup>;
    private lookup;
    private waitForToken;
    private submit;
    private ensureBrowser;
    private isCdpUp;
    private findChromePath;
}
