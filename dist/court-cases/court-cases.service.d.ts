export declare class CourtCasesService {
    getCourtCases(tin?: string, caseNumber?: string): Promise<any[] | {
        message: string;
        tin: string | undefined;
        caseNumber: string | undefined;
    }>;
}
