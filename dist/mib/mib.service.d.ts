import { HttpService } from '@nestjs/axios';
import { MibHomeDto } from './mib.parser';
import { MibDebtResultDto } from './mib-debt.parser';
export declare class MibScriptService {
    private readonly httpService;
    private readonly logger;
    private readonly BASE_URL;
    private session;
    private lastDebtPageUrl;
    private readonly defaultHeaders;
    private worker;
    constructor(httpService: HttpService);
    private parseAmount;
    checkDebtByInn(inn: string): Promise<MibDebtResultDto>;
    checkDebtByPinfl(pinfl: string): Promise<MibDebtResultDto>;
    private checkDebt;
    private getWorker;
    private solveCaptcha;
    private preprocessCaptcha;
    private submitDebtForm;
    private saveCookies;
    private cleanUrl;
    fetchHome(): Promise<MibHomeDto>;
    fetchPage(url: string): Promise<string>;
    getDebtCheckInfo(): Promise<{
        homeData: MibHomeDto;
        debtPageHtml?: string;
    }>;
    testCaptchaSolving(): Promise<{
        success: boolean;
        error: string;
        captchaImgUrl?: undefined;
        answer?: undefined;
        ocrResults?: undefined;
        message?: undefined;
    } | {
        success: boolean;
        captchaImgUrl: string;
        answer: number | null;
        ocrResults: {
            name: string;
            text: string;
        }[];
        message: string;
        error?: undefined;
    }>;
    onModuleDestroy(): Promise<void>;
}
