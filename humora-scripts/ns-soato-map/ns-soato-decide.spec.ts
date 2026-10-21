import {
  MhobtIndex,
  decideNsSoato,
  foldCyrillic,
  parseTaxOfficeName,
  taxOfficeLabel,
  withinOneEdit,
} from './ns-soato-decide';

// Real MHOBT rows (cs.egov.uz 082-3-007, 2025-12-10), plus two made-up
// cities for the ambiguity case.
const mhobt = new MhobtIndex([
  { code: '1703200', name: 'Андижон вилоятининг туманлари' },
  { code: '1703203', name: 'Андижон тумани' },
  { code: '1703220', name: 'Қўрғонтепа тумани' },
  { code: '1703220505', name: 'Қорасув' },
  { code: '1703400', name: 'Андижон в-тининг вил-т аҳамиятига эга шаҳарлари' },
  { code: '1703401', name: 'Андижон' },
  { code: '1710245', name: 'Шаҳрисабз тумани' },
  { code: '1710405', name: 'Шаҳрисабз' },
  { code: '1712248', name: 'Учқудуқ тумани' },
  {
    code: '1712248500',
    name: 'Учқудуқ туманининг туман аҳамиятига эга шаҳарлари',
  },
  { code: '1712248501', name: 'Учқудуқ' },
  { code: '1712408', name: 'Зарафшон' },
  { code: '1714219', name: 'Поп тумани' },
  { code: '1722210', name: 'Денов тумани' },
  { code: '1722210501', name: 'Денов' },
  { code: '1722210823', name: 'Денов' },
  { code: '1727249', name: 'Паркент тумани' },
  { code: '1727250', name: 'Пскент тумани' },
  { code: '1730233', name: 'Фарғона тумани' },
  { code: '1730401', name: 'Фарғона' },
  { code: '1733221', name: 'Тупроққалъа тумани' },
  { code: '1718201', name: 'Бирор тумани' },
  { code: '1718201501', name: 'Янгиобод' },
  { code: '1718202', name: 'Бошқа тумани' },
  { code: '1718202501', name: 'Янгиобод' },
]);

const decide = (ns10: number, ns11: number, name: string) =>
  decideNsSoato({ ns10, ns11, name }, mhobt);

describe('decideNsSoato', () => {
  it('sends a city office to the city and a district office to the district', () => {
    // The seed had 3/1 at 1703203 (the district).
    expect(decide(3, 1, 'Андижон шаҳар давлат солиқ инспeкцияси')).toEqual({
      soato: '1703401',
      how: 'name',
      matched: 'Андижон',
    });
    expect(decide(3, 7, 'Андижон туман давлат солиқ инспeкцияси')).toEqual({
      soato: '1703203',
      how: 'name',
      matched: 'Андижон тумани',
    });
    // The seed's own short names read the same way.
    expect(decide(30, 5, 'ФАРҒОНА ШАҲАР').soato).toBe('1730401');
  });

  it('places a city of district rank in its district', () => {
    // The seed had Uchquduq at 1712408 — Zarafshon, another city.
    expect(decide(12, 3, 'Учқудуқ шаҳар давлат солиқ инспeкцияси')).toEqual({
      soato: '1712248',
      how: 'district_rank_city',
      matched: 'Учқудуқ',
    });
    // Denov's village (…823) carries the same name; only the city counts.
    expect(decide(22, 2, 'ДЕНОВ ШАҲАР').soato).toBe('1722210');
    expect(decide(3, 5, 'ҚОРАСУВ ШАҲАР').soato).toBe('1703220');
  });

  it('forgives one letter in a long name, when nothing else is that close', () => {
    expect(
      decide(10, 2, 'Шаҳризабз шаҳар давлат солиқ инспeкцияси'),
    ).toMatchObject({
      soato: '1710405',
      how: 'close_name',
    });
    expect(
      decide(27, 10, 'Пискeнт туман давлат солиқ инспeкцияси'),
    ).toMatchObject({
      soato: '1727250',
      how: 'close_name',
    });
    // …and in the kind word itself.
    expect(
      decide(33, 14, 'Тупроққалъа иумани давлат солиқ инспeкция').soato,
    ).toBe('1733221');
    // A short name must be exact: "Пап" is not "Поп".
    expect(decide(14, 11, 'Пап туман давлат солиқ инспекцияси')).toMatchObject({
      soato: null,
      how: 'no_match',
    });
  });

  it('gives no answer rather than a guess', () => {
    // Renamed (Бўз → Бўстон) or not in MHOBT yet (Давлатобод).
    expect(decide(3, 9, 'Бўз туман давлат солиқ инспeкцияси').soato).toBeNull();
    expect(
      decide(14, 18, 'Давлатобод туман давлат солиқ инспeкцияси'),
    ).toMatchObject({
      soato: null,
      how: 'no_match',
    });
    // Two cities of that name in one region.
    expect(
      decide(18, 30, 'Янгиобод шаҳар давлат солиқ инспекцияси'),
    ).toMatchObject({
      soato: null,
      how: 'ambiguous',
    });
  });

  it('knows an administration is no place', () => {
    for (const [ns10, ns11, name] of [
      [50, 3, 'Андижон вилоят  солиқ бошқармаси'],
      [27, 27, 'Тошкeнт вилояти  солиқ бошқармаси'],
      [0, 0, 'Солиқ қўмитаси'],
      [50, 1, 'Йирик солиқ тўловчилар бўйича ҳудудлараро солиқ инспекцияси'],
    ] as const) {
      expect(decide(ns10, ns11, name)).toMatchObject({
        soato: null,
        how: 'not_territorial',
      });
    }
  });
});

describe('the pieces', () => {
  it('folds the spellings the two lists use', () => {
    expect(foldCyrillic('Қўрғонтeпа')).toBe(foldCyrillic('Қўрғонтепа'));
    expect(foldCyrillic('Шаҳрихон')).toBe(foldCyrillic('Шахрихон'));
    expect(foldCyrillic('Элликқалъа')).toBe('элликкала');
  });

  it('counts one edit and no more', () => {
    expect(withinOneEdit('пискент', 'пскент')).toBe(true);
    expect(withinOneEdit('шахризабз', 'шахрисабз')).toBe(true);
    expect(withinOneEdit('бозатав', 'бузатов')).toBe(false);
  });

  it('reads the name and the kind', () => {
    expect(
      parseTaxOfficeName('Янги Наманган туман давлат солиқ инспeкцияси'),
    ).toEqual({
      base: 'янги наманган',
      kind: 'district',
    });
    expect(parseTaxOfficeName('КАТТАҚЎРҒОН ШАҲАР')).toEqual({
      base: 'каттакургон',
      kind: 'city',
    });
    expect(parseTaxOfficeName('Андижон вилоят солиқ бошқармаси')).toBeNull();
  });

  it('skips the group headings and knows its codes', () => {
    expect(mhobt.hasDistrict('1703401')).toBe(true);
    expect(mhobt.hasDistrict('1703200')).toBe(false);
    expect(mhobt.hasDistrict('1722407')).toBe(false);
  });

  it('names a new pair the way the seeded table does', () => {
    expect(taxOfficeLabel('Андижон шаҳар давлат солиқ инспeкцияси')).toBe(
      'АНДИЖОН ШАҲАР',
    );
    expect(taxOfficeLabel('Янги Наманган туман давлат солиқ инспeкцияси')).toBe(
      'ЯНГИ НАМАНГАН ТУМАНИ',
    );
    // No Latin letter survives inside a Cyrillic word.
    expect(taxOfficeLabel('Тeрмиз шаҳар ДСИ')).toBe('ТЕРМИЗ ШАҲАР');
    expect(taxOfficeLabel('Андижон вилоят солиқ бошқармаси')).toBeNull();
  });
});
