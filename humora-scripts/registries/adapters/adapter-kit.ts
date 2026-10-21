import { createHash } from 'crypto';
import { Labels, MappedEntry, Skip } from '../registry-types';
import { isTraderStir, taxpayerOf, TaxpayerIds } from '../registry-normalize';

export const L = (uz: string, ru: string, en: string): Labels => ({
  uz,
  ru,
  en,
});

/** Field labels several registers share. */
export const F = {
  address: L('Manzil', 'Адрес', 'Address'),
  legal_address: L('Yuridik manzil', 'Юридический адрес', 'Registered address'),
  activity_address: L(
    'Faoliyat manzili',
    'Адрес осуществления деятельности',
    'Place of business',
  ),
  region: L('Hudud', 'Регион', 'Region'),
  district: L('Tuman', 'Район', 'District'),
  activity: L('Faoliyat turi', 'Вид деятельности', 'Activity'),
  issue_date: L('Berilgan sana', 'Дата выдачи', 'Issued on'),
  registered_on: L(
    'Reyestrga kiritilgan sana',
    'Дата внесения в реестр',
    'Entered in the register on',
  ),
  registry_number: L('Reyestr raqami', 'Номер в реестре', 'Register number'),
  customs_post: L('Bojxona posti', 'Таможенный пост', 'Customs post'),
  coordinates: L('Koordinatalar', 'Координаты', 'Coordinates'),
  branch_name: L('Obyekt nomi', 'Название объекта', 'Site name'),
  branch_address: L('Obyekt manzili', 'Адрес объекта', 'Site address'),
  scope: L('Qo‘llanish sohasi', 'Область применения', 'Scope'),
  standard: L('Standart', 'Стандарт', 'Standard'),
  period: L('Davr', 'Период', 'Period'),
  status_text: L('Holati', 'Статус', 'Status'),
  note: L('Izoh', 'Примечание', 'Note'),
};

/**
 * An entry with every column the store has; what the mapper does not set is
 * null. Empty fields are left out, so a blank at the source never reads as a
 * value (and never replaces a stored one).
 */
export function entry(
  p: Partial<MappedEntry> & { sourceKey: string },
): MappedEntry {
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.fields ?? {})) {
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    fields[k] = v;
  }
  const out: MappedEntry = {
    inn: null,
    pinfl: null,
    rawTin: null,
    name: null,
    number: null,
    status: null,
    isActive: null,
    validFrom: null,
    validTo: null,
    amount: null,
    amountUnit: null,
    raw: {},
    asOf: null,
    ...p,
    fields,
  };
  // An individual entrepreneur's name is a person's name: not kept, in the
  // entry or in its copy of the source row.
  if ((isTraderStir(out.inn) || out.pinfl) && out.name) {
    const name = out.name.trim();
    out.raw = Object.fromEntries(
      Object.entries(out.raw).filter(
        ([, v]) => typeof v !== 'string' || v.trim() !== name,
      ),
    );
    out.name = null;
  }
  // A name is one line: registers wrap long names inside the cell.
  if (out.name) out.name = out.name.replace(/\s+/g, ' ').trim() || null;
  return out;
}

export const skip = (reason: string): Skip => ({ skip: reason });

/**
 * A key for a person's entry that does not carry the PINFL: keys reach the
 * change log and the run report, the PINFL itself stays in its own column.
 */
export function personKey(pinfl: string): string {
  return `p:${createHash('sha1').update(pinfl).digest('hex').slice(0, 16)}`;
}

/** The STIR of a row, or why it is left out. Registers here list companies. */
export function stirOrSkip(value: unknown): TaxpayerIds | Skip {
  const ids = taxpayerOf(value);
  if (ids.inn) return ids;
  if (ids.pinfl) return skip('a PINFL where a STIR was expected');
  if (ids.rawTin) return skip('taxpayer number not a STIR');
  return skip('no STIR');
}

/**
 * The name to keep: a legal entity's as written; an individual
 * entrepreneur's (STIR 4/5/6) is a person's name and is not kept.
 */
export function companyName(inn: string | null, name: string | null) {
  return inn && !isTraderStir(inn) ? name : null;
}

/** `"40.553433, 70.934486"` or two numbers → `{lat, lng}`, or null. */
export function coordinates(
  lat: unknown,
  lng?: unknown,
): { lat: number; lng: number } | null {
  let a: number;
  let b: number;
  if (lng === undefined) {
    const m = /(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)/.exec(
      String(lat ?? ''),
    );
    if (!m) return null;
    a = Number(m[1]);
    b = Number(m[2]);
  } else {
    a = Number(lat);
    b = Number(lng);
  }
  if (!Number.isFinite(a) || !Number.isFinite(b) || (a === 0 && b === 0)) {
    return null;
  }
  // Uzbekistan lies within 37–46 N, 55–74 E; anything else is a typo.
  if (a < 30 || a > 50 || b < 50 || b > 80) return null;
  return { lat: a, lng: b };
}
