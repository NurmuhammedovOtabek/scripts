export declare class MemoryCacheService {
    private readonly store;
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T, ttlMs: number): Promise<void>;
    del(key: string): Promise<void>;
    private sweep;
}
