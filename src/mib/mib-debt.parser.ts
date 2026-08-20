import { load } from 'cheerio';

export interface MibDebtFormDto {
  formAction: string;
  formId: string;
  hiddenFieldName: string;
  hiddenFieldValue: string;
  captchaImgUrl: string;
  ajaxSubmitUrl: string;
  /**
   * The name of the field the searched value goes in — `inn` on the legal
   * entity tab, `pinfl` on the ЖШШИР one. The page carries both forms at
   * once, each with its own Wicket hidden field, so the caller cannot assume
   * either name.
   */
  keyFieldName: 'inn' | 'pinfl';
}

export interface MibDebtResultDto {
  success: boolean;
  error: string | null;
  /** Umumiy ma'lumot */
  summary: MibDebtSummary | null;
  /** Har bir ijro hujjati bo'yicha qarzlar */
  debts: MibDebtItem[];
}

export interface MibDebtSummary {
  /** Umumiy qarzdorlik */
  totalDebt: string | null;
  /** Joriy qarzdorlik */
  currentDebt: string | null;
  /** Reestr qarzdorlik */
  registryDebt: string | null;
  /** Label matni (masalan: "202099756 СТИР рақамли юридик шахсда қарздорлик мавжуд!") */
  label: string | null;
}

export interface MibDebtItem {
  /** ФИО */
  name: string | null;
  /** СТИР */
  inn: string | null;
  /** Ижро иши рақами */
  caseNumber: string | null;
  /** Ҳужжат ҳолати */
  docStatus: string | null;
  /** И/Ҳ мазмуни */
  description: string | null;
  /** Ҳужжат иш юритувида */
  region: string | null;
  /** Ундирувчи */
  creditor: string | null;
  /** Қарздорлик миқдори */
  amount: string | null;
}

const clean = (s: string) =>
  (s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Qarzdorlik sahifasidan forma ma'lumotlarini olish.
 *
 * The page carries four forms — search, passport, ЖШШИР and STIR — and each
 * has its own Wicket hidden field, so picking the wrong one submits a token
 * the server will not accept. `key` chooses the tab: `inn` for a company,
 * `pinfl` for a person.
 */
export function parseDebtCheckPage(
  html: string,
  baseUrl: string,
  key: 'inn' | 'pinfl' = 'inn',
): MibDebtFormDto | null {
  const $ = load(html);

  let form = $(key === 'pinfl' ? '#tab_pinfl form' : '#tab_juridical form');
  if (!form.length) {
    form = $(`form:has(input[name="${key}"])`);
  }
  if (!form.length) return null;

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
    const regex = new RegExp(
      `"u":"([^"]+)"[^}]*"m":"POST"[^}]*"f":"${formId}"[^}]*"sc":"submit_button"`,
    );
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

/**
 * Natija HTML ni parse qilish
 */
export function parseDebtResult(html: string): MibDebtResultDto {
  const $ = load(html);

  // Xatolik tekshirish
  const errorEl = $('.feedbackPanelERROR, .alert-danger, .error-message');
  if (errorEl.length) {
    return {
      success: false,
      error: clean(errorEl.text()),
      summary: null,
      debts: [],
    };
  }

  // СТИР noto'g'ri xatolik
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

  // Umumiy ma'lumot: .debit-all-info-table
  let summary: MibDebtSummary | null = null;
  const summaryTable = $('.debit-all-info-table');
  if (summaryTable.length) {
    const label = clean($('.debit-all-info label').first().text());
    const rows = summaryTable.find('tr').toArray();

    let totalDebt: string | null = null;
    let currentDebt: string | null = null;
    let registryDebt: string | null = null;

    for (const row of rows) {
      const text = clean($(row).text());
      const amount = $(row).find('b').text().trim();

      if (text.includes('Умумий')) {
        totalDebt = amount ? `${amount} сўм` : null;
      } else if (text.includes('Жорий')) {
        currentDebt = amount ? `${amount} сўм` : null;
      } else if (text.includes('Реестр')) {
        registryDebt = amount ? `${amount} сўм` : null;
      }
    }

    summary = { totalDebt, currentDebt, registryDebt, label };
  }

  // Ijro hujjatlari: .black_item_v2
  const debts: MibDebtItem[] = [];
  $('.black_item_v2').each((_, el) => {
    const block = $(el);

    // bl-f-item lardan ma'lumot olish
    const fields: Record<string, string> = {};
    block.find('.bl-f-item').each((__, fi) => {
      const key = clean($(fi).find('span').text());
      const val = clean($(fi).find('label').text());
      if (key) fields[key] = val;
    });

    // Qarzdorlik miqdori
    const amountEl = block.find('.debit-amount label');
    const amount = amountEl.length ? clean(amountEl.text()) : null;

    // Faqat haqiqiy debt entry bo'lsa qo'shish (СТИР yoki ФИО bo'lishi kerak)
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

  // Agar qarz topilmasa
  if (!debts.length && !summary) {
    if (
      bodyText.includes('топилмади') ||
      bodyText.includes('мавжуд эмас') ||
      bodyText.includes('topilmadi')
    ) {
      return { success: true, error: null, summary: null, debts: [] };
    }
  }

  return { success: true, error: null, summary, debts };
}

function resolveRelativeUrl(href: string, baseUrl: string): string {
  if (href.startsWith('http')) return href;

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
