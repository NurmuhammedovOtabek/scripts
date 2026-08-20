"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDebtCheckPage = parseDebtCheckPage;
exports.parseDebtResult = parseDebtResult;
const cheerio_1 = require("cheerio");
const clean = (s) => (s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
function parseDebtCheckPage(html, baseUrl, key = 'inn') {
    const $ = (0, cheerio_1.load)(html);
    let form = $(key === 'pinfl' ? '#tab_pinfl form' : '#tab_juridical form');
    if (!form.length) {
        form = $(`form:has(input[name="${key}"])`);
    }
    if (!form.length)
        return null;
    const formId = form.attr('id') || '';
    const formAction = form.attr('action') || '';
    const hiddenInput = form.find('input[type="hidden"]').first();
    const hiddenFieldName = hiddenInput.attr('name') || '';
    const hiddenFieldValue = hiddenInput.attr('value') || '';
    let captchaImgUrl = '';
    form.find('img[alt]').each((_, el) => {
        const src = $(el).attr('src') || '';
        if (src.includes('antiCache') || src.includes('captcha')) {
            captchaImgUrl = src;
            return false;
        }
    });
    if (!captchaImgUrl) {
        const captchaLink = form.find('.captcha-link, .captcha');
        captchaImgUrl = captchaLink.find('img').attr('src') || '';
    }
    if (captchaImgUrl && !captchaImgUrl.startsWith('http')) {
        captchaImgUrl = resolveRelativeUrl(captchaImgUrl, baseUrl);
    }
    let ajaxSubmitUrl = '';
    const scripts = $('script').toArray();
    for (const script of scripts) {
        const scriptText = $(script).text();
        const regex = new RegExp(`"u":"([^"]+)"[^}]*"m":"POST"[^}]*"f":"${formId}"[^}]*"sc":"submit_button"`);
        const match = scriptText.match(regex);
        if (match) {
            ajaxSubmitUrl = match[1];
            if (!ajaxSubmitUrl.startsWith('http')) {
                ajaxSubmitUrl = resolveRelativeUrl(ajaxSubmitUrl, baseUrl);
            }
            break;
        }
    }
    if (!ajaxSubmitUrl) {
        ajaxSubmitUrl = formAction ? resolveRelativeUrl(formAction, baseUrl) : '';
    }
    return {
        formAction: formAction ? resolveRelativeUrl(formAction, baseUrl) : '',
        formId,
        hiddenFieldName,
        hiddenFieldValue,
        captchaImgUrl,
        ajaxSubmitUrl,
        keyFieldName: key,
    };
}
function parseDebtResult(html) {
    const $ = (0, cheerio_1.load)(html);
    const errorEl = $('.feedbackPanelERROR, .alert-danger, .error-message');
    if (errorEl.length) {
        return {
            success: false,
            error: clean(errorEl.text()),
            summary: null,
            debts: [],
        };
    }
    const bodyText = $('body').text();
    const stirError = bodyText.match(/(Киритилган СТИР нотўғри[^!]*!)/);
    if (stirError) {
        return {
            success: false,
            error: clean(stirError[1]),
            summary: null,
            debts: [],
        };
    }
    let summary = null;
    const summaryTable = $('.debit-all-info-table');
    if (summaryTable.length) {
        const label = clean($('.debit-all-info label').first().text());
        const rows = summaryTable.find('tr').toArray();
        let totalDebt = null;
        let currentDebt = null;
        let registryDebt = null;
        for (const row of rows) {
            const text = clean($(row).text());
            const amount = $(row).find('b').text().trim();
            if (text.includes('Умумий')) {
                totalDebt = amount ? `${amount} сўм` : null;
            }
            else if (text.includes('Жорий')) {
                currentDebt = amount ? `${amount} сўм` : null;
            }
            else if (text.includes('Реестр')) {
                registryDebt = amount ? `${amount} сўм` : null;
            }
        }
        summary = { totalDebt, currentDebt, registryDebt, label };
    }
    const debts = [];
    $('.black_item_v2').each((_, el) => {
        const block = $(el);
        const fields = {};
        block.find('.bl-f-item').each((__, fi) => {
            const key = clean($(fi).find('span').text());
            const val = clean($(fi).find('label').text());
            if (key)
                fields[key] = val;
        });
        const amountEl = block.find('.debit-amount label');
        const amount = amountEl.length ? clean(amountEl.text()) : null;
        if (fields['СТИР'] || fields['ФИО']) {
            debts.push({
                name: fields['ФИО'] || null,
                inn: fields['СТИР'] || null,
                caseNumber: fields['Ижро иши рақами'] || null,
                docStatus: fields['Ҳужжат ҳолати'] || null,
                description: fields['И/Ҳ мазмуни'] || null,
                region: fields['Ҳужжат иш юритувида'] || null,
                creditor: fields['Ундирувчи'] || null,
                amount,
            });
        }
    });
    if (!debts.length && !summary) {
        if (bodyText.includes('топилмади') ||
            bodyText.includes('мавжуд эмас') ||
            bodyText.includes('topilmadi')) {
            return { success: true, error: null, summary: null, debts: [] };
        }
    }
    return { success: true, error: null, summary, debts };
}
function resolveRelativeUrl(href, baseUrl) {
    if (href.startsWith('http'))
        return href;
    const base = new URL(baseUrl);
    let path = href;
    while (path.startsWith('../')) {
        path = path.slice(3);
    }
    if (path.startsWith('./')) {
        path = path.slice(2);
    }
    return `${base.origin}/${path}`;
}
//# sourceMappingURL=mib-debt.parser.js.map