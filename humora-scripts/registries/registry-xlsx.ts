import * as ExcelJS from 'exceljs';

/** A sheet as rows of plain values (text, number, Date). */
export type SheetRows = unknown[][];

function plainCell(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    const o = v as any;
    if (Array.isArray(o.richText)) {
      return o.richText.map((p: any) => p.text ?? '').join('');
    }
    if (o.text !== undefined) return o.text;
    if (o.result !== undefined) return o.result;
    return null;
  }
  return v;
}

/** Every sheet of a workbook, by name, as plain rows. */
export async function readWorkbook(
  buf: Buffer,
): Promise<Array<{ name: string; rows: SheetRows }>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const out: Array<{ name: string; rows: SheetRows }> = [];
  wb.eachSheet((ws) => {
    const rows: SheetRows = [];
    ws.eachRow({ includeEmpty: true }, (row, i) => {
      rows[i - 1] = (row.values as unknown[]).slice(1).map(plainCell);
    });
    out.push({ name: ws.name, rows: Array.from(rows, (r) => r ?? []) });
  });
  return out;
}

/** A CSV (comma or semicolon, quotes doubled) as rows of text. */
export function readCsv(text: string): SheetRows {
  const body = text.replace(/^﻿/, '');
  const firstLine = body.split(/\r?\n/, 1)[0] ?? '';
  const sep =
    (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0)
      ? ';'
      : ',';
  const rows: SheetRows = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quoted) {
      if (ch === '"' && body[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && body[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
