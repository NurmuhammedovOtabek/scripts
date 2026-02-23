import { HttpService } from '@nestjs/axios';
import * as Tesseract from 'tesseract.js';
export declare class CaptchaSolverService {
    private readonly httpService;
    private readonly logger;
    private session;
    private userAgentIndex;
    private requestCount;
    private readonly MAX_REQUESTS;
    private readonly TIME_WINDOW;
    constructor(httpService: HttpService);
    private getNextUserAgent;
    initializeSession(): Promise<void>;
    fetchCaptcha(): Promise<Buffer>;
    searchByTin(tin: string): Promise<any>;
    private checkRateLimit;
    solveCaptcha(): Promise<string>;
    private worker;
    getWorker(): Promise<Tesseract.Worker>;
    readWithTesseract(buffer: Buffer): Promise<string>;
    private extractCookieValue;
    private delay;
    clearSession(): void;
    onModuleDestroy(): Promise<void>;
}
