import {
  contentHash,
  dayOf,
  daysIn,
  digitsOf,
  isTraderStir,
  looksLikeOrganisation,
  nameKey,
  numberOf,
  quarterEnd,
  quarterOf,
  taxpayerOf,
  textOf,
} from './registry-normalize';

describe('registry-normalize', () => {
  it('reads text, closing spaces and dropping placeholders', () => {
    expect(textOf('  "ALFA SAVDO"   MChJ  ')).toBe('"ALFA SAVDO" MChJ');
    expect(textOf('Ichki turizm\r\n - Chiqish turizmi')).toBe(
      'Ichki turizm\n- Chiqish turizmi',
    );
    for (const blank of ['', ' ', '-', '—', 'empty', null, undefined]) {
      expect(textOf(blank)).toBeNull();
    }
  });

  it('reads numbers written with spaces or a decimal comma', () => {
    expect(numberOf('1 532 013,49')).toBe(1532013.49);
    expect(numberOf(0)).toBe(0);
    expect(numberOf('abc')).toBeNull();
  });

  it('reads a STIR kept as a float, and tells a PINFL from a STIR', () => {
    expect(digitsOf(305943358.0)).toBe('305943358');
    expect(digitsOf('305943358.0')).toBe('305943358');
    expect(taxpayerOf(300000001)).toEqual({
      inn: '300000001',
      pinfl: null,
      rawTin: null,
    });
    expect(taxpayerOf('30000000000001')).toEqual({
      inn: null,
      pinfl: '30000000000001',
      rawTin: null,
    });
    // A zero is no taxpayer; a 10-digit foreign number is kept as written.
    expect(taxpayerOf('0').inn).toBeNull();
    expect(taxpayerOf('1234567890')).toEqual({
      inn: null,
      pinfl: null,
      rawTin: '1234567890',
    });
    expect(isTraderStir('400000001')).toBe(true);
    expect(isTraderStir('300000001')).toBe(false);
  });

  it('reads the day formats registers use, and refuses a day that does not exist', () => {
    expect(dayOf('2026-01-08')).toBe('2026-01-08');
    expect(dayOf('08.01.2026')).toBe('2026-01-08');
    expect(dayOf('08/01/2026')).toBe('2026-01-08');
    expect(dayOf('22.08.2024 14:00:00')).toBe('2024-08-22');
    expect(dayOf('2026-09-14T00:00:00')).toBe('2026-09-14');
    // An instant at UTC midnight-minus-five is the next Tashkent day.
    expect(dayOf('2026-04-12T19:30:00Z')).toBe('2026-04-13');
    expect(dayOf('29.02.2042')).toBeNull();
    expect(dayOf('Неограниченный')).toBeNull();
    expect(daysIn('QQ 0259 G5-сон  24.11.2023 от 30.02.2046')).toEqual([
      '2023-11-24',
      null,
    ]);
  });

  it('finds the quarter a dataset description names', () => {
    expect(quarterOf('2026 yil I-chorak davomida toʻlovchilar kesimida')).toBe(
      '2026Q1',
    );
    expect(quarterOf('2026 йил 1 чорак давомида')).toBe('2026Q1');
    expect(quarterOf('imtiyozlar (2024-yil 2-chorak)')).toBe('2024Q2');
    expect(quarterOf('Information on customs benefits')).toBeNull();
    expect(quarterEnd('2024Q2')).toBe('2024-06-30');
  });

  it('hashes the same content the same whatever the key order', () => {
    expect(contentHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(
      contentHash({ b: { d: [1, 2], c: 2 }, a: 1 }),
    );
    expect(contentHash({ a: 1 })).not.toBe(contentHash({ a: 2 }));
  });

  it('tells an organisation’s name from a person’s', () => {
    for (const org of [
      '"ALFA SAVDO" MChJ',
      'MASULIYATI CHEKLANGAN JAMYAT  ALFA LOGISTICS',
      'Hududiy elektr tarmoqlari AJ',
      'ALFA SAVDO МЧЖ',
      'ООО ALFA',
      'Toshkent shahar ALFA markazi',
    ]) {
      expect(looksLikeOrganisation(org)).toBe(true);
    }
    for (const person of [
      'TOSHMATOV ESHMAT',
      'Toshmatov Eshmat Toshmatovich',
      'ИП ТОШМАТОВ ЭШМАТ',
      'YaTT TOSHMATOV ESHMAT',
      '',
      null,
    ]) {
      expect(looksLikeOrganisation(person)).toBe(false);
    }
  });

  describe('nameKey', () => {
    it('folds Latin and Cyrillic spellings and the legal form to one key', () => {
      const key = nameKey('"ALFA SAVDO" MChJ');
      expect(key).toBe('ALFASAVDO');
      expect(nameKey('«АЛФА САВДО» масъулияти чекланган жамияти')).toBe(key);
      expect(nameKey('ООО "ALFA SAVDO"')).toBe(key);
      expect(nameKey("Alfa Savdo mas'uliyati cheklangan jamiyati")).toBe(key);
    });

    it('reads Latin letters inside a Cyrillic word as the Cyrillic they look like', () => {
      // A Latin H in the middle of Cyrillic text.
      expect(nameKey('ЦЕHТР')).toBe(nameKey('ЦЕНТР'));
      // A Latin word stays itself.
      expect(nameKey('"HOTEL BUKHARA" XK')).toBe('HOTELBUXARA');
    });

    it('is null when only the legal form is left', () => {
      expect(nameKey('MChJ')).toBeNull();
      expect(nameKey('')).toBeNull();
    });
  });
});
