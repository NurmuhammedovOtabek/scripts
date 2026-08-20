import { HttpService } from '@nestjs/axios';
import { CaptchaSolverClient } from '../common/captcha-solver.client';
export interface TaxDebtorResult {
    success: boolean;
    in_debtor_list: boolean;
    reason?: string;
    attempts: number;
    data?: {
        tin: string;
        name: string | null;
        region: string | null;
        ns11_name: string | null;
        entity_type: number;
        entity_type_text: 'legal' | 'entrepreneur';
        sum_debt: number | null;
    };
    raw?: any;
}
export declare class TaxDebtorService {
    private readonly httpService;
    private readonly solver;
    private readonly logger;
    private queue;
    constructor(httpService: HttpService, solver: CaptchaSolverClient);
    checkByInn(inn: string, maxAttempts?: number): Promise<TaxDebtorResult>;
    checkByPinfl(pinfl: string, maxAttempts?: number): Promise<TaxDebtorResult>;
    private runCheck;
    private absorbSetCookie;
    private jarToHeader;
    private initSession;
    private fetchCaptcha;
    private submitForm;
    private mapResponse;
}
