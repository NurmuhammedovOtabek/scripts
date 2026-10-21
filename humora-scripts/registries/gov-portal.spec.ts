import { editionDayOf, govSection, newestFile, uploadDay } from './gov-portal';
import { HostPacer, RegistryHttp } from './registry-http';

describe('gov.uz files', () => {
  it('dates a file by its upload path and picks the newest', () => {
    const a = 'https://api-portal.gov.uz/uploads/3/2026/02/09/a_media_.pdf';
    const b = 'https://api-portal.gov.uz/uploads/3/2026/06/25/b_media_.pdf';
    expect(uploadDay(a)).toBe('2026-02-09');
    expect(newestFile([a, b])).toBe(b);
    expect(newestFile([])).toBeNull();
  });

  it('reads the "as of" day a register prints in its title', () => {
    expect(
      editionDayOf(
        'Auditorlik tashkilotlari reyestri 2025-yil 31-dekabr holatiga koʻra',
      ),
    ).toBe('2025-12-31');
    expect(editionDayOf('2026-yil 31-iyul holatiga')).toBe('2026-07-31');
    expect(editionDayOf('2026 йил 31 июль ҳолатига')).toBe('2026-07-31');
    expect(editionDayOf('31.07.2026 holatiga')).toBe('2026-07-31');
    expect(editionDayOf('Sanepid xulosa 2026-yil 3-chorak')).toBeNull();
  });

  it('lists a section’s documents with their PDFs, from the link and the body', async () => {
    const send = jest.fn(async (config: any) => {
      expect(config.headers.code).toBe('imv');
      return {
        status: 200,
        headers: {},
        data: {
          total_page: 1,
          data: [
            {
              id: 111717,
              title: 'Auditorlik tashkilotlari reyestri',
              link: 'https://api-portal.gov.uz/uploads/3/2026/02/13/x_media_.xlsx',
              body: '',
            },
            {
              id: 121389,
              title: 'Reyestr',
              link: null,
              body: '<a href="https://api-portal.gov.uz/uploads/3/2026/06/25/y_media_.pdf">2026</a>',
            },
          ],
        },
      };
    });
    const docs = await govSection(
      new RegistryHttp(new HostPacer(0), null, send, 0),
      'imv',
      'section',
    );
    expect(docs).toEqual([
      {
        id: 111717,
        title: 'Auditorlik tashkilotlari reyestri',
        pdfs: [],
        others: [
          'https://api-portal.gov.uz/uploads/3/2026/02/13/x_media_.xlsx',
        ],
      },
      {
        id: 121389,
        title: 'Reyestr',
        pdfs: ['https://api-portal.gov.uz/uploads/3/2026/06/25/y_media_.pdf'],
        others: [],
      },
    ]);
  });
});
