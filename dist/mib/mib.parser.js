"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseMibHome = parseMibHome;
const cheerio_1 = require("cheerio");
const clean = (s) => (s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
function parseMibHome(html, baseUrl = 'https://mib.uz') {
    const $ = (0, cheerio_1.load)(html);
    let token = null;
    const metaCsrf = $('meta[name="csrf-token"]').attr('content');
    if (metaCsrf) {
        token = metaCsrf;
    }
    if (!token) {
        const inputToken = $('input[name="_token"]').val();
        if (inputToken) {
            token = String(inputToken);
        }
    }
    const allLinks = [];
    $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        const text = clean($(el).text());
        const imgAlt = $(el).find('img').attr('alt') || '';
        allLinks.push({
            text: text || imgAlt,
            href,
        });
    });
    let debtCheckUrl = null;
    const DEBT_KEYWORDS = [
        'қарздорликни текшириш',
        'қарздорлик',
        'карздорликни текшириш',
        'карздорлик',
        'qarzdorlikni tekshirish',
        'qarzdorlik',
        'ижро ҳужжатлари',
        'ijro hujjatlari',
    ];
    $('a[href]').each((_, el) => {
        const text = clean($(el).text()).toLowerCase();
        const href = $(el).attr('href') || '';
        if (href === '#' || !href)
            return;
        for (const keyword of DEBT_KEYWORDS) {
            if (text.includes(keyword)) {
                debtCheckUrl = resolveUrl(href, baseUrl);
                return false;
            }
        }
    });
    return {
        debtCheckUrl,
        token,
        allLinks,
    };
}
function resolveUrl(href, baseUrl) {
    if (href.startsWith('./')) {
        return baseUrl.replace(/\/$/, '') + '/' + href.slice(2);
    }
    if (href.startsWith('/')) {
        const url = new URL(baseUrl);
        return url.origin + href;
    }
    if (href.startsWith('http')) {
        return href;
    }
    return baseUrl.replace(/\/$/, '') + '/' + href;
}
//# sourceMappingURL=mib.parser.js.map