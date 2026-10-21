import { readCsv, readWorkbook, SheetRows } from '../registry-xlsx';
import {
  FetchResult,
  Labels,
  MapResult,
  RegistryAdapter,
  RegistryKind,
  RegistrySector,
} from '../registry-types';
import { dayOf, numberOf, textOf } from '../registry-normalize';
import { entry, stirOrSkip } from './adapter-kit';

/**
 * Registers published only as files a script cannot fetch (PDFs on
 * api-portal.gov.uz answer 403 to scripts; the Tourism Committee posts PDFs).
 * An admin downloads the file, turns it into a table (XLSX or CSV) and posts
 * it: `POST /registries-sync/upload?source=<code>`.
 *
 * The table's first row names the columns. `stir` is required; `name`,
 * `number`, `status`, `valid_from`, `valid_to`, `amount` fill the entry's own
 * columns; any column named like a key of the register's `fieldLabels` is
 * shown with that label; anything else is kept in `raw` only. Columns that
 * name a person (auditors, guides, founders) must not be in the file.
 */
const MANUAL = 'manual';

/** The header of an uploaded table, as keys: `Valid From` → `valid_from`. */
export function headerKey(text: unknown): string {
  const key = String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яёўқғҳ]+/gi, '_')
    .replace(/^_+|_+$/g, '');
  if (/^(stir|inn|стир|инн|tin)$/.test(key)) return 'stir';
  return key;
}

/**
 * The rows of an uploaded file: the first sheet whose first ten rows hold a
 * header with a STIR column, each row keyed by the header.
 */
export async function uploadedRows(
  file: Buffer,
  filename: string,
): Promise<Array<Record<string, unknown>>> {
  const sheets: SheetRows[] = /\.csv$/i.test(filename)
    ? [readCsv(file.toString('utf8'))]
    : (await readWorkbook(file)).map((s) => s.rows);
  for (const rows of sheets) {
    const at = rows
      .slice(0, 10)
      .findIndex((r) => r.some((v) => headerKey(v) === 'stir'));
    if (at < 0) continue;
    const header = rows[at].map(headerKey);
    return rows
      .slice(at + 1)
      .map((r) =>
        Object.fromEntries(
          header.map((h, i) => [h || `col_${i + 1}`, r[i] ?? null]),
        ),
      )
      .filter((r) => Object.values(r).some((v) => textOf(v) !== null));
  }
  throw new Error('the file has no table with a STIR column');
}

export function manualAdapter(
  code: string,
  sector: RegistrySector,
  kind: RegistryKind,
  title: Labels,
  fieldLabels: Record<string, Labels>,
  minRows: number,
): RegistryAdapter {
  return {
    meta: {
      code,
      sector,
      kind,
      title,
      cadence: MANUAL,
      display: true,
      fieldLabels,
      minRows,
    },
    fetchAll(): Promise<FetchResult> {
      return Promise.reject(
        new Error(
          `${code} is read from a file: POST /registries-sync/upload?source=${code}`,
        ),
      );
    },
    map(row: unknown): MapResult {
      const r = row as Record<string, unknown>;
      const ids = stirOrSkip(r.stir);
      if ('skip' in ids) return ids;
      const number = textOf(r.number);
      const fields: Record<string, unknown> = {};
      for (const key of Object.keys(fieldLabels)) {
        const v = r[key];
        fields[key] = /(_on|_date)$/.test(key) ? dayOf(v) : textOf(v);
      }
      const status = textOf(r.status);
      return entry({
        sourceKey: number ? `${ids.inn}:${number}` : ids.inn!,
        inn: ids.inn,
        name: textOf(r.name),
        number,
        status,
        validFrom: dayOf(r.valid_from),
        validTo: dayOf(r.valid_to),
        amount: numberOf(r.amount),
        amountUnit: numberOf(r.amount) === null ? null : 'UZS',
        fields,
        raw: r,
      });
    },
  };
}

/**
 * Registers read only from a file an admin posts. None today: the four that
 * were here (audit firms, public interest entities, accommodation,
 * sanitary conclusions) are read from gov.uz's PDFs since 2026-10-15
 * (`gov-pdf.adapters.ts`). The way stays for a register no script can reach.
 */
export const MANUAL_ADAPTERS: RegistryAdapter[] = [];
