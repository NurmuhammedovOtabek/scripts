import { RegistryHttp } from '../registry-http';
import {
  FetchResult,
  Labels,
  MapResult,
  RegistryAdapter,
} from '../registry-types';
import { dayOf, nameKey, textOf } from '../registry-normalize';
import { entry, F, L, skip, stirOrSkip } from './adapter-kit';

/**
 * Pharmacy and drug-trade registers:
 *
 * - **GxP certificates** of the Pharmaceutical Agency — GPP (pharmacies), GDP
 *   (distributors), GMP (manufacturers). A Spring Data API, pages from 0.
 *   GPP and GDP share one list route and snake_case rows; GMP has its own
 *   route and camelCase rows.
 * - **Drug licences** of the drug-control inspectorate — manufacture,
 *   wholesale, retail. Django REST (`count`, `next`, `results`).
 *   `drugs/` on the same host is never read: its `inn` is the drug's
 *   international non-proprietary name, not a taxpayer number.
 */
export const GXP_API =
  'https://api.gxp-application.pharmagency.uz/gxp-application-api/v1';
export const UZPHARM_API = 'https://back.uzpharm-control.uz/api/v1';

const GXP_PAGE_SIZE = 500;
const UZPHARM_PAGE_SIZE = 100;

/** Every page of a Spring Data list; `complete` when the last page came. */
export async function fetchSpringPages(
  http: RegistryHttp,
  url: string,
  params: Record<string, string>,
): Promise<FetchResult> {
  const rows: unknown[] = [];
  let expected: number | null = null;
  for (let page = 0; ; page++) {
    if (http.spent) return { rows, complete: false, expected };
    const resp = await http.get(url, {
      params: { ...params, page, size: GXP_PAGE_SIZE },
      headers: { Accept: 'application/json' },
    });
    const body = resp.data;
    if (!body || !Array.isArray(body.content)) {
      throw new Error(`${url} page ${page} came without a list`);
    }
    if (page === 0 && Number.isInteger(body.totalElements)) {
      expected = body.totalElements;
    }
    rows.push(...body.content);
    if (body.last === true || body.content.length === 0) break;
    if (expected !== null && page > Math.ceil(expected / GXP_PAGE_SIZE) + 1) {
      throw new Error(`${url} kept answering after ${page} pages`);
    }
  }
  return {
    rows,
    complete: expected === null || rows.length >= expected,
    expected,
  };
}

/** Every page of a Django REST list, following `next`. */
export async function fetchDrfPages(
  http: RegistryHttp,
  url: string,
): Promise<FetchResult> {
  const rows: unknown[] = [];
  let expected: number | null = null;
  let edition: string | null = null;
  let next: string | null = `${url}?page_size=${UZPHARM_PAGE_SIZE}`;
  for (let page = 0; next; page++) {
    if (http.spent) return { rows, complete: false, expected };
    const resp = await http.get(next, {
      headers: { Accept: 'application/json' },
    });
    const body = resp.data;
    if (!body || !Array.isArray(body.results)) {
      throw new Error(`${url} page ${page + 1} came without a list`);
    }
    if (page === 0) {
      expected = Number.isInteger(body.count) ? body.count : null;
      edition = dayOf(body.registry_update_date);
    }
    rows.push(...body.results);
    next = typeof body.next === 'string' ? body.next : null;
    if (body.results.length === 0) break;
    if (expected !== null && page > Math.ceil(expected / 20) + 1) {
      throw new Error(`${url} kept answering after ${page} pages`);
    }
  }
  return {
    rows,
    complete: expected === null || rows.length >= expected,
    expected,
    editionDate: edition,
  };
}

const GXP_FIELDS = {
  branch_name: F.branch_name,
  branch_address: F.branch_address,
  standard: F.standard,
  last_inspection: L(
    'Oxirgi inspeksiya',
    'Последняя инспекция',
    'Last inspection',
  ),
  cadastre_number: L('Kadastr raqami', 'Кадастровый номер', 'Cadastre number'),
};

function gxpListAdapter(
  code: string,
  type: 'GPP' | 'GDP',
  title: Labels,
  minRows: number,
): RegistryAdapter {
  return {
    meta: {
      code,
      sector: 'pharma',
      kind: 'certificate',
      title,
      cadence: 'daily',
      display: true,
      fieldLabels: GXP_FIELDS,
      minRows,
    },
    fetchAll: (http) =>
      fetchSpringPages(http, `${GXP_API}/certificate/list`, { gxpType: type }),
    map(row: unknown): MapResult {
      const r = row as Record<string, any>;
      const ids = stirOrSkip(r.company_inn);
      if ('skip' in ids) return ids;
      const number = textOf(r.certificate_number) ?? textOf(r.certificate_id);
      if (!number) return skip('no certificate number');
      return entry({
        sourceKey: `${number}:${ids.inn}`,
        inn: ids.inn,
        name: textOf(r.company_name),
        number,
        validFrom: dayOf(r.start_date),
        validTo: dayOf(r.end_date),
        fields: {
          branch_name: textOf(r.branch_name),
          branch_address: textOf(r.branch_address),
          standard: textOf(r.certificate_area),
          last_inspection: dayOf(r.last_inspection_date),
          cadastre_number: textOf(r.cadastre_number),
        },
        raw: r,
      });
    },
  };
}

export const gmpCertificate: RegistryAdapter = {
  meta: {
    code: 'pharma_gmp',
    sector: 'pharma',
    kind: 'certificate',
    title: L(
      'GMP sertifikati (dori ishlab chiqarish)',
      'Сертификат GMP (производство лекарств)',
      'GMP certificate (drug manufacturing)',
    ),
    cadence: 'daily',
    display: true,
    fieldLabels: {
      branch_address: F.branch_address,
      standard: F.standard,
      scope: F.scope,
      last_inspection: GXP_FIELDS.last_inspection,
    },
    minRows: 70,
  },
  fetchAll: (http) => fetchSpringPages(http, `${GXP_API}/certificate/gmp`, {}),
  map(row: unknown): MapResult {
    const r = row as Record<string, any>;
    const ids = stirOrSkip(r.companyInn);
    if ('skip' in ids) return ids;
    const number = textOf(r.certificateId) ?? textOf(r.blankNumber);
    if (!number) return skip('no certificate number');
    return entry({
      sourceKey: `${number}:${ids.inn}`,
      inn: ids.inn,
      name: textOf(r.companyName),
      number,
      isActive: typeof r.isActive === 'boolean' ? r.isActive : null,
      validFrom: dayOf(r.startDate),
      validTo: dayOf(r.endDate),
      fields: {
        branch_address: textOf(r.objectAddress) ?? textOf(r.companyAddress),
        standard: textOf(r.certificateArea),
        scope: textOf(r.usageArea),
        last_inspection: dayOf(r.lastInspectionDate),
      },
      raw: r,
    });
  },
};

function drugLicenceAdapter(
  code: string,
  path: string,
  title: Labels,
  minRows: number,
): RegistryAdapter {
  return {
    meta: {
      code,
      sector: 'pharma',
      kind: 'licence',
      title,
      cadence: 'weekly',
      display: true,
      fieldLabels: {
        activity: F.activity,
        activity_address: F.activity_address,
        legal_address: F.legal_address,
        registry_number: F.registry_number,
        region: F.region,
      },
      minRows,
    },
    fetchAll: (http) => fetchDrfPages(http, `${UZPHARM_API}/${path}/`),
    map(row: unknown): MapResult {
      const r = row as Record<string, any>;
      const ids = stirOrSkip(r.inn);
      if ('skip' in ids) return ids;
      const number = textOf(r.license_number);
      const registry = textOf(r.registry_number);
      if (!number && !registry) return skip('no licence number');
      const active =
        r.is_active === true || r.is_active === 'True'
          ? true
          : r.is_active === false || r.is_active === 'False'
            ? false
            : null;
      // One licence covers every place it lists; the place tells them apart.
      const place = nameKey(textOf(r.activity_address)) ?? String(r.id ?? '');
      // `updated_at` moves on every save at the source, changed or not.
      const kept = { ...r };
      delete kept.updated_at;
      return entry({
        sourceKey: `${registry ?? number}:${place}`,
        inn: ids.inn,
        name: textOf(r.organization_name),
        number: number ?? registry,
        isActive: active,
        validFrom: dayOf(r.issue_date),
        validTo: dayOf(r.expiry_date),
        fields: {
          activity: textOf(r.activity_status),
          activity_address: textOf(r.activity_address),
          legal_address: textOf(r.legal_address),
          registry_number: registry,
          region: textOf(r.region),
        },
        raw: kept,
      });
    },
  };
}

export const PHARMA_ADAPTERS: RegistryAdapter[] = [
  gxpListAdapter(
    'pharma_gpp',
    'GPP',
    L(
      'GPP sertifikati (dorixona amaliyoti)',
      'Сертификат GPP (аптечная практика)',
      'GPP certificate (pharmacy practice)',
    ),
    7000,
  ),
  gxpListAdapter(
    'pharma_gdp',
    'GDP',
    L(
      'GDP sertifikati (dori distributsiyasi)',
      'Сертификат GDP (дистрибуция лекарств)',
      'GDP certificate (drug distribution)',
    ),
    50,
  ),
  gmpCertificate,
  drugLicenceAdapter(
    'pharma_licence_manufacture',
    'drug-manufacturers',
    L(
      'Dori vositalarini ishlab chiqarish litsenziyasi',
      'Лицензия на производство лекарственных средств',
      'Drug manufacturing licence',
    ),
    30,
  ),
  drugLicenceAdapter(
    'pharma_licence_wholesale',
    'wholesale-drugs',
    L(
      'Dori vositalarini ulgurji savdo litsenziyasi',
      'Лицензия на оптовую торговлю лекарственными средствами',
      'Wholesale drug trade licence',
    ),
    200,
  ),
  drugLicenceAdapter(
    'pharma_licence_retail',
    'retail-drugs',
    L(
      'Dori vositalarini chakana savdo litsenziyasi (dorixona)',
      'Лицензия на розничную торговлю лекарственными средствами (аптека)',
      'Retail drug trade licence (pharmacy)',
    ),
    4000,
  ),
];
