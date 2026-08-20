"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.HtmlParserService = void 0;
const common_1 = require("@nestjs/common");
const davreestr_parser_1 = require("./davreestr.parser");
let HtmlParserService = class HtmlParserService {
    parseDavreestr(html) {
        return (0, davreestr_parser_1.parseDavreestrHtml)(html);
    }
    parseCadProperty(html) {
        return (0, davreestr_parser_1.parseCadPropertyHtml)(html);
    }
};
exports.HtmlParserService = HtmlParserService;
exports.HtmlParserService = HtmlParserService = __decorate([
    (0, common_1.Injectable)()
], HtmlParserService);
//# sourceMappingURL=html-parser.service.js.map