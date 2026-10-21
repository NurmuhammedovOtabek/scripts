import { createHash } from 'crypto';
import { parseSourceDay, sourceTimeIso } from '../../common/tashkent-time';

/** An organisation as the portal lists it (`organizations/organizations/`). */
export interface OiOrganization {
  id: number;
  inn: number | string | null;
  full_name_text?: string | null;
  short_name_text?: string | null;
  exchange_ticket_name?: string | null;
  is_listing?: boolean | null;
  listing_date?: string | null;
  [key: string]: unknown;
}

/** A fact as the list gives it (`disclosure/facts/`). */
export interface OiFactListItem {
  id: number;
  organization: number;
  fact_number: number | string;
  object_id?: number | null;
  fact_title?: string | null;
  fact_short_title?: string | null;
  pub_date?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

/** `disclosure/facts/{id}/`: the organisation and the fact, one each. */
export interface OiFactDetailResponse {
  id: number;
  organization?: unknown[];
  fact?: Array<Record<string, unknown>>;
}

/** `reports/accounting-report/{org}/`: one entry per period. */
export interface OiAccountingReport {
  id: number;
  reporting_year: number;
  period?: string | null;
  accounting_report: Array<Record<string, unknown>>;
}

export interface OrganizationRow {
  org_id: number;
  inn: string | null;
  full_name: string | null;
  short_name: string | null;
  ticker: string | null;
  is_listing: boolean | null;
  listing_date: string | null;
  raw: Record<string, unknown>;
  content_hash: string;
}

export interface FactListRow {
  id: number;
  org_id: number;
  fact_number: number;
  object_id: number | null;
  title: string | null;
  short_title: string | null;
  pub_date: string | null;
  status: string | null;
  list_raw: Record<string, unknown>;
}

/** Per-reader fields of the organisation record — not the organisation's. */
const ORG_VOLATILE = new Set(['is_subscribed', 'subscription_id']);

function stable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as object)
        .sort()
        .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
    );
  }
  return v;
}

export function contentHash(value: unknown): string {
  return createHash('sha1')
    .update(JSON.stringify(stable(value)))
    .digest('hex');
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

/**
 * A company STIR: nine digits. The portal stores it as a number, so it never
 * keeps a leading zero — and no company STIR starts with one. Anything else
 * (a missing value, a PINFL, a short number) ties the record to no company.
 */
export function stirOf(v: unknown): string | null {
  const s = text(v);
  return s && /^\d{9}$/.test(s) ? s : null;
}

export function mapOrganization(raw: OiOrganization): OrganizationRow {
  const kept = Object.fromEntries(
    Object.entries(raw).filter(([k]) => !ORG_VOLATILE.has(k)),
  );
  return {
    org_id: Number(raw.id),
    inn: stirOf(raw.inn),
    full_name: text(raw.full_name_text),
    short_name: text(raw.short_name_text),
    ticker: text(raw.exchange_ticket_name),
    is_listing: typeof raw.is_listing === 'boolean' ? raw.is_listing : null,
    listing_date: parseSourceDay(raw.listing_date),
    raw: kept,
    content_hash: contentHash(kept),
  };
}

export function mapFactListItem(raw: OiFactListItem): FactListRow | null {
  const id = Number(raw.id);
  const orgId = Number(raw.organization);
  const number = Number(raw.fact_number);
  if (!Number.isInteger(id) || !Number.isInteger(orgId)) return null;
  if (!Number.isInteger(number) || number <= 0) return null;
  return {
    id,
    org_id: orgId,
    fact_number: number,
    // `Number(null)` is 0: a fact with no object was stored as object 0.
    object_id:
      raw.object_id != null &&
      String(raw.object_id).trim() !== '' &&
      Number.isInteger(Number(raw.object_id))
        ? Number(raw.object_id)
        : null,
    title: text(raw.fact_title),
    short_title: text(raw.fact_short_title),
    // The portal writes Tashkent's clock without a zone.
    pub_date: sourceTimeIso(raw.pub_date),
    status: text(raw.status),
    list_raw: raw as Record<string, unknown>,
  };
}

/**
 * The fact's own content: the detail's `fact[0]` without the organisation it
 * repeats (`organization`, `organization_*`, `org_*` — kept once, in
 * `openinfo_organizations`). Null when the answer carries no fact.
 */
export function factContentOf(
  body: OiFactDetailResponse | null,
): Record<string, unknown> | null {
  const fact = body?.fact?.[0];
  if (!fact || typeof fact !== 'object') return null;
  return Object.fromEntries(
    Object.entries(fact).filter(
      ([k]) =>
        k !== 'organization' &&
        !k.startsWith('organization_') &&
        !k.startsWith('org_'),
    ),
  );
}

/**
 * An amount as the portal writes it: a number, `"334700000.00"`, or
 * `"503 395 875,00"` (spaces between thousands, a decimal comma). With both a
 * dot and a comma the last one is the decimal mark. Anything else — words, two
 * decimal marks of one kind — is null: a misread amount is worse than none.
 */
export function parseAmount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.replace(/[\s  ]/g, '');
  if (!s) return null;
  const dot = s.lastIndexOf('.');
  const comma = s.lastIndexOf(',');
  if (dot !== -1 && comma !== -1) {
    const decimal = dot > comma ? '.' : ',';
    const group = decimal === '.' ? ',' : '.';
    s = s.split(group).join('');
    if (decimal === ',') s = s.replace(',', '.');
  } else if (comma !== -1) {
    s = s.replace(',', '.');
  }
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * One annual statement's lines, in the order the portal gives them: the line
 * code and title, and the values (form 1: start and end of the year; form 2:
 * the year's value). Thousand so'm, as the portal states on every statement.
 */
export function reportLines(
  report: OiAccountingReport,
): Array<Record<string, unknown>> {
  return (report.accounting_report ?? []).map((line) => ({
    // The statement's line code (form 1; `000` on headings). `title_id` is
    // the portal's own id, not a line code.
    code: text(line.tnum) === '000' ? null : text(line.tnum),
    title: text(line.title),
    start: typeof line.value1 === 'number' ? line.value1 : null,
    end: typeof line.value2 === 'number' ? line.value2 : null,
    value: typeof line.value === 'number' ? line.value : null,
    is_title: line.is_title === true,
    is_highlight: line.is_highlight === true,
  }));
}
