/**
 * Tables out of PDF registers, read by their ruling lines.
 *
 * The registers ministries publish as PDF are Excel or Word tables printed to
 * PDF. The text alone does not say which line belongs to which row — a long
 * address wraps into three lines, a cell's text is centred in a cell that
 * spans the rows of its auditors — but every cell is drawn with lines. So a
 * row is the band between two horizontal lines that cross the row-number
 * column, a column the interval between two vertical lines, and a cell's
 * text everything inside both.
 *
 * pdfjs (Mozilla's reader) gives the text with its position and the drawing
 * operators the lines come from; both are mapped through the page's viewport,
 * so `y` grows downwards on every page, rotated ones included.
 */

/** A run of text, its box in viewport space (y downwards). */
export interface PdfText {
  x: number;
  y: number;
  w: number;
  h: number;
  text: string;
}

/** A horizontal line (`at` = y) or a vertical one (`at` = x). */
export interface PdfSegment {
  at: number;
  from: number;
  to: number;
}

export interface PdfPage {
  texts: PdfText[];
  horizontal: PdfSegment[];
  vertical: PdfSegment[];
}

type Matrix = [number, number, number, number, number, number];

const mul = (m: Matrix, n: number[]): Matrix => [
  m[0] * n[0] + m[2] * n[1],
  m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3],
  m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4],
  m[1] * n[4] + m[3] * n[5] + m[5],
];
const apply = (m: Matrix, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];

/** pdfjs, loaded on first use: it is large, and most runs read no PDF. */
function pdfjs(): any {
  return require('pdfjs-dist/legacy/build/pdf.js');
}

/** Every page of a PDF: its text runs and its ruling lines. */
export async function readPdf(data: Buffer | Uint8Array): Promise<PdfPage[]> {
  const lib = pdfjs();
  const OPS = lib.OPS;
  const doc = await lib.getDocument({
    data: new Uint8Array(data),
    disableFontFace: true,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const pages: PdfPage[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const viewport = page.getViewport({ scale: 1 });
      const vt = viewport.transform as Matrix;

      const texts: PdfText[] = [];
      const content = await page.getTextContent();
      for (const item of content.items as any[]) {
        const text = typeof item.str === 'string' ? item.str : '';
        if (!text.trim()) continue;
        const m = mul(vt, item.transform);
        const h = Math.hypot(m[2], m[3]) || item.height || 0;
        const [x, base] = [m[4], m[5]];
        texts.push({ x, y: base - h, w: item.width ?? 0, h, text });
      }

      const horizontal: PdfSegment[] = [];
      const vertical: PdfSegment[] = [];
      // One edge drawn again (the cell beside it, a clip over a stroke) is
      // kept once: Sanepid's pages clip every cell, ~30k edges a page.
      const seen = new Set<string>();
      const keep = (list: PdfSegment[], s: PdfSegment, dir: string) => {
        const key = `${dir}${Math.round(s.at * 4)}:${Math.round(s.from * 4)}:${Math.round(s.to * 4)}`;
        if (seen.has(key)) return;
        seen.add(key);
        list.push(s);
      };
      const segment = (a: [number, number], b: [number, number]) => {
        const [x1, y1] = a;
        const [x2, y2] = b;
        if (Math.abs(y1 - y2) < 1 && Math.abs(x2 - x1) > 2) {
          keep(
            horizontal,
            {
              at: (y1 + y2) / 2,
              from: Math.min(x1, x2),
              to: Math.max(x1, x2),
            },
            'h',
          );
        } else if (Math.abs(x1 - x2) < 1 && Math.abs(y2 - y1) > 2) {
          keep(
            vertical,
            {
              at: (x1 + x2) / 2,
              from: Math.min(y1, y2),
              to: Math.max(y1, y2),
            },
            'v',
          );
        }
      };
      // A path's edges count only when the path is stroked: a filled
      // rectangle is a cell's background, not its border — except a filled
      // bar a point or two thick, which is how some writers draw a line.
      const ops = await page.getOperatorList();
      let ctm: Matrix = vt;
      const stack: Matrix[] = [];
      let edges: Array<[[number, number], [number, number]]> = [];
      let bars: Array<[[number, number], [number, number]]> = [];
      const STROKE = new Set([
        OPS.stroke,
        OPS.closeStroke,
        OPS.fillStroke,
        OPS.eoFillStroke,
        OPS.closeFillStroke,
        OPS.closeEOFillStroke,
      ]);
      const FILL = new Set([OPS.fill, OPS.eoFill]);
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i];
        if (fn === OPS.save) stack.push(ctm);
        else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === OPS.transform) ctm = mul(ctm, args);
        else if (fn === OPS.constructPath) {
          const [codes, coords] = args as [number[], number[]];
          let k = 0;
          let cur: [number, number] | null = null;
          let start: [number, number] | null = null;
          for (const op of codes) {
            if (op === OPS.rectangle) {
              const [x, y, w, hh] = coords.slice(k, k + 4);
              k += 4;
              const p = [
                apply(ctm, x, y),
                apply(ctm, x + w, y),
                apply(ctm, x + w, y + hh),
                apply(ctm, x, y + hh),
              ];
              edges.push(
                [p[0], p[1]],
                [p[1], p[2]],
                [p[2], p[3]],
                [p[3], p[0]],
              );
              // Thickness on the page, not in the path's own units: a writer
              // that draws in a scaled space has thin bars with large numbers.
              const across = Math.hypot(p[1][0] - p[0][0], p[1][1] - p[0][1]);
              const down = Math.hypot(p[2][0] - p[1][0], p[2][1] - p[1][1]);
              if (down <= 2.5 && across > 2) {
                bars.push([
                  apply(ctm, x, y + hh / 2),
                  apply(ctm, x + w, y + hh / 2),
                ]);
              } else if (across <= 2.5 && down > 2) {
                bars.push([
                  apply(ctm, x + w / 2, y),
                  apply(ctm, x + w / 2, y + hh),
                ]);
              }
            } else if (op === OPS.moveTo) {
              cur = start = apply(ctm, coords[k], coords[k + 1]);
              k += 2;
            } else if (op === OPS.lineTo) {
              const next = apply(ctm, coords[k], coords[k + 1]);
              k += 2;
              if (cur) edges.push([cur, next]);
              cur = next;
            } else if (op === OPS.curveTo) {
              k += 6;
            } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
              k += 4;
            } else if (op === OPS.closePath) {
              if (cur && start) edges.push([cur, start]);
              cur = start;
            }
          }
        } else if (STROKE.has(fn)) {
          for (const [a, b] of edges) segment(a, b);
          edges = [];
          bars = [];
        } else if (FILL.has(fn)) {
          for (const [a, b] of bars) segment(a, b);
          edges = [];
          bars = [];
        } else if (fn === OPS.clip || fn === OPS.eoClip) {
          // Some writers draw no lines at all and clip each cell's text to
          // the cell instead: the clip rectangles are the grid.
          for (const [a, b] of edges) segment(a, b);
          edges = [];
          bars = [];
        } else if (fn === OPS.endPath) {
          edges = [];
          bars = [];
        }
      }
      pages.push({ texts, horizontal, vertical });
      page.cleanup();
    }
  } finally {
    await doc.destroy();
  }
  return pages;
}

/** Values within `tol` of each other, as one (their mean), sorted. */
function cluster(values: number[], tol: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const out: number[][] = [];
  for (const v of sorted) {
    const last = out[out.length - 1];
    if (last && v - last[last.length - 1] <= tol) last.push(v);
    else out.push([v]);
  }
  return out.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}

export interface TableColumn {
  key: string;
  /** Matched against the column's header text (all its header lines). */
  header: RegExp;
  /**
   * Every row has its own value here (a product, its code): `anchoredRows`
   * gives a text to the nearest row in its cell only, never to every row of
   * a cell that looks merged because an edge between two rows is missing.
   */
  ownRow?: boolean;
}

export interface TableSpec {
  columns: TableColumn[];
  /** The column holding the row number; a row is a band where it is a number. */
  anchor: string;
}

/** One row of the table: each column's text, lines joined with `\n`. */
export type TableRow = Record<string, string>;

/** The text inside a box, line by line. */
function textIn(
  texts: PdfText[],
  x1: number,
  x2: number,
  y1: number,
  y2: number,
): string {
  const inside = texts.filter((t) => {
    const cx = t.x + t.w / 2;
    const cy = t.y + t.h / 2;
    return cx >= x1 && cx < x2 && cy >= y1 && cy < y2;
  });
  inside.sort((a, b) => a.y - b.y || a.x - b.x);
  const lines: PdfText[][] = [];
  for (const t of inside) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line[0].y - t.y) <= Math.max(2, t.h * 0.4))
      line.push(t);
    else lines.push([t]);
  }
  return lines
    .map((l) =>
      l
        .sort((a, b) => a.x - b.x)
        .map((t) => t.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n');
}

/**
 * The header band of a page: from the top of the table to just above the
 * first row number. Null when the page has no ruled table.
 */
function headerBand(page: PdfPage): [number, number] | null {
  if (!page.vertical.length) return null;
  const top = Math.min(...page.vertical.map((s) => s.from));
  const firstNumber = page.texts
    .filter((t) => /^\s*1\.?\s*$/.test(t.text) && t.y > top)
    .sort((a, b) => a.y - b.y)[0];
  return [top, firstNumber ? firstNumber.y - 1 : top + 120];
}

/**
 * The columns of the header: intervals between the vertical lines that cross
 * the header band (lines inside merged data cells would split a column),
 * contiguous, a sliver narrower than 4 points folded into its neighbour.
 */
function headerIntervals(
  page: PdfPage,
  band: [number, number],
): Array<[number, number]> {
  // Lines that cross the header. A header cell drawn over two data columns
  // has none between them; `headerColumns` splits it by the data.
  const inHeader = page.vertical
    .filter((s) => s.from <= band[1] && s.to >= band[0] + 1)
    .map((s) => s.at);
  const edges = cluster(inHeader, 2);
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const iv: [number, number] = [edges[i], edges[i + 1]];
    const last = out[out.length - 1];
    if (iv[1] - iv[0] < 4 && last) last[1] = iv[1];
    else out.push(iv);
  }
  return out;
}

/**
 * The rows of a ruled table that runs over many pages.
 *
 * Columns are found once, on the first page whose header names every column
 * of the spec, and kept for the pages after it (registers repeat the layout,
 * not always the header). A row is a band between two horizontal lines that
 * cross the row-number column and holds a whole number there; text in a band
 * at the top of a page with no number continues the last row of the page
 * before (a row cut by the page break).
 */
export function tableRows(pages: PdfPage[], spec: TableSpec): TableRow[] {
  let columns: Map<string, [number, number]> | null = null;
  const rows: TableRow[] = [];
  let tail: TableRow | null = null;

  for (const page of pages) {
    // A page that repeats the header gives its own columns (widths can
    // differ from page to page); one without keeps the last page's.
    columns = headerColumns(page, spec) ?? columns;
    if (!columns) continue;
    const anchor = columns.get(spec.anchor)!;

    // Bands: horizontal lines that cross the row-number column, and the
    // table's own top and bottom. A row cut by the page break has its number
    // (centred over the whole row) outside the last or first line, so a
    // strip just beyond each is a band too — 15 points, closer than any
    // page header or footer sits.
    // A row line crosses the row-number column, or — where that column is
    // not ruled — runs across most of the table.
    const spans = [...columns.values()];
    const left = Math.min(...spans.map((c) => c[0]));
    const right = Math.max(...spans.map((c) => c[1]));
    const lines = page.horizontal
      .filter(
        (s) =>
          (s.from <= anchor[0] + 2 && s.to >= anchor[1] - 2) ||
          s.to - s.from >= (right - left) * 0.4,
      )
      .map((s) => s.at);
    if (!lines.length) continue;
    const verticals = page.vertical.filter(
      (s) => s.at >= anchor[0] - 2 && s.at <= anchor[1] + 2,
    );
    const top = Math.min(...lines, ...verticals.map((s) => s.from));
    const bottom = Math.max(...lines, ...verticals.map((s) => s.to));
    const cuts = cluster([...lines, top - 15, bottom + 15], 1.5);
    const read = (y1: number, y2: number) => {
      const row: TableRow = {};
      for (const [key, [x1, x2]] of columns!) {
        row[key] = textIn(page.texts, x1, x2, y1, y2);
      }
      return row;
    };
    const append = (to: TableRow, part: TableRow, before = false) => {
      for (const [key, value] of Object.entries(part)) {
        if (key === spec.anchor || !value) continue;
        if (!to[key]) to[key] = value;
        else to[key] = before ? `${value}\n${to[key]}` : `${to[key]}\n${value}`;
      }
    };
    let seenNumber = false;
    // Only the first numbered band of a page can continue the page before.
    let seenEarlier = false;
    for (let i = 0; i + 1 < cuts.length; i++) {
      const [y1, y2] = [cuts[i], cuts[i + 1]];
      if (y2 - y1 < 3) continue;
      const row = read(y1, y2);
      const number = row[spec.anchor] ?? '';
      // "25" or "25." — registers write both.
      if (/^\d{1,6}\.?$/.test(number.replace(/\s/g, ''))) {
        seenNumber = true;
        // The top of this row was the number-less end of the page before.
        if (tail) append(row, tail, true);
        tail = null;
        // A row split by the page break can carry its number on both pages.
        const prev = rows[rows.length - 1];
        const key = (v: string | undefined) => (v ?? '').replace(/[\s.]/g, '');
        if (prev && !seenEarlier && key(prev[spec.anchor]) === key(number)) {
          append(prev, row);
        } else {
          rows.push(row);
        }
        seenEarlier = true;
      } else if (Object.values(row).some(Boolean)) {
        if (!seenNumber && rows.length) {
          // The rest of the last row of the page before.
          if (tail) append(rows[rows.length - 1], tail);
          tail = null;
          append(rows[rows.length - 1], row);
        } else if (seenNumber) {
          // A number-less band after this page's rows: the top of a row
          // whose number is on the next page, or the end of the last one.
          tail = tail ? (append(tail, row), tail) : row;
        }
      }
    }
    // Kept for the next page. With no next page it is not a row's at all:
    // the notes some registers box under the table (PIE's criteria legend).
  }
  return rows;
}

/**
 * Each column of the spec, as the header interval whose text matches it;
 * null when the page does not show them all.
 *
 * Some writers draw one header cell over two data columns ("T/r Tashkilot
 * nomi") and no line between them anywhere. A column no interval of its own
 * names is looked for inside the others' text (its pattern without `^`/`$`);
 * the interval it is found in is split at the widest gaps in the data text
 * below the header — the empty strip between two columns' values — and its
 * columns take the parts in spec order (specs list columns left to right).
 */
function headerColumns(
  page: PdfPage,
  spec: TableSpec,
): Map<string, [number, number]> | null {
  const layout = headerLayout(page, spec);
  if (!layout) return null;
  const { band, intervals } = layout;
  const texts = intervals.map(([x1, x2]) =>
    textIn(page.texts, x1, x2, band[0] - 2, band[1]).replace(/\n/g, ' '),
  );
  const out = new Map<string, [number, number]>();
  const used = new Set<number>();
  const missing: TableColumn[] = [];
  for (const column of spec.columns) {
    const i = intervals.findIndex(
      (_, j) => !used.has(j) && column.header.test(texts[j]),
    );
    if (i < 0) {
      missing.push(column);
      continue;
    }
    used.add(i);
    out.set(column.key, intervals[i]);
  }
  if (!missing.length) return out;

  // Columns sharing a merged header cell.
  const shared = new Map<number, TableColumn[]>();
  for (const column of missing) {
    const loose = new RegExp(
      column.header.source.replace(/^\^|\$$/g, ''),
      column.header.flags,
    );
    const i = texts.findIndex((text) => loose.test(text));
    if (i < 0) return null;
    shared.set(i, [...(shared.get(i) ?? []), column]);
  }
  for (const [i, extra] of shared) {
    const owner = spec.columns.find((c) => out.get(c.key) === intervals[i]);
    const keys = new Set([
      ...(owner ? [owner.key] : []),
      ...extra.map((c) => c.key),
    ]);
    const cols = spec.columns.filter((c) => keys.has(c.key));
    const parts =
      splitByTitles(page, intervals[i], band, cols.length) ??
      splitByData(page, intervals[i], band[1], cols.length);
    if (!parts) return null;
    cols.forEach((c, k) => out.set(c.key, parts[k]));
  }
  return out;
}

/**
 * The header's band and column intervals: between the lines that cross it,
 * or — for a table drawn with no lines at all — between its column titles,
 * the band running from the row-number column's title down to the first row.
 */
function headerLayout(
  page: PdfPage,
  spec: TableSpec,
): { band: [number, number]; intervals: Array<[number, number]> } | null {
  const band = headerBand(page);
  if (band) return { band, intervals: headerIntervals(page, band) };
  const anchor = spec.columns.find((c) => c.key === spec.anchor);
  const mark = anchor
    ? page.texts
        .filter((t) => anchor.header.test(t.text))
        .sort((a, b) => a.y - b.y)[0]
    : undefined;
  if (!mark) return null;
  const centre = mark.x + mark.w / 2;
  const first = page.texts
    .filter(
      (t) =>
        /^\s*1\.?\s*$/.test(t.text) &&
        t.y > mark.y &&
        Math.abs(t.x + t.w / 2 - centre) < 20,
    )
    .sort((a, b) => a.y - b.y)[0];
  if (!first) return null;
  const textBand: [number, number] = [mark.y - 4, first.y - 1];
  const groups = titleGroups(page, [-Infinity, Infinity], textBand);
  if (groups.length < 2) return null;
  const edges = [0, ...titleCuts(page, groups, textBand[1]), 100_000];
  return {
    band: textBand,
    intervals: edges
      .slice(0, -1)
      .map((e, i) => [e, edges[i + 1]] as [number, number]),
  };
}

/** The header words inside an interval, one group per column title (overlapping words joined). */
function titleGroups(
  page: PdfPage,
  [x1, x2]: [number, number],
  band: [number, number],
): Array<[number, number]> {
  const words = page.texts
    .filter((t) => {
      const cx = t.x + t.w / 2;
      const cy = t.y + t.h / 2;
      return cx >= x1 && cx < x2 && cy >= band[0] - 2 && cy < band[1];
    })
    .map((t) => [t.x, t.x + t.w] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const groups: Array<[number, number]> = [];
  for (const [a, b] of words) {
    const last = groups[groups.length - 1];
    if (last && a <= last[1] + 1) last[1] = Math.max(last[1], b);
    else groups.push([a, b]);
  }
  return groups;
}

/**
 * Where to cut between neighbouring column titles: in the widest gap the data
 * below leaves between the two titles' centres (values are aligned to their
 * own column, titles are centred), else halfway between the titles.
 */
function titleCuts(
  page: PdfPage,
  groups: Array<[number, number]>,
  below: number,
): number[] {
  const cuts: number[] = [];
  for (let i = 0; i + 1 < groups.length; i++) {
    const from = (groups[i][0] + groups[i][1]) / 2;
    const to = (groups[i + 1][0] + groups[i + 1][1]) / 2;
    const spans = page.texts
      .filter((t) => t.y > below && t.x < to && t.x + t.w > from)
      .map(
        (t) =>
          [Math.max(from, t.x), Math.min(to, t.x + t.w)] as [number, number],
      )
      .sort((a, b) => a[0] - b[0]);
    let reach = from;
    let best: [number, number] | null = null;
    for (const [a, b] of [...spans, [to, to] as [number, number]]) {
      if (a - reach >= 2 && (!best || a - reach > best[1] - best[0]))
        best = [reach, a];
      reach = Math.max(reach, b);
    }
    cuts.push(
      best ? (best[0] + best[1]) / 2 : (groups[i][1] + groups[i + 1][0]) / 2,
    );
  }
  return cuts;
}

/** A merged header cell cut between the `n` column titles it holds; null unless it holds exactly `n`. */
function splitByTitles(
  page: PdfPage,
  iv: [number, number],
  band: [number, number],
  n: number,
): Array<[number, number]> | null {
  const groups = titleGroups(page, iv, band);
  if (groups.length !== n) return null;
  const edges = [iv[0], ...titleCuts(page, groups, band[1]), iv[1]];
  return edges
    .slice(0, -1)
    .map((e, i) => [e, edges[i + 1]] as [number, number]);
}

/**
 * An interval cut into `n` columns at the `n - 1` widest gaps the text below
 * the header leaves in it. Null when the text leaves fewer gaps.
 */
function splitByData(
  page: PdfPage,
  [x1, x2]: [number, number],
  below: number,
  n: number,
): Array<[number, number]> | null {
  const spans = page.texts
    .filter((t) => t.y > below && t.x + t.w / 2 >= x1 && t.x + t.w / 2 < x2)
    .map(
      (t) => [Math.max(x1, t.x), Math.min(x2, t.x + t.w)] as [number, number],
    )
    .sort((a, b) => a[0] - b[0]);
  const gaps: Array<[number, number]> = [];
  let reach = x1;
  for (const [a, b] of spans) {
    if (a - reach >= 3) gaps.push([reach, a]);
    reach = Math.max(reach, b);
  }
  const cuts = gaps
    .filter(([a]) => a > x1 + 1)
    .sort((g, h) => h[1] - h[0] - (g[1] - g[0]))
    .slice(0, n - 1)
    .map(([a, b]) => (a + b) / 2)
    .sort((a, b) => a - b);
  if (cuts.length < n - 1) return null;
  const edges = [x1, ...cuts, x2];
  return edges
    .slice(0, -1)
    .map((e, i) => [e, edges[i + 1]] as [number, number]);
}

/** Every column's header text on a page — for writing a spec. */
export function headerTexts(
  page: PdfPage,
): Array<{ x1: number; x2: number; header: string }> {
  const band = headerBand(page);
  if (!band) return [];
  return headerIntervals(page, band).map(([x1, x2]) => ({
    x1: Math.round(x1),
    x2: Math.round(x2),
    header: textIn(page.texts, x1, x2, band[0] - 2, band[1]).replace(
      /\n/g,
      ' ',
    ),
  }));
}

/**
 * The rows of a table whose rows are told by a value every row carries in one
 * column (an application number) rather than by lines — for a table drawn
 * with merged cells across rows, or with no row lines at all. Each text goes
 * to the row whose anchor is nearest on its page; a value that a merged cell
 * centres over several rows reaches only the nearest of them.
 */
export function anchoredRows(
  pages: PdfPage[],
  spec: TableSpec,
  anchorPattern: RegExp,
): TableRow[] {
  let columns: Map<string, [number, number]> | null = null;
  const rows: TableRow[] = [];
  const ownRow = new Set(
    spec.columns.filter((c) => c.ownRow).map((c) => c.key),
  );
  for (const page of pages) {
    // A page that repeats the header gives its own columns (widths can
    // differ from page to page); one without keeps the last page's, and its
    // table starts at the top.
    const own = headerColumns(page, spec);
    columns = own ?? columns;
    if (!columns) continue;
    const [ax1, ax2] = columns.get(spec.anchor)!;
    const found = page.texts.filter((t) => {
      const cx = t.x + t.w / 2;
      return (
        cx >= ax1 && cx < ax2 && anchorPattern.test(t.text.replace(/\s/g, ''))
      );
    });
    if (!found.length) continue;
    found.sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
    const anchors = found.map((t) => t.y + t.h / 2);
    // A page with its own header: the header is everything above the first
    // row's value.
    const below = own ? Math.min(...found.map((t) => t.y)) - 4 : -Infinity;
    const pageRows: Array<Record<string, PdfText[]>> = anchors.map(() => ({}));
    const gaps = anchors.slice(1).map((y, i) => y - anchors[i]);
    const reach = Math.max(4, (gaps.length ? Math.min(...gaps) : 8) * 2);
    // Each column's own cell edges: a text belongs to every row whose anchor
    // lies in its cell — a merged cell to all of them, a wrapped line to its
    // own row even when it sits nearer the next one.
    const cutsOf = new Map<string, number[]>();
    for (const [k, [x1, x2]] of columns) {
      cutsOf.set(
        k,
        cluster(
          page.horizontal
            .filter((s) => s.from <= x1 + 2 && s.to >= x2 - 2)
            .map((s) => s.at),
          1,
        ),
      );
    }
    for (const t of page.texts) {
      const cx = t.x + t.w / 2;
      const cy = t.y + t.h / 2;
      if (cy <= below) continue;
      let key: string | null = null;
      for (const [k, [x1, x2]] of columns) {
        if (cx >= x1 && cx < x2) {
          key = k;
          break;
        }
      }
      if (!key) continue;
      const cuts = cutsOf.get(key)!;
      let hits: number[] = [];
      const after = cuts.findIndex((c) => c > cy);
      if (after > 0) {
        const [y1, y2] = [cuts[after - 1], cuts[after]];
        hits = anchors.flatMap((a, i) => (a > y1 && a < y2 ? [i] : []));
      }
      if (!hits.length) {
        // No cell around it: the nearest row, if near enough.
        let best = 0;
        for (let i = 1; i < anchors.length; i++) {
          if (Math.abs(anchors[i] - cy) < Math.abs(anchors[best] - cy))
            best = i;
        }
        if (Math.abs(anchors[best] - cy) > reach) continue;
        hits = [best];
      }
      if (hits.length > 1 && ownRow.has(key)) {
        hits = [
          hits.reduce((best, i) =>
            Math.abs(anchors[i] - cy) < Math.abs(anchors[best] - cy) ? i : best,
          ),
        ];
      }
      for (const i of hits) (pageRows[i][key] ??= []).push(t);
    }
    pageRows.forEach((r, i) => {
      const row: TableRow = {};
      for (const [k] of columns!) {
        row[k] = joinCell((r[k] ?? []).sort((a, b) => a.y - b.y || a.x - b.x));
      }
      // The row's own value, even where a missing cell edge put two rows'
      // values in one cell.
      row[spec.anchor] = found[i].text;
      rows.push(row);
    });
  }
  return rows;
}

/**
 * A cell's text runs as one string, in reading order. Narrow columns wrap
 * inside words ("лаборатор" / "ия"), but a full line also ends at a word as
 * often, so the lines are joined with a space: a word shown broken, never
 * two words glued into one.
 */
function joinCell(texts: PdfText[]): string {
  return texts
    .map((t) => t.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}
