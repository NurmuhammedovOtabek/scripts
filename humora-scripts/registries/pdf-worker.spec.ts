import { readPdfTable } from './pdf-worker';

/** A one-page PDF drawn by hand: its content stream, Helvetica as F1. */
function tinyPdf(content: string): Uint8Array {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R ' +
      '/Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf +=
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
    `startxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf, 'latin1'));
}

const text = (x: number, y: number, s: string) =>
  `BT /F1 8 Tf ${x} ${y} Td (${s}) Tj ET`;

// Columns No 10-40, Nomi 40-150, STIR 150-290; header 180-160, one row 160-140.
const TABLE = tinyPdf(
  [
    '0.5 w',
    ...[180, 160, 140].map((y) => `10 ${y} m 290 ${y} l S`),
    ...[10, 40, 150, 290].map((x) => `${x} 180 m ${x} 140 l S`),
    text(15, 167, 'No'),
    text(60, 167, 'Nomi'),
    text(200, 167, 'STIR'),
    text(20, 147, '1'),
    text(50, 147, 'ALFA SAVDO MChJ'),
    text(170, 147, '300000001'),
  ].join('\n'),
);

const LAYOUT = {
  spec: {
    anchor: 'no',
    columns: [
      { key: 'no', header: /^\s*No\s*$/ },
      { key: 'name', header: /Nomi/ },
      { key: 'stir', header: /STIR/ },
    ],
  },
};

describe('readPdfTable (worker thread)', () => {
  it('reads a ruled table on its own thread and says which layout it was', async () => {
    const read = await readPdfTable(TABLE, {
      layouts: [
        { spec: { anchor: 'x', columns: [{ key: 'x', header: /Other/ }] } },
        // A caller's own fields (here a function) stay on its side.
        { ...LAYOUT, rows: (r: unknown) => r } as any,
      ],
    });
    expect(read).toMatchObject({
      layout: 1,
      pages: 1,
      rows: [{ no: '1', name: 'ALFA SAVDO MChJ', stir: '300000001' }],
    });
    expect(read.firstPageText).toContain('STIR');
  }, 60_000);

  it('answers -1 when no layout fits, and rejects a file that is no PDF', async () => {
    const none = await readPdfTable(TABLE, {
      layouts: [
        { spec: { anchor: 'x', columns: [{ key: 'x', header: /Other/ }] } },
      ],
    });
    expect(none).toMatchObject({ layout: -1, rows: [] });
    await expect(
      readPdfTable(new Uint8Array(Buffer.from('not a pdf')), {
        layouts: [LAYOUT],
      }),
    ).rejects.toThrow();
  }, 60_000);
});
