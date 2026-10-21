/**
 * Maps one license.gov.uz record onto `company_licenses` columns.
 *
 * The registry returns every text field as an object keyed by language
 * (`uz`, `oz`, `ru`, `en`). The table's convention is that the bare column
 * holds Russian and `_uz` holds Uzbek, so that is what these pick out.
 */

import { tashkentMidnightIso } from '../../common/tashkent-time';

type Localised = Record<string, string> | null | undefined;

const ru = (v: Localised): string | null => v?.ru?.trim() || null;
const uz = (v: Localised): string | null => v?.uz?.trim() || null;
const en = (v: Localised): string | null => v?.en?.trim() || null;

/** "04.04.2026" → "2026-04-04". Empty strings are the registry's null. */
function parseDate(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

const text = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
};

const int = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};

export interface GovLicenseRow {
  inn: string;
  uuid: string | null;
  register_id: number | null;
  document_id: number | null;
  register_number: string | null;
  number: string | null;
  serial: string | null;
  doc_type: string | null;
  status_code: string | null;
  is_active: boolean | null;
  pin: string | null;
  title: string | null;
  title_uz: string | null;
  title_en: string | null;
  category: string | null;
  category_uz: string | null;
  category_en: string | null;
  region: string | null;
  region_uz: string | null;
  region_id: number | null;
  sub_region: string | null;
  sub_region_uz: string | null;
  sub_region_id: number | null;
  address: string | null;
  organization: string | null;
  organization_uz: string | null;
  organization_director: string | null;
  date_of_issue: string | null;
  validity: string | null;
  revoke_date: string | null;
  suspension_begin: string | null;
  suspension_end: string | null;
  specializations: string | null;
  activity_addresses: string | null;
}

export function mapGovLicense(inn: string, r: any): GovLicenseRow {
  return {
    inn,
    uuid: text(r?.uuid),
    register_id: int(r?.register_id),
    document_id: int(r?.document_id),
    register_number: text(r?.register_number),
    number: text(r?.number),
    serial: text(r?.serial),

    // PERMIT | LICENSE — kept as the registry's own word rather than mapped
    // onto myorg's integer codes, which mean something else entirely.
    doc_type: text(r?.type),
    status_code: text(r?.status?.status),
    is_active: typeof r?.active === 'boolean' ? r.active : null,

    // The owner's PINFL. For a sole trader this is the only link back to the
    // person, since their permits are filed against them and not a company.
    pin: text(r?.pin),

    // `document` is what the permit actually authorises — the closest thing the
    // registry has to a title, so it fills the title columns.
    title: ru(r?.document),
    title_uz: uz(r?.document),
    title_en: en(r?.document),

    category: ru(r?.category?.title),
    category_uz: uz(r?.category?.title),
    category_en: en(r?.category?.title),

    region: ru(r?.region),
    region_uz: uz(r?.region),
    region_id: int(r?.regionId),
    sub_region: ru(r?.subRegion),
    sub_region_uz: uz(r?.subRegion),
    sub_region_id: int(r?.subRegionId),
    address: text(r?.address),

    organization: ru(r?.organization),
    organization_uz: uz(r?.organization),
    organization_director:
      uz(r?.organization_director) ?? ru(r?.organization_director),

    // timestamptz columns: the day as Tashkent midnight. The other three are
    // `date` columns and take the day itself.
    date_of_issue: tashkentMidnightIso(parseDate(r?.registration_date)),
    validity: tashkentMidnightIso(parseDate(r?.expiry_date)),
    revoke_date: parseDate(r?.revoke_date),
    suspension_begin: parseDate(r?.suspension_begin),
    suspension_end: parseDate(r?.suspension_end),

    // Genuinely repeating structures: a permit can carry several
    // specialisations and be valid at several addresses.
    specializations:
      Array.isArray(r?.specializations) && r.specializations.length
        ? JSON.stringify(r.specializations)
        : null,
    activity_addresses:
      Array.isArray(r?.activity_addresses) && r.activity_addresses.length
        ? JSON.stringify(r.activity_addresses)
        : null,
  };
}
