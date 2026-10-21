import {
  anchoredRows,
  headerTexts,
  PdfPage,
  PdfSegment,
  PdfText,
  tableRows,
  TableSpec,
} from './pdf-table';

/** A text run of `w` points at x, y (y downwards). */
const t = (x: number, y: number, text: string, w = 20): PdfText => ({
  x,
  y,
  w,
  h: 6,
  text,
});
const h = (at: number, from = 0, to = 300): PdfSegment => ({ at, from, to });
const v = (at: number, from = 0, to = 400): PdfSegment => ({ at, from, to });

/** Columns: № 0–30, name 30–150, STIR 150–300. */
const COLS = [v(0), v(30), v(150), v(300)];
const SPEC: TableSpec = {
  anchor: 'no',
  columns: [
    { key: 'no', header: /№/ },
    { key: 'name', header: /Nomi/ },
    { key: 'stir', header: /STIR/ },
  ],
};
const header = [t(5, 2, '№', 10), t(60, 2, 'Nomi'), t(200, 2, 'STIR')];

describe('tableRows', () => {
  it('reads a ruled table, a wrapped cell as one value', () => {
    const page: PdfPage = {
      texts: [
        ...header,
        t(10, 22, '1', 5),
        t(40, 18, '"ALFA SAVDO"', 80),
        t(40, 26, 'MChJ'),
        t(200, 22, '300000001', 40),
        t(10, 42, '2.', 6),
        t(40, 42, '"BETA" AJ'),
        t(200, 42, '300 000 002', 40),
      ],
      horizontal: [h(0), h(12), h(35), h(55)],
      vertical: COLS,
    };
    expect(tableRows([page], SPEC)).toEqual([
      { no: '1', name: '"ALFA SAVDO"\nMChJ', stir: '300000001' },
      { no: '2.', name: '"BETA" AJ', stir: '300 000 002' },
    ]);
  });

  it('keeps a row cut by the page break whole, its number on both pages', () => {
    const first: PdfPage = {
      texts: [
        ...header,
        t(10, 22, '1', 5),
        t(40, 22, '"ALFA"'),
        t(200, 22, '300000001', 40),
        t(10, 48, '2', 5),
        t(40, 44, '"BETA SAVDO"', 80),
      ],
      horizontal: [h(0), h(12), h(35), h(55)],
      vertical: COLS,
    };
    const second: PdfPage = {
      texts: [
        t(10, 4, '2', 5),
        t(40, 4, 'MChJ'),
        t(200, 4, '300000002', 40),
        t(10, 22, '3', 5),
        t(40, 22, '"GAMMA"'),
        t(200, 22, '300000003', 40),
      ],
      horizontal: [h(12), h(35)],
      vertical: [
        v(0, 12, 400),
        v(30, 12, 400),
        v(150, 12, 400),
        v(300, 12, 400),
      ],
    };
    const rows = tableRows([first, second], SPEC);
    expect(rows.map((r) => r.no.replace('\n', ' '))).toEqual(['1', '2', '3']);
    expect(rows[1].name).toBe('"BETA SAVDO"\nMChJ');
    expect(rows[1].stir).toBe('300000002');
  });

  it('reads the header columns of a page', () => {
    const page: PdfPage = {
      texts: [...header, t(10, 22, '1', 5)],
      horizontal: [h(0), h(12)],
      vertical: COLS,
    };
    expect(headerTexts(page).map((c) => c.header)).toEqual([
      '№',
      'Nomi',
      'STIR',
    ]);
  });

  it('splits a header cell drawn over two columns by the gap in the data', () => {
    // "№ Nomi" is one header cell: no line between the number and the name.
    const page: PdfPage = {
      texts: [
        t(5, 2, '№ Nomi', 60),
        t(200, 2, 'STIR'),
        t(4, 22, '1', 5),
        t(40, 22, '"ALFA"'),
        t(200, 22, '300000001', 40),
        t(4, 42, '2', 5),
        t(40, 42, '"BETA" AJ', 40),
        t(200, 42, '300000002', 40),
      ],
      horizontal: [h(0), h(12), h(35), h(55)],
      vertical: [v(0), v(150), v(300)],
    };
    const rows = tableRows([page], {
      anchor: 'no',
      columns: [
        { key: 'no', header: /^\s*№/ },
        { key: 'name', header: /Nomi/ },
        { key: 'stir', header: /^\s*STIR\s*$/ },
      ],
    });
    expect(rows).toEqual([
      { no: '1', name: '"ALFA"', stir: '300000001' },
      { no: '2', name: '"BETA" AJ', stir: '300000002' },
    ]);
  });

  it('splits a header cell between the column titles it holds', () => {
    // "Nomi" and "STIR" sit side by side in one header cell; the data
    // leaves no gap wide enough to tell them apart without the titles.
    const page: PdfPage = {
      texts: [
        t(5, 2, '№', 10),
        t(40, 2, 'Nomi', 20),
        t(110, 2, 'STIR', 20),
        t(10, 22, '1', 5),
        t(32, 22, '"ALFA SAVDO" MChJ', 66),
        t(100, 22, '300000001', 40),
      ],
      horizontal: [h(0), h(12), h(35)],
      vertical: [v(0), v(30), v(300)],
    };
    const rows = tableRows([page], {
      anchor: 'no',
      columns: [
        { key: 'no', header: /^\s*№\s*$/ },
        { key: 'name', header: /Nomi/ },
        { key: 'stir', header: /STIR/ },
      ],
    });
    expect(rows).toEqual([
      { no: '1', name: '"ALFA SAVDO" MChJ', stir: '300000001' },
    ]);
  });

  it('leaves the notes boxed under the last row out of it', () => {
    const page: PdfPage = {
      texts: [
        ...header,
        t(10, 22, '1', 5),
        t(40, 22, '"ALFA"'),
        t(200, 22, '300000001', 40),
        t(40, 44, '* M1 – criterion', 100),
      ],
      horizontal: [h(0), h(12), h(35), h(55)],
      vertical: COLS,
    };
    expect(tableRows([page], SPEC)).toEqual([
      { no: '1', name: '"ALFA"', stir: '300000001' },
    ]);
  });

  it('reads nothing from a page without the spec’s columns', () => {
    const page: PdfPage = {
      texts: [t(5, 2, 'Other')],
      horizontal: [h(0)],
      vertical: COLS,
    };
    expect(tableRows([page], SPEC)).toEqual([]);
  });
});

describe('anchoredRows', () => {
  const spec: TableSpec = {
    anchor: 'app',
    columns: [
      { key: 'name', header: /Nomi/ },
      { key: 'app', header: /Ariza/ },
    ],
  };
  const cols = [v(0), v(150), v(300)];
  const head = [t(40, 2, 'Nomi'), t(200, 2, 'Ariza')];

  it('gives a merged cell to every row inside it, a cell line to its own row', () => {
    const page: PdfPage = {
      texts: [
        ...head,
        // One name over two product rows (merged cell 12–52).
        t(40, 29, '"ALFA" MChJ'),
        t(200, 16, '30000000120260000001', 60),
        t(200, 40, '30000000120260000002', 60),
      ],
      // The name column has only the merged cell's edges; the anchor column one per row.
      horizontal: [
        h(12, 0, 150),
        h(52, 0, 150),
        h(12, 150, 300),
        h(30, 150, 300),
        h(52, 150, 300),
      ],
      vertical: cols,
    };
    const rows = anchoredRows([page], spec, /^\d{20}$/);
    expect(rows).toEqual([
      { name: '"ALFA" MChJ', app: '30000000120260000001' },
      { name: '"ALFA" MChJ', app: '30000000120260000002' },
    ]);
  });

  it('gives an own-row column only to the nearest row of a cell that looks merged', () => {
    const own: TableSpec = {
      anchor: 'app',
      columns: [
        { key: 'name', header: /Nomi/, ownRow: true },
        { key: 'app', header: /Ariza/ },
      ],
    };
    const page: PdfPage = {
      texts: [
        ...head,
        t(40, 16, 'Sok'),
        t(40, 40, 'Tomat pastasi', 50),
        t(200, 16, '30000000120260000001', 60),
        t(200, 40, '30000000120260000002', 60),
      ],
      // The name column is missing its edge between the two rows.
      horizontal: [
        h(12, 0, 150),
        h(52, 0, 150),
        h(12, 150, 300),
        h(30, 150, 300),
        h(52, 150, 300),
      ],
      vertical: cols,
    };
    expect(anchoredRows([page], own, /^\d{20}$/).map((r) => r.name)).toEqual([
      'Sok',
      'Tomat pastasi',
    ]);
  });

  it('gives each row its own value where a missing cell edge joins two', () => {
    const page: PdfPage = {
      texts: [
        ...head,
        t(40, 16, '"ALFA"'),
        t(40, 40, '"BETA"'),
        t(200, 16, '30000000120260000001', 60),
        t(200, 40, '30000000220260000001', 60),
      ],
      // The anchor column has no edge between the two rows.
      horizontal: [
        h(12, 0, 150),
        h(30, 0, 150),
        h(52, 0, 150),
        h(12, 150, 300),
        h(52, 150, 300),
      ],
      vertical: cols,
    };
    expect(anchoredRows([page], spec, /^\d{20}$/)).toEqual([
      { name: '"ALFA"', app: '30000000120260000001' },
      { name: '"BETA"', app: '30000000220260000001' },
    ]);
  });

  it('reads a table drawn with no lines, columns by their titles', () => {
    const page: PdfPage = {
      texts: [
        t(80, -20, 'Reyestr 2025-yil 1-chorak', 200),
        t(5, 2, '№', 10),
        t(40, 2, 'Nomi', 20),
        t(200, 2, 'Ariza', 20),
        t(6, 20, '1', 5),
        t(30, 20, '"ALFA" MChJ', 50),
        t(190, 20, '30000000120260000001', 60),
        t(6, 40, '2', 5),
        t(30, 40, '"BETA" AJ', 40),
        t(190, 40, '30000000220260000001', 60),
      ],
      horizontal: [],
      vertical: [],
    };
    const rows = anchoredRows(
      [page],
      {
        anchor: 'no',
        columns: [
          { key: 'no', header: /^\s*№\s*$/ },
          { key: 'name', header: /Nomi/ },
          { key: 'app', header: /Ariza/ },
        ],
      },
      /^\d{1,5}$/,
    );
    expect(rows).toEqual([
      { no: '1', name: '"ALFA" MChJ', app: '30000000120260000001' },
      { no: '2', name: '"BETA" AJ', app: '30000000220260000001' },
    ]);
  });

  it('keeps reading on pages that do not repeat the header', () => {
    const page1: PdfPage = {
      texts: [...head, t(200, 20, '30000000120260000001', 60)],
      horizontal: [],
      vertical: cols,
    };
    const page2: PdfPage = {
      texts: [t(200, 4, '30000000220260000001', 60)],
      horizontal: [],
      vertical: cols,
    };
    expect(
      anchoredRows([page1, page2], spec, /^\d{20}$/).map((r) => r.app),
    ).toEqual(['30000000120260000001', '30000000220260000001']);
  });
});
