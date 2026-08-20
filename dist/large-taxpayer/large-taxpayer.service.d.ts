import { HttpService } from '@nestjs/axios';
export interface LargeTaxpayerResult {
    inn: string;
    is_large_taxpayer: boolean;
    data?: {
        tin: string;
        name: string;
        region: string | null;
        district: string | null;
    };
}
export declare class LargeTaxpayerService {
    private readonly httpService;
    private readonly logger;
    constructor(httpService: HttpService);
    checkByInn(inn: string): Promise<LargeTaxpayerResult>;
}
