import * as cheerio from 'cheerio';
import { RegistryHttp } from '../registry-http';
import { FetchResult, MapResult, RegistryAdapter } from '../registry-types';
import { dayOf, daysIn, textOf } from '../registry-normalize';
import { entry, F, L, skip, stirOrSkip } from './adapter-kit';

/**
 * The capital-market registers of the National Agency for Perspective
 * Projects (napp.uz): professional participants of the securities market and
 * participants of the special capital-market regime. One HTML table each.
 *
 * The details cell runs name, address, e-mail, STIR, phone and site together,
 * one per line; only the name, the address and the STIR are kept.
 */
export const NAPP = 'https://napp.uz';
const PROFESSIONAL_PAGE = `${NAPP}/uz/pages/qimmatli-qog-ozlar-bozori-professional-ishtirokchilarining-reestri`;
const SPECIAL_REGIME_PAGE = `${NAPP}/uz/pages/kapital-bozori-sohasidagi-maxsus-rejim-ishtirokchilari-reyestri`;

/** A cell's text with its line breaks kept (`<br>`, paragraphs). */
function cellLines($: cheerio.CheerioAPI, el: any): string[] {
  const html = ($(el).html() ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n');
  return cheerio
    .load(`<div>${html}</div>`)('div')
    .text()
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

export interface NappDetails {
  name: string | null;
  address: string | null;
  stirText: string | null;
  /** The name carries a footnote mark (`*`). */
  marked: boolean;
}

/** Name, address and STIR out of the details cell; contacts are left out. */
export function nappDetails(lines: string[]): NappDetails {
  const joined = lines.join('\n');
  const stir = /СТИР\s*:?\s*(\d{6,})/i.exec(joined);
  let name: string | null = null;
  const address: string[] = [];
  let inAddress = false;
  for (const line of lines) {
    if (/^(email|e-mail|электрон|телефон|tel|www\.|http|СТИР)/i.test(line)) {
      inAddress = false;
      continue;
    }
    const m = /^(Манзил|Manzil)\s*:?\s*(.*)$/i.exec(line);
    if (m) {
      inAddress = true;
      if (m[2]) address.push(m[2]);
      continue;
    }
    if (inAddress) {
      address.push(line);
      continue;
    }
    if (!name) name = line;
  }
  const rawName = name ?? '';
  return {
    name: textOf(rawName.replace(/\*+/g, '').replace(/[.\s]+$/, '')),
    address: textOf(address.join(' ').replace(/\s+,/g, ',')),
    stirText: stir ? stir[1] : null,
    marked: rawName.includes('*'),
  };
}

export interface NappProfessionalRow {
  name: string | null;
  address: string | null;
  stirText: string | null;
  broker: string | null;
  manager: string | null;
  adviser: string | null;
  qualifiedStaff: string | null;
  /** The footnote under the table when the row is marked. */
  note: string | null;
}

/** The professional participants' table, and its footnotes. */
export function parseNappProfessional(html: string): NappProfessionalRow[] {
  const $ = cheerio.load(html);
  const table = $('table').first();
  const notes = table
    .nextAll()
    .map((_, e) => textOf($(e).text().replace(/\s+/g, ' ')))
    .get()
    .filter((t): t is string => !!t && t.startsWith('*'));
  const rows: NappProfessionalRow[] = [];
  table.find('tr').each((_, tr) => {
    const cells = $(tr).children('td');
    if (cells.length < 6) return;
    if (!/^\d+$/.test($(cells[0]).text().trim())) return; // the header
    const details = nappDetails(cellLines($, cells[1]));
    const flag = (i: number) => textOf($(cells[i]).text());
    // A marked row's footnote names it in quotes.
    const note = details.marked
      ? (notes.find((n) => {
          const core = (details.name ?? '')
            .replace(/[«»"“”]/g, '')
            .split(' ')[0];
          return core && n.replace(/[«»"“”]/g, '').includes(core);
        }) ??
        notes[0] ??
        null)
      : null;
    rows.push({
      ...details,
      broker: flag(2),
      manager: flag(3),
      adviser: flag(4),
      qualifiedStaff: flag(5),
      note,
    });
  });
  return rows;
}

export interface NappSpecialRow {
  name: string | null;
  address: string | null;
  stirText: string | null;
  licences: string | null;
  activities: string[];
  registration: string | null;
  decision: string | null;
  decisionDate: string | null;
  deprived: string | null;
}

const SPECIAL_ACTIVITIES = [
  'investment_intermediary',
  'foreign_nominee_holder',
  'issuer',
  'agent_bank',
  'custodian',
];

/** The special-regime table: details, licences, five activity marks, numbers. */
export function parseNappSpecialRegime(html: string): NappSpecialRow[] {
  const $ = cheerio.load(html);
  const rows: NappSpecialRow[] = [];
  $('table')
    .first()
    .find('tr')
    .each((_, tr) => {
      const cells = $(tr).children('td');
      if (cells.length < 11) return;
      if (!/^\d+$/.test($(cells[0]).text().trim())) return;
      const details = nappDetails(cellLines($, cells[1]));
      const text = (i: number) =>
        textOf($(cells[i]).text().replace(/\s+/g, ' '));
      const activities = SPECIAL_ACTIVITIES.filter((_, j) =>
        /\+|✓|√|1/.test(text(3 + j) ?? ''),
      );
      // "№ 1026.02.2024" — the number and the date run together.
      const decisionText = text(9);
      const dm = /№\s*(\d+?)\s*(\d{2}\.\d{2}\.\d{4})/.exec(decisionText ?? '');
      rows.push({
        name: details.name,
        address: details.address,
        stirText: details.stirText,
        licences: text(2),
        activities,
        registration: text(8),
        decision: dm ? dm[1] : decisionText,
        decisionDate: dm ? dayOf(dm[2]) : (daysIn(decisionText)[0] ?? null),
        deprived: text(10),
      });
    });
  return rows;
}

const YES = L('Bor', 'Есть', 'Yes');
const NO = L('Yo‘q', 'Нет', 'No');

export const nappProfessional: RegistryAdapter = {
  meta: {
    code: 'capital_market_participant',
    sector: 'capital_market',
    kind: 'licence',
    title: L(
      'Qimmatli qog‘ozlar bozorining professional ishtirokchisi',
      'Профессиональный участник рынка ценных бумаг',
      'Professional securities market participant',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      investment_intermediary: L(
        'Investitsiya vositachisi',
        'Инвестиционный посредник',
        'Investment intermediary',
      ),
      asset_manager: L(
        'Investitsiya aktivlarining ishonchli boshqaruvchisi',
        'Доверительный управляющий инвестиционными активами',
        'Investment asset manager',
      ),
      investment_adviser: L(
        'Investitsiya maslahatchisi',
        'Инвестиционный консультант',
        'Investment adviser',
      ),
      qualified_staff: L(
        'Malaka sertifikatiga ega xodimlar',
        'Сотрудники с квалификационным сертификатом',
        'Staff with a qualification certificate',
      ),
      address: F.address,
      note: F.note,
    },
    minRows: 30,
  },
  async fetchAll(http: RegistryHttp): Promise<FetchResult> {
    const page = await http.get<string>(PROFESSIONAL_PAGE, {
      responseType: 'text',
    });
    const rows = parseNappProfessional(String(page.data));
    return { rows, complete: true, expected: null };
  },
  map(row: unknown): MapResult {
    const r = row as NappProfessionalRow;
    const ids = stirOrSkip(r.stirText);
    if ('skip' in ids) return ids;
    // A '0' is said as "no": a blank would keep a licence the register
    // has since taken away.
    const yes = (v: string | null) => (v === '1' ? YES : v === '0' ? NO : null);
    const suspended =
      r.note !== null && /тўхтатил|to.xtatil|приостанов/i.test(r.note);
    return entry({
      sourceKey: ids.inn!,
      inn: ids.inn,
      name: r.name,
      // Always said, so a lifted suspension replaces the stored one (a null
      // would keep it: a blank never overwrites).
      status: suspended ? 'suspended' : 'active',
      isActive: !suspended,
      fields: {
        investment_intermediary: yes(r.broker),
        asset_manager: yes(r.manager),
        investment_adviser: yes(r.adviser),
        qualified_staff: r.qualifiedStaff
          ? Number(r.qualifiedStaff) || r.qualifiedStaff
          : null,
        address: r.address,
        note: r.note,
      },
      raw: { ...r },
    });
  },
};

export const nappSpecialRegime: RegistryAdapter = {
  meta: {
    code: 'capital_market_special_regime',
    sector: 'capital_market',
    kind: 'registration',
    title: L(
      'Kapital bozori maxsus rejimi ishtirokchisi',
      'Участник специального режима рынка капитала',
      'Capital market special regime participant',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      activities: L('Faoliyat turi', 'Вид деятельности', 'Activity'),
      licences: L(
        'Litsenziyalar va ruxsatnomalar',
        'Лицензии и разрешения',
        'Licences and permits',
      ),
      decision: L('Qaror', 'Решение', 'Decision'),
      deprived: L(
        'Maqomdan mahrum etilgan',
        'Лишён статуса',
        'Status withdrawn',
      ),
      address: F.address,
    },
    minRows: 10,
  },
  async fetchAll(http: RegistryHttp): Promise<FetchResult> {
    const page = await http.get<string>(SPECIAL_REGIME_PAGE, {
      responseType: 'text',
    });
    const rows = parseNappSpecialRegime(String(page.data));
    return { rows, complete: true, expected: null };
  },
  map(row: unknown): MapResult {
    const r = row as NappSpecialRow;
    const ids = stirOrSkip(r.stirText);
    if ('skip' in ids) return ids;
    if (!r.registration) return skip('no registration number');
    const ACT: Record<string, ReturnType<typeof L>> = {
      investment_intermediary: L(
        'Investitsiya vositachisi',
        'Инвестиционный посредник',
        'Investment intermediary',
      ),
      foreign_nominee_holder: L(
        'Chet ellik nominal saqlovchi',
        'Иностранный номинальный держатель',
        'Foreign nominee holder',
      ),
      issuer: L('Emitent', 'Эмитент', 'Issuer'),
      agent_bank: L('Agent-bank', 'Агент-банк', 'Agent bank'),
      custodian: L('Kastodian', 'Кастодиан', 'Custodian'),
    };
    const deprived =
      r.deprived && !/^[-–—]$/.test(r.deprived) ? r.deprived : null;
    return entry({
      sourceKey: r.registration,
      inn: ids.inn,
      name: r.name,
      number: r.registration,
      isActive: !deprived,
      status: deprived ? 'withdrawn' : 'active',
      validFrom: r.decisionDate,
      validTo: deprived ? (daysIn(deprived)[0] ?? null) : null,
      fields: {
        activities: r.activities.map((a) => ACT[a]),
        licences: r.licences,
        decision:
          [r.decision ? `№ ${r.decision}` : null, r.decisionDate]
            .filter(Boolean)
            .join(', ') || null,
        deprived,
        address: r.address,
      },
      raw: { ...r },
    });
  },
};

export const NAPP_ADAPTERS = [nappProfessional, nappSpecialRegime];
