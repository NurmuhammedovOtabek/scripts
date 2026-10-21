import { RegistryHttp } from './registry-http';
import { FetchResult } from './registry-types';
import { dayOf, quarterOf, textOf } from './registry-normalize';

/**
 * data.egov.uz, the open-data portal: every dataset is read with one POST per
 * page and described by one GET.
 *
 *   POST /apiClient/Main/GetMainData?GuidId=<id>  {guidId, fields:{}, limit, offset}
 *        → result.{tableFields, count, data[]}
 *   GET  /apiClient/Main/GetById?id=<id>
 *        → result.{description, updateDate, tableFields}  (the period lives in
 *          the description: "2026 yil I-chorak davomida …")
 *
 * A row is `{id, dateTime, tableColumn: {<field>: cell}}`. The portal keeps
 * only the latest upload of a dataset: a new upload replaces every row and
 * gives each a new id, so the id joins nothing across uploads.
 */
export const EGOV_API = 'https://data.egov.uz/apiClient/Main';

/**
 * One value. Text sits in `data` (its `number` is 0), numbers in `number`,
 * and "multilingual" fields carry a four-language object in `text`; `default`
 * repeats whichever it is. The same field can use either slot from row to row.
 */
export interface EgovCell {
  text?: {
    uzbText?: string | null;
    uzbKrText?: string | null;
    rusText?: string | null;
    engText?: string | null;
  } | null;
  number?: number | null;
  data?: unknown;
  default?: unknown;
}

export interface EgovRow {
  id: string;
  dateTime: string;
  tableColumn: Record<string, EgovCell | undefined>;
}

/** The text of a cell, whichever slot holds it; numbers come back as text. */
export function egovText(cell: EgovCell | undefined | null): string | null {
  if (!cell) return null;
  const t = cell.text;
  if (t && typeof t === 'object') {
    const v = t.uzbText || t.uzbKrText || t.rusText || t.engText;
    if (v) return textOf(v);
  }
  if (cell.data !== null && cell.data !== undefined && cell.data !== '') {
    return textOf(cell.data);
  }
  if (typeof cell.default === 'string') return textOf(cell.default);
  if (typeof cell.number === 'number' && cell.number !== 0) {
    return String(cell.number);
  }
  if (typeof cell.default === 'number' && cell.default !== 0) {
    return String(cell.default);
  }
  return null;
}

/**
 * The number of a cell. A zero in `number` is a real zero only when no other
 * slot holds the value (text cells carry `number: 0`).
 */
export function egovNumber(cell: EgovCell | undefined | null): number | null {
  if (!cell) return null;
  const hasText =
    (cell.data !== null && cell.data !== undefined && cell.data !== '') ||
    (cell.text && typeof cell.text === 'object');
  if (hasText) {
    const raw =
      cell.data ??
      (cell.text && typeof cell.text === 'object'
        ? (cell.text.uzbText ?? cell.text.rusText)
        : null);
    const text = String(raw ?? '')
      .replace(/[\s ]/g, '')
      .replace(',', '.');
    return /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null;
  }
  if (typeof cell.number === 'number' && Number.isFinite(cell.number)) {
    return cell.number;
  }
  if (typeof cell.default === 'number' && Number.isFinite(cell.default)) {
    return cell.default;
  }
  return null;
}

/** A four-language cell as `{uz, ru, en}`; a plain text cell repeats its text. */
export function egovLabels(
  cell: EgovCell | undefined | null,
): { uz: string; ru: string; en: string } | null {
  if (!cell) return null;
  const t = cell.text;
  if (t && typeof t === 'object') {
    const uz = textOf(t.uzbText) ?? textOf(t.uzbKrText);
    const ru = textOf(t.rusText) ?? uz;
    const en = textOf(t.engText) ?? uz;
    if (uz && ru && en) return { uz, ru, en };
  }
  const plain = egovText(cell);
  return plain ? { uz: plain, ru: plain, en: plain } : null;
}

/** The raw value of a cell, for `raw` (the slot that holds it). */
export function egovRaw(cell: EgovCell | undefined | null): unknown {
  if (!cell) return null;
  if (cell.text && typeof cell.text === 'object') {
    return (
      cell.text.uzbText ?? cell.text.uzbKrText ?? cell.text.rusText ?? null
    );
  }
  if (cell.data !== null && cell.data !== undefined) return cell.data;
  return cell.default ?? cell.number ?? null;
}

/** A row as plain `{field: value}`, without the fields that name a person. */
export function egovPlain(
  row: EgovRow,
  drop: readonly string[] = [],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, cell] of Object.entries(row.tableColumn ?? {})) {
    if (drop.includes(k)) continue;
    out[k] = egovRaw(cell);
  }
  return out;
}

export interface EgovInfo {
  /** The description in Uzbek (Latin, else Cyrillic). */
  description: string | null;
  /** The quarter the description names (`2026Q1`), or null. */
  period: string | null;
}

/** What the dataset says about itself; the period is in its description. */
export async function fetchEgovInfo(
  http: RegistryHttp,
  guid: string,
): Promise<EgovInfo> {
  const resp = await http.get(`${EGOV_API}/GetById`, {
    params: { id: guid },
    headers: { Accept: 'application/json' },
  });
  const result = resp.data?.result;
  if (!result || typeof result !== 'object') {
    throw new Error(`data.egov.uz described ${guid} without a result`);
  }
  const d = result.description ?? {};
  const description =
    textOf(d.uzbText) ?? textOf(d.uzbKrText) ?? textOf(d.rusText) ?? null;
  return {
    description,
    period: quarterOf(textOf(d.uzbText)) ?? quarterOf(textOf(d.uzbKrText)),
  };
}

/**
 * Every row of a dataset, page by page, and the count the portal states. A
 * read with fewer rows than the count, or cut by the trial limit, comes back
 * `complete: false` — the engine then writes nothing as removed.
 */
export async function fetchEgovRows(
  http: RegistryHttp,
  guid: string,
  pageSize = 2000,
): Promise<{ rows: EgovRow[]; count: number; complete: boolean }> {
  const rows: EgovRow[] = [];
  let count = 0;
  for (let offset = 0, page = 0; ; offset += pageSize, page++) {
    if (http.spent) return { rows, count, complete: false };
    const resp = await http.post(
      `${EGOV_API}/GetMainData`,
      { guidId: guid, fields: {}, limit: pageSize, offset },
      {
        params: { GuidId: guid },
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      },
    );
    const result = resp.data?.result;
    if (
      !result ||
      !Array.isArray(result.data) ||
      !Number.isInteger(result.count)
    ) {
      throw new Error(
        `data.egov.uz answered ${guid} offset ${offset} without a list`,
      );
    }
    if (page === 0) count = result.count;
    rows.push(...(result.data as EgovRow[]));
    if (result.data.length < pageSize || rows.length >= count) break;
    if (page > Math.ceil(count / pageSize) + 1) {
      throw new Error(
        `data.egov.uz kept answering ${guid} after ${page} pages`,
      );
    }
  }
  return { rows, count, complete: rows.length >= count };
}

/** The upload day of a row (`dateTime`), the edition the register is at. */
export function egovUploadDay(rows: EgovRow[]): string | null {
  let newest: string | null = null;
  for (const r of rows) {
    const day = dayOf(r.dateTime);
    if (day && (!newest || day > newest)) newest = day;
  }
  return newest;
}

/** A dataset read whole: rows, completeness, edition (upload) day, period. */
export async function fetchEgovDataset(
  http: RegistryHttp,
  guid: string,
  opts: { pageSize?: number; withPeriod?: boolean } = {},
): Promise<FetchResult> {
  const info = opts.withPeriod ? await fetchEgovInfo(http, guid) : null;
  const { rows, count, complete } = await fetchEgovRows(
    http,
    guid,
    opts.pageSize ?? 2000,
  );
  return {
    rows,
    complete,
    expected: count,
    editionDate: egovUploadDay(rows),
    period: info?.period ?? null,
  };
}
