export interface FounderDto {
    name: string;
    share?: string;
}
export interface RegistrDto {
    inn: string | null;
    companyName: string | null;
    registerOrg: string | null;
    registerDate: string | null;
    registerNumber: string | null;
    legalForm: string | null;
    ifut: string | null;
    dbibt: string | null;
    smallBusiness: string | null;
    activityStatus: string | null;
    charterCapital: string | null;
    email: string | null;
    phone: string | null;
    mhobt: string | null;
    address: string | null;
    director: string | null;
    founders: FounderDto[];
    asOf: string | null;
}
export declare function parseRegistrHtml(html: string): RegistrDto;
