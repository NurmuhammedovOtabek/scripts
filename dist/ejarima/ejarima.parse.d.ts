export type EjarimaOutcome = 'found' | 'none' | 'unavailable';
export declare const EJARIMA_STATUS: {
    readonly PAID: 0;
    readonly PARTIAL: 1;
    readonly UNPAID: 2;
};
export interface EjarimaProtocol {
    series: string | null;
    status: string | null;
    statusCode: number | null;
    paid: boolean;
    decided: boolean;
    penaltyKind: string | null;
    fineAmount: number | null;
    fineText: string | null;
    damageAmount: number | null;
    damageText: string | null;
    paidAt: string | null;
    region: string | null;
    district: string | null;
    issuedAt: string | null;
    receiptNo: string | null;
    personKind: string | null;
    authority: string | null;
    article: string | null;
}
export interface EjarimaPassportResult {
    serial: string;
    number: string;
    outcome: EjarimaOutcome;
    found: boolean;
    protocols: EjarimaProtocol[];
    unpaidCount: number;
    unpaidTotal: number;
    pendingCount: number;
    message: string | null;
}
export declare function parseAmount(raw: string | null | undefined): number | null;
export declare function parsePassportPage(html: string, serial: string, number: string): EjarimaPassportResult;
