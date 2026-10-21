import { CbuAddress, CbuCompanyData } from './cbu-api.service';
import { logRemoved } from '../../common/change-log';

/** One address's content, so a re-listed address is not logged as removed. */
function addressKey(type: string, parts: unknown[]): string {
  return [type, ...parts.map((p) => (p == null ? '' : String(p).trim()))].join(
    '|',
  );
}

/**
 * Minimal query runner — a TypeORM DataSource, EntityManager, or QueryRunner
 * all satisfy this, so the same persistence works inside the batch's
 * transaction and on the live sync's pooled connection.
 */
export interface AddressExec {
  query(sql: string, params?: any[]): Promise<any>;
}

/**
 * Replace a company's CBU-sourced billing + shipping addresses in
 * `company_addresses` (delete-and-reinsert of `source='cbu'` rows).
 *
 * No-op when CBU returns no addresses, so a previously-stored set is never
 * wiped to empty by an incomplete payload. Shared by the nightly batch
 * (`cbu-fill.syncAddresses`) and the live search (OrgService, on CBU sync) so
 * both stay in lock-step and a searched company's addresses refresh without
 * waiting for the batch.
 */
export async function persistCompanyAddresses(
  exec: AddressExec,
  inn: string,
  data: CbuCompanyData,
): Promise<void> {
  const rows: Array<{ addr: CbuAddress; type: 'billing' | 'shipping' }> = [];
  if (data.companyBillingAddress) {
    rows.push({ addr: data.companyBillingAddress, type: 'billing' });
  }
  for (const s of data.companyShippingAddresses ?? []) {
    if (s) rows.push({ addr: s, type: 'shipping' });
  }
  if (rows.length === 0) return;

  // An address CBU no longer lists is kept in the change log before the
  // delete-and-reinsert (common/change-log.ts); one it still lists is not.
  const stored: any[] = await exec.query(
    `SELECT * FROM public.company_addresses WHERE inn=$1 AND source='cbu'`,
    [inn],
  );
  const listed = new Set(
    rows.map(({ addr, type }) =>
      addressKey(type, [
        addr.countryCode,
        addr.sectorCode,
        addr.villageCode,
        addr.streetName,
        addr.house,
        addr.flat,
        addr.soato,
        addr.cadastreNumber,
        addr.postcode,
      ]),
    ),
  );
  for (const old of stored ?? []) {
    const key = addressKey(old.address_type, [
      old.country_code,
      old.sector_code,
      old.village_code,
      old.street_name,
      old.house,
      old.flat,
      old.soato,
      old.cadastre_number,
      old.postcode,
    ]);
    if (!listed.has(key)) {
      await logRemoved(
        exec,
        {
          entity: 'company_addresses',
          inn,
          key: old.address_type,
          source: 'cbu',
        },
        old,
      );
    }
  }

  await exec.query(
    `DELETE FROM public.company_addresses WHERE inn=$1 AND source='cbu'`,
    [inn],
  );
  for (const { addr, type } of rows) {
    await exec.query(
      `INSERT INTO public.company_addresses
         (inn, address_type, country_code, sector_code, village_code,
          street_name, house, flat, soato, cadastre_number, postcode, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'cbu')`,
      [
        inn,
        type,
        addr.countryCode ?? null,
        addr.sectorCode ?? null,
        addr.villageCode ?? null,
        addr.streetName ?? null,
        addr.house ?? null,
        addr.flat ?? null,
        addr.soato ?? null,
        addr.cadastreNumber ?? null,
        addr.postcode ?? null,
      ],
    );
  }
}
