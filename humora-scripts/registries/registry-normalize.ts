import { createHash } from 'crypto';
import { tashkentDay } from '../../common/tashkent-time';

/**
 * Text as a register shows it, trimmed and with runs of spaces closed; the
 * placeholders registers type into an empty cell ("-", "empty", "—") are null.
 * Line breaks inside a cell (lists of activities) are kept.
 */
export function textOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
    .filter((line, i, all) => line !== '' || (i > 0 && i < all.length - 1))
    .join('\n')
    .trim();
  if (!text) return null;
  if (/^[-–—.\s]+$/.test(text)) return null;
  if (/^(empty|null|none|нет|yo['‘’`ʻ]?q)$/i.test(text)) return null;
  return text;
}

/**
 * A number as a register sends it: a number, or text with spaces or a comma
 * for the decimal point. Null when it is not one.
 */
export function numberOf(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value).replace(/[\s ]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Digits of a taxpayer number however the register keeps it: text, a number,
 * or a float (`305943358.0` — several data.egov.uz registers).
 */
export function digitsOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  let text =
    typeof value === 'number'
      ? Number.isInteger(value)
        ? String(value)
        : ''
      : String(value).trim();
  text = text.replace(/\.0+$/, '').replace(/[\s ]/g, '');
  return /^\d+$/.test(text) ? text : null;
}

export interface TaxpayerIds {
  /** Nine digits — a company or an individual entrepreneur. */
  inn: string | null;
  /** Fourteen digits — a person. Never logged, never returned by company routes. */
  pinfl: string | null;
  /** What the source wrote when it is neither (kept for the report). */
  rawTin: string | null;
}

/** A taxpayer number read into STIR or PINFL; anything else only as written. */
export function taxpayerOf(value: unknown): TaxpayerIds {
  const digits = digitsOf(value);
  if (digits && /^\d{9}$/.test(digits) && !/^0+$/.test(digits)) {
    return { inn: digits, pinfl: null, rawTin: null };
  }
  if (digits && /^\d{14}$/.test(digits)) {
    return { inn: null, pinfl: digits, rawTin: null };
  }
  const raw = value === null || value === undefined ? '' : String(value).trim();
  return { inn: null, pinfl: null, rawTin: raw || null };
}

/** An individual entrepreneur's STIR starts 4, 5 or 6; a legal entity's 2 or 3. */
export function isTraderStir(inn: string | null): boolean {
  return inn !== null && /^[456]/.test(inn);
}

function realDay(y: number, m: number, d: number): string | null {
  if (y < 1900 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    return null; // 30.02 or 31.04 — a typo at the source, not a day
  }
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * A calendar day, `YYYY-MM-DD`, from the shapes registers write it in:
 * `2026-01-08`, `2026-01-08T…`, `08.01.2026`, `08/01/2026`, `08-01-2026`,
 * `08.01.2026 14:00:00`. A day that does not exist (29.02.2042) is null —
 * the text it came from stays in `raw`.
 */
export function dayOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return tashkentDay(value);
  const text = String(value).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T ])/.exec(text);
  if (m) {
    // An instant (`…T19:00:00Z`) is the Tashkent day it falls on.
    if (/T\d{2}:\d{2}/.test(text) && /(Z|[+-]\d{2}:?\d{2})$/.test(text)) {
      return tashkentDay(text);
    }
    return realDay(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(?:$|\s)/.exec(text);
  if (m) return realDay(Number(m[3]), Number(m[2]), Number(m[1]));
  return null;
}

/** Days in a text, in the order they are written (`… 24.11.2023 от 24.11.2025`). */
export function daysIn(text: string | null): Array<string | null> {
  if (!text) return [];
  const out: Array<string | null> = [];
  for (const m of text.matchAll(/(\d{1,2})[./](\d{1,2})[./](\d{4})/g)) {
    out.push(realDay(Number(m[3]), Number(m[2]), Number(m[1])));
  }
  return out;
}

/** sha1 of the value as JSON with keys sorted at every level. */
export function contentHash(value: unknown): string {
  return createHash('sha1').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
    .join(',')}}`;
}

/** A copy without the keys that name or reach a person. */
export function withoutKeys(
  row: Record<string, unknown>,
  drop: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!drop.includes(k)) out[k] = v;
  }
  return out;
}

/**
 * The quarter a dataset description names: "2026 yil I-chorak davomida",
 * "2026 йил 1 чорак", "(2024-yil 2-chorak)" → `2026Q1`. Null when it names none.
 */
export function quarterOf(text: string | null | undefined): string | null {
  if (!text) return null;
  const m =
    /(20\d{2})\s*[-–]?\s*(?:yil|йил|год)\w*\s*([IV]{1,3}|[1-4])\s*[-–]?\s*(?:chorak|чорак|квартал)/i.exec(
      text,
    );
  if (!m) return null;
  const roman: Record<string, number> = { I: 1, II: 2, III: 3, IV: 4 };
  const q = roman[m[2].toUpperCase()] ?? Number(m[2]);
  return q >= 1 && q <= 4 ? `${m[1]}Q${q}` : null;
}

/** The last day of a quarter: `2026Q1` → `2026-03-31`. */
export function quarterEnd(period: string): string | null {
  const m = /^(\d{4})Q([1-4])$/.exec(period);
  if (!m) return null;
  const ends = ['03-31', '06-30', '09-30', '12-31'];
  return `${m[1]}-${ends[Number(m[2]) - 1]}`;
}

// ---- Names, for registers that carry no STIR -------------------------------

/** Latin letters drawn like Cyrillic ones, in words that mix the two. */
const HOMOGLYPHS: Record<string, string> = {
  A: 'А',
  B: 'В',
  C: 'С',
  E: 'Е',
  H: 'Н',
  K: 'К',
  M: 'М',
  O: 'О',
  P: 'Р',
  T: 'Т',
  X: 'Х',
  Y: 'У',
};

const TRANSLIT: Record<string, string> = {
  А: 'A',
  Б: 'B',
  В: 'V',
  Г: 'G',
  Д: 'D',
  Е: 'E',
  Ё: 'YO',
  Ж: 'J',
  З: 'Z',
  И: 'I',
  Й: 'Y',
  К: 'K',
  Л: 'L',
  М: 'M',
  Н: 'N',
  О: 'O',
  П: 'P',
  Р: 'R',
  С: 'S',
  Т: 'T',
  У: 'U',
  Ф: 'F',
  Х: 'X',
  Ц: 'TS',
  Ч: 'CH',
  Ш: 'SH',
  Щ: 'SH',
  Ъ: '',
  Ы: 'I',
  Ь: '',
  Э: 'E',
  Ю: 'YU',
  Я: 'YA',
  Ў: 'O',
  Қ: 'Q',
  Ғ: 'G',
  Ҳ: 'H',
};

/**
 * Legal forms, written out and short, after folding. Dropped: one register
 * writes `MChJ`, the next "mas'uliyati cheklangan jamiyati", a third `ООО`.
 */
const LEGAL_FORMS = [
  'MASULIYATI CHEKLANGAN JAMIYATI',
  'MASULIYATI CHEKLANGAN JAMIYAT',
  'MASULIYATI CHEKLANGAN JAMYAT',
  'OBSHESTVO S OGRANICHENNOY OTVETSTVENNOSTYU',
  'AKSIYADORLIK JAMIYATI',
  'AKTSIONERNOE OBSHESTVO',
  'AKTSIONERNOYE OBSHESTVO',
  'XUSUSIY KORXONASI',
  'XUSUSIY KORXONA',
  'QOSHMA KORXONASI',
  'QOSHMA KORXONA',
  'XORIJIY KORXONA',
  'DAVLAT UNITAR KORXONASI',
  'UNITAR KORXONASI',
  'FERMER XOJALIGI',
  'MCHJ',
  'MCH',
  'OOO',
  'AJ',
  'AO',
  'XK',
  'QK',
  'XF',
  'DUK',
  'UK',
  'MCHJQK',
  'MCHJXK',
];

/**
 * A company name folded so two spellings of it meet: one alphabet (Latin),
 * no quotes, apostrophes or punctuation, no legal form, no spaces.
 * `"ALFA SAVDO" MChJ` and `«АЛФА САВДО» масъулияти чекланган жамияти` both
 * become `ALFASAVDO`. Null when nothing is left.
 */
export function nameKey(name: string | null | undefined): string | null {
  if (!name) return null;
  let text = name.toUpperCase().replace(/[ʻʼ'‘’`´]/g, '');
  // Latin homoglyphs inside Cyrillic words become the Cyrillic they meant.
  text = text.replace(/[A-ZА-ЯЁЎҚҒҲ]+/g, (word) =>
    /[А-ЯЁЎҚҒҲ]/.test(word) && /[A-Z]/.test(word)
      ? word.replace(/[A-Z]/g, (c) => HOMOGLYPHS[c] ?? c)
      : word,
  );
  text = text.replace(/[А-ЯЁЎҚҒҲЪЬ]/g, (c) => TRANSLIT[c] ?? c);
  text = text
    .replace(/KH/g, 'X')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
  for (const form of LEGAL_FORMS) {
    text = text.replace(new RegExp(`(^| )${form}( |$)`, 'g'), ' ').trim();
  }
  const key = text.replace(/ /g, '');
  return key || null;
}

/** Words that name an organisation, not a person, once folded to Latin. */
const ORGANISATION_WORDS =
  /(^| )(JAMIYAT\w*|KORXONA\w*|UYUSHMA\w*|KOMBINAT\w*|ZAVOD\w*|FABRIKA\w*|BANK\w*|INSTITUT\w*|MARKAZ\w*|FILIAL\w*|BOSHQARMA\w*|AGENTLIG\w*|AGENTSTV\w*|KOMPANIYA\w*|KOMPANI\w*|XOJALIG\w*|XUJALIG\w*|KOOPERATIV\w*|TRESTI?|KONTSERN\w*|XOLDING\w*|OBSHESTVO|PREDPRIYATIE|TOVARISHESTVO|GROUP|COMPANY|LLC|LTD|INC|CORP\w*|UNIVERSITET\w*|MAKTAB\w*|AKADEMIY\w*|VAZIRLIG\w*|QOMITA\w*|HOKIMIYAT\w*|DAVLAT|TASHKILOT\w*|MASULIYATI|AKSIYADORLIK|MCHJ|OOO|AJ|AO|XK|QK|DUK|UK|MCH|SP)( |$)/;

/**
 * Whether a register's name text is an organisation's: quoted, or carrying a
 * legal form or an organisation word. A bare "SURNAME NAME" is a person —
 * registers without a STIR (road carriers above all) list individual
 * entrepreneurs by their own names, and those are not kept.
 */
export function looksLikeOrganisation(
  name: string | null | undefined,
): boolean {
  if (!name) return false;
  if (/["«»“”„]/.test(name)) return true;
  let text = name.toUpperCase().replace(/[ʻʼ'‘’`´]/g, '');
  text = text.replace(/[А-ЯЁЎҚҒҲЪЬ]/g, (c) => TRANSLIT[c] ?? c);
  text = text.replace(/[^A-Z0-9]+/g, ' ').trim();
  return ORGANISATION_WORDS.test(text);
}
