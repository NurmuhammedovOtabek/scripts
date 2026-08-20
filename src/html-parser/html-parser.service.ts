import { Injectable } from '@nestjs/common';
import {
  parseDavreestrHtml,
  DavreestrResultDto,
  parseCadPropertyHtml,
  CadPropertyDto,
} from './davreestr.parser';

@Injectable()
export class HtmlParserService {
  parseDavreestr(html: string): DavreestrResultDto {
    return parseDavreestrHtml(html);
  }

  parseCadProperty(html: string): CadPropertyDto {
    return parseCadPropertyHtml(html);
  }
}
