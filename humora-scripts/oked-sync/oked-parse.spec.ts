import { CsRow } from '../common/cs-egov';
import { parseOkedDataset } from './oked-parse';

/** A cell the way cs.egov.uz sends it: the four languages, and a default. */
const cell = (uz: string, ru = uz, en = uz, cyrl = uz) => ({
  text: { uzbText: uz, uzbKrText: cyrl, rusText: ru, engText: en },
  number: 0,
  data: null,
  default: ru,
});
const dash = () => cell('-');

/** One printed line of the classifier; code columns not given are "-". */
function row(cols: {
  DIVISION?: ReturnType<typeof cell>;
  GROUP?: string;
  CLASS?: string;
  SUBCLASS?: string;
  groupname?: string;
  name: [string, string, string];
}): CsRow {
  const [uz, ru, en] = cols.name;
  return {
    tableColumn: {
      DIVISION: cols.DIVISION ?? dash(),
      GROUP: cols.GROUP ? cell(cols.GROUP) : dash(),
      CLASS: cols.CLASS ? cell(cols.CLASS) : dash(),
      SUBCLASS: cols.SUBCLASS ? cell(cols.SUBCLASS) : dash(),
      groupname: cols.groupname ? cell(cols.groupname) : dash(),
      name: cell(uz, ru, en, `${uz} (kirill)`),
      oked: cell('01111'),
    },
  };
}

// Real lines of 082-3-004 (2026-10-08), shortened.
const SECTION_A = row({
  DIVISION: cell('A seksiyasi', 'Секция A', 'Section A', 'A секцияси'),
  name: [
    'QISHLOQ, O‘RMON VA BALIQ XO‘JALIGI',
    'СЕЛЬСКОЕ, ЛЕСНОЕ И РЫБНОЕ ХОЗЯЙСТВО',
    'AGRICULTURE, FORESTRY AND FISHING',
  ],
});
const DIVISION_01 = row({
  DIVISION: cell('01'),
  groupname: 'A',
  name: ['DEHQONCHILIK VA CHORVACHILIK', 'РАСТЕНИЕВОДСТВО', 'Crop and animal'],
});
const GROUP_011 = row({
  GROUP: '01.1',
  groupname: '01',
  name: ['Mavsumiy ekinlar', 'Сезонные культуры', 'Non-perennial crops'],
});
const CLASS_0111 = row({
  CLASS: '01.11',
  groupname: '01',
  name: ['Donli ekinlar', 'Зерновые культуры', 'Cereals'],
});
const SUBCLASS_01111 = row({
  SUBCLASS: '01.11.1',
  groupname: '01.11',
  name: [
    'Donli ekinlar yetishtirish',
    'Выращивание зерновых',
    'Growing of cereals',
  ],
});
/** A class with one subclass is one printed line carrying both codes. */
const CLASS_AND_SUBCLASS_0112 = row({
  CLASS: '01.12',
  SUBCLASS: '01.12.0',
  groupname: '01.12',
  name: ['Sholi yetishtirish', 'Выращивание риса', 'Growing of rice'],
});

describe('parseOkedDataset', () => {
  const tree = () =>
    parseOkedDataset([
      SECTION_A,
      DIVISION_01,
      GROUP_011,
      CLASS_0111,
      SUBCLASS_01111,
      CLASS_AND_SUBCLASS_0112,
    ]);
  const byCode = () => new Map(tree().nodes.map((n) => [n.code, n]));

  it('reads every level, codes without their dots', () => {
    const nodes = byCode();
    expect([...nodes.keys()].sort()).toEqual([
      '01',
      '011',
      '0111',
      '01111',
      '0112',
      '01120',
      'A',
    ]);
    expect(nodes.get('A')).toMatchObject({
      level: 'section',
      parent_code: null,
    });
    expect(nodes.get('01')).toMatchObject({
      level: 'division',
      parent_code: 'A',
    });
    expect(nodes.get('011')).toMatchObject({
      level: 'group',
      parent_code: '01',
    });
    expect(nodes.get('0111')).toMatchObject({
      level: 'class',
      parent_code: '011',
    });
    expect(nodes.get('01111')).toMatchObject({
      level: 'subclass',
      parent_code: '0111',
    });
  });

  it('takes the parent from the code, not from groupname', () => {
    // groupname names the division on a class line ("01"), not its group.
    expect(byCode().get('0111')?.parent_code).toBe('011');
  });

  it('makes a class and its only subclass out of one line, same name', () => {
    const nodes = byCode();
    expect(nodes.get('0112')).toMatchObject({
      level: 'class',
      parent_code: '011',
      name_ru: 'Выращивание риса',
    });
    expect(nodes.get('01120')).toMatchObject({
      level: 'subclass',
      parent_code: '0112',
      name_ru: 'Выращивание риса',
    });
  });

  it('keeps the name in all four languages', () => {
    expect(byCode().get('A')).toMatchObject({
      name_uz: 'QISHLOQ, O‘RMON VA BALIQ XO‘JALIGI',
      name_uz_cyrl: 'QISHLOQ, O‘RMON VA BALIQ XO‘JALIGI (kirill)',
      name_ru: 'СЕЛЬСКОЕ, ЛЕСНОЕ И РЫБНОЕ ХОЗЯЙСТВО',
      name_en: 'AGRICULTURE, FORESTRY AND FISHING',
    });
  });

  it('carries the section down to every node', () => {
    for (const n of tree().nodes) expect(n.section_code).toBe('A');
  });

  it('leaves out a node whose parent is missing, and everything under it', () => {
    const parsed = parseOkedDataset([
      SECTION_A,
      // no division 01
      GROUP_011,
      CLASS_0111,
      SUBCLASS_01111,
    ]);
    expect(parsed.nodes.map((n) => n.code)).toEqual(['A']);
    expect(parsed.orphans.sort()).toEqual(['011', '0111', '01111']);
  });

  it('leaves out a division that names no section', () => {
    const parsed = parseOkedDataset([
      SECTION_A,
      row({ DIVISION: cell('02'), name: ['x', 'x', 'x'] }),
    ]);
    expect(parsed.orphans).toEqual(['02']);
  });

  it('counts a line with no code it can read', () => {
    const parsed = parseOkedDataset([
      SECTION_A,
      row({ name: ['?', '?', '?'] }),
    ]);
    expect(parsed.unreadable).toBe(1);
  });

  it('prefers a class line of its own to the one it shares with its subclass', () => {
    const parsed = parseOkedDataset([
      SECTION_A,
      DIVISION_01,
      GROUP_011,
      CLASS_AND_SUBCLASS_0112,
      row({ CLASS: '01.12', groupname: '01', name: ['Sholi', 'Рис', 'Rice'] }),
    ]);
    const klass = parsed.nodes.find((n) => n.code === '0112');
    expect(klass?.name_ru).toBe('Рис');
    expect(parsed.duplicates).toEqual(['0112']);
  });
});
