import {
  egovLabels,
  egovNumber,
  egovPlain,
  egovText,
  EgovRow,
  fetchEgovDataset,
} from './data-egov';
import { HostPacer, RegistryHttp } from './registry-http';

const textCell = (v: string) => ({
  text: null,
  number: 0,
  data: v,
  default: v,
});
const numberCell = (v: number) => ({
  text: null,
  number: v,
  data: null,
  default: v,
});
const langCell = (uz: string, ru = uz, en = uz) => ({
  text: { uzbText: uz, uzbKrText: uz, rusText: ru, engText: en },
  number: 0,
  data: null,
  default: uz,
});

describe('data.egov.uz cells', () => {
  it('reads text from whichever slot holds it', () => {
    expect(egovText(textCell('300000001'))).toBe('300000001');
    expect(egovText(langCell('"ALFA SAVDO" MChJ '))).toBe('"ALFA SAVDO" MChJ');
    expect(egovText(numberCell(305943358))).toBe('305943358');
    expect(egovText(numberCell(0))).toBeNull();
    expect(egovText(undefined)).toBeNull();
  });

  it('reads numbers from the number slot or from text, and keeps real zeros', () => {
    expect(egovNumber(numberCell(103669991.55))).toBe(103669991.55);
    expect(egovNumber(numberCell(0))).toBe(0);
    expect(egovNumber(textCell('8009643344.019573'))).toBe(8009643344.019573);
    expect(egovNumber(langCell('1532013.4931'))).toBe(1532013.4931);
    expect(egovNumber(textCell('Неограниченный'))).toBeNull();
  });

  it('reads a four-language cell as labels', () => {
    expect(
      egovLabels(
        langCell(
          'Qo‘shilgan qiymat solig‘i',
          'Налог на добавленную стоимость',
          'Value added tax',
        ),
      ),
    ).toEqual({
      uz: 'Qo‘shilgan qiymat solig‘i',
      ru: 'Налог на добавленную стоимость',
      en: 'Value added tax',
    });
  });

  it('drops the fields that name a person from the plain row', () => {
    const row: EgovRow = {
      id: '69dce4e7774e3358ed3dc4f9',
      dateTime: '2026-04-13T12:43:15.717Z',
      tableColumn: {
        STIR: textCell('300000001'),
        Raxbariyat: textCell('TOSHMATOV ESHMAT'),
      },
    };
    expect(egovPlain(row, ['Raxbariyat'])).toEqual({ STIR: '300000001' });
  });
});

describe('fetchEgovDataset', () => {
  const row = (i: number, day = '2026-04-13T07:00:00Z'): EgovRow => ({
    id: `id${i}`,
    dateTime: day,
    tableColumn: { n: numberCell(i) },
  });

  function portal(count: number, pages: EgovRow[][], description = '') {
    return jest.fn(async (config: any) => {
      if (String(config.url).endsWith('/GetById')) {
        return {
          status: 200,
          data: { result: { description: { uzbText: description } } },
          headers: {},
        };
      }
      const page = pages[config.data.offset / config.data.limit] ?? [];
      return {
        status: 200,
        data: { result: { count, data: page } },
        headers: {},
      };
    });
  }

  it('reads every page, the upload day and the period', async () => {
    const send = portal(
      3,
      [[row(1), row(2)], [row(3, '2026-04-14T07:00:00Z')]],
      '2026 yil I-chorak davomida',
    );
    const http = new RegistryHttp(new HostPacer(0), null, send, 0);
    const read = await fetchEgovDataset(http, 'guid', {
      pageSize: 2,
      withPeriod: true,
    });
    expect(read.rows).toHaveLength(3);
    expect(read.complete).toBe(true);
    expect(read.expected).toBe(3);
    expect(read.editionDate).toBe('2026-04-14');
    expect(read.period).toBe('2026Q1');
  });

  it('is incomplete when the portal sends fewer rows than it counts', async () => {
    const send = portal(5, [[row(1), row(2)], [row(3)]]);
    const http = new RegistryHttp(new HostPacer(0), null, send, 0);
    const read = await fetchEgovDataset(http, 'guid', { pageSize: 2 });
    expect(read.complete).toBe(false);
  });

  it('is incomplete when a trial limit cuts the read', async () => {
    const send = portal(4, [
      [row(1), row(2)],
      [row(3), row(4)],
    ]);
    const http = new RegistryHttp(new HostPacer(0), 1, send, 0);
    const read = await fetchEgovDataset(http, 'guid', { pageSize: 2 });
    expect(read.rows).toHaveLength(2);
    expect(read.complete).toBe(false);
  });

  it('fails on an answer without a list', async () => {
    const send = jest.fn(async () => ({
      status: 200,
      data: { result: null },
      headers: {},
    }));
    const http = new RegistryHttp(new HostPacer(0), null, send, 0);
    await expect(fetchEgovDataset(http, 'guid')).rejects.toThrow(
      /without a list/,
    );
  });
});
