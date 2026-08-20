export interface MibDebtFormDto {
    formAction: string;
    formId: string;
    hiddenFieldName: string;
    hiddenFieldValue: string;
    captchaImgUrl: string;
    ajaxSubmitUrl: string;
    keyFieldName: 'inn' | 'pinfl';
}
export interface MibDebtResultDto {
    success: boolean;
    error: string | null;
    summary: MibDebtSummary | null;
    debts: MibDebtItem[];
}
export interface MibDebtSummary {
    totalDebt: string | null;
    currentDebt: string | null;
    registryDebt: string | null;
    label: string | null;
}
export interface MibDebtItem {
    name: string | null;
    inn: string | null;
    caseNumber: string | null;
    docStatus: string | null;
    description: string | null;
    region: string | null;
    creditor: string | null;
    amount: string | null;
}
export declare function parseDebtCheckPage(html: string, baseUrl: string, key?: 'inn' | 'pinfl'): MibDebtFormDto | null;
export declare function parseDebtResult(html: string): MibDebtResultDto;
