import { load } from 'cheerio';

/**
 * Reading ejarima.uz's answer for a passport.
 *
 * Kept apart from the service that fetches it, and pure, because the fetch
 * needs a real browser and a reCAPTCHA token while this needs neither: the
 * shapes below can be tested against saved markup, which is the only way to
 * exercise the branches that matter without asking a live registry about a
 * real person.
 */

/**
 * What the site did, which is not the same question as what it found.
 *
 * `none` means it ran the search and there is nothing. `unavailable` means it
 * never got that far — and the two must never be collapsed, because storing
 * `unavailable` as "no fines" is how a person with unpaid penalties comes back
 * clean. The site itself is careful about this and says so in two different
 * ways (a warning versus an error); this keeps that distinction.
 */
export type EjarimaOutcome = 'found' | 'none' | 'unavailable';

/** The site's own status codes, taken from the `status_N` class. */
export const EJARIMA_STATUS = {
  PAID: 0,
  PARTIAL: 1,
  UNPAID: 2,
} as const;

export interface EjarimaProtocol {
  /** "Bayonnoma seriyasi va raqami", e.g. `PAND 2607107021832`. */
  series: string | null;
  /** The status word as the site wrote it, in the language we asked for. */
  status: string | null;
  /**
   * The same status as a number, read off the `status_N` class.
   *
   * Preferred over the word for anything that decides: the class is stable
   * across the site's three languages and across rewording, the word is not.
   * `null` when the markup carried `status_` with nothing after it, which the
   * site does emit.
   */
  statusCode: number | null;
  /** True only for an explicit `status_0`. An unknown status is not "paid". */
  paid: boolean;
  /**
   * Whether this protocol has reached a penalty at all.
   *
   * The site leaves the status blank until it has, and a blank is not a
   * neutral unknown — see `penaltyKind`.
   */
  decided: boolean;
  /**
   * "Jazo chorasi" — but the column holds two different kinds of thing.
   *
   * On a decided protocol it is the penalty: `JARIMA`. On one still in
   * progress it is the **stage of the case** instead — `KO'RIB CHIQILMOQDA`,
   * `RO'YXATGA OLINGAN`, `ORGANGA YUBORILGAN`, `SUDGA TAYYORGARLIK`,
   * `SUDGA YUBORILDI` — and those carry no status, no amount, no receipt.
   * Measured on a passport with 47 protocols: all 32 with a status read
   * `JARIMA` and all 32 had an amount; all 15 without a status were stages
   * and every one had an amount of zero.
   *
   * Which is why `decided` exists. Counting a protocol under review as "no
   * unpaid fine" is true today and may not be next month; counting it as an
   * unpaid fine would invent a debt that has not been imposed.
   */
  penaltyKind: string | null;
  /** "Jarima miqdori" in so'm, digits only. */
  fineAmount: number | null;
  /** The same, as printed — kept because the currency word is part of it. */
  fineText: string | null;
  /** "Zarar miqdori" in so'm. */
  damageAmount: number | null;
  damageText: string | null;
  /** "To'lov sanasi" — blank while unpaid. */
  paidAt: string | null;
  /** "Sodir etilgan viloyat:" / "Sodir etilgan tuman:" */
  region: string | null;
  district: string | null;
  /** "Tuzilgan sana" */
  issuedAt: string | null;
  /** "Kvitansiya raqami" */
  receiptNo: string | null;
  /** "Shaxs" — jismoniy / yuridik. */
  personKind: string | null;
  /** "Tuzgan organ" — the body an objection goes to. */
  authority: string | null;
  /** "Modda" — the article of the code. */
  article: string | null;
}

export interface EjarimaPassportResult {
  serial: string;
  number: string;
  outcome: EjarimaOutcome;
  /** Sugar for `outcome === 'found'`. */
  found: boolean;
  protocols: EjarimaProtocol[];
  /** Decided fines that are not settled — `status_1` and `status_2`. */
  unpaidCount: number;
  /** Their amounts added up, in so'm. Zero when everything is settled. */
  unpaidTotal: number;
  /**
   * Protocols still in progress — registered, under review, or gone to court.
   *
   * Reported separately rather than folded into either total: nothing is owed
   * on them yet, so they are not a debt, but they are also not an all-clear,
   * and a caller answering "does this person have outstanding penalties"
   * deserves to know a case is open.
   */
  pendingCount: number;
  /** Whatever the site said in its own words, when it said anything. */
  message: string | null;
}

/**
 * The fields the page states in words — everything a label can be mapped to.
 *
 * Derived rather than listed so that a field whose type stops being textual
 * (a date parsed into a `Date`, say) is a compile error at the mapping below
 * instead of a silent wrong assignment.
 */
type TextField = {
  [K in keyof EjarimaProtocol]: EjarimaProtocol[K] extends string | null
    ? K
    : never;
}[keyof EjarimaProtocol];

/** The site's labels, mapped onto our field names. */
const FIELDS: Record<string, TextField> = {
  'bayonnoma seriyasi va raqami': 'series',
  holati: 'status',
  'jazo chorasi': 'penaltyKind',
  'jarima miqdori': 'fineText',
  'zarar miqdori': 'damageText',
  "to'lov sanasi": 'paidAt',
  'sodir etilgan viloyat': 'region',
  'sodir etilgan tuman': 'district',
  'tuzilgan sana': 'issuedAt',
  'kvitansiya raqami': 'receiptNo',
  shaxs: 'personKind',
  'tuzgan organ': 'authority',
  modda: 'article',
};

/**
 * One spelling of an apostrophe.
 *
 * The page mixes at least three — a plain one in its labels, a curly one in
 * "To'langan" — and a lookup that does not fold them silently drops the field
 * it cannot match. Same treatment for the colon some labels carry and some
 * do not.
 */
function labelKey(raw: string): string {
  return raw
    .replace(/[‘’ʻʼ`´]/g, "'")
    .replace(/\s+/g, ' ')
    .replace(/\s*:\s*$/, '')
    .trim()
    .toLowerCase();
}

function text(raw: string | undefined | null): string | null {
  const t = (raw ?? '').replace(/\s+/g, ' ').trim();
  return t === '' ? null : t;
}

/**
 * "412 000 sum" -> 412000.
 *
 * Every separator the page might use is dropped rather than enumerated — the
 * thousands gap has been a plain space and a non-breaking one, and the
 * currency word is Cyrillic. Sums here are whole so'm, so digits are the
 * whole of the number; a string with no digits at all is `null`, not `0`,
 * because a blank cell is not a zero fine.
 */
export function parseAmount(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const digits = raw.replace(/\D+/g, '');
  if (digits === '') return null;
  const n = Number(digits);
  return Number.isFinite(n) ? n : null;
}

/** The `status_N` class, when the markup carries a number after the underscore. */
function statusCodeOf(className: string): number | null {
  const m = /(?:^|\s)status_(\d+)(?:\s|$)/.exec(className || '');
  return m ? Number(m[1]) : null;
}

/**
 * The site's toastr calls, in order.
 *
 * It reports both outcomes this way — a warning for a search that found
 * nothing, an error for a search that could not run — so the level is as
 * informative as the text and both are kept.
 */
function toastrMessages(html: string): { level: string; text: string }[] {
  const out: { level: string; text: string }[] = [];
  const re = /toastr\.(error|warning|success|info)\(\s*'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    out.push({
      level: m[1],
      text: m[2]
        .replace(/&#0?39;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/\\'/g, "'"),
    });
  }
  return out;
}

export function parsePassportPage(
  html: string,
  serial: string,
  number: string,
): EjarimaPassportResult {
  const $ = load(html ?? '');
  const messages = toastrMessages(html ?? '');

  const protocols: EjarimaProtocol[] = $('.result-card')
    .toArray()
    .map((card) => {
      const p: EjarimaProtocol = {
        series: null,
        status: null,
        statusCode: null,
        paid: false,
        decided: false,
        penaltyKind: null,
        fineAmount: null,
        fineText: null,
        damageAmount: null,
        damageText: null,
        paidAt: null,
        region: null,
        district: null,
        issuedAt: null,
        receiptNo: null,
        personKind: null,
        authority: null,
        article: null,
      };

      // Every fact on the card is a label/value pair in its own column, so the
      // label is read rather than the position: the page groups them three to
      // a row in one place and two in another, and has already moved them.
      $(card)
        .find('p.text-muted')
        .each((_, label) => {
          const key = FIELDS[labelKey($(label).text())];
          if (!key) return;
          const value = $(label).nextAll('h5').first();
          if (!value.length) return;

          p[key] = text(value.text());
          if (key === 'status') {
            p.statusCode = statusCodeOf(value.attr('class') ?? '');
          }
        });

      p.fineAmount = parseAmount(p.fineText);
      p.damageAmount = parseAmount(p.damageText);
      p.decided = p.statusCode !== null;
      p.paid = p.statusCode === EJARIMA_STATUS.PAID;
      return p;
    });

  // A card is proof the search ran and found something. The results header is
  // proof it ran at all — the site prints it with the serial and number echoed
  // back, above either the cards or its "nothing found" warning. Neither being
  // present means we are looking at some other page (an error, a challenge, a
  // redirect), and that is not an answer about this passport.
  const searched = protocols.length > 0 || $('.result-header').length > 0;
  const outcome: EjarimaOutcome =
    protocols.length > 0 ? 'found' : searched ? 'none' : 'unavailable';

  const unpaid = protocols.filter(
    (p) =>
      p.statusCode === EJARIMA_STATUS.UNPAID ||
      p.statusCode === EJARIMA_STATUS.PARTIAL,
  );

  return {
    serial,
    number,
    outcome,
    found: outcome === 'found',
    protocols,
    unpaidCount: unpaid.length,
    unpaidTotal: unpaid.reduce((sum, p) => sum + (p.fineAmount ?? 0), 0),
    pendingCount: protocols.filter((p) => !p.decided).length,
    message: messages.length ? messages[messages.length - 1].text : null,
  };
}
