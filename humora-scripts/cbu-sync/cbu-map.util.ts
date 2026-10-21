import { CbuCompanyData } from './cbu-api.service';
import { normalizeKfsCode } from '../../org/kfs';

/** Parse "DD.MM.YYYY" → ISO date string "YYYY-MM-DD", or null. */
export function parseCbuDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  if (!/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) return null;
  const [day, month, year] = raw.split('.');
  return `${year}-${month}-${day}`;
}

/** Join name parts, return null if all parts are empty. */
export function joinCbuName(
  last?: string | null,
  first?: string | null,
  middle?: string | null,
): string | null {
  const parts = [last, first, middle].filter((p) => p && p.trim());
  return parts.length > 0 ? parts.join(' ') : null;
}

/**
 * Map a CBU payload to `company_info` column changes.
 *
 * Null / undefined / empty-string values are skipped, so a missing CBU field
 * never overwrites stored data with a blank. Shared by the cbu-sync batch and
 * the live `syncCompanyInfo` path so both produce identical field mappings.
 */
/**
 * The company_info columns CBU writes.
 *
 * CBU is the authoritative source for these — it reads the state register
 * directly — so anything else that can produce the same column defers on it.
 * registr.stat.uz overlaps on six of them and fills them only where CBU has
 * left nothing, rather than competing and producing a history entry every time
 * the two render a name or an address slightly differently.
 *
 * Keep in step with `mapCbuToCompanyInfo` below; the spec beside this file
 * fails if they drift apart.
 */
export const CBU_OWNED_FIELDS = new Set<string>([
  'accountant',
  'accountant_pinfl',
  'avg_employees',
  'bank_account_number',
  'bank_code',
  'business_fund_currency',
  'business_structure',
  'company_name',
  'director_name',
  'director_pinfl',
  'director_tin',
  'kfs_code',
  'liquidation_date',
  'liquidation_reason',
  'oked_code',
  'registration_date',
  'reregistration_date',
  'short_name',
  'soogu_registrator',
  'street_address',
  'suspension_date',
  'suspension_reason',
  'tax_mode',
]);

export function mapCbuToCompanyInfo(data: CbuCompanyData): Record<string, any> {
  const changes: Record<string, any> = {};

  const set = (col: string, val: any) => {
    if (val !== null && val !== undefined && val !== '') {
      changes[col] = val;
    }
  };

  const c = data.company;
  const d = data.director;
  const a = data.accountant;
  const addr = data.companyBillingAddress;
  const bank = data.companyBanks?.[0] ?? null;

  set('company_name', c.name);
  set('short_name', c.shortName);
  set('oked_code', c.oked);
  set('registration_date', parseCbuDate(c.registrationDate));
  set('director_name', joinCbuName(d?.lastName, d?.firstName, d?.middleName));
  set('director_tin', d?.tin);
  set('director_pinfl', d?.pinfl);
  set('accountant', joinCbuName(a?.lastName, a?.firstName, a?.middleName));
  set('accountant_pinfl', a?.pinfl);
  set('street_address', addr?.streetName);
  set('bank_code', bank?.mfo);
  set('bank_account_number', bank?.paymentAccount);
  set('liquidation_date', parseCbuDate(c.liquidationDate));
  set('reregistration_date', parseCbuDate(c.reregistrationDate));
  set('avg_employees', data.companyExtraInfo?.avgNumberEmployees);

  // Extra scalar columns (docs/CBU.md — user decision).
  set('soogu_registrator', c.sooguRegistrator);
  // Form of ownership — three digits; src/org/kfs.ts names it.
  set('kfs_code', normalizeKfsCode(c.kfs));
  set('liquidation_reason', c.liquidationReason);
  set('suspension_date', parseCbuDate(c.suspensionDate));
  set('suspension_reason', c.suspensionReason);
  set('business_structure', c.businessStructure);
  set('business_fund_currency', c.businessFundCurrency);
  set('tax_mode', c.taxMode);
  set(
    'monthly_number_employees',
    data.companyExtraInfo?.monthlyNumberEmployees,
  );
  // activity_types is jsonb — stringify a non-empty array, skip otherwise.
  if (Array.isArray(c.activityTypes) && c.activityTypes.length > 0) {
    changes['activity_types'] = JSON.stringify(c.activityTypes);
  }

  return changes;
}
