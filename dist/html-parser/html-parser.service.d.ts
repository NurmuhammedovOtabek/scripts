import { DavreestrResultDto, CadPropertyDto } from './davreestr.parser';
export declare class HtmlParserService {
    parseDavreestr(html: string): DavreestrResultDto;
    parseCadProperty(html: string): CadPropertyDto;
}
