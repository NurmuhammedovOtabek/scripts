import { createHash } from 'crypto';
import { presentOnly } from '../../common/change-log';

/**
 * One entry of the National Accreditation System register as
 * `GET api-e.akkred.uz/apps/registries/main/` lists it. Only the fields we
 * read are named; the whole object is kept as `raw`.
 */
export interface AkkredEntry {
  id: number;
  uid?: string | null;
  number?: string | null;
  area?: string | null;
  status?: string | null;
  status_date?: string | null;
  accreditation_date?: string | null;
  re_accreditation_date?: string | null;
  accreditation_duration?: string | null;
  accreditation_duration_text?: string | null;
  step?: string | null;
  type_ownership?: string | null;
  type_accredited?: string | null;
  specific_to_finance?: boolean | null;
  in_production?: boolean | null;
  designation_of_the_fundamental_standard?: string | null;
  type_std?: unknown;
  directions?: unknown;
  region?: number | null;
  tin?: string | null;
  legal_entity_name?: string | null;
  legal_entity_address?: string | null;
  phone?: string | null;
  email?: string | null;
  web_site?: string | null;
  title_organ?: string | null;
  address_organ?: string | null;
  is_fact_address?: boolean | null;
  full_name_supervisor_ao?: string | null;
  phone_ao?: string | null;
  email_ao?: string | null;
  text?: string | null;
  certificate_pdf?: string | null;
  file_oblast?: string | null;
  file_scopes?: string | null;
  modified_date?: string | null;
  [key: string]: unknown;
}

/** A register entry in our columns (`public.company_accreditations`). */
export interface AccreditationRecord {
  source_id: number;
  source_uid: string | null;
  area: string | null;
  number: string | null;
  type_code: string | null;
  tin: string | null;
  inn: string | null;
  status: string | null;
  status_date: string | null;
  accreditation_date: string | null;
  re_accreditation_date: string | null;
  expiry_date: string | null;
  expiry_text: string | null;
  step: string | null;
  type_ownership: string | null;
  type_accredited: string | null;
  specific_to_finance: boolean | null;
  in_production: boolean | null;
  standard: string | null;
  type_std: unknown;
  directions: unknown;
  region_id: number | null;
  legal_entity_name: string | null;
  legal_entity_address: string | null;
  phone: string | null;
  email: string | null;
  web_site: string | null;
  unit_name: string | null;
  unit_address: string | null;
  is_fact_address: boolean | null;
  supervisor_name: string | null;
  supervisor_phone: string | null;
  supervisor_email: string | null;
  scope_text: string | null;
  certificate_url: string | null;
  scope_url: string | null;
  source_modified_at: string | null;
  content_hash: string;
  raw: AkkredEntry;
}

/**
 * The columns a refresh may replace, and so the ones whose old value goes to
 * `company_change_log` first. `raw`, the hash and the source's own
 * modification time are bookkeeping, not data a reader sees.
 */
export const ACCREDITATION_DATA_FIELDS = [
  'area',
  'number',
  'type_code',
  'tin',
  'inn',
  'status',
  'status_date',
  'accreditation_date',
  're_accreditation_date',
  'expiry_date',
  'expiry_text',
  'step',
  'type_ownership',
  'type_accredited',
  'specific_to_finance',
  'in_production',
  'standard',
  'type_std',
  'directions',
  'region_id',
  'legal_entity_name',
  'legal_entity_address',
  'phone',
  'email',
  'web_site',
  'unit_name',
  'unit_address',
  'is_fact_address',
  'supervisor_name',
  'supervisor_phone',
  'supervisor_email',
  'scope_text',
  'certificate_url',
  'scope_url',
] as const;

/**
 * Text as the register writes it, or null for nothing. The register fills an
 * empty field with "-" (a web site, an address); that is no value, not a value
 * of "-".
 */
export function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  return s === '' || s === '-' ? null : s;
}

/** A day as `YYYY-MM-DD`, or null. The register writes days that way. */
export function dayOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  // A day that does not exist (2026-02-30) is no day.
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== m[0]
    ? null
    : m[0];
}

const boolOf = (value: unknown): boolean | null =>
  typeof value === 'boolean' ? value : null;

const intOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isInteger(value) ? value : null;

/**
 * A list or object as sent, or null for nothing. An empty list is nothing
 * too: a refresh keeps the stored value over a blank (`COALESCE`), and `[]`
 * would otherwise replace the unit's directions with none.
 */
function jsonOf(value: unknown): unknown {
  if (Array.isArray(value)) return value.length ? value : null;
  return value && typeof value === 'object' ? value : null;
}

/**
 * The company's STIR, only when the register's TIN is one: nine digits. The
 * register also carries 1-, 8-, 10-, 11- and 14-digit values (8 of 823 on
 * 2026-10-10); tying those to a company would be a guess, so they stay in
 * `tin` alone.
 */
export function stirOf(tin: unknown): string | null {
  const s = textOf(tin);
  return s && /^\d{9}$/.test(s) ? s : null;
}

/**
 * The unit's kind from its registry number: `O'ZAK.SL.0001` → `SL`,
 * `O'ZAK.O'U.0001` → `O'U`. The apostrophe is written several ways in the
 * register's other fields; the code keeps the plain one.
 */
export function typeCodeOf(number: unknown): string | null {
  const s = textOf(number);
  if (!s) return null;
  const folded = s.replace(/[‘’ʻʼ`]/g, "'");
  const m = folded.match(/^O'?ZAK\.([^.]+)\.\d+$/i);
  return m ? m[1].toUpperCase() : null;
}

/** A timestamp the register sends with its own zone (`…+05:00`), kept as sent. */
function instantOf(value: unknown): string | null {
  const s = textOf(value);
  if (!s) return null;
  return Number.isNaN(Date.parse(s)) ? null : s;
}

/** Key-sorted JSON, so two copies of the same entry hash the same. */
function stableJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

/**
 * What an entry says, hashed. The source's `modified_date` is left out on
 * purpose: the register re-saved most of its entries on 2026-04-14 without
 * changing them, and a refresh must not call that a change.
 */
export function contentHashOf(
  record: Omit<
    AccreditationRecord,
    'content_hash' | 'raw' | 'source_modified_at'
  >,
): string {
  return createHash('sha1').update(stableJson(record)).digest('hex');
}

/**
 * What a refresh of a held unit writes: the fields the source sent with a
 * value — a blank keeps the stored one — and the two read off another field
 * whenever that field was sent. `inn` follows `tin` and `type_code` follows
 * `number`, so a TIN corrected to something that is not a STIR unties the
 * unit from the company rather than leaving it on the wrong one.
 */
export function sentValues(
  record: AccreditationRecord,
): Record<string, unknown> {
  const sent = presentOnly(record, ACCREDITATION_DATA_FIELDS);
  if (record.tin !== null) sent.inn = record.inn;
  if (record.number !== null) sent.type_code = record.type_code;
  return sent;
}

/** One register entry in our columns, or null when it has no id to key it by. */
export function mapAccreditation(
  entry: AkkredEntry,
): AccreditationRecord | null {
  if (!entry || !Number.isInteger(entry.id)) return null;

  const record: Omit<
    AccreditationRecord,
    'content_hash' | 'raw' | 'source_modified_at'
  > = {
    source_id: entry.id,
    source_uid: textOf(entry.uid),
    area: textOf(entry.area),
    number: textOf(entry.number),
    type_code: typeCodeOf(entry.number),
    tin: textOf(entry.tin),
    inn: stirOf(entry.tin),
    status: textOf(entry.status),
    status_date: dayOf(entry.status_date),
    accreditation_date: dayOf(entry.accreditation_date),
    re_accreditation_date: dayOf(entry.re_accreditation_date),
    expiry_date: dayOf(entry.accreditation_duration),
    expiry_text: textOf(entry.accreditation_duration_text),
    step: textOf(entry.step),
    type_ownership: textOf(entry.type_ownership),
    type_accredited: textOf(entry.type_accredited),
    specific_to_finance: boolOf(entry.specific_to_finance),
    in_production: boolOf(entry.in_production),
    standard: textOf(entry.designation_of_the_fundamental_standard),
    type_std: jsonOf(entry.type_std),
    directions: jsonOf(entry.directions),
    region_id: intOf(entry.region),
    legal_entity_name: textOf(entry.legal_entity_name),
    legal_entity_address: textOf(entry.legal_entity_address),
    phone: textOf(entry.phone),
    email: textOf(entry.email),
    web_site: textOf(entry.web_site),
    unit_name: textOf(entry.title_organ),
    unit_address: textOf(entry.address_organ),
    is_fact_address: boolOf(entry.is_fact_address),
    supervisor_name: textOf(entry.full_name_supervisor_ao),
    supervisor_phone: textOf(entry.phone_ao),
    supervisor_email: textOf(entry.email_ao),
    scope_text: textOf(entry.text),
    certificate_url: textOf(entry.certificate_pdf),
    // Two scope files: `file_scopes` is the current one and `file_oblast` the
    // older upload. akkred.uz shows `file_scopes ?? file_oblast`, so do we —
    // 531 entries had both on 2026-10-10, never the same file.
    scope_url: textOf(entry.file_scopes) ?? textOf(entry.file_oblast),
  };

  return {
    ...record,
    source_modified_at: instantOf(entry.modified_date),
    content_hash: contentHashOf(record),
    raw: entry,
  };
}
