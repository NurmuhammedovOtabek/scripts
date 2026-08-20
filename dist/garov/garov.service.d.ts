import { MemoryCacheService } from '../common/memory-cache.service';
export interface GarovRecord {
    collateral_id?: number | null;
    inn: string;
    inn_or_pinfl?: string | null;
    code: string;
    debtor_name: string | null;
    state_name: string | null;
    state: string | null;
    creditor_name: string | null;
    creditor_phone: string | null;
    printable: number | null;
    order?: string | null;
    created_at?: string | null;
    updated_at?: string | null;
}
export interface GarovFilters {
    state?: 'active' | 'resolved';
    sort?: 'created_date';
    order?: 'asc' | 'desc';
}
export declare class GarovService {
    private readonly cacheManager;
    private readonly logger;
    private readonly BASE;
    private readonly SEARCH_URL;
    private readonly UA;
    private readonly httpTimeout;
    private readonly CACHE_TTL_MS;
    private queue;
    constructor(cacheManager: MemoryCacheService);
    getByInn(inn: string, filters?: GarovFilters): Promise<GarovRecord[]>;
    getByPinfl(pinfl: string): Promise<GarovRecord[]>;
    refreshByInn(inn: string): Promise<GarovRecord[]>;
    verifyByCode(code: string): Promise<GarovRecord | null>;
    private fetchByInn;
    private fetchByPinfl;
    private fetchByCode;
    private fetchCaptchaToken;
    private postSearch;
    private runQueued;
    private readonly failureAlerts;
    private notifyFailure;
    private cacheKey;
    private randomToken;
    private mapRecord;
}
