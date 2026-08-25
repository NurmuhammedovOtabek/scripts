import type { Response } from 'express';
export declare class LogsController {
    private assertAllowed;
    read(res: Response, token?: string, lines?: string, q?: string): string;
    info(token?: string): {
        file: string;
        sizeBytes: number;
        sizeMb: number;
        lastLine: string;
    };
}
