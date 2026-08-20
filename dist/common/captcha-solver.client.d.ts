import { OnModuleInit, OnModuleDestroy } from '@nestjs/common';
export type CaptchaCharset = 'digits' | 'alpha' | 'alnum';
export interface SolveOptions {
    type?: CaptchaCharset;
    length?: number;
}
export declare class CaptchaSolverClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger;
    private readonly pythonBin;
    private readonly scriptPath;
    private readonly solveTimeoutMs;
    private proc;
    private stdoutBuffer;
    private pending;
    private nextId;
    private ready;
    private readyWaiters;
    private shuttingDown;
    onModuleInit(): void;
    onModuleDestroy(): Promise<void>;
    solve(imgBuf: Buffer, opts?: SolveOptions): Promise<string | null>;
    private spawnProcess;
    private markReady;
    private waitReady;
    private onStdout;
}
