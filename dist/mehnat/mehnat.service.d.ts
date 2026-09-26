import { HttpService } from '@nestjs/axios';
export interface MehnatVacanciesResult {
    tin: string;
    rows: any[];
    details: Record<string, any>;
}
export declare class MehnatService {
    private readonly http;
    private readonly logger;
    constructor(http: HttpService);
    getVacancies(tin: string): Promise<MehnatVacanciesResult>;
    private listAll;
    private fetchJson;
}
export declare function rowsForTin(body: any, tin: string): any[];
