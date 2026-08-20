export interface DavreestrResultDto {
    success: boolean;
    error: string | null;
    totalCount: number;
    cadNumbers: string[];
    rowsSeen: number;
}
export interface CadRestriction {
    number: string;
    type: string;
    by: string;
    date: string;
    docNumber: string;
    exchangeCode: string;
}
export interface CadPropertyDto {
    success: boolean;
    error: string | null;
    cadNumber: string;
    address: string;
    objectType: string;
    totalLandArea: string;
    currentLandArea: string;
    buildingArea: string;
    usableArea: string;
    ownersCount: string;
    cadastralValue: string;
    registrationDate: string;
    extractNumber: string;
    restrictions: CadRestriction[];
    hasRestrictions: boolean;
}
export declare function parseDavreestrHtml(html: string): DavreestrResultDto;
export declare function parseCadPropertyHtml(html: string): CadPropertyDto;
