import axios from 'axios';

/**
 * cs.egov.uz — the government's published classifiers, each a dataset read
 * whole with one POST. Used by the ns10/ns11 → SOATO sync; the bank registry
 * sync has its own copy of the same checks.
 */
export const CS_EGOV_URL = 'https://cs.egov.uz/apiData/MainData/Get';

/**
 * One cell. `text` is a plain string in some datasets and the four
 * languages in others ({ uzbText, uzbKrText, rusText, engText }).
 */
export interface CsCell {
  text?: string | Record<string, string | null | undefined> | null;
  number?: number | null;
  data?: string | null;
  default?: string | number | null;
}

export interface CsRow {
  id?: string;
  tableColumn?: Record<string, CsCell>;
}

/**
 * The full dataset, or an error. An HTTP error, an `error` in the body, a
 * missing row list, or fewer rows than the source's own `count` are all
 * failures — never an empty classifier. Not `isSuccess`, which cs.egov.uz
 * sends as false together with the full dataset.
 */
export async function fetchCsDataset(
  id: string,
  timeoutMs = 60_000,
): Promise<CsRow[]> {
  const resp = await axios.post(
    CS_EGOV_URL,
    { id, offset: 0, limit: 100000, query: {} },
    {
      timeout: timeoutMs,
      headers: { 'Content-Type': 'application/json' },
      validateStatus: () => true,
    },
  );
  const body: any = resp.data;
  if (resp.status !== 200 || body?.error) {
    throw new Error(
      `cs.egov.uz answered HTTP ${resp.status}` +
        (body?.error
          ? ` with error ${JSON.stringify(body.error).slice(0, 200)}`
          : '') +
        ` for dataset ${id}`,
    );
  }
  const rows = body?.result?.data;
  if (!Array.isArray(rows)) {
    throw new Error(`cs.egov.uz answered without a row list for dataset ${id}`);
  }
  const count = Number(body?.result?.count);
  if (Number.isFinite(count) && count > rows.length) {
    throw new Error(
      `cs.egov.uz sent ${rows.length} of ${count} rows for dataset ${id}`,
    );
  }
  return rows as CsRow[];
}

/**
 * A cell's text in one script — `uzbKrText` (Cyrillic) or `uzbText`
 * (Latin) — falling back to the other, then to a plain string or `default`.
 * Null when blank.
 */
export function csText(
  cell: CsCell | undefined,
  prefer: 'uzbKrText' | 'uzbText' = 'uzbKrText',
): string | null {
  if (!cell) return null;
  const other = prefer === 'uzbKrText' ? 'uzbText' : 'uzbKrText';
  const t = cell.text;
  const raw =
    typeof t === 'string'
      ? t
      : t && typeof t === 'object'
        ? t[prefer] || t[other] || null
        : null;
  const value = raw ?? (typeof cell.default === 'string' ? cell.default : null);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** A cell's number, or null — a blank `default` is no number, not 0. */
export function csNumber(cell: CsCell | undefined): number | null {
  if (!cell) return null;
  if (typeof cell.number === 'number' && Number.isFinite(cell.number)) {
    return cell.number;
  }
  const d = cell.default;
  if (d == null || (typeof d === 'string' && !d.trim())) return null;
  const n = Number(d);
  return Number.isFinite(n) ? n : null;
}
