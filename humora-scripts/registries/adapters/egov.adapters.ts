import {
  egovLabels,
  egovNumber,
  egovPlain,
  egovText,
  EgovRow,
  fetchEgovDataset,
} from '../data-egov';
import { RegistryHttp } from '../registry-http';
import {
  FetchResult,
  MapContext,
  MapResult,
  RegistryAdapter,
  RegistryMeta,
} from '../registry-types';
import {
  dayOf,
  daysIn,
  nameKey,
  quarterEnd,
  taxpayerOf,
} from '../registry-normalize';
import {
  companyName,
  coordinates,
  entry,
  F,
  L,
  personKey,
  skip,
  stirOrSkip,
} from './adapter-kit';

/**
 * The registers published on data.egov.uz. Each is one dataset id and a
 * mapper; the portal client (`../data-egov.ts`) does the reading.
 */
function egovAdapter(
  meta: RegistryMeta,
  guid: string,
  map: (row: EgovRow, ctx: MapContext) => MapResult,
  opts: {
    pageSize?: number;
    withPeriod?: boolean;
    /** Rows the portal sends more than once, folded before mapping. */
    dedupe?: (row: EgovRow) => string | null;
  } = {},
): RegistryAdapter & { guid: string } {
  return {
    meta,
    guid,
    async fetchAll(http: RegistryHttp): Promise<FetchResult> {
      const read = await fetchEgovDataset(http, guid, opts);
      if (!opts.dedupe) return read;
      const seen = new Set<string>();
      const rows = (read.rows as EgovRow[]).filter((r) => {
        const key = opts.dedupe!(r);
        if (key === null) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      // The stated count counts the copies; the rows left are the register.
      return { ...read, rows, expected: rows.length };
    },
    map: (row, ctx) => map(row as EgovRow, ctx),
  };
}

const c = (row: EgovRow, field: string) => row.tableColumn?.[field];
const t = (row: EgovRow, field: string) => egovText(c(row, field));
const n = (row: EgovRow, field: string) => egovNumber(c(row, field));
const d = (row: EgovRow, field: string) => dayOf(t(row, field));

/**
 * An amount in so‘m to the tiyin: the portal sends floats
 * (`1074593397.6399999`), which would be stored and shown as such.
 */
function som(v: number | null): number | null {
  return v === null ? null : Math.round(v * 100) / 100;
}

/** `1712 - Навоийская область` → `Навоийская область`. */
function withoutCode(text: string | null): string | null {
  return text ? text.replace(/^\d+\s*-\s*/, '').trim() || null : null;
}

// ---- A1 · customs benefits ---------------------------------------------------

const BENEFIT_FIELDS = {
  period: F.period,
  customs_duty: L('Bojxona boji', 'Таможенная пошлина', 'Customs duty'),
  vat: L('QQS', 'НДС', 'VAT'),
  customs_fee: L('Bojxona yig‘imi', 'Таможенный сбор', 'Customs fee'),
  excise: L('Aksiz solig‘i', 'Акцизный налог', 'Excise tax'),
};

export const customsBenefit = egovAdapter(
  {
    code: 'customs_benefit',
    sector: 'customs',
    kind: 'benefit',
    title: L(
      'Bojxona imtiyozlari',
      'Таможенные льготы',
      'Customs benefits received',
    ),
    cadence: 'weekly',
    display: true,
    periodic: true,
    fieldLabels: BENEFIT_FIELDS,
    minRows: 3000,
  },
  '61cae24eae25c8ecefc7a5de',
  (row, ctx) => {
    const ids = taxpayerOf(t(row, 'KorxonaSTIRi'));
    if (!ids.inn && !ids.pinfl) return skip('no taxpayer number');
    // The period from the dataset's description; an upload that names none
    // is its own snapshot, keyed by its day.
    const period = ctx.period ?? ctx.editionDate;
    if (!period) return skip('no period and no upload date');
    const who = ids.inn ?? personKey(ids.pinfl!);
    const plain = egovPlain(row, ids.inn ? [] : ['KorxonaSTIRi']);
    const name = companyName(ids.inn, t(row, 'Korxonanomi'));
    if (!name) delete plain.Korxonanomi;
    return entry({
      sourceKey: `${who}:${period}`,
      inn: ids.inn,
      pinfl: ids.pinfl,
      name,
      amount: som(n(row, 'Jamiimtiyozsummasi')),
      amountUnit: 'UZS',
      fields: {
        period: ctx.period,
        customs_duty: som(n(row, 'Bojxonaboji')),
        vat: som(n(row, 'QQS')),
        customs_fee: som(n(row, 'Bojxonayigimi')),
        excise: som(n(row, 'Aksizsoligi')),
      },
      raw: plain,
      asOf: (ctx.period && quarterEnd(ctx.period)) ?? ctx.editionDate,
    });
  },
  { withPeriod: true },
);

// ---- A2 · tax and customs benefits under government acts --------------------

/** The eight tax types, by a word their Russian name always has. */
const TAX_TYPES: Array<[RegExp, string]> = [
  [/добавленн/i, 'vat'],
  [/прибыл/i, 'profit'],
  [/социальн/i, 'social'],
  [/земел/i, 'land'],
  [/имуществ/i, 'property'],
  [/доход.*физ|физ.*доход/i, 'personal_income'],
  [/оборот/i, 'turnover'],
  [/водн/i, 'water'],
];

export function taxTypeCode(ru: string | null, uz: string | null): string {
  for (const [re, code] of TAX_TYPES) if (ru && re.test(ru)) return code;
  return (nameKey(uz ?? ru) ?? 'other').toLowerCase().slice(0, 40);
}

export const taxCustomsBenefit = egovAdapter(
  {
    code: 'tax_customs_benefit',
    sector: 'tax',
    kind: 'benefit',
    title: L(
      'Soliq va bojxona imtiyozlari (hukumat qarorlari bo‘yicha)',
      'Налоговые и таможенные льготы (по актам правительства)',
      'Tax and customs benefits under government acts',
    ),
    // Stored, not shown: a 2024 quarter, cut at 19,999 rows (the user decides).
    cadence: 'monthly',
    display: false,
    periodic: true,
    fieldLabels: {
      period: F.period,
      tax_type: L('Soliq turi', 'Вид налога', 'Tax type'),
      tax_paid: L('To‘langan soliq', 'Уплаченный налог', 'Tax paid'),
      zero_rate_vat: L(
        'Shundan 0% QQS',
        'В т.ч. НДС по нулевой ставке',
        'Of which zero-rate VAT',
      ),
    },
    minRows: 10000,
  },
  '61641e6aec71c8d08438430c',
  (row, ctx) => {
    const ids = taxpayerOf(t(row, 'Identifikatsiyaraqami'));
    if (!ids.inn && !ids.pinfl) return skip('no taxpayer number');
    const period = ctx.period ?? ctx.editionDate;
    if (!period) return skip('no period and no upload date');
    const taxType = egovLabels(c(row, 'Imtiyozlar2'));
    const code = taxTypeCode(taxType?.ru ?? null, taxType?.uz ?? null);
    const who = ids.inn ?? personKey(ids.pinfl!);
    // Thousand so'm at the source.
    const k = (v: number | null) => (v === null ? null : Math.round(v * 1000));
    const drop = ['Imtiyoz8', ...(ids.inn ? [] : ['Identifikatsiyaraqami'])];
    const name = companyName(ids.inn, t(row, 'Imtiyozlar1'));
    const plain = egovPlain(row, drop);
    if (!name) delete plain.Imtiyozlar1;
    return entry({
      sourceKey: `${who}:${code}:${period}`,
      inn: ids.inn,
      pinfl: ids.pinfl,
      name,
      amount: k(n(row, 'Umumiyimtiyoz')),
      amountUnit: 'UZS',
      fields: {
        period: ctx.period,
        tax_type: taxType,
        tax_paid: k(n(row, 'Tolangansoliq')),
        zero_rate_vat: k(n(row, 'nolovoy')),
      },
      raw: plain,
      asOf: (ctx.period && quarterEnd(ctx.period)) ?? ctx.editionDate,
    });
  },
  { withPeriod: true },
);

// ---- A3 · subsoil-use licences -----------------------------------------------

/** `QQ 0259 G5-сон  24.11.2023 от 24.11.2025` → series, number, code, dates. */
export function parseSubsoilLicence(text: string | null): {
  series: string;
  number: string;
  code: string | null;
  issued: string | null;
  ends: string | null;
} | null {
  if (!text) return null;
  const m = /^\s*([A-ZА-Я]{2})\s*№?\s*(\d{3,5})\s*([A-ZА-Я]\d)?/u.exec(text);
  if (!m) return null;
  const days = daysIn(text);
  return {
    series: m[1],
    number: m[2],
    code: m[3] ?? null,
    issued: days.length >= 2 ? days[0] : null,
    ends: days.length >= 1 ? days[days.length - 1] : null,
  };
}

export const subsoilLicence = egovAdapter(
  {
    code: 'subsoil_licence',
    sector: 'energy',
    kind: 'licence',
    title: L(
      'Yer qa’ridan foydalanish litsenziyasi',
      'Лицензия на пользование недрами',
      'Subsoil use licence',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      use_type: L('Foydalanish turi', 'Вид пользования', 'Type of use'),
      mineral: L('Xomashyo turi', 'Вид сырья', 'Mineral'),
      plot: L('Uchastka', 'Участок', 'Plot'),
      district: F.district,
      licence_code: L(
        'Litsenziya turi kodi',
        'Код вида лицензии',
        'Licence type code',
      ),
      term_text: L(
        'Litsenziya va muddati (reyestrda yozilganidek)',
        'Лицензия и срок (как в реестре)',
        'Licence and term (as written in the register)',
      ),
    },
    minRows: 1500,
  },
  '61713c87c90c443f4dfb7dcd',
  (row, ctx) => {
    const ids = stirOrSkip(t(row, 'Soliqtolovchiningidentifikatsionraqami'));
    if ('skip' in ids) return ids;
    const term = t(row, 'Yerqaridanfoydalanishvalitsenziyaniamalqilishmuddati');
    const lic = parseSubsoilLicence(term);
    if (!lic) return skip('licence text not readable');
    const plot = t(row, 'Yerqariuchastkasinomi');
    const mineral = t(row, 'Xomashyoturi');
    const fold = (s: string | null) =>
      (s ?? '').toLowerCase().replace(/[\s"'«»“”.,-]+/g, '');
    return entry({
      sourceKey: `${lic.series}${lic.number}:${fold(plot)}:${fold(mineral)}`,
      inn: ids.inn,
      name: t(row, 'Tashkilotnomi'),
      number: `${lic.series} ${lic.number}`,
      validFrom: lic.issued,
      validTo: lic.ends,
      fields: {
        use_type: t(row, 'Yerqaridanfoydalanishturi'),
        mineral,
        plot,
        district: t(row, 'Joylashganjoyituman'),
        licence_code: lic.code,
        term_text: term,
      },
      raw: egovPlain(row),
      asOf: ctx.editionDate,
    });
  },
  {
    pageSize: 5000,
    // Every row comes twice; the row number tells the copies.
    dedupe: (row) => t(row, 'Tartibraqami'),
  },
);

// ---- A4 · telecom licences (frozen 2021) --------------------------------------

export const telecomLicence = egovAdapter(
  {
    code: 'telecom_licence',
    sector: 'telecom',
    kind: 'licence',
    title: L(
      'Telekommunikatsiya litsenziyasi',
      'Лицензия в сфере телекоммуникаций',
      'Telecommunications licence',
    ),
    cadence: 'monthly',
    display: true,
    fieldLabels: {
      activity: F.activity,
      registry_number: F.registry_number,
      region: F.region,
      address: F.address,
    },
    minRows: 700,
  },
  '6107d3fa2a2e256d868e86f6',
  (row, ctx) => {
    const ids = stirOrSkip(t(row, 'TIN'));
    if ('skip' in ids) return ids;
    const series = t(row, 'Series');
    const number = t(row, 'Number');
    const reg = t(row, 'Registrynumber');
    if (!number && !reg) return skip('no licence number');
    return entry({
      sourceKey: `${series ?? ''}${number ?? ''}:${reg ?? ''}`,
      inn: ids.inn,
      name: t(row, 'Licensee'),
      number: [series, number].filter(Boolean).join(' ') || reg,
      validFrom: d(row, 'Date') ?? d(row, 'Validfrom'),
      validTo: d(row, 'Validityby'),
      fields: {
        activity: t(row, 'Typeofactivityinthelicense'),
        registry_number: reg,
        region: withoutCode(t(row, 'Region')),
        // The column is titled "postcode" and holds the address.
        address: t(row, 'Postcode'),
      },
      raw: egovPlain(row),
      asOf: ctx.editionDate,
    });
  },
);

// ---- A5–A7 · customs warehouses and duty-free shops ---------------------------

function customsSite(
  code: string,
  title: ReturnType<typeof L>,
  guid: string,
  cols: { name: string; address: string; post: string; licence: string },
  minRows: number,
) {
  return egovAdapter(
    {
      code,
      sector: 'customs',
      kind: 'licence',
      title,
      cadence: 'weekly',
      display: true,
      fieldLabels: {
        site_name: F.branch_name,
        address: F.address,
        customs_post: F.customs_post,
        coordinates: F.coordinates,
      },
      minRows,
    },
    guid,
    (row, ctx) => {
      const ids = stirOrSkip(t(row, 'STIR'));
      if ('skip' in ids) return ids;
      const licence = t(row, cols.licence);
      const address = t(row, cols.address);
      return entry({
        sourceKey: licence ?? `${ids.inn}:${nameKey(address) ?? ''}`,
        inn: ids.inn,
        number: licence,
        fields: {
          site_name: t(row, cols.name),
          address,
          customs_post: t(row, cols.post),
          coordinates: coordinates(n(row, 'latitude'), n(row, 'longitude')),
        },
        raw: egovPlain(row),
        asOf: ctx.editionDate,
      });
    },
  );
}

export const customsWarehouse = customsSite(
  'customs_warehouse',
  L('Bojxona ombori', 'Таможенный склад', 'Customs warehouse'),
  '610258012a2e256d868e82dd',
  {
    name: 'name',
    address: 'Bojxonaomborimanzili',
    post: 'Nazoratposti',
    licence: 'Litsenziya',
  },
  200,
);

export const freeWarehouse = customsSite(
  'free_warehouse',
  L('Erkin ombor', 'Свободный склад', 'Free warehouse'),
  '610257632a2e256d868e82d9',
  {
    name: 'Erkinombor',
    address: 'Manzili',
    post: 'Nazoratposti',
    licence: 'Litsenziyaraqami',
  },
  5,
);

export const dutyFreeShop = customsSite(
  'duty_free_shop',
  L('Bojsiz savdo do‘koni', 'Магазин беспошлинной торговли', 'Duty-free shop'),
  '610257982a2e256d868e82db',
  {
    name: 'Bojolinmaydigansavdodokoni',
    address: 'Manzili',
    post: 'nazoratposti',
    licence: 'litsenziya',
  },
  20,
);

// ---- A8 · tour operator licences ---------------------------------------------

export const tourOperatorLicence = egovAdapter(
  {
    code: 'tour_operator_licence',
    sector: 'tourism',
    kind: 'licence',
    title: L(
      'Turoperatorlik litsenziyasi',
      'Лицензия туроператора',
      'Tour operator licence',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      service: L('Xizmat yo‘nalishi', 'Направление обслуживания', 'Service'),
      activity: F.activity,
      region: F.region,
      address: F.address,
    },
    minRows: 2000,
  },
  '6627583e2f776a551cc8b7c4',
  (row, ctx) => {
    const ids = stirOrSkip(t(row, 'LitsenziatSTIRraqami'));
    if ('skip' in ids) return ids;
    const licence = t(row, 'Litsenziyaraqami');
    if (!licence) return skip('no licence number');
    const postcode = t(row, 'Pochtaindeksi');
    const address = t(row, 'Litsenziatpochtamanzili');
    const issued = d(row, 'Berilgansanasi');
    return entry({
      // A licence issued again keeps its number; the date tells the two apart.
      sourceKey: `${licence}:${ids.inn}:${issued ?? ''}`,
      inn: ids.inn,
      name: t(row, 'Litsenziatnomivatashkiliyhuquqiyshakli'),
      number: licence,
      validFrom: issued,
      fields: {
        service: t(row, 'Xizmatkorsatishyonalishi'),
        activity: t(row, 'Litsenziyadagifaoliyatyonalishi'),
        region: t(row, 'Hudud'),
        address: postcode && address ? `${postcode}, ${address}` : address,
      },
      raw: egovPlain(row),
      asOf: ctx.editionDate,
    });
  },
);

// ---- A9 · hotel certificates -------------------------------------------------

export const hotelCertificate = egovAdapter(
  {
    code: 'hotel_certificate',
    sector: 'tourism',
    kind: 'certificate',
    title: L(
      'Mehmonxona xizmatlari sertifikati',
      'Сертификат гостиничных услуг',
      'Hotel services certificate',
    ),
    cadence: 'weekly',
    display: true,
    fieldLabels: {
      address: F.address,
      region: F.region,
      coordinates: F.coordinates,
    },
    minRows: 1000,
  },
  '662758862f776a551cc8b7c6',
  (row, ctx) => {
    const ids = stirOrSkip(t(row, 'ObyektSTIRraqami'));
    if ('skip' in ids) return ids;
    const cert = t(row, 'Royxatdanotgansertifikatraqami');
    if (!cert) return skip('no certificate number');
    const address = t(row, 'Manzil');
    return entry({
      // One number is listed for several companies, and for several sites of
      // one company: the company and the site tell them apart.
      sourceKey: `${cert}:${ids.inn}:${nameKey(address) ?? ''}`,
      inn: ids.inn,
      name: t(row, 'Yuridikshaxsnomi'),
      number: cert,
      validFrom: d(row, 'Sertifikatberilgansana'),
      validTo: d(row, 'Sertifikatamalqilishmuddati'),
      fields: {
        address,
        region: t(row, 'Viloyat'),
        coordinates: coordinates(n(row, 'latitude'), n(row, 'longitude')),
      },
      raw: egovPlain(row),
      asOf: ctx.editionDate,
    });
  },
);

// ---- A10 · publishers (frozen 2023) -------------------------------------------

export const publisherRegistration = egovAdapter(
  {
    code: 'publisher_registration',
    sector: 'media',
    kind: 'registration',
    title: L(
      'Nashriyot faoliyati tasdiqnomasi',
      'Удостоверение на издательскую деятельность',
      'Publishing activity certificate',
    ),
    cadence: 'monthly',
    display: true,
    fieldLabels: {
      region: F.region,
      district: F.district,
      address: F.address,
    },
    minRows: 150,
  },
  '6163d319ec71c8d0843838f4',
  (row, ctx) => {
    const ids = stirOrSkip(t(row, 'Stirlar'));
    if ('skip' in ids) return ids;
    const number = t(row, 'Tasdiqnomaraqami');
    if (!number) return skip('no certificate number');
    return entry({
      sourceKey: `${number}:${ids.inn}`,
      inn: ids.inn,
      name: t(row, 'Yuridiknomi'),
      number,
      validFrom: d(row, 'Sanalar'),
      fields: {
        region: t(row, 'Hudud'),
        district: t(row, 'Tumandan'),
        address: t(row, 'Manzili'),
      },
      // The head of the publisher is a person: not kept.
      raw: egovPlain(row, ['Raxbariyat']),
      asOf: ctx.editionDate,
    });
  },
);

// ---- A11 · non-state education licences (to 2022) ----------------------------

export const educationLicence = egovAdapter(
  {
    code: 'education_licence_2022',
    sector: 'education',
    kind: 'licence',
    title: L(
      'Nodavlat ta’lim xizmatlari litsenziyasi',
      'Лицензия на негосударственные образовательные услуги',
      'Non-state education licence',
    ),
    cadence: 'monthly',
    display: true,
    fieldLabels: {
      education_type: L(
        'Ta’lim faoliyati turi',
        'Вид образовательной деятельности',
        'Type of education',
      ),
      directions: L(
        'Ta’lim yo‘nalishlari',
        'Направления обучения',
        'Programmes',
      ),
      legal_address: F.legal_address,
      activity_address: F.activity_address,
      supervisor: L(
        'Nazorat qiluvchi organ',
        'Контролирующий орган',
        'Supervising body',
      ),
    },
    minRows: 1500,
  },
  '61110fe9db32b99538e08216',
  (row, ctx) => {
    const ids = stirOrSkip(t(row, 'TIN'));
    if ('skip' in ids) return ids;
    const number = t(row, 'Licensenumber');
    if (!number) return skip('no licence number');
    return entry({
      sourceKey: `${number}:${ids.inn}`,
      inn: ids.inn,
      name: t(row, 'Nameoftheeducationalinstitution'),
      number,
      validFrom: d(row, 'Licenseregistrationdate'),
      validTo: d(row, 'Licensevalidityperiod'),
      fields: {
        education_type: t(row, 'Typeofeducationalactivity'),
        directions: t(row, 'Listofeducationaldirections'),
        legal_address: t(row, 'Legaladdress'),
        activity_address: t(row, 'Businessaddress'),
        supervisor: t(row, 'Territory'),
      },
      raw: egovPlain(row),
      asOf: ctx.editionDate,
    });
  },
);

// ---- Phase C · registers without a STIR (stored, matched by name, not shown) --

export const taxAudit = egovAdapter(
  {
    code: 'tax_audit',
    sector: 'tax',
    kind: 'audit',
    title: L('Soliq tekshiruvi', 'Налоговая проверка', 'Tax audit'),
    cadence: 'weekly',
    display: false,
    nameOnly: true,
    fieldLabels: {
      audit_type: L('Tekshiruv turi', 'Вид проверки', 'Type of audit'),
      region: F.region,
    },
    // 21,696 organisations of 31,248 rows on 2026-10-13 (the rest are people).
    minRows: 10000,
  },
  '616ecdd1ec71c8d0845cf0e7',
  (row, ctx) => {
    const name = t(row, 'Soliqtekshiruvi1');
    const key = nameKey(name);
    if (!name || !key) return skip('no name');
    const type = t(row, 'Soliqtekshiruvi3');
    const start = d(row, 'Soliqtekshiruvi5');
    const end = d(row, 'Soliqtekshiruvi6');
    const region = t(row, 'Soliqtekshiruvi2');
    return entry({
      sourceKey: [key, nameKey(type), nameKey(region), start, end]
        .map((v) => v ?? '')
        .join(':'),
      name,
      validFrom: start,
      validTo: end,
      fields: { audit_type: type, region: t(row, 'Soliqtekshiruvi2') },
      region: t(row, 'Soliqtekshiruvi2'),
      // The inspector is a person: not kept.
      raw: egovPlain(row, ['Soliqtekshiruvi4']),
      asOf: ctx.editionDate,
    });
  },
);

export const roadCarrierLicence = egovAdapter(
  {
    code: 'road_carrier_licence',
    sector: 'transport',
    kind: 'licence',
    title: L(
      'Avtomobil transportida tashish litsenziyasi',
      'Лицензия на перевозки автомобильным транспортом',
      'Road transport licence',
    ),
    cadence: 'weekly',
    display: false,
    nameOnly: true,
    fieldLabels: {
      activity: F.activity,
      licence_type: L('Litsenziya turi', 'Тип лицензии', 'Licence type'),
      status_text: F.status_text,
      issuer: L(
        'Rasmiylashtirgan boshqarma',
        'Оформившее управление',
        'Issuing office',
      ),
    },
    // Almost every holder is an individual entrepreneur, kept by no name:
    // 129 organisations of 34,923 rows on 2026-10-13.
    minRows: 50,
  },
  '61024d652a2e256d868e82ac',
  (row, ctx) => {
    const name = t(row, 'Nomi');
    if (!name || !nameKey(name)) return skip('no name');
    const number = t(row, 'Litsenziyaraqami');
    if (!number) return skip('no licence number');
    const status = t(row, 'Holati');
    return entry({
      sourceKey: number,
      name,
      number,
      status,
      isActive: status
        ? /^действ|^amal/i.test(status)
          ? true
          : /прекращ|аннулир|приостан|bekor|to.xtat/i.test(status)
            ? false
            : null
        : null,
      validFrom: d(row, 'Litsenziyaberilgansana'),
      validTo: d(row, 'Litsenziyaniamalqilishmuddati'),
      fields: {
        activity: t(row, 'Faoliyatturi'),
        licence_type: t(row, 'Litsenziyaturi'),
        status_text: status,
        issuer: t(row, 'Litsenziyanirasmiylashtirganhududiyboshqarma'),
      },
      raw: egovPlain(row),
      asOf: ctx.editionDate,
    });
  },
);

export const pppProject = egovAdapter(
  {
    code: 'ppp_project',
    sector: 'investment',
    kind: 'project',
    title: L(
      'Davlat-xususiy sheriklik loyihasi',
      'Проект государственно-частного партнёрства',
      'Public-private partnership project',
    ),
    cadence: 'weekly',
    display: false,
    nameOnly: true,
    fieldLabels: {
      project: L('Loyiha', 'Проект', 'Project'),
      public_partner: L(
        'Davlat sherigi',
        'Государственный партнёр',
        'Public partner',
      ),
      initiator: L('Tashabbuskor', 'Инициатор', 'Initiator'),
      term_years: L('Muddati (yil)', 'Срок (лет)', 'Term (years)'),
      removed_on: L(
        'Reyestrdan chiqarilgan sana',
        'Дата исключения из реестра',
        'Removed from the register on',
      ),
    },
    minRows: 1000,
  },
  '64dc9c7fb04a41cb2e29d597',
  (row, ctx) => {
    const name = t(row, 'Xususiysherik');
    if (!name || !nameKey(name)) return skip('no private partner');
    const number = t(row, 'Royxatgaolinganraqami');
    if (!number) return skip('no registration number');
    const value = n(row, 'Loyihaqiymati');
    const removed = d(row, 'Qoshimchamalumotlar');
    return entry({
      sourceKey: `${number}:${nameKey(name)}`,
      name,
      number,
      isActive: removed ? false : null,
      validFrom: d(row, 'Loyiharoyxatgaolingansana'),
      // Million so'm at the source.
      amount: value === null ? null : Math.round(value * 1_000_000),
      amountUnit: 'UZS',
      fields: {
        project: t(row, 'Loyihanomi'),
        public_partner: t(row, 'Davlatsherigi'),
        initiator: t(row, 'Loyihatashabbuskori'),
        term_years: n(row, 'Loyihamuddati'),
        removed_on: removed,
      },
      raw: egovPlain(row),
      asOf: ctx.editionDate,
    });
  },
);

const ISO_COLUMNS = [
  'ISO9001',
  'ISO14001',
  'OHSAS18001',
  'ISO22000',
  'ISO50001',
  'ISOTS16949',
  'GMP',
];

export const isoCertified = egovAdapter(
  {
    code: 'iso_certified',
    sector: 'professional',
    kind: 'certificate',
    title: L(
      'Menejment tizimi sertifikati (ISO)',
      'Сертификат системы менеджмента (ISO)',
      'Management system certificate (ISO)',
    ),
    cadence: 'weekly',
    display: false,
    nameOnly: true,
    fieldLabels: {
      standards: F.standard,
      scope: F.scope,
      region: F.region,
      address: F.address,
    },
    minRows: 2000,
  },
  '610d1c371a64fdd0373a9114',
  (row, ctx) => {
    const name = t(row, 'Korxonaningnomi');
    if (!name || !nameKey(name)) return skip('no name');
    const number = t(row, 'Davlatreystriraqami');
    if (!number) return skip('no register number');
    const standards = [
      ...new Set(
        ISO_COLUMNS.map((col) => t(row, col)).filter(
          (v): v is string => v !== null,
        ),
      ),
    ];
    return entry({
      sourceKey: number,
      name,
      number,
      validTo: d(row, 'Amalqilishmuddati'),
      fields: {
        standards: standards.join('; ') || null,
        scope: t(row, 'Menejmenttiziminingqollanishsohasi'),
        region: t(row, 'Hudud'),
        address: t(row, 'Manzili'),
      },
      region: t(row, 'Hudud'),
      raw: egovPlain(row),
      asOf: ctx.editionDate,
    });
  },
);

export const naturalMonopoly = egovAdapter(
  {
    code: 'natural_monopoly',
    sector: 'energy',
    kind: 'status',
    title: L(
      'Tabiiy monopoliya subyekti',
      'Субъект естественной монополии',
      'Natural monopoly',
    ),
    cadence: 'weekly',
    display: false,
    nameOnly: true,
    fieldLabels: {
      service: L('Xizmat turi', 'Вид услуги', 'Service'),
      region: F.region,
    },
    minRows: 30,
  },
  '610b8a641a64fdd0373a8f56',
  (row, ctx) => {
    const name = t(row, 'XojalikYurituvchiSubektNomi');
    const key = nameKey(name);
    if (!name || !key) return skip('no name');
    const service = t(row, 'XizmatTuri');
    return entry({
      sourceKey: `${key}:${nameKey(service) ?? ''}:${nameKey(t(row, 'Hudud')) ?? ''}`,
      name,
      fields: { service, region: t(row, 'Hudud') },
      region: t(row, 'Hudud'),
      raw: egovPlain(row),
      asOf: ctx.editionDate,
    });
  },
);

export const EGOV_ADAPTERS = [
  customsBenefit,
  taxCustomsBenefit,
  subsoilLicence,
  telecomLicence,
  customsWarehouse,
  freeWarehouse,
  dutyFreeShop,
  tourOperatorLicence,
  hotelCertificate,
  publisherRegistration,
  educationLicence,
  taxAudit,
  roadCarrierLicence,
  pppProject,
  isoCertified,
  naturalMonopoly,
];
