"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EJARIMA_STATUS = void 0;
exports.parseAmount = parseAmount;
exports.parsePassportPage = parsePassportPage;
const cheerio_1 = require("cheerio");
exports.EJARIMA_STATUS = {
    PAID: 0,
    PARTIAL: 1,
    UNPAID: 2,
};
const FIELDS = {
    'bayonnoma seriyasi va raqami': 'series',
    holati: 'status',
    'jazo chorasi': 'penaltyKind',
    'jarima miqdori': 'fineText',
    'zarar miqdori': 'damageText',
    "to'lov sanasi": 'paidAt',
    'sodir etilgan viloyat': 'region',
    'sodir etilgan tuman': 'district',
    'tuzilgan sana': 'issuedAt',
    'kvitansiya raqami': 'receiptNo',
    shaxs: 'personKind',
    'tuzgan organ': 'authority',
    modda: 'article',
};
function labelKey(raw) {
    return raw
        .replace(/[‘’ʻʼ`´]/g, "'")
        .replace(/\s+/g, ' ')
        .replace(/\s*:\s*$/, '')
        .trim()
        .toLowerCase();
}
function text(raw) {
    const t = (raw ?? '').replace(/\s+/g, ' ').trim();
    return t === '' ? null : t;
}
function parseAmount(raw) {
    if (raw == null)
        return null;
    const digits = raw.replace(/\D+/g, '');
    if (digits === '')
        return null;
    const n = Number(digits);
    return Number.isFinite(n) ? n : null;
}
function statusCodeOf(className) {
    const m = /(?:^|\s)status_(\d+)(?:\s|$)/.exec(className || '');
    return m ? Number(m[1]) : null;
}
function toastrMessages(html) {
    const out = [];
    const re = /toastr\.(error|warning|success|info)\(\s*'((?:[^'\\]|\\.)*)'/g;
    let m;
    while ((m = re.exec(html))) {
        out.push({
            level: m[1],
            text: m[2]
                .replace(/&#0?39;/g, "'")
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&')
                .replace(/\\'/g, "'"),
        });
    }
    return out;
}
function parsePassportPage(html, serial, number) {
    const $ = (0, cheerio_1.load)(html ?? '');
    const messages = toastrMessages(html ?? '');
    const protocols = $('.result-card')
        .toArray()
        .map((card) => {
        const p = {
            series: null,
            status: null,
            statusCode: null,
            paid: false,
            decided: false,
            penaltyKind: null,
            fineAmount: null,
            fineText: null,
            damageAmount: null,
            damageText: null,
            paidAt: null,
            region: null,
            district: null,
            issuedAt: null,
            receiptNo: null,
            personKind: null,
            authority: null,
            article: null,
        };
        $(card)
            .find('p.text-muted')
            .each((_, label) => {
            const key = FIELDS[labelKey($(label).text())];
            if (!key)
                return;
            const value = $(label).nextAll('h5').first();
            if (!value.length)
                return;
            p[key] = text(value.text());
            if (key === 'status') {
                p.statusCode = statusCodeOf(value.attr('class') ?? '');
            }
        });
        p.fineAmount = parseAmount(p.fineText);
        p.damageAmount = parseAmount(p.damageText);
        p.decided = p.statusCode !== null;
        p.paid = p.statusCode === exports.EJARIMA_STATUS.PAID;
        return p;
    });
    const searched = protocols.length > 0 || $('.result-header').length > 0;
    const outcome = protocols.length > 0 ? 'found' : searched ? 'none' : 'unavailable';
    const unpaid = protocols.filter((p) => p.statusCode === exports.EJARIMA_STATUS.UNPAID ||
        p.statusCode === exports.EJARIMA_STATUS.PARTIAL);
    return {
        serial,
        number,
        outcome,
        found: outcome === 'found',
        protocols,
        unpaidCount: unpaid.length,
        unpaidTotal: unpaid.reduce((sum, p) => sum + (p.fineAmount ?? 0), 0),
        pendingCount: protocols.filter((p) => !p.decided).length,
        message: messages.length ? messages[messages.length - 1].text : null,
    };
}
//# sourceMappingURL=ejarima.parse.js.map