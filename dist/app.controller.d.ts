import { AppService } from './app.service';
export declare class AppController {
    private readonly appService;
    constructor(appService: AppService);
    getFromStatus(inn?: string): Promise<import("./parser").RegistrDto>;
    getLitsens(tin?: string): Promise<any[]>;
    getSud(tin?: string, caseNumber?: string): Promise<any[] | {
        message: string;
        tin: string | undefined;
        caseNumber: string | undefined;
    }>;
}
