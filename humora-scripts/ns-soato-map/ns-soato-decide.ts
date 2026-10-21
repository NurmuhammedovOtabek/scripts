/**
 * Which SOATO district a tax office (mysoliq's ns10/ns11 pair) stands for,
 * read off two official classifiers and nothing else:
 *
 * - the Tax Committee's list of its territorial inspections (cs.egov.uz
 *   083-4-001): the pair and the office's name — "Андижон шаҳар давлат солиқ
 *   инспекцияси" (3/1) and "Андижон туман …" (3/7);
 * - Statistics' MHOBT (cs.egov.uz 082-3-007): every SOATO code with its
 *   name — 1703401 "Андижон", 1703203 "Андижон тумани", and the cities of
 *   district rank as ten-digit settlements (1712248501 "Учқудуқ").
 *
 * The office's own word says which kind of place it is (шаҳар / туман), so a
 * city office is only ever matched to a city and a district office to a
 * district — the confusion the seeded table made for ten regional cities.
 * An answer is given only when exactly one place of that kind in the region
 * carries the name; a one-letter difference is allowed for names of five
 * letters or more, because the tax list has typos ("Шаҳризабз", "Пискент")
 * and a region has twenty districts at most, but it must still be the only
 * one. Anything else is no answer: a pair without a district is a company
 * without a mahalla, never one in the wrong place.
 */

export interface MhobtRow {
  /** 7 digits for a district or regional city, 10 for a settlement. */
  code: string;
  /** Cyrillic, as MHOBT writes it. */
  name: string;
}

export interface TaxOffice {
  ns10: number;
  ns11: number;
  name: string;
}

export type NsHow =
  /** Exactly one place of the office's kind has its name. */
  | 'name'
  /** A city of district rank: the district it sits in. */
  | 'district_rank_city'
  /** One letter off, and still the only candidate. */
  | 'close_name'
  /** A regional administration, the committee, the large-taxpayer office. */
  | 'not_territorial'
  | 'unparsed'
  | 'ambiguous'
  | 'no_match';

export interface NsDecision {
  soato: string | null;
  how: NsHow;
  /** The MHOBT name the answer came from. */
  matched: string | null;
}

// Latin letters the tax list types inside Cyrillic words ("Тeрмиз").
const LOOKALIKE: Record<string, string> = {
  a: 'а',
  e: 'е',
  o: 'о',
  p: 'р',
  c: 'с',
  x: 'х',
  y: 'у',
  k: 'к',
  m: 'м',
  t: 'т',
  b: 'в',
};

/**
 * One spelling for the variants the two lists use for the same name:
 * Latin look-alikes, ҳ/х, ў/у, қ/к, ғ/г, ё/е, hard and soft signs,
 * punctuation and spacing.
 */
export function foldCyrillic(s: string): string {
  return s
    .toLowerCase()
    .replace(/[aeopcxykmtb]/g, (ch) => LOOKALIKE[ch] ?? ch)
    .replace(/ҳ/g, 'х')
    .replace(/ў/g, 'у')
    .replace(/қ/g, 'к')
    .replace(/ғ/g, 'г')
    .replace(/ё/g, 'е')
    .replace(/[ъь]/g, '')
    .replace(/[ʼʻ'`’‘"«»().,-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** At most one insertion, deletion or substitution apart. */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

const CITY_WORD = foldCyrillic('шаҳар');
const DISTRICT_WORD = foldCyrillic('тумани');
const NOT_TERRITORIAL = /бошкарма|вилоят|кумита|йирик|худудлараро/;

/**
 * The place name and its kind, from "<name> шаҳар|туман давлат солиқ
 * инспекцияси". The kind word may itself carry a typo ("иумани").
 */
export function parseTaxOfficeName(
  name: string,
): { base: string; kind: 'city' | 'district' } | null {
  const words = foldCyrillic(name).split(' ');
  for (let k = 1; k < words.length; k++) {
    const w = words[k];
    const kind =
      w === CITY_WORD || (w.length >= 4 && withinOneEdit(w, CITY_WORD))
        ? 'city'
        : w === 'туман' || withinOneEdit(w, DISTRICT_WORD)
          ? 'district'
          : null;
    if (kind) {
      const base = words.slice(0, k).join(' ');
      return base ? { base, kind } : null;
    }
  }
  return null;
}

const UPPER_LOOKALIKE: Record<string, string> = {
  A: 'А',
  E: 'Е',
  O: 'О',
  P: 'Р',
  C: 'С',
  X: 'Х',
  Y: 'У',
  K: 'К',
  M: 'М',
  T: 'Т',
  B: 'В',
};

/**
 * The office as the seeded table names places — "АНДИЖОН ШАҲАР",
 * "ШАХРИСАБЗ ТУМАНИ" — for a pair the sync adds. The tax list's own name
 * ("Андижон шаҳар давлат солиқ инспeкцияси", a Latin "e" in it) reaches the
 * YaTT profile and the partner API through `ns11_name`, so it is not stored
 * as it comes. Null when the name says neither шаҳар nor туман.
 */
export function taxOfficeLabel(name: string): string | null {
  const words = name.trim().split(/\s+/);
  for (let k = 1; k < words.length; k++) {
    const w = foldCyrillic(words[k]);
    const kind =
      w === CITY_WORD || (w.length >= 4 && withinOneEdit(w, CITY_WORD))
        ? 'ШАҲАР'
        : w === 'туман' || withinOneEdit(w, DISTRICT_WORD)
          ? 'ТУМАНИ'
          : null;
    if (kind) {
      const base = words
        .slice(0, k)
        .map((word) =>
          /[Ѐ-ӿ]/.test(word)
            ? word
                .toUpperCase()
                .replace(/[AEOPCXYKMTB]/g, (ch) => UPPER_LOOKALIKE[ch] ?? ch)
            : word.toUpperCase(),
        )
        .join(' ');
      return `${base} ${kind}`;
    }
  }
  return null;
}

interface Place {
  /** The district code the answer is. */
  district: string;
  name: string;
  f: string;
}

/** MHOBT arranged for the lookups: per region, cities and districts apart. */
export class MhobtIndex {
  private readonly cities = new Map<string, Place[]>();
  private readonly districts = new Map<string, Place[]>();
  private readonly codes = new Set<string>();

  constructor(rows: MhobtRow[]) {
    const add = (m: Map<string, Place[]>, region: string, p: Place) => {
      const list = m.get(region) ?? [];
      list.push(p);
      m.set(region, list);
    };
    for (const r of rows) {
      const code = (r.code ?? '').trim();
      const name = (r.name ?? '').trim();
      if (!/^17\d{5}(\d{3})?$/.test(code) || !name) continue;
      const region = code.slice(0, 4);
      if (code.length === 7) {
        // 17xx200, 17xx400, 1726260 head a group ("… вилоятининг туманлари",
        // "… аҳамиятига эга шаҳарлар") and are no place.
        if (/туманлари|шаҳарлар|аҳамиятига/i.test(name)) continue;
        this.codes.add(code);
        const kind = code[4];
        if (kind === '2') {
          const bare = name.replace(/\s+тумани$/i, '');
          add(this.districts, region, {
            district: code,
            name,
            f: foldCyrillic(bare),
          });
        } else if (kind === '4') {
          add(this.cities, region, {
            district: code,
            name,
            f: foldCyrillic(name),
          });
        }
      } else if (code[4] === '2' && /^5(0[1-9]|[1-4]\d)$/.test(code.slice(7))) {
        // A city of district rank (…501–…549): the answer is its district.
        add(this.cities, region, {
          district: code.slice(0, 7),
          name,
          f: foldCyrillic(name),
        });
      }
    }
  }

  /** Whether MHOBT has this seven-digit code at all. */
  hasDistrict(code: string | null | undefined): boolean {
    return !!code && this.codes.has(code);
  }

  /** Districts and regional cities held — a cut-off answer has far fewer. */
  get size(): number {
    return this.codes.size;
  }

  places(region: string, kind: 'city' | 'district'): Place[] {
    return (kind === 'city' ? this.cities : this.districts).get(region) ?? [];
  }
}

const unique = (places: Place[]): Place[] => {
  const byDistrict = new Map(places.map((p) => [p.district, p]));
  return [...byDistrict.values()];
};

/** ns10 is the SOATO region code less 1700: 3 → 1703, 26 → 1726. */
export function regionOfNs10(ns10: number): string | null {
  return ns10 > 0 && ns10 < 100 ? String(1700 + ns10) : null;
}

export function decideNsSoato(
  office: TaxOffice,
  mhobt: MhobtIndex,
): NsDecision {
  const none = (how: NsHow): NsDecision => ({
    soato: null,
    how,
    matched: null,
  });
  const region = regionOfNs10(office.ns10);
  const folded = foldCyrillic(office.name ?? '');
  if (!region || !office.ns11 || office.ns10 === 50)
    return none('not_territorial');
  const parsed = parseTaxOfficeName(office.name ?? '');
  if (!parsed) {
    return NOT_TERRITORIAL.test(folded)
      ? none('not_territorial')
      : none('unparsed');
  }
  const candidates = mhobt.places(region, parsed.kind);
  const exact = unique(candidates.filter((p) => p.f === parsed.base));
  if (exact.length === 1) {
    const p = exact[0];
    const districtRank = parsed.kind === 'city' && p.district[4] === '2';
    return {
      soato: p.district,
      how: districtRank ? 'district_rank_city' : 'name',
      matched: p.name,
    };
  }
  if (exact.length > 1) return none('ambiguous');
  if (parsed.base.length >= 5) {
    const close = unique(
      candidates.filter((p) => withinOneEdit(p.f, parsed.base)),
    );
    if (close.length === 1) {
      return {
        soato: close[0].district,
        how: 'close_name',
        matched: close[0].name,
      };
    }
    if (close.length > 1) return none('ambiguous');
  }
  return none('no_match');
}
