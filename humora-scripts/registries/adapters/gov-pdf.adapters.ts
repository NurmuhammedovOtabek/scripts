import {
  downloadPdf,
  editionDayOf,
  GovDocument,
  govSection,
  newestFile,
  uploadDay,
} from '../gov-portal';
import { TableRow, TableSpec } from '../pdf-table';
import { PdfTableLayout, readPdfTable } from '../pdf-worker';
import { RegistryHttp } from '../registry-http';
import {
  dayOf,
  digitsOf,
  looksLikeOrganisation,
  numberOf,
  quarterOf,
  taxpayerOf,
  textOf,
} from '../registry-normalize';
import {
  FetchResult,
  Labels,
  MapResult,
  RegistryAdapter,
  RegistryMeta,
} from '../registry-types';
import {
  companyName,
  entry,
  F,
  L,
  personKey,
  skip,
  stirOrSkip,
} from './adapter-kit';

/**
 * Registers ministries publish only as PDF tables on gov.uz: the adapter
 * finds the newest file of the register's document (`gov-portal.ts`), reads
 * its table by the ruling lines (`pdf-table.ts`) and maps the rows. A column
 * that names a person (heads, auditors, applicants, contacts) is never read
 * out of the table — the specs below do not name it.
 */

/** The table of each register, by its header words. */
export const PDF_SPECS = {
  audit: {
    anchor: 'no',
    columns: [
      { key: 'no', header: /№/ },
      { key: 'name', header: /tashkilotining nomi/i },
      { key: 'included', header: /kiritish sanasi/i },
      { key: 'excluded', header: /chiqarish asosi/i },
      { key: 'address', header: /pochta manzili/i },
      { key: 'stir', header: /^\s*STIR\s*$/i },
      { key: 'certificates', header: /Auditorlar.*malaka/i },
    ],
  },
  pie: {
    anchor: 'no',
    columns: [
      { key: 'no', header: /T\/r/i },
      { key: 'name', header: /Tashkilot nomi/i },
      { key: 'year', header: /kiritilgan yili/i },
      { key: 'criteria', header: /mezon/i },
      { key: 'form', header: /huquqiy shakli/i },
      { key: 'stir', header: /^\s*STIR\s*$/i },
      { key: 'region', header: /hududi/i },
    ],
  },
  accommodation: {
    anchor: 'no',
    columns: [
      { key: 'no', header: /^\s*№\s*$/ },
      { key: 'region', header: /^\s*Hudud\s*$/i },
      { key: 'name', header: /Yuridik shaxs nomi/i },
      { key: 'stir', header: /^\s*STIR\s*$/i },
      { key: 'legal_address', header: /Yuridik manzil/i },
      { key: 'blank', header: /Blank raqami/i },
      { key: 'certificate', header: /ro.yxatidan o.tgan/i },
      { key: 'issued', header: /Berilgan sana/i },
      { key: 'valid_to', header: /Amal qilish muddati/i },
      { key: 'district', header: /^\s*Tuman\s*$/i },
      { key: 'site_address', header: /vositasi manzili/i },
      { key: 'site_name', header: /Nomi/ },
      { key: 'site_type', header: /^\s*turi\s*$/i },
      { key: 'rooms', header: /Nomer\s*$/i },
      { key: 'beds', header: /O.rin/i },
      { key: 'stars', header: /Toifa/i },
      { key: 'opened', header: /topshirilgan yil/i },
    ],
  },
  hostel: {
    anchor: 'no',
    columns: [
      { key: 'no', header: /^\s*№\s*$/ },
      { key: 'region', header: /Ҳудуд/i },
      { key: 'subject', header: /тадбиркорлик субъекти/i },
      { key: 'name', header: /хостел номи/i },
      { key: 'stir', header: /^\s*стир\s*$/i },
      { key: 'district', header: /туман номи/i },
      { key: 'address', header: /хостел манзили/i },
      { key: 'registry_no', header: /реестр рақами/i },
      { key: 'registered_on', header: /киритилган сана/i },
      { key: 'rooms', header: /Хоналар/i },
      { key: 'beds', header: /Ўринлар/i },
      { key: 'jobs', header: /иш ўринлари/i },
    ],
  },
  medical: {
    anchor: 'no',
    columns: [
      { key: 'no', header: /^\s*№\s*$/ },
      { key: 'name', header: /Объекти номи/i },
      { key: 'stir_reg', header: /СТИР/i },
      { key: 'address', header: /Юридик манзили/i },
    ],
  },
  sanepid: {
    // Rows are told by the application number each product row carries: the
    // number and name columns are merged over an application's rows.
    anchor: 'application_no',
    columns: [
      { key: 'no', header: /^\s*№\s*$/ },
      { key: 'applicant', header: /Наименование заявител/i },
      { key: 'applicant_inn', header: /ИНН заявител/i },
      { key: 'importer', header: /Наименование импорт/i },
      { key: 'importer_inn', header: /ИНН импорт/i },
      { key: 'exporter', header: /Наименование экспорт/i },
      { key: 'exporter_inn', header: /ИНН экспорт/i },
      { key: 'application_no', header: /Номер заявки/i },
      { key: 'application_date', header: /Дата заявлени/i },
      // One product and its code per row: never spread over a merged cell.
      { key: 'product', header: /Наименование продукци/i, ownRow: true },
      { key: 'hs_code', header: /ТН ВЭД/i, ownRow: true },
      { key: 'direction', header: /Направлени/i },
      { key: 'permit_no', header: /Номер разрешени/i },
      { key: 'permit_date', header: /Дата разрешени/i },
      // "Статус" holds the system's numeric code; the words — approved,
      // under review, received, or why not — are under "Причина".
      { key: 'status_code', header: /Статус/i },
      { key: 'outcome', header: /Причин/i },
    ],
  },
  // Sanepid, 2026 Q1: one row per conclusion, its products listed in one
  // cell; the seven columns after the issuing office share one header cell.
  sanepidConclusions: {
    anchor: 'no',
    columns: [
      { key: 'no', header: /Т\/р/ },
      { key: 'applicant', header: /ХЮС номи/i },
      { key: 'applicant_inn', header: /ХЮС СТИРи/i },
      { key: 'product', header: /Маҳсулот номи/i },
      { key: 'country', header: /Ишлаб чиқарувчи давлат/i },
      { key: 'permit_no', header: /хулоса рақами/i },
      { key: 'permit_date', header: /берилган вақти/i },
      { key: 'validity', header: /амал қилиш муддати/i },
      { key: 'shortfall', header: /жавоб бермаслиги/i },
    ],
  },
  // Sanepid, 2025 Q1: no lines at all; columns by their titles, rows by the
  // row number. The "Исполнитель" column (a person) is not read.
  sanepidCertificates: {
    anchor: 'no',
    columns: [
      { key: 'no', header: /^\s*№\s*$/ },
      { key: 'certificate', header: /Серти/i },
      { key: 'issued', header: /Дата/i },
      { key: 'valid_to', header: /рок/i },
      { key: 'organisation', header: /Назван|организац/i },
      { key: 'product', header: /Товар/i },
      { key: 'country', header: /Страна/i },
      { key: 'inn', header: /И\s*Н\s*Н/ },
    ],
  },
} satisfies Record<string, TableSpec>;

interface GovSource {
  authority: string;
  section: string;
  /** The document that carries the register (its id on gov.uz). */
  documentId: number;
  /**
   * Files of earlier editions known to be readable, used when the document
   * offers none (the portal refuses its XLSX files to scripts).
   */
  fallback?: string[];
}

/** The newest readable PDF of the register's document, downloaded. */
async function registerPdf(
  http: RegistryHttp,
  source: GovSource,
): Promise<{ url: string; data: Buffer }> {
  const docs = await govSection(http, source.authority, source.section);
  const doc = docs.find((d) => d.id === source.documentId);
  if (!doc) {
    throw new Error(
      `gov.uz ${source.authority}/${source.section} no longer lists document ${source.documentId}`,
    );
  }
  const url = newestFile([...doc.pdfs, ...(source.fallback ?? [])]);
  if (!url) {
    throw new Error(
      `gov.uz document ${doc.id} "${doc.title}" offers no PDF` +
        (doc.others.length ? ` (only ${doc.others.length} other file(s))` : ''),
    );
  }
  return { url, data: await downloadPdf(http, url) };
}

/** The register's own "as of" day if its first page prints one, else the upload day. */
function editionOf(firstPageText: string, url: string): string | null {
  return editionDayOf(firstPageText) ?? uploadDay(url);
}

function govPdfAdapter(
  meta: RegistryMeta,
  source: GovSource,
  spec: TableSpec,
  map: (row: TableRow, editionDate: string | null) => MapResult,
): RegistryAdapter {
  return {
    meta,
    async fetchAll(http: RegistryHttp): Promise<FetchResult> {
      const { url, data } = await registerPdf(http, source);
      // Read on a worker thread: pdfjs would hold the API's event loop.
      const read = await readPdfTable(data, { layouts: [{ spec }] });
      const rows = read.rows;
      const editionDate = editionOf(read.firstPageText, url);
      return {
        rows: rows.map((r) => ({ ...r, __edition: editionDate })),
        files: [{ url, day: uploadDay(url), data }],
        complete: rows.length > 0,
        expected: null,
        editionDate,
      };
    },
    map: (row) => {
      const r = row as TableRow & { __edition?: string | null };
      return map(r, r.__edition ?? null);
    },
  };
}

const oneLine = (v: string | undefined) =>
  textOf((v ?? '').replace(/\n/g, ' '));
/**
 * The STIR of a cell. A PDF may space it out ("309 007 505"), and a row cut
 * by a page break repeats it on a second line.
 */
export const stirIn = (v: string | undefined) => {
  const lines = (v ?? '').split('\n').map((l) => l.replace(/[\s\u00a0]/g, ''));
  for (const line of lines) {
    const m = /(?<!\d)([23456]\d{8})(?!\d)/.exec(line);
    if (m) return m[1];
  }
  return digitsOf(lines[0] ?? '');
};
const count = (v: string | undefined) => {
  const n = numberOf((v ?? '').replace(/\s/g, ''));
  return n === null ? null : Math.round(n);
};

// ---- Audit firms (Ministry of Economy and Finance) -----------------------------

export const auditFirm = govPdfAdapter(
  {
    code: 'audit_firm',
    sector: 'professional',
    kind: 'registration',
    title: L(
      'Auditorlik tashkilotlari reyestri',
      'Реестр аудиторских организаций',
      'Register of audit firms',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      included_on: L(
        'Reyestrga kiritilgan',
        'Включена в реестр',
        'Entered in the register',
      ),
      excluded: L(
        'Reyestrdan chiqarilgan (asos, sana)',
        'Исключена из реестра (основание, дата)',
        'Removed from the register (grounds, date)',
      ),
      auditors: L(
        'Malaka sertifikatli auditorlar',
        'Аудиторы с квалификационным сертификатом',
        'Certified auditors',
      ),
      address: F.address,
    },
    minRows: 100,
  },
  {
    authority: 'imv',
    section: 'buxgalteriya-hisobi-va-audit-uslubiyoti-boshqarmasi',
    documentId: 111717,
    // The 31.12.2025 edition as PDF; the document now links an XLSX of the
    // same edition, which the portal refuses to scripts.
    fallback: [
      'https://api-portal.gov.uz/uploads/3/2026/02/09/b631111e-5770-fa78-3e72-676f3c0ef040_media_.pdf',
    ],
  },
  PDF_SPECS.audit,
  (r, edition) => {
    const ids = stirOrSkip(stirIn(r.stir));
    if ('skip' in ids) return ids;
    const excluded = oneLine(r.excluded);
    const included = dayOf(oneLine(r.included));
    // Each certified auditor is one certificate line ("№ 05392 11.06.2020").
    const auditors = (r.certificates ?? '').match(/№\s*\d+/g)?.length ?? null;
    return entry({
      sourceKey: ids.inn!,
      inn: ids.inn,
      name: oneLine(r.name),
      status: excluded ? 'withdrawn' : 'active',
      isActive: !excluded,
      validFrom: included,
      fields: {
        included_on: included,
        excluded,
        auditors,
        address: oneLine(r.address),
      },
      raw: {
        name: r.name,
        included: r.included,
        excluded: r.excluded,
        address: r.address,
        stir: r.stir,
        auditors,
      },
      asOf: edition,
    });
  },
);

// ---- Public interest entities (MoEF) -------------------------------------------

export const publicInterestEntity = govPdfAdapter(
  {
    code: 'public_interest_entity',
    sector: 'finance',
    kind: 'status',
    title: L(
      'Jamoat ahamiyatiga ega tashkilot (PIE)',
      'Организация, представляющая общественный интерес (PIE)',
      'Public interest entity (PIE)',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      year: L(
        'Reyestrga kiritilgan yil',
        'Год включения в реестр',
        'Year entered',
      ),
      included_on: L(
        'Reyestrga kiritilgan',
        'Включена в реестр',
        'Entered in the register',
      ),
      criteria: L('Mezon', 'Критерий', 'Criterion'),
      legal_form: L(
        'Tashkiliy-huquqiy shakli',
        'Организационно-правовая форма',
        'Legal form',
      ),
      region: F.region,
    },
    minRows: 200,
  },
  {
    authority: 'imv',
    section: 'moliyaviy-hisobotning-xalqaro-standartlari-mhxs',
    documentId: 121389,
    fallback: [
      'https://api-portal.gov.uz/uploads/3/2026/06/25/84710afe-d58f-fc76-9dfc-df5b5914aabc_media_.pdf',
    ],
  },
  PDF_SPECS.pie,
  (r, edition) => {
    const ids = stirOrSkip(stirIn(r.stir));
    if ('skip' in ids) return ids;
    // The year entered, or (from the October 2026 edition) the day.
    const entered = oneLine(r.year);
    const yearText = /(?<!\d)(20\d{2})(?!\d)/.exec(entered)?.[1];
    const year = yearText ? Number(yearText) : null;
    const included = /\d{1,2}\.\d{1,2}\.\d{4}/.test(entered)
      ? dayOf(entered)
      : null;
    // Criteria codes, however the cell runs them together ("M1M6").
    const codes = oneLine(r.criteria).match(/M\d+/g);
    return entry({
      sourceKey: `${ids.inn}:${year ?? ''}`,
      inn: ids.inn,
      name: oneLine(r.name),
      validFrom: included,
      fields: {
        year,
        included_on: included,
        criteria: codes ? codes.join(', ') : oneLine(r.criteria),
        legal_form: oneLine(r.form),
        region: oneLine(r.region),
      },
      raw: {
        name: r.name,
        year: r.year,
        criteria: r.criteria,
        form: r.form,
        stir: r.stir,
        region: r.region,
      },
      asOf: edition,
    });
  },
);

// ---- Accommodation with a conformity certificate (Tourism Committee) ------------

export const tourismAccommodation = govPdfAdapter(
  {
    code: 'tourism_accommodation',
    sector: 'tourism',
    kind: 'certificate',
    title: L(
      'Joylashtirish vositasi (toifa, xonalar)',
      'Средство размещения (категория, номера)',
      'Accommodation (category, rooms)',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      site_name: F.branch_name,
      site_type: L('Turi', 'Тип', 'Type'),
      stars: L('Toifa (yulduz)', 'Категория (звёзды)', 'Category (stars)'),
      rooms: L('Nomerlar', 'Номера', 'Rooms'),
      beds: L('O‘rinlar', 'Места', 'Beds'),
      opened: L(
        'Foydalanishga topshirilgan yil',
        'Год ввода в эксплуатацию',
        'Opened in',
      ),
      site_address: F.branch_address,
      district: F.district,
      region: F.region,
      blank: L('Blank raqami', 'Номер бланка', 'Form number'),
    },
    minRows: 500,
  },
  {
    authority: 'uzbektourism',
    section: 'oilaviy-mehmon-uylari-reyestri',
    documentId: 208214,
  },
  PDF_SPECS.accommodation,
  (r, edition) => {
    const ids = stirOrSkip(stirIn(r.stir));
    if ('skip' in ids) return ids;
    const certificate = oneLine(r.certificate);
    const site = oneLine(r.site_name);
    if (!certificate) return skip('no certificate number');
    return entry({
      sourceKey: `${certificate}:${ids.inn}:${site ?? ''}`,
      inn: ids.inn,
      name: oneLine(r.name),
      number: certificate,
      validFrom: dayOf(oneLine(r.issued)),
      validTo: dayOf(oneLine(r.valid_to)),
      fields: {
        site_name: site,
        site_type: oneLine(r.site_type),
        stars: count(r.stars),
        rooms: count(r.rooms),
        beds: count(r.beds),
        opened: count(r.opened),
        site_address: oneLine(r.site_address),
        district: oneLine(r.district),
        region: oneLine(r.region),
        blank: oneLine(r.blank),
      },
      // The phone column is not read.
      raw: Object.fromEntries(
        Object.entries(r).filter(([k]) => k !== '__edition'),
      ),
      asOf: edition,
    });
  },
);

// ---- Hostels (Tourism Committee) ------------------------------------------------

export const hostelRegistration = govPdfAdapter(
  {
    code: 'hostel_registration',
    sector: 'tourism',
    kind: 'registration',
    title: L(
      'Xostellar yagona reyestri',
      'Единый реестр хостелов',
      'Unified register of hostels',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      hostel: L('Xostel', 'Хостел', 'Hostel'),
      registry_no: F.registry_number,
      registered_on: F.registered_on,
      rooms: L('Xonalar', 'Номера', 'Rooms'),
      beds: L('O‘rinlar', 'Места', 'Beds'),
      jobs: L(
        'Yaratilgan ish o‘rinlari',
        'Созданные рабочие места',
        'Jobs created',
      ),
      address: F.address,
      district: F.district,
      region: F.region,
    },
    minRows: 300,
  },
  {
    authority: 'uzbektourism',
    section: 'oilaviy-mehmon-uylari-reyestri',
    documentId: 208212,
  },
  PDF_SPECS.hostel,
  (r, edition) => {
    // A person registers a hostel under their PINFL: kept for their trader
    // page, keyed so the PINFL reaches no key, without their name or street.
    const ids = taxpayerOf(stirIn(r.stir));
    if (!ids.inn && !ids.pinfl) {
      return skip(ids.rawTin ? 'taxpayer number not a STIR' : 'no STIR');
    }
    const person = !ids.inn;
    const registry = oneLine(r.registry_no);
    const hostel = oneLine(r.name);
    const registered = dayOf(oneLine(r.registered_on));
    return entry({
      sourceKey: `${registry ?? ''}:${ids.inn ?? personKey(ids.pinfl!)}:${hostel ?? ''}`,
      inn: ids.inn,
      pinfl: ids.pinfl,
      name: companyName(ids.inn, oneLine(r.subject)),
      number: registry,
      validFrom: registered,
      fields: {
        hostel,
        registry_no: registry,
        registered_on: registered,
        rooms: count(r.rooms),
        beds: count(r.beds),
        jobs: count(r.jobs),
        address: person ? null : oneLine(r.address),
        district: oneLine(r.district),
        region: oneLine(r.region),
      },
      // The applicant's name, phone and e-mail are not read; a person's
      // PINFL, name and street are not kept.
      raw: Object.fromEntries(
        Object.entries(r).filter(
          ([k]) =>
            k !== '__edition' &&
            !(person && ['stir', 'subject', 'address'].includes(k)),
        ),
      ),
      asOf: edition,
    });
  },
);

// ---- Medical and wellness institutions (Tourism Committee) ---------------------

export const medicalWellness = govPdfAdapter(
  {
    code: 'medical_wellness_institution',
    sector: 'tourism',
    kind: 'registration',
    title: L(
      'Tibbiyot va sog‘lomlashtirish muassasalari reyestri',
      'Реестр медицинских и оздоровительных учреждений',
      'Register of medical and wellness institutions',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      site_name: L('Obyekt', 'Объект', 'Facility'),
      state_registration: L(
        'Davlat ro‘yxatidan o‘tgan raqami',
        'Номер государственной регистрации',
        'State registration number',
      ),
      address: F.legal_address,
    },
    minRows: 300,
  },
  {
    authority: 'uzbektourism',
    section: 'oilaviy-mehmon-uylari-reyestri',
    documentId: 208229,
  },
  PDF_SPECS.medical,
  (r, edition) => {
    const stir = stirIn(r.stir_reg);
    const ids = stirOrSkip(stir);
    if ('skip' in ids) return ids;
    // The cell holds the STIR and the state registration number together.
    const registration =
      oneLine((r.stir_reg ?? '').replace(stir ?? '', ''))?.replace(
        /^[\s,;:-]+|[\s,;:-]+$/g,
        '',
      ) || null;
    const site = oneLine(r.name);
    return entry({
      sourceKey: `${ids.inn}:${site ?? ''}`,
      inn: ids.inn,
      fields: {
        site_name: site,
        state_registration: registration,
        address: oneLine(r.address),
      },
      // The responsible person, phone and e-mail are not read.
      raw: { name: r.name, stir_reg: r.stir_reg, address: r.address },
      asOf: edition,
    });
  },
);

// ---- Sanitary-epidemiological conclusions (quarterly files) --------------------

/** "Импорт" or "Экспорт" — a merged cell can repeat it; both is no answer. */
function directionOf(v: string | undefined): string | null {
  const words = new Set(
    (v ?? '').split(/\s+/).filter((w) => /^(Импорт|Экспорт)$/i.test(w)),
  );
  return words.size === 1 ? [...words][0] : null;
}

/** The outcome column read as a state, or kept as the source's note. */
function outcomeOf(v: string | undefined): {
  status: SanepidRow['status'];
  note: string | null;
} {
  const text = oneLine(v);
  if (!text) return { status: null, note: null };
  // Narrow cells break words across lines ("Одобрени е"): compare unspaced.
  const flat = text.replace(/\s+/g, '').toLowerCase();
  const states: Array<[RegExp, NonNullable<SanepidRow['status']>]> = [
    [/одобрени/, 'approved'],
    [/рассмотрени/, 'review'],
    [/приём|прием/, 'received'],
  ];
  const hits = states.filter(([re]) => re.test(flat));
  if (hits.length === 1 && flat.length <= 14)
    return { status: hits[0][1], note: null };
  return { status: null, note: text };
}

const STATUS_LABEL: Record<NonNullable<SanepidRow['status']>, Labels> = {
  approved: L('Ruxsat berilgan', 'Одобрено', 'Approved'),
  review: L('Ko‘rib chiqilmoqda', 'На рассмотрении', 'Under review'),
  received: L('Ariza qabul qilingan', 'Заявка принята', 'Application received'),
};

type SanepidRole = 'applicant' | 'importer' | 'exporter';

/** A company's part in one conclusion, the products listed under it. */
export interface SanepidRow {
  inn: string;
  /** Applicant, importer, exporter — one company can be more than one. */
  roles: SanepidRole[];
  /** The permit, else the application — hashed when it carries a PINFL. */
  ref: string;
  name: string | null;
  permitNo: string | null;
  applicationNo: string | null;
  applicationDate: string | null;
  permitDate: string | null;
  direction: string | null;
  /** `approved` · `review` · `received`; null when the source says otherwise. */
  status: 'approved' | 'review' | 'received' | null;
  /** The source's words when they are not one of those: why not, a letter. */
  note: string | null;
  products: string[];
  hsCodes: string[];
  counterparties: string[];
  /** Where the products were made (older files only). */
  country: string | null;
  /** The conclusion's end of validity (older files only). */
  validTo: string | null;
  period: string | null;
}

const ROLE_LABEL: Record<SanepidRole, Labels> = {
  applicant: L('Ariza beruvchi', 'Заявитель', 'Applicant'),
  importer: L('Import qiluvchi', 'Импортёр', 'Importer'),
  exporter: L('Eksport qiluvchi', 'Экспортёр', 'Exporter'),
};

/**
 * The product rows of one quarter's file, gathered per conclusion and per
 * company named in it (applicant, importer, exporter — each with a STIR).
 * Another party is named only when its name is an organisation's.
 */
export function sanepidRows(
  rows: TableRow[],
  period: string | null,
): SanepidRow[] {
  const out = new Map<string, SanepidRow>();
  for (const r of rows) {
    const permitNo = oneLine(r.permit_no);
    // An application number starts with the applicant's id: kept only when
    // that is a company STIR, never a person's PINFL.
    const application = oneLine(r.application_no)?.replace(/\s/g, '') ?? '';
    const applicant = stirIn(r.applicant_inn);
    const applicationNo =
      applicant &&
      /^\d{9}$/.test(applicant) &&
      application.startsWith(applicant)
        ? application
        : null;
    const ref =
      permitNo ??
      applicationNo ??
      (application ? personKey(application) : null);
    if (!ref) continue;
    const parties: Array<
      [SanepidRole, string | undefined, string | undefined]
    > = [
      ['applicant', r.applicant_inn, r.applicant],
      ['importer', r.importer_inn, r.importer],
      ['exporter', r.exporter_inn, r.exporter],
    ];
    const names = parties
      .map(([, , n]) => oneLine(n))
      .filter((n): n is string => !!n && looksLikeOrganisation(n));
    for (const [role, innText, nameText] of parties) {
      const inn = stirIn(innText);
      if (!inn || !/^\d{9}$/.test(inn)) continue;
      const key = `${ref}:${inn}`;
      const name = oneLine(nameText);
      const row =
        out.get(key) ??
        ({
          inn,
          roles: [],
          ref,
          name: name && looksLikeOrganisation(name) ? name : null,
          permitNo,
          applicationNo,
          applicationDate: dayOf(oneLine(r.application_date)),
          permitDate: dayOf(oneLine(r.permit_date)),
          direction: directionOf(r.direction),
          ...outcomeOf(r.outcome),
          products: [],
          hsCodes: [],
          counterparties: [],
          country: null,
          validTo: null,
          period,
        } as SanepidRow);
      if (!row.roles.includes(role)) row.roles.push(role);
      if (!row.name && name && looksLikeOrganisation(name)) row.name = name;
      const product = oneLine(r.product);
      if (product && !row.products.includes(product))
        row.products.push(product);
      const hs = digitsOf((r.hs_code ?? '').replace(/\s/g, ''));
      if (hs && !row.hsCodes.includes(hs)) row.hsCodes.push(hs);
      for (const n of names) {
        if (n !== row.name && !row.counterparties.includes(n))
          row.counterparties.push(n);
      }
      out.set(key, row);
    }
  }
  return [...out.values()];
}

/** Products in one cell, each numbered: "1) Milk powder 2) Whey …". */
function productItems(v: string | undefined): string[] {
  return (oneLine(v) ?? '')
    .split(/(?:^|\s)\d{1,3}\)\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** "03 01 25" — day, month, two-digit year (the 2025 files). */
function shortDay(v: string | undefined): string | null {
  const m = /(\d{2})\s*[ .-]?\s*(\d{2})\s*[ .-]?\s*(\d{2}|\d{4})(?!\d)/.exec(
    oneLine(v) ?? '',
  );
  if (!m) return null;
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return dayOf(`${m[1]}.${m[2]}.${year}`);
}

/** Rows of one conclusion and company, their products gathered. */
function gather(out: Map<string, SanepidRow>, row: SanepidRow): void {
  const key = `${row.ref}:${row.inn}`;
  const held = out.get(key);
  if (!held) {
    out.set(key, row);
    return;
  }
  for (const p of row.products)
    if (!held.products.includes(p)) held.products.push(p);
}

/**
 * The 2026 Q1 layout: one row per conclusion, the applicant's name and STIR,
 * its products numbered in one cell, the country, the conclusion's number,
 * day and validity, and a remark when the products fall short of the norms.
 */
export function sanepidConclusionRows(
  rows: TableRow[],
  period: string | null,
): SanepidRow[] {
  const out = new Map<string, SanepidRow>();
  for (const r of rows) {
    const inn = stirIn(r.applicant_inn);
    const permitNo = oneLine(r.permit_no);
    if (!inn || !/^\d{9}$/.test(inn) || !permitNo) continue;
    const name = oneLine(r.applicant);
    const [from, to] = (oneLine(r.validity) ?? '').match(
      /\d{2}[-.]\d{2}[-.]\d{4}/g,
    ) ?? [null, null];
    const shortfall = oneLine(r.shortfall);
    gather(out, {
      inn,
      roles: ['applicant'],
      ref: permitNo,
      name: name && looksLikeOrganisation(name) ? name : null,
      permitNo,
      applicationNo: null,
      applicationDate: null,
      permitDate: dayOf(oneLine(r.permit_date)) ?? dayOf(from ?? ''),
      direction: null,
      status: shortfall ? null : 'approved',
      note: shortfall,
      products: productItems(r.product),
      hsCodes: [],
      counterparties: [],
      country: oneLine(r.country),
      validTo: to ? dayOf(to) : null,
      period,
    });
  }
  return [...out.values()];
}

/**
 * The 2025 Q1 layout (no lines): the conclusion's number and days, the
 * organisation and its STIR, the product and the country. Its numbers are
 * short and restart each year, so the key carries the quarter.
 */
export function sanepidCertificateRows(
  rows: TableRow[],
  period: string | null,
): SanepidRow[] {
  const out = new Map<string, SanepidRow>();
  for (const r of rows) {
    const inn = stirIn(r.inn);
    const certificate = digitsOf((r.certificate ?? '').replace(/\s/g, ''));
    if (!inn || !/^\d{9}$/.test(inn) || !certificate) continue;
    const name = oneLine(r.organisation);
    const product = oneLine(r.product);
    gather(out, {
      inn,
      roles: ['applicant'],
      ref: `${period ?? ''}:${certificate}`,
      name: name && looksLikeOrganisation(name) ? name : null,
      permitNo: certificate,
      applicationNo: null,
      applicationDate: null,
      permitDate: shortDay(r.issued),
      direction: null,
      status: 'approved',
      note: null,
      products: product ? [product] : [],
      hsCodes: [],
      counterparties: [],
      country: oneLine(r.country),
      validTo: shortDay(r.valid_to),
      period,
    });
  }
  return [...out.values()];
}

const SANEPID_SOURCE = { authority: 'sanepid', section: 'sanepid-xulosa' };
/** An application number: the applicant's STIR, the year, a counter. */
export const SANEPID_APPLICATION = /^\d{17,22}$/;

/** The layouts Sanepid's quarterly files have used, newest first, each with its rows' reading. */
const SANEPID_LAYOUTS: Array<
  PdfTableLayout & {
    rows: (rows: TableRow[], period: string | null) => SanepidRow[];
  }
> = [
  { spec: PDF_SPECS.sanepid, anchor: SANEPID_APPLICATION, rows: sanepidRows },
  { spec: PDF_SPECS.sanepidConclusions, rows: sanepidConclusionRows },
  {
    spec: PDF_SPECS.sanepidCertificates,
    anchor: /^\d{1,5}$/,
    rows: sanepidCertificateRows,
  },
];

/** What Sanepid's adapter remembers: the file read for each quarter. */
interface SanepidState {
  files: Record<string, string>;
}

export const sanitaryConclusion: RegistryAdapter = {
  meta: {
    code: 'sanitary_import_conclusion',
    sector: 'customs',
    kind: 'permit',
    title: L(
      'Sanitariya-epidemiologik xulosa (import / eksport)',
      'Санитарно-эпидемиологическое заключение (импорт / экспорт)',
      'Sanitary-epidemiological conclusion (import / export)',
    ),
    cadence: 'weekly',
    display: true,
    periodic: true,
    fieldLabels: {
      period: F.period,
      role: L('Kompaniyaning roli', 'Роль компании', 'Company’s role'),
      direction: L('Yo‘nalish', 'Направление', 'Direction'),
      country: L(
        'Ishlab chiqarilgan davlat',
        'Страна производства',
        'Country of origin',
      ),
      outcome: F.status_text,
      note: F.note,
      products: L('Mahsulotlar', 'Продукция', 'Products'),
      hs_codes: L('TIF TN kodlari', 'Коды ТН ВЭД', 'HS codes'),
      counterparties: L('Boshqa tomonlar', 'Другие стороны', 'Other parties'),
      application: L('Ariza', 'Заявка', 'Application'),
    },
    minRows: 500,
  },
  /**
   * Every quarter's file. A quarter whose file is the one the last run read
   * (same address) is left alone and its entries kept — a past quarter does
   * not change, and each file is a minute of CPU. A file that cannot be read
   * keeps its quarter's entries too, and is tried again next run.
   */
  async fetchAll(http: RegistryHttp, opts): Promise<FetchResult> {
    const docs: GovDocument[] = await govSection(
      http,
      SANEPID_SOURCE.authority,
      SANEPID_SOURCE.section,
    );
    const before = (opts?.state as SanepidState | undefined)?.files ?? {};
    const files: Record<string, string> = {};
    const rows: SanepidRow[] = [];
    const read: NonNullable<FetchResult['files']> = [];
    const held: string[] = [];
    const notes: string[] = [];
    let edition: string | null = null;
    let used = 0;
    for (const doc of docs) {
      const url = newestFile(doc.pdfs);
      if (!url) continue;
      const period = quarterOf(doc.title);
      const key = period ?? `doc ${doc.id}`;
      const day = uploadDay(url);
      if (day && (!edition || day > edition)) edition = day;
      if (period && before[key] === url) {
        files[key] = url;
        held.push(period);
        used++;
        continue;
      }
      try {
        const data = await downloadPdf(http, url);
        const table = await readPdfTable(data, { layouts: SANEPID_LAYOUTS });
        read.push({ url, day, data });
        files[key] = url;
        used++;
        if (table.layout < 0) {
          notes.push(
            `${doc.title}: ${table.pages} pages in a layout not known — not read`,
          );
          continue;
        }
        rows.push(...SANEPID_LAYOUTS[table.layout].rows(table.rows, period));
      } catch (err) {
        // Its quarter keeps what we hold; the address is not remembered, so
        // the next run tries it again.
        if (period) held.push(period);
        notes.push(
          `${doc.title}: ${(err as Error).message} — kept, read again next run`,
        );
      }
    }
    if (!used) {
      throw new Error(`no Sanepid file could be read: ${notes.join('; ')}`);
    }
    return {
      rows,
      complete: true,
      expected: null,
      editionDate: edition,
      heldPeriods: held,
      state: { files } satisfies SanepidState,
      files: read,
      notes,
    };
  },
  map(row: unknown): MapResult {
    const r = row as SanepidRow;
    const ref = r.ref;
    if (!ref) return skip('no permit or application number');
    const roles = (['applicant', 'importer', 'exporter'] as const).filter(
      (role) => r.roles.includes(role),
    );
    const role = L(
      roles.map((x) => ROLE_LABEL[x].uz).join(', '),
      roles.map((x) => ROLE_LABEL[x].ru).join(', '),
      roles.map((x) => ROLE_LABEL[x].en).join(', '),
    );
    const MAX = 15;
    const products =
      r.products.slice(0, MAX).join('\n') +
      (r.products.length > MAX ? `\n… +${r.products.length - MAX}` : '');
    // A permit's number can come back in a later quarter's file with other
    // products: each quarter keeps its own entry.
    return entry({
      sourceKey: `${r.period ?? ''}:${ref}:${r.inn}`,
      inn: r.inn,
      name: r.name,
      number: r.permitNo,
      status: r.status,
      validFrom: r.permitDate ?? r.applicationDate,
      validTo: r.validTo,
      fields: {
        period: r.period,
        role: roles.length ? role : null,
        direction: r.direction,
        country: r.country,
        outcome: r.status ? STATUS_LABEL[r.status] : null,
        note: r.note,
        products: products || null,
        hs_codes: r.hsCodes.join(', ') || null,
        counterparties: r.counterparties.join('; ') || null,
        application:
          [r.applicationNo, r.applicationDate].filter(Boolean).join(', ') ||
          null,
      },
      raw: { ...r },
      asOf: r.permitDate ?? r.applicationDate,
    });
  },
};

export const GOV_PDF_ADAPTERS: RegistryAdapter[] = [
  auditFirm,
  publicInterestEntity,
  tourismAccommodation,
  hostelRegistration,
  medicalWellness,
  sanitaryConclusion,
];
