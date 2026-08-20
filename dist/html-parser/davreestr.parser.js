"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDavreestrHtml = parseDavreestrHtml;
exports.parseCadPropertyHtml = parseCadPropertyHtml;
const cheerio_1 = require("cheerio");
const clean = (s) => (s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const CAD_NUMBER_RE = /\d{2}:\d{2}:(?:\d{2}:\d{2}:\d{2}:\d{4}(?:[:/]\d+)*|\d{6,})/g;
function parseDavreestrHtml(html) {
    const $ = (0, cheerio_1.load)(html);
    const alertDanger = $('.alert-danger');
    if (alertDanger.length) {
        const errors = [];
        alertDanger.find('li').each((_, el) => {
            errors.push(clean($(el).text()));
        });
        if (errors.length) {
            return {
                success: false,
                error: errors.join('; '),
                totalCount: 0,
                cadNumbers: [],
                rowsSeen: 0,
            };
        }
    }
    let totalCount = 0;
    const COUNT_RE = /Topilgan\s+Obyektlar\s+Soni:\s*(\d+)/i;
    $('*').each((_, el) => {
        if (totalCount)
            return false;
        const ownText = $(el)
            .contents()
            .filter((__, n) => n.type === 'text')
            .text();
        const m = ownText.match(COUNT_RE);
        if (m)
            totalCount = parseInt(m[1], 10);
        return undefined;
    });
    const cadNumbers = [];
    const seen = new Set();
    let rowsSeen = 0;
    $('input[name="trg1"]').each((_, el) => {
        const v = clean($(el).attr('value') || '');
        if (!v)
            return;
        rowsSeen++;
        if (!seen.has(v)) {
            seen.add(v);
            cadNumbers.push(v);
        }
    });
    $('script, style, noscript, template').remove();
    $('*').each((_, el) => {
        const node = $(el);
        const ownText = node
            .contents()
            .filter((__, n) => n.type === 'text')
            .text();
        const matches = ownText.match(CAD_NUMBER_RE);
        if (matches) {
            for (const m of matches) {
                if (!seen.has(m)) {
                    seen.add(m);
                    cadNumbers.push(m);
                }
            }
        }
    });
    return {
        success: cadNumbers.length > 0,
        error: cadNumbers.length === 0 ? "Ma'lumot topilmadi" : null,
        totalCount: totalCount || cadNumbers.length,
        cadNumbers,
        rowsSeen: rowsSeen || cadNumbers.length,
    };
}
function parseCadPropertyHtml(html) {
    const $ = (0, cheerio_1.load)(html);
    const alertDanger = $('.alert-danger');
    if (alertDanger.length) {
        const errors = [];
        alertDanger.find('li').each((_, el) => {
            errors.push(clean($(el).text()));
        });
        if (errors.length) {
            return {
                success: false,
                error: errors.join('; '),
                cadNumber: '',
                address: '',
                objectType: '',
                totalLandArea: '',
                currentLandArea: '',
                buildingArea: '',
                usableArea: '',
                ownersCount: '',
                cadastralValue: '',
                registrationDate: '',
                extractNumber: '',
                restrictions: [],
                hasRestrictions: false,
            };
        }
    }
    const cadNumber = clean($('h1.captlize').text());
    if (!cadNumber) {
        return {
            success: false,
            error: "Ma'lumot topilmadi",
            cadNumber: '',
            address: '',
            objectType: '',
            totalLandArea: '',
            currentLandArea: '',
            buildingArea: '',
            usableArea: '',
            ownersCount: '',
            cadastralValue: '',
            registrationDate: '',
            extractNumber: '',
            restrictions: [],
            hasRestrictions: false,
        };
    }
    const address = clean($('p.location-color').text());
    const getField = (label) => {
        let value = '';
        $('table.table tbody tr').each((_, tr) => {
            const tds = $(tr).find('td');
            if (tds.length >= 2) {
                const tdText = clean($(tds[0]).text());
                if (tdText.includes(label)) {
                    value = clean($(tds[1]).text());
                }
            }
        });
        return value;
    };
    const objectType = getField("Ob'ekt turi");
    const totalLandArea = getField('umumiy yer maydoni');
    const currentLandArea = getField('Amaldagi yer maydoni');
    const buildingArea = getField('Qurilish osti maydoni');
    const usableArea = getField('Umumiy foydali maydoni');
    const ownersCount = getField('Mulkdorlar soni');
    const cadastralValue = getField('Kadastr qiymati');
    const registrationDate = getField("o'tkazish sanasi");
    const extractNumber = getField("Ko'chirma raqami");
    const restrictions = [];
    const hasRestrictions = $('p.text-danger').text().includes('Mavjud');
    $('table table tbody tr').each((_, tr) => {
        const tds = $(tr).find('td');
        if (tds.length >= 6) {
            restrictions.push({
                number: clean($(tds[0]).text()),
                type: clean($(tds[1]).text()),
                by: clean($(tds[2]).text()),
                date: clean($(tds[3]).text()),
                docNumber: clean($(tds[4]).text()),
                exchangeCode: clean($(tds[5]).text()),
            });
        }
    });
    return {
        success: true,
        error: null,
        cadNumber,
        address,
        objectType,
        totalLandArea,
        currentLandArea,
        buildingArea,
        usableArea,
        ownersCount,
        cadastralValue,
        registrationDate,
        extractNumber,
        restrictions,
        hasRestrictions,
    };
}
//# sourceMappingURL=davreestr.parser.js.map