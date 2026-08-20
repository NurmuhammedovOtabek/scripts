export declare class NoProxyPool {
    acquire(): string | null;
    agentFor(_endpoint: string): undefined;
    report(_endpoint: string | null, _ok: boolean): void;
}
