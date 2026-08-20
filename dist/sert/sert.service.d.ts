export interface CertificateFields {
    cert_body: string;
    blank_number: string;
    registry_number: string;
    issued_date: string;
    expiry_date: string;
    product_name: string;
    scheme: string;
    applicant_inn: string;
    tnved_code: string;
    applicant_name: string;
    country: string;
    status: string;
}
export declare function hasStorableContent(cert: CertificateFields): boolean;
export declare class SertScriptService {
    private readonly logger;
    private readonly INDEX_URL;
    private readonly SEARCH_URL;
    getSession(): Promise<string>;
    searchByInn(inn: string, session: string): Promise<{
        certs: CertificateFields[];
        session: string;
    }>;
    getByInn(inn: string): Promise<CertificateFields[]>;
    private parse;
}
