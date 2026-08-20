import { HttpService } from '@nestjs/axios';
import { CaptchaSolverClient } from '../common/captcha-solver.client';
export interface TaxRiskResult {
    success: boolean;
    in_risk_list: boolean;
    reason?: string;
    attempts: number;
    data?: {
        tin: string;
        name: string | null;
        region: string | null;
        ns11_name: string | null;
        status: number;
        status_text: 'Ishonchli' | 'Shubhali';
        obnal: number | null;
        obnal_text: 'Ha' | "Yo'q" | null;
        sum_debt: number | null;
        vat_state: number | null;
        tax_gap: number | null;
        reg_date: string | null;
        founders: any;
        personal_data: any;
    };
    raw?: any;
}
export declare class TaxRiskService {
    private readonly httpService;
    private readonly solver;
    private readonly logger;
    private queue;
    constructor(httpService: HttpService, solver: CaptchaSolverClient);
    checkByInn(inn: string, maxAttempts?: number): Promise<TaxRiskResult>;
    checkByPinfl(pinfl: string, maxAttempts?: number): Promise<TaxRiskResult>;
    private runCheck;
    private absorbSetCookie;
    private jarToHeader;
    private initSession;
    private fetchCaptcha;
    private submitForm;
    private mapResponse;
}
