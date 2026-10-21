import { EgovRow } from '../data-egov';
import { isSkip, MapContext, MappedEntry, MapResult } from '../registry-types';
import { L, personKey } from './adapter-kit';
import { cbuRows } from './cbu.adapters';
import {
  advocacyEntity,
  ngoRegistration,
  parseItParkResidents,
} from './civil.adapters';
import {
  customsBenefit,
  hotelCertificate,
  parseSubsoilLicence,
  subsoilLicence,
  taxCustomsBenefit,
  taxTypeCode,
  tourOperatorLicence,
} from './egov.adapters';
import { headerKey, manualAdapter, uploadedRows } from './manual.adapters';
import { parseNappProfessional, parseNappSpecialRegime } from './napp.adapters';
import { PHARMA_ADAPTERS } from './pharma.adapters';

const ctx: MapContext = {
  editionDate: '2026-04-13',
  period: '2026Q1',
  today: '2026-10-13',
};

const text = (v: string) => ({ text: null, number: 0, data: v, default: v });
const num = (v: number) => ({ text: null, number: v, data: null, default: v });
const lang = (uz: string, ru = uz, en = uz) => ({
  text: { uzbText: uz, uzbKrText: uz, rusText: ru, engText: en },
  number: 0,
  data: null,
  default: uz,
});
const egovRow = (cols: EgovRow['tableColumn']): EgovRow => ({
  id: '69dce4e7774e3358ed3dc4f9',
  dateTime: '2026-04-13T12:43:15.717Z',
  tableColumn: cols,
});
function entryOf(r: MapResult): MappedEntry {
  if (isSkip(r)) throw new Error(`skipped: ${r.skip}`);
  return r;
}

describe('customs benefits (A1)', () => {
  const row = (tin: string, name = '"ALFA SAVDO" MChJ') =>
    egovRow({
      KorxonaSTIRi: text(tin),
      Korxonanomi: text(`${name}      `),
      Jamiimtiyozsummasi: num(103669991.55),
      Bojxonayigimi: num(0),
      Bojxonaboji: num(81523292.11),
      Aksizsoligi: num(0),
      QQS: num(22146699.44),
    });

  it('keeps a company per STIR and period, the amounts in so‘m and real zeros', () => {
    const e = entryOf(customsBenefit.map(row('300000001'), ctx));
    expect(e).toMatchObject({
      sourceKey: '300000001:2026Q1',
      inn: '300000001',
      pinfl: null,
      name: '"ALFA SAVDO" MChJ',
      amount: 103669991.55,
      amountUnit: 'UZS',
      asOf: '2026-03-31',
    });
    expect(e.fields).toEqual({
      period: '2026Q1',
      customs_duty: 81523292.11,
      vat: 22146699.44,
      customs_fee: 0,
      excise: 0,
    });
  });

  it('keeps no name for an individual entrepreneur', () => {
    const e = entryOf(
      customsBenefit.map(row('400000001', 'TOSHMATOV ESHMAT'), ctx),
    );
    expect(e.name).toBeNull();
    expect(JSON.stringify(e.raw)).not.toContain('TOSHMATOV');
  });

  it('keeps a person by PINFL, with neither the PINFL nor the name in its key or raw row', () => {
    const pinfl = '30000000000001';
    const e = entryOf(customsBenefit.map(row(pinfl, 'TOSHMATOV ESHMAT'), ctx));
    expect(e.inn).toBeNull();
    expect(e.pinfl).toBe(pinfl);
    expect(e.sourceKey).toBe(`${personKey(pinfl)}:2026Q1`);
    expect(e.sourceKey).not.toContain(pinfl);
    expect(JSON.stringify(e.raw)).not.toContain(pinfl);
    expect(JSON.stringify(e.raw)).not.toContain('TOSHMATOV');
  });

  it('leaves out a row with no taxpayer number', () => {
    expect(customsBenefit.map(row('0'), ctx)).toEqual({
      skip: 'no taxpayer number',
    });
  });

  it('keys an upload that names no period by its day', () => {
    const e = entryOf(
      customsBenefit.map(row('300000001'), { ...ctx, period: null }),
    );
    expect(e.sourceKey).toBe('300000001:2026-04-13');
    expect(e.asOf).toBe('2026-04-13');
  });
});

describe('tax and customs benefits (A2)', () => {
  it('turns thousand so‘m into so‘m and never keeps the beneficiary', () => {
    const e = entryOf(
      taxCustomsBenefit.map(
        egovRow({
          Identifikatsiyaraqami: text('300000001'),
          Imtiyozlar1: lang('"ALFA SAVDO" MChJ'),
          Imtiyozlar2: lang(
            'Qo‘shilgan qiymat solig‘i',
            'Налог на добавленную стоимость',
            'Value added tax',
          ),
          Umumiyimtiyoz: text('1532013.4931'),
          Tolangansoliq: text('205'),
          Imtiyoz8: lang('TOSHMATOV ESHMAT'),
          nolovoy: lang('0'),
        }),
        { ...ctx, period: '2024Q2' },
      ),
    );
    expect(e.sourceKey).toBe('300000001:vat:2024Q2');
    expect(e.amount).toBe(1532013493);
    expect(e.fields).toMatchObject({ tax_paid: 205000, zero_rate_vat: 0 });
    expect(JSON.stringify(e.raw)).not.toContain('TOSHMATOV');
    expect(e.raw).not.toHaveProperty('Imtiyoz8');
  });

  it('names the eight tax types by code', () => {
    expect(taxTypeCode('Налог на прибыль', null)).toBe('profit');
    expect(taxTypeCode('Налог на доходы физических лиц', null)).toBe(
      'personal_income',
    );
    expect(taxTypeCode(null, 'Boshqa soliq')).toBe('boshqasoliq');
  });
});

describe('subsoil licences (A3)', () => {
  it('reads the series, number, type code and both dates out of one text', () => {
    expect(
      parseSubsoilLicence('QQ 0259 G5-сон  24.11.2023 от 24.11.2025'),
    ).toEqual({
      series: 'QQ',
      number: '0259',
      code: 'G5',
      issued: '2023-11-24',
      ends: '2025-11-24',
    });
    expect(
      parseSubsoilLicence('TV №440 F5 01.02.2020 от 29.02.2042'),
    ).toMatchObject({
      number: '440',
      ends: null,
    });
    expect(parseSubsoilLicence('no licence here')).toBeNull();
  });

  it('keys a licence by its plot and mineral, and drops the copy the portal sends', async () => {
    const row = (n: number) =>
      egovRow({
        Tartibraqami: num(n),
        Tashkilotnomi: text('"ALFA SAVDO" MChJ'),
        Soliqtolovchiningidentifikatsionraqami: num(300000001),
        Yerqariuchastkasinomi: text('Olmazor 1 uchastkasi'),
        Xomashyoturi: text('гранит'),
        Joylashganjoyituman: text('Amudaryo'),
        Yerqaridanfoydalanishturi: text('қидирув ишларини олиб бориш'),
        Yerqaridanfoydalanishvalitsenziyaniamalqilishmuddati: text(
          'QQ 0259 G5-сон  24.11.2023 от 24.11.2025',
        ),
      });
    const e = entryOf(subsoilLicence.map(row(1), ctx));
    expect(e).toMatchObject({
      sourceKey: 'QQ0259:olmazor1uchastkasi:гранит',
      inn: '300000001',
      number: 'QQ 0259',
      validFrom: '2023-11-24',
      validTo: '2025-11-24',
    });
    const send = jest.fn(async () => ({
      status: 200,
      data: { result: { count: 4, data: [row(1), row(1), row(2), row(2)] } },
      headers: {},
    }));
    const { HostPacer, RegistryHttp } = await import('../registry-http');
    const read = await subsoilLicence.fetchAll(
      new RegistryHttp(new HostPacer(0), null, send, 0),
      {},
    );
    expect(read.rows).toHaveLength(2);
    expect(read.complete).toBe(true);
  });
});

describe('tourism (A8, A9)', () => {
  it('tells a re-issued tour licence from the first by its date', () => {
    const row = (day: string) =>
      egovRow({
        LitsenziatSTIRraqami: num(300000001),
        Litsenziyaraqami: text('T-0001-01'),
        Berilgansanasi: text(day),
        Litsenziatnomivatashkiliyhuquqiyshakli: lang('"ALFA TUR" MChJ'),
      });
    const a = entryOf(tourOperatorLicence.map(row('2018-07-12'), ctx));
    const b = entryOf(tourOperatorLicence.map(row('2020-12-29'), ctx));
    expect(a.sourceKey).not.toBe(b.sourceKey);
  });

  it('keys a hotel certificate by company and site, and reads its dd/mm/yyyy dates', () => {
    const e = entryOf(
      hotelCertificate.map(
        egovRow({
          ObyektSTIRraqami: num(300000001),
          Royxatdanotgansertifikatraqami: text('UZ.SMT.02.0003.000001'),
          Sertifikatberilgansana: text('08/01/2026'),
          Sertifikatamalqilishmuddati: text('08/01/2031'),
          Manzil: lang('Navoiy ko‘chasi, 1-uy'),
          latitude: num(41.3),
          longitude: num(69.2),
        }),
        ctx,
      ),
    );
    expect(e.sourceKey).toBe(
      'UZ.SMT.02.0003.000001:300000001:NAVOIYKOCHASI1UY',
    );
    expect(e.validFrom).toBe('2026-01-08');
    expect(e.validTo).toBe('2031-01-08');
    expect(e.fields.coordinates).toEqual({ lat: 41.3, lng: 69.2 });
  });
});

describe('Central Bank workbooks', () => {
  it('reads the one-sheet layout', () => {
    const rows = cbuRows([
      {
        name: 'Лист1',
        rows: [
          [
            'ID',
            'LIC',
            'LIC_DATA',
            'LICENZIYAT_RUS',
            'LICENZIYAT_UZB',
            'LICENZIYAT_UZL',
            'LICENZIYAT_ENG',
            'INN',
            'ADRES_RUS',
            'ADRES_UZB',
            'ADRES_UZL',
            'ADRES_ENG',
            'GEO_ID',
          ],
          [
            1,
            12,
            '14.05.2019',
            'ООО',
            'МЧЖ',
            '"ALFA MIKROMOLIYA"\nmasʼuliyati cheklangan jamiyati',
            'LLC',
            300000001,
            'г. Ташкент',
            'Тошкент ш.',
            'Toshkent sh.',
            'Tashkent',
            '41.311081, 69.240562',
          ],
        ],
      },
    ]);
    expect(rows).toEqual([
      {
        inn: 300000001,
        name: '"ALFA MIKROMOLIYA"\nmasʼuliyati cheklangan jamiyati',
        number: 12,
        date: '14.05.2019',
        address: 'Toshkent sh.',
        geo: '41.311081, 69.240562',
      },
    ]);
  });

  it('reads the Latin sheet of the per-language layout', () => {
    const rows = cbuRows([
      {
        name: 'Рус',
        rows: [
          ['РЕЕСТР'],
          [],
          ['№', 'Наименование', '№ реестра', 'Дата', 'Адрес', 'ИНН'],
          [1, 'ООО', 1, '01.01.2020', 'г. Ташкент', 300000002],
        ],
      },
      {
        name: 'Лотин',
        rows: [
          ['REYESTR'],
          [],
          [
            '№',
            'Faktoring tashkiloti nomi',
            'Reyestr №',
            'Reyestrga kiritilgan sana',
            'Yuridik manzili',
            'STIR',
          ],
          [
            1,
            '"ALFA FAKTORING" MChJ',
            1,
            '01.01.2020',
            'Toshkent sh.',
            300000002,
          ],
        ],
      },
    ]);
    expect(rows).toEqual([
      {
        inn: 300000002,
        name: '"ALFA FAKTORING" MChJ',
        number: 1,
        date: '01.01.2020',
        address: 'Toshkent sh.',
      },
    ]);
  });
});

describe('capital market registers', () => {
  const details = (name: string, stir: string) =>
    `<strong>${name}</strong><br>Манзил: Тошкент ш.,<br>Навоий кўчаси, 1-уй.<br>Email: info@example.uz<br>СТИР: ${stir}<br>www.example.uz`;

  it('keeps name, address and STIR, never the e-mail; a footnote marks a suspension', () => {
    const html = `<table>
      <tr><td>т/р</td><td>Тўлиқ номи</td><td>a</td><td>b</td><td>c</td><td>d</td></tr>
      <tr><td>1</td><td>${details('«ALFA CAPITAL» МЧЖ', '300000001')}</td><td>1</td><td>0</td><td>1</td><td>4</td></tr>
      <tr><td>2</td><td>${details('«BETA INVEST» МЧЖ *', '300000002')}</td><td>1</td><td>1</td><td>1</td><td>3</td></tr>
    </table><p></p><p>* Изоҳ: “BETA INVEST” МЧЖга лицензияларнинг амал қилиши тўхтатилган.</p>`;
    const rows = parseNappProfessional(html);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      name: '«ALFA CAPITAL» МЧЖ',
      address: 'Тошкент ш., Навоий кўчаси, 1-уй.',
      stirText: '300000001',
      broker: '1',
      manager: '0',
      note: null,
    });
    expect(JSON.stringify(rows)).not.toContain('example.uz');
    expect(rows[1].note).toMatch(/тўхтатилган/);
  });

  it('reads the special regime: activity marks, number and the decision run together', () => {
    const cells = [
      '1',
      details('“ALFA BANK” акциядорлик жамияти', '300000003'),
      'Банк лицензияси № 1',
      '',
      '+',
      '',
      '',
      '',
      '#0001',
      '№ 1026.02.2024',
      '-',
    ];
    const html = `<table><tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr></table>`;
    const [row] = parseNappSpecialRegime(html);
    expect(row).toMatchObject({
      stirText: '300000003',
      activities: ['foreign_nominee_holder'],
      registration: '#0001',
      decision: '10',
      decisionDate: '2024-02-26',
      // "-" is the register's blank.
      deprived: null,
    });
  });
});

describe('pharmacy registers', () => {
  const retail = PHARMA_ADAPTERS.find(
    (a) => a.meta.code === 'pharma_licence_retail',
  )!;

  it('reads a licence per place and leaves out the moving timestamp', () => {
    const e = entryOf(
      retail.map(
        {
          id: 1,
          organization_name: '"ALFA FARM" MChJ',
          inn: '300000001',
          activity_address: 'Toshkent sh., Navoiy ko‘chasi, 1-uy',
          license_number: '1000001',
          registry_number: 'L-1000000000001',
          issue_date: '2026-10-02',
          expiry_date: '2031-10-02',
          is_active: 'True',
          updated_at: '2026-10-07T14:47:45+05:00',
        },
        ctx,
      ),
    );
    expect(e).toMatchObject({
      inn: '300000001',
      number: '1000001',
      isActive: true,
      validTo: '2031-10-02',
    });
    expect(e.sourceKey).toBe('L-1000000000001:TOSHKENTSHNAVOIYKOCHASI1UY');
    expect(e.raw).not.toHaveProperty('updated_at');
  });
});

describe('civil registers', () => {
  it('reads an NGO row array', () => {
    const e = entryOf(
      ngoRegistration.map(
        {
          0: 1,
          1: 'ALFA UYUSHMASI',
          2: 300000001,
          3: 'Toshkent sh.',
          4: '10000001',
          5: 'Toshkent sh., Navoiy ko‘chasi',
        },
        ctx,
      ),
    );
    expect(e).toMatchObject({ sourceKey: '300000001', name: 'ALFA UYUSHMASI' });
  });

  it('keeps an advocacy firm, never its director, phone or e-mail', () => {
    const e = entryOf(
      advocacyEntity.map(
        {
          id: 10,
          name: 'ALFA LAW',
          inn: '300000001',
          registerNumber: '1000001',
          directorFullName: 'TOSHMATOV ESHMAT',
          phone: '+998900000000',
          email: 'a@example.uz',
          reOrganizedDate: '13-10-2026',
          typeDto: {
            nameLt: 'Advokatlik byurosi',
            nameRu: 'Адвокатское бюро',
            nameEn: 'Advocacy bureau',
          },
          regionDto: {
            nameLt: 'Marhamat tumani',
            nameRu: 'Мархаматский район',
            nameEn: 'Markhamat district',
            parentNameLt: 'Andijon viloyati',
            parentNameRu: 'Андижанская область',
            parentNameEn: 'Andijan region',
          },
          address: 'Uzumzor MFY',
        },
        ctx,
      ),
    );
    const all = JSON.stringify(e);
    for (const personal of ['TOSHMATOV', '+998', 'example.uz', '13-10-2026']) {
      expect(all).not.toContain(personal);
    }
    expect(e.fields.entity_type).toEqual({
      uz: 'Advokatlik byurosi',
      ru: 'Адвокатское бюро',
      en: 'Advocacy bureau',
    });
  });

  it('reads the IT Park table, whose row number is a header cell', () => {
    const html = `<table>
      <tr><th>№</th><th>Юридическое лицо</th><th>ИНН</th><th>Почтовый адрес</th><th>Электронный адрес</th><th>Дата внесения в Реестр</th></tr>
      <tr><th>1</th><td>"ALFA SOFT" MChJ</td><td>300000001</td><td>NAVOIY KO'CHASI, 1-UY</td><td>Электронная почта</td><td>2019-08-20</td></tr>
    </table>`;
    expect(parseItParkResidents(html)).toEqual([
      {
        name: '"ALFA SOFT" MChJ',
        inn: '300000001',
        address: "NAVOIY KO'CHASI, 1-UY",
        registered_on: '2019-08-20',
      },
    ]);
  });
});

describe('registers read from a file', () => {
  it('names columns by their header, STIR in any spelling', () => {
    expect(headerKey('СТИР')).toBe('stir');
    expect(headerKey(' Valid From ')).toBe('valid_from');
  });

  it('reads a CSV and maps it, only the known fields shown', async () => {
    // Quotes inside a cell are doubled, as spreadsheets write them.
    const csv =
      'name;stir;number;included_on;basis;extra\n' +
      '"""ALFA AUDIT"" MChJ";300000001;12;01.02.2024;Buyruq 5;x\n';
    const rows = await uploadedRows(Buffer.from(csv), 'audit.csv');
    const audit = manualAdapter(
      'test_register',
      'professional',
      'registration',
      L('Sinov', 'Тест', 'Test'),
      {
        included_on: L('Kiritilgan', 'Включена', 'Entered'),
        basis: L('Asos', 'Основание', 'Grounds'),
      },
      1,
    );
    const e = entryOf(audit.map(rows[0], ctx));
    expect(e).toMatchObject({
      sourceKey: '300000001:12',
      name: '"ALFA AUDIT" MChJ',
      fields: { included_on: '2024-02-01', basis: 'Buyruq 5' },
    });
    expect(e.fields).not.toHaveProperty('extra');
  });

  it('refuses a file with no STIR column', async () => {
    await expect(
      uploadedRows(Buffer.from('a;b\n1;2\n'), 'x.csv'),
    ).rejects.toThrow(/STIR/);
  });
});
