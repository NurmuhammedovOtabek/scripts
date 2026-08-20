import { load } from 'cheerio';

// ─── DTOs ──────────────────────────────────────────────────────────────────

export interface DavreestrResultDto {
  success: boolean;
  error: string | null;
  totalCount: number;
  cadNumbers: string[];
  /**
   * Result rows the page rendered, before duplicates were collapsed.
   *
   * `totalCount` is the register's own "Topilgan Obyektlar Soni" — a count of
   * OBJECTS, and one parcel routinely carries several: a warehouse and two
   * buildings on one cadastre number is three objects and one number. So
   * `cadNumbers.length` is not the figure to check completeness against, and
   * comparing them read INN 304701231 as "8 declared, 3 parsed" when nothing
   * at all was missing — and then refused to save its perfectly good data.
   */
  rowsSeen: number;
}

export interface CadRestriction {
  number: string;
  type: string;
  by: string;
  date: string;
  docNumber: string;
  exchangeCode: string;
}

export interface CadPropertyDto {
  success: boolean;
  error: string | null;
  cadNumber: string;
  address: string;
  objectType: string;
  totalLandArea: string;
  currentLandArea: string;
  buildingArea: string;
  usableArea: string;
  ownersCount: string;
  cadastralValue: string;
  registrationDate: string;
  extractNumber: string;
  restrictions: CadRestriction[];
  hasRestrictions: boolean;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const clean = (s: string) =>
  (s || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// Kadastr raqami ikki shaklda keladi, va davreestr ikkalasini bir ro'yxatda
// aralashtirib beradi:
//   11:04:41:01:01:0116   olti guruh
//   11:04:000004043       uch guruh
// INN 300922269 uchun o'n ikkitadan o'ntasi uchinchi shaklda edi — faqat olti
// guruhlisini biladigan naqsh o'n ikkitadan bittasini qaytargan.
const CAD_NUMBER_RE =
  /\d{2}:\d{2}:(?:\d{2}:\d{2}:\d{2}:\d{4}(?:[:/]\d+)*|\d{6,})/g;

// ─── Parser ────────────────────────────────────────────────────────────────

export function parseDavreestrHtml(html: string): DavreestrResultDto {
  const $ = load(html);

  // 1. Xatolik bor-yo'qligini tekshirish
  const alertDanger = $('.alert-danger');
  if (alertDanger.length) {
    const errors: string[] = [];
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

  // 2. "Topilgan Obyektlar Soni: XX" ni olish.
  //
  // Read from the text of the one element that carries the label, not from
  // `$('body').text()`. That flattens the whole page into one string with no
  // separator between elements, so a count of 12 followed by a result labelled
  // `11:04:000004043` reads as `Soni: 1211:04:…` and `(\d+)` walks off the end
  // of the number into the next one — 12 becomes 1211, and every answer looks
  // short. Only whitespace in the source HTML was hiding it.
  let totalCount = 0;
  const COUNT_RE = /Topilgan\s+Obyektlar\s+Soni:\s*(\d+)/i;
  $('*').each((_, el) => {
    if (totalCount) return false;
    const ownText = $(el)
      .contents()
      .filter((__, n) => n.type === 'text')
      .text();
    const m = ownText.match(COUNT_RE);
    if (m) totalCount = parseInt(m[1], 10);
    return undefined;
  });

  // 3. Kadastr raqamlarini yig'ish.
  const cadNumbers: string[] = [];
  const seen = new Set<string>();

  // Natijalar matnda emas, radio tugmalarning `value` atributida turadi:
  //   <input type="radio" name="trg1" value="11:04:000004043">
  //
  // Bu qiymatlar SHAKLI bo'yicha tekshirilmaydi, va bu ataylab. `name="trg1"`
  // — saytning o'zi qo'ygan belgi: "bu qator natija". Ustiga "kadastr raqami
  // shunday ko'rinishi kerak" degan naqsh qo'yish — har safar registr biz
  // kutmagan shaklni ishlatganda ma'lumotni jimgina yo'qotish demak. Aynan
  // shundan INN 300922269 o'n ikkitadan bittasini ko'rsatgan (uch guruhli
  // shakl naqshda yo'q edi), keyin INN 304701231 sakkiztadan uchtasini.
  //
  // Bu yerda naqsh bo'lishining yagona sababi qidiruv maydonidagi namuna va
  // inputmask edi — lekin ikkalasi ham `trg1` qiymati bo'la olmaydi: biri
  // boshqa inputning `placeholder` atributi, ikkinchisi <script> ichida.
  // Rows are counted as the page rendered them; `cadNumbers` collapses the
  // duplicates. Both are needed: the numbers are what we store, the row count
  // is what the register's own total can honestly be compared against.
  let rowsSeen = 0;
  $('input[name="trg1"]').each((_, el) => {
    const v = clean($(el).attr('value') || '');
    if (!v) return;
    rowsSeen++;
    if (!seen.has(v)) {
      seen.add(v);
      cadNumbers.push(v);
    }
  });

  // davreestr.uz <script> tag'larida jQuery inputmask format mask'lari bor
  // (masalan, "99:99:99:99:99:9999"). Ular kadastr raqami emas — input
  // formatini tasvirlovchi shablon. <style>, <noscript>, <template> ham
  // ko'rinadigan kontent emas. Hammasini olib tashlaymiz.
  $('script, style, noscript, template').remove();

  // Zaxira: matn tugunlaridan yig'ish, agar sahifa tuzilishi o'zgarsa.
  // Endi <script> olib tashlangan, faqat haqiqiy kontent qoladi.
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

  // Usul 2 (fallback) — endi yo'q. Avval butun HTML'dan regex bilan
  // olardik, lekin u <script> ichidagi misollarni ham ushlardi va dummy
  // raqamlarni qo'shardi. Endi Usul 1 yetarli.

  return {
    success: cadNumbers.length > 0,
    error: cadNumbers.length === 0 ? "Ma'lumot topilmadi" : null,
    totalCount: totalCount || cadNumbers.length,
    cadNumbers,
    // The text-node fallback has no rows of its own to count, so when it is
    // the only thing that found anything, the numbers it found are the best
    // account of the page we have.
    rowsSeen: rowsSeen || cadNumbers.length,
  };
}

// ─── Kadastr raqami bo'yicha natija parser ─────────────────────────────────

export function parseCadPropertyHtml(html: string): CadPropertyDto {
  const $ = load(html);

  // Xatolik tekshirish
  const alertDanger = $('.alert-danger');
  if (alertDanger.length) {
    const errors: string[] = [];
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

  // Kadastr raqami - h1.captlize
  const cadNumber = clean($('h1.captlize').text());

  // Ma'lumot topilmadimi?
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

  // Manzil - h1 dan keyingi p.location-color
  const address = clean($('p.location-color').text());

  // Jadvaldan ma'lumotlarni olish
  const getField = (label: string): string => {
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

  // Ta'qiq va cheklovlar
  const restrictions: CadRestriction[] = [];
  const hasRestrictions = $('p.text-danger').text().includes('Mavjud');

  // Cheklovlar jadvali (ichki jadval)
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
