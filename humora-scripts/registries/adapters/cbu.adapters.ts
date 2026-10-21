import { RegistryHttp } from '../registry-http';
import { readWorkbook, SheetRows } from '../registry-xlsx';
import {
  FetchResult,
  Labels,
  MapResult,
  RegistryAdapter,
  RegistryKind,
} from '../registry-types';
import { dayOf, textOf } from '../registry-normalize';
import { coordinates, entry, F, L, skip, stirOrSkip } from './adapter-kit';

/**
 * The Central Bank's registers of non-bank credit organisations. Each page
 * links one XLSX whose path changes with every upload, so the page is read
 * first for the link. Two layouts:
 *
 * - microcredit, pawn shops: one sheet, header `ID, LIC, LIC_DATA,
 *   LICENZIYAT_{RUS,UZB,UZL,ENG}, INN, ADRES_{…}, GEO_ID`;
 * - factoring, guarantee, mortgage refinancing, credit bureaus: a sheet per
 *   language (title row, blank row, header) — the Latin one is read.
 */
export const CBU = 'https://cbu.uz';

const STIR_HEADER = /^(INN|STIR|СТИР|ИНН)$|taxpayer identification/i;

/** Column picks, most specific pattern first. */
const COLUMNS: Record<string, RegExp[]> = {
  inn: [STIR_HEADER],
  name: [
    /^LICENZIYAT_UZL$/i,
    /^LICENZIYAT_UZB$/i,
    /nomi$|номи$|наименование|^name/i,
  ],
  number: [
    /^LIC$/i,
    /reyestr\s*(№|raqami)|реестр рақами|№ реестра|registr(y|ation)\s*n/i,
    /litsenziya raqami|лицензия рақами/i,
  ],
  date: [/^LIC_DATA$/i, /sana|сана|дата|date/i],
  address: [/^ADRES_UZL$/i, /^ADRES_UZB$/i, /manzil|манзил|адрес|address/i],
  geo: [/^GEO_ID$/i],
};

function pickColumns(header: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, patterns] of Object.entries(COLUMNS)) {
    for (const re of patterns) {
      const i = header.findIndex((h) => re.test(h));
      if (i >= 0) {
        out[key] = i;
        break;
      }
    }
  }
  return out;
}

/** One row of a register, by our column names. */
export type CbuRow = Record<string, unknown>;

/**
 * The register's rows from a workbook: the Latin sheet when there is one,
 * else the first sheet with a STIR column; the header is the first row (of
 * ten) that names the STIR. Null when no sheet has one.
 */
export function cbuRows(
  sheets: Array<{ name: string; rows: SheetRows }>,
): CbuRow[] | null {
  const ordered = [
    ...sheets.filter((s) => /лотин|lotin|latin/i.test(s.name)),
    ...sheets.filter((s) => !/лотин|lotin|latin/i.test(s.name)),
  ];
  for (const sheet of ordered) {
    const at = sheet.rows
      .slice(0, 10)
      .findIndex((r) =>
        r.some((v) => STIR_HEADER.test(String(v ?? '').trim())),
      );
    if (at < 0) continue;
    const header = sheet.rows[at].map((v) => String(v ?? '').trim());
    const cols = pickColumns(header);
    if (cols.inn === undefined || cols.name === undefined) continue;
    const out: CbuRow[] = [];
    for (const r of sheet.rows.slice(at + 1)) {
      const row: CbuRow = {};
      for (const [key, i] of Object.entries(cols)) row[key] = r[i] ?? null;
      if (!textOf(row.inn) && !textOf(row.name)) continue;
      out.push(row);
    }
    return out;
  }
  return null;
}

/** The workbook link on a register page (the first `.xlsx`). */
export function xlsxLink(html: string): string | null {
  const m = /href="([^"]+\.xlsx)"/i.exec(html);
  if (!m) return null;
  return m[1].startsWith('http') ? m[1] : `${CBU}${m[1]}`;
}

function cbuAdapter(
  code: string,
  page: string,
  kind: RegistryKind,
  title: Labels,
  minRows: number,
): RegistryAdapter {
  return {
    meta: {
      code,
      sector: 'finance',
      kind,
      title,
      cadence: 'weekly',
      display: true,
      fieldLabels: { address: F.legal_address, coordinates: F.coordinates },
      minRows,
    },
    async fetchAll(http: RegistryHttp): Promise<FetchResult> {
      const pageUrl = `${CBU}/en/credit-organizations/${page}/`;
      const html = await http.get<string>(pageUrl, { responseType: 'text' });
      const link = xlsxLink(String(html.data));
      if (!link)
        throw new Error(`cbu.uz ${page}: no workbook link on the page`);
      if (http.spent) return { rows: [], complete: false, expected: null };
      const file = await http.get<ArrayBuffer>(link, {
        responseType: 'arraybuffer',
      });
      const rows = cbuRows(await readWorkbook(Buffer.from(file.data)));
      if (!rows) throw new Error(`cbu.uz ${page}: no sheet with a STIR column`);
      return { rows, complete: true, expected: null };
    },
    map(row: unknown): MapResult {
      const r = row as CbuRow;
      const ids = stirOrSkip(r.inn);
      if ('skip' in ids) return ids;
      const name = textOf(r.name);
      if (!name) return skip('no name');
      const number = textOf(r.number);
      return entry({
        sourceKey: ids.inn!,
        inn: ids.inn,
        name,
        number,
        validFrom: dayOf(r.date),
        fields: {
          address: textOf(r.address),
          coordinates: coordinates(r.geo),
        },
        raw: Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            v instanceof Date ? v.toISOString() : v,
          ]),
        ),
      });
    },
  };
}

export const CBU_ADAPTERS: RegistryAdapter[] = [
  cbuAdapter(
    'microfinance_licence',
    'microcredit',
    'licence',
    L(
      'Mikromoliya tashkiloti litsenziyasi',
      'Лицензия микрофинансовой организации',
      'Microfinance organisation licence',
    ),
    60,
  ),
  cbuAdapter(
    'pawnshop_licence',
    'pawn-shops',
    'licence',
    L('Lombard litsenziyasi', 'Лицензия ломбарда', 'Pawnshop licence'),
    40,
  ),
  cbuAdapter(
    'factoring_company',
    'factoring',
    'registration',
    L(
      'Faktoring tashkilotlari reyestri',
      'Реестр факторинговых организаций',
      'Register of factoring companies',
    ),
    3,
  ),
  cbuAdapter(
    'guarantee_provider',
    'guarantee',
    'registration',
    L(
      'Kafolat beruvchi tashkilotlar reyestri',
      'Реестр организаций по предоставлению гарантий',
      'Register of guarantee providers',
    ),
    1,
  ),
  cbuAdapter(
    'mortgage_refinancing_company',
    'mortgage',
    'registration',
    L(
      'Ipotekani qayta moliyalashtirish tashkilotlari reyestri',
      'Реестр организаций по рефинансированию ипотеки',
      'Register of mortgage refinancing companies',
    ),
    1,
  ),
  cbuAdapter(
    'credit_bureau_licence',
    'bureaus',
    'licence',
    L(
      'Kredit byurosi litsenziyasi',
      'Лицензия кредитного бюро',
      'Credit bureau licence',
    ),
    1,
  ),
];
