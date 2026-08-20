export interface MibHomeDto {
    debtCheckUrl: string | null;
    token: string | null;
    allLinks: {
        text: string;
        href: string;
    }[];
}
export declare function parseMibHome(html: string, baseUrl?: string): MibHomeDto;
