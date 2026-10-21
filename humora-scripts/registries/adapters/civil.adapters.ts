import * as cheerio from 'cheerio';
import { RegistryHttp } from '../registry-http';
import { FetchResult, MapResult, RegistryAdapter } from '../registry-types';
import { dayOf, textOf } from '../registry-normalize';
import { entry, F, L, skip, stirOrSkip } from './adapter-kit';

// ---- Non-governmental non-profit organisations (e-ngo.uz) --------------------

export const NGO = 'https://e-ngo.uz';
const NGO_PAGE_SIZE = 500;

/**
 * The Ministry of Justice register of NGOs. The list answers only inside a
 * session the register page opens (a cookie) and only to an XHR. A row is an
 * array: `[n, name, STIR, territory, code, address]`; the register has no
 * status column, so a closed NGO shows only by leaving the list.
 */
export const ngoRegistration: RegistryAdapter = {
  meta: {
    code: 'ngo_registration',
    sector: 'ngo',
    kind: 'registration',
    title: L(
      'Nodavlat notijorat tashkiloti',
      'Негосударственная некоммерческая организация',
      'Non-governmental non-profit organisation',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      territory: L(
        'Faoliyat hududi',
        'Территория деятельности',
        'Area of activity',
      ),
      address: F.address,
    },
    minRows: 5000,
  },
  async fetchAll(http: RegistryHttp): Promise<FetchResult> {
    const page = await http.get<string>(`${NGO}/front/registry`, {
      responseType: 'text',
    });
    const setCookie = page.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.split(';')[0])
      .join('; ');
    const rows: unknown[] = [];
    let expected: number | null = null;
    for (let p = 0; ; p++) {
      if (http.spent) return { rows, complete: false, expected };
      const resp = await http.get(`${NGO}/front/registry_ajax`, {
        params: {
          page: p,
          size: NGO_PAGE_SIZE,
          name: '',
          tin: '',
          sort: 'id,desc',
        },
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${NGO}/front/registry`,
          ...(cookie ? { Cookie: cookie } : {}),
        },
      });
      const body = resp.data;
      if (!body || !Array.isArray(body.data)) {
        throw new Error(`e-ngo.uz page ${p} came without a list`);
      }
      if (p === 0) {
        expected = Number.isInteger(body.recordsTotal)
          ? body.recordsTotal
          : null;
      }
      rows.push(...body.data);
      if (body.data.length < NGO_PAGE_SIZE) break;
      if (expected !== null && rows.length >= expected) break;
      if (expected !== null && p > Math.ceil(expected / NGO_PAGE_SIZE) + 1) {
        throw new Error(`e-ngo.uz kept answering after ${p} pages`);
      }
    }
    return {
      rows,
      complete: expected === null || rows.length >= expected,
      expected,
    };
  },
  map(row: unknown): MapResult {
    const r = row as Record<string, unknown>;
    const ids = stirOrSkip(r['2']);
    if ('skip' in ids) return ids;
    const name = textOf(r['1']);
    if (!name) return skip('no name');
    return entry({
      sourceKey: ids.inn!,
      inn: ids.inn,
      name,
      fields: { territory: textOf(r['3']), address: textOf(r['5']) },
      raw: {
        name: r['1'],
        inn: r['2'],
        territory: r['3'],
        code: r['4'],
        address: r['5'],
      },
    });
  },
};

// ---- Advocacy entities (e-advokat.uz) -----------------------------------------

export const ADVOKAT_API = 'https://api.e-advokat.uz/api/v.1';
const ADVOKAT_PAGE_SIZE = 500;

/**
 * The Chamber of Advocates' register of advocacy firms, bureaus and
 * collegiums. The director's name, phone, e-mail and fax are left out;
 * `reOrganizedDate` is today's date on every row (not a date of anything).
 */
export const advocacyEntity: RegistryAdapter = {
  meta: {
    code: 'advocacy_entity',
    sector: 'professional',
    kind: 'registration',
    title: L(
      'Advokatlik tuzilmasi (firma, byuro, hay’at)',
      'Адвокатское образование (фирма, бюро, коллегия)',
      'Advocacy entity (firm, bureau, collegium)',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      entity_type: L('Turi', 'Вид', 'Type'),
      registry_number: F.registry_number,
      region: F.region,
      district: F.district,
      address: F.address,
    },
    minRows: 2500,
  },
  async fetchAll(http: RegistryHttp): Promise<FetchResult> {
    const rows: unknown[] = [];
    let expected: number | null = null;
    for (let page = 0; ; page++) {
      if (http.spent) return { rows, complete: false, expected };
      const resp = await http.post(
        `${ADVOKAT_API}/getInfo/contragentList`,
        { limit: ADVOKAT_PAGE_SIZE, page },
        {
          params: { search: '', isArchive: false, typeId: '', regionId: '' },
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
      );
      const body = resp.data;
      if (!body || !Array.isArray(body.list)) {
        throw new Error(`e-advokat.uz page ${page} came without a list`);
      }
      if (page === 0)
        expected = Number.isInteger(body.total) ? body.total : null;
      rows.push(...body.list);
      if (body.list.length < ADVOKAT_PAGE_SIZE) break;
      if (expected !== null && rows.length >= expected) break;
      if (
        expected !== null &&
        page > Math.ceil(expected / ADVOKAT_PAGE_SIZE) + 1
      ) {
        throw new Error(`e-advokat.uz kept answering after ${page} pages`);
      }
    }
    return {
      rows,
      complete: expected === null || rows.length >= expected,
      expected,
    };
  },
  map(row: unknown): MapResult {
    const r = row as Record<string, any>;
    const ids = stirOrSkip(r.inn);
    if ('skip' in ids) return ids;
    const name = textOf(r.name);
    if (!name) return skip('no name');
    const type = r.typeDto ?? {};
    const region = r.regionDto ?? {};
    const typeLabel =
      textOf(type.nameLt) && textOf(type.nameRu)
        ? L(
            textOf(type.nameLt)!,
            textOf(type.nameRu)!,
            textOf(type.nameEn) ?? textOf(type.nameLt)!,
          )
        : null;
    const district =
      textOf(region.nameLt) && textOf(region.nameRu)
        ? L(
            textOf(region.nameLt)!,
            textOf(region.nameRu)!,
            textOf(region.nameEn) ?? textOf(region.nameLt)!,
          )
        : null;
    const regionLabel =
      textOf(region.parentNameLt) && textOf(region.parentNameRu)
        ? L(
            textOf(region.parentNameLt)!,
            textOf(region.parentNameRu)!,
            textOf(region.parentNameEn) ?? textOf(region.parentNameLt)!,
          )
        : null;
    const number = textOf(r.registerNumber);
    return entry({
      sourceKey:
        r.id !== undefined && r.id !== null
          ? String(r.id)
          : `${ids.inn}:${number ?? ''}`,
      inn: ids.inn,
      name,
      number,
      fields: {
        entity_type: typeLabel,
        registry_number: number,
        region: regionLabel,
        district,
        address: textOf(r.address),
      },
      raw: {
        id: r.id,
        name: r.name,
        inn: r.inn,
        registerNumber: r.registerNumber,
        type: type.nameLt ?? null,
        region: region.parentNameLt ?? null,
        district: region.nameLt ?? null,
        soato: r.addressSoato ?? null,
        address: r.address ?? null,
      },
    });
  },
};

// ---- IT Park residents ---------------------------------------------------------

export const ITPARK_RESIDENTS =
  'https://www.it-park.uz/ru/itpark/residents/itpark-residents';

/** `[name, STIR, postal address, entry date]` per row of the residents table. */
export function parseItParkResidents(
  html: string,
): Array<Record<string, string | null>> {
  const $ = cheerio.load(html);
  const table = $('table').first();
  const header = table
    .find('tr')
    .first()
    .children('td,th')
    .map((_, c) => $(c).text().replace(/\s+/g, ' ').trim())
    .get();
  const col = (re: RegExp) => header.findIndex((h) => re.test(h));
  const at = {
    name: col(/юридическое лицо|наименование|nomi/i),
    inn: col(/^(инн|stir|inn)$/i),
    address: col(/почтовый адрес|адрес|manzil/i),
    date: col(/дата внесения|sana/i),
  };
  if (at.name < 0 || at.inn < 0) {
    throw new Error(
      'it-park.uz: the residents table has no name or STIR column',
    );
  }
  const rows: Array<Record<string, string | null>> = [];
  table
    .find('tr')
    .slice(1)
    .each((_, tr) => {
      // The row number is a header cell (`th`), the rest `td`.
      const cells = $(tr).children('td,th');
      const cell = (i: number) =>
        i < 0 ? null : textOf($(cells[i]).text().replace(/\s+/g, ' '));
      rows.push({
        name: cell(at.name),
        inn: cell(at.inn),
        address: cell(at.address),
        registered_on: cell(at.date),
      });
    });
  return rows;
}

export const itParkResident: RegistryAdapter = {
  meta: {
    code: 'itpark_resident',
    sector: 'it',
    kind: 'membership',
    title: L('IT Park rezidenti', 'Резидент IT Park', 'IT Park resident'),
    // Read once a day (user decision 2026-10-15): the company page's IT Park
    // mark and "since" day come from this copy (ItparkScriptService), so it
    // is not shown a second time among the registers.
    cadence: 'daily',
    display: false,
    fieldLabels: {
      registered_on: F.registered_on,
      address: F.address,
    },
    minRows: 2000,
  },
  async fetchAll(http: RegistryHttp): Promise<FetchResult> {
    const page = await http.get<string>(ITPARK_RESIDENTS, {
      responseType: 'text',
    });
    return {
      rows: parseItParkResidents(String(page.data)),
      complete: true,
      expected: null,
    };
  },
  map(row: unknown): MapResult {
    const r = row as Record<string, string | null>;
    const ids = stirOrSkip(r.inn);
    if ('skip' in ids) return ids;
    const day = dayOf(r.registered_on);
    return entry({
      sourceKey: ids.inn!,
      inn: ids.inn,
      name: r.name,
      validFrom: day,
      fields: { registered_on: day, address: r.address },
      raw: r,
    });
  },
};

export const CIVIL_ADAPTERS = [ngoRegistration, advocacyEntity, itParkResident];
