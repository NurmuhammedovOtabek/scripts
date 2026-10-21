import { isSkip, MappedEntry, MapResult } from '../registry-types';
import {
  auditFirm,
  hostelRegistration,
  medicalWellness,
  PDF_SPECS,
  publicInterestEntity,
  sanepidCertificateRows,
  sanepidConclusionRows,
  sanepidRows,
  sanitaryConclusion,
  stirIn,
  tourismAccommodation,
} from './gov-pdf.adapters';

const ctx = { editionDate: '2025-12-31', period: null, today: '2026-10-15' };
const edition = '2025-12-31';
function entryOf(r: MapResult): MappedEntry {
  if (isSkip(r)) throw new Error(`skipped: ${r.skip}`);
  return r;
}

describe('PDF registers on gov.uz', () => {
  it('names no person column in any table spec', () => {
    const headers = Object.values(PDF_SPECS)
      .flatMap((s) => s.columns.map((c) => c.header.source))
      .join(' ');
    for (const personal of [
      'F\\.I\\.Sh',
      'Ф\\.И',
      'Telefon',
      'телефон',
      'почта',
      'rahbar',
      'Масъул',
    ]) {
      expect(headers).not.toMatch(new RegExp(personal, 'i'));
    }
  });

  it('reads a STIR spaced out, or repeated by a page break', () => {
    expect(stirIn('309 007 505')).toBe('309007505');
    expect(stirIn('300000001\n300000001')).toBe('300000001');
    expect(stirIn('')).toBeNull();
  });

  it('keeps an audit firm with its dates and a count of auditors, no names', () => {
    const e = entryOf(
      auditFirm.map(
        {
          no: '1.',
          name: '"ALFA AUDIT"\nMChJ',
          included: '01.06.2021',
          excluded: '',
          address: 'Toshkent sh.',
          stir: '300 000 001',
          certificates: '№ 05392 11.06.2020\n№ 06105 20.11.2021',
          __edition: edition,
        } as any,
        ctx,
      ),
    );
    expect(e).toMatchObject({
      sourceKey: '300000001',
      name: '"ALFA AUDIT" MChJ',
      status: 'active',
      isActive: true,
      validFrom: '2021-06-01',
      asOf: edition,
    });
    expect(e.fields).toEqual({
      included_on: '2021-06-01',
      auditors: 2,
      address: 'Toshkent sh.',
    });
  });

  it('marks an audit firm the register removed', () => {
    const e = entryOf(
      auditFirm.map(
        {
          no: '1',
          name: '"BETA AUDIT" MChJ',
          included: '05.09.2022',
          excluded: '04.12.2025',
          address: '',
          stir: '300000002',
          certificates: '',
        } as any,
        ctx,
      ),
    );
    expect(e).toMatchObject({ status: 'withdrawn', isActive: false });
    expect(e.fields.excluded).toBe('04.12.2025');
  });

  it('keeps a public interest entity per year with its criterion', () => {
    const e = entryOf(
      publicInterestEntity.map(
        {
          no: '1',
          name: '"ALFA" AJ',
          year: '2026',
          criteria: 'M1',
          form: 'Aksiyadorlik jamiyati',
          stir: '300000001',
          region: 'Navoiy viloyati',
        } as any,
        ctx,
      ),
    );
    expect(e).toMatchObject({
      sourceKey: '300000001:2026',
      fields: {
        year: 2026,
        criteria: 'M1',
        legal_form: 'Aksiyadorlik jamiyati',
        region: 'Navoiy viloyati',
      },
    });
  });

  it('reads the day a later edition writes for the year, and criteria run together', () => {
    const e = entryOf(
      publicInterestEntity.map(
        {
          no: '1',
          name: '"ALFA" AJ',
          year: '23.07.2026',
          criteria: 'M1M6',
          form: 'Aksiyadorlik jamiyati',
          stir: '300000001',
          region: 'Navoiy viloyati',
        } as any,
        ctx,
      ),
    );
    expect(e).toMatchObject({
      sourceKey: '300000001:2026',
      validFrom: '2026-07-23',
      fields: { year: 2026, included_on: '2026-07-23', criteria: 'M1, M6' },
    });
  });

  it('keeps an accommodation’s category, rooms and beds; skips the column-number row', () => {
    const row = {
      no: '1',
      region: 'Buxoro viloyati',
      name: '"ALFA HOTEL" MChJ',
      stir: '300000001',
      legal_address: 'Buxoro sh.',
      blank: '0001234',
      certificate: 'UZ.SMT.02.0003.000001',
      issued: '08.01.2026',
      valid_to: '08.01.2031',
      district: 'Buxoro',
      site_address: 'Navoiy ko‘chasi, 1',
      site_name: 'ALFA',
      site_type: 'mehmonxona',
      rooms: '30',
      beds: '60',
      stars: '3',
      opened: '2015',
    };
    const e = entryOf(tourismAccommodation.map(row as any, ctx));
    expect(e).toMatchObject({
      number: 'UZ.SMT.02.0003.000001',
      validFrom: '2026-01-08',
      validTo: '2031-01-08',
    });
    expect(e.fields).toMatchObject({
      stars: 3,
      rooms: 30,
      beds: 60,
      opened: 2015,
      site_type: 'mehmonxona',
    });
    expect(
      tourismAccommodation.map(
        { ...row, stir: '4', certificate: '8' } as any,
        ctx,
      ),
    ).toEqual({ skip: 'taxpayer number not a STIR' });
  });

  it('keeps a hostel without the applicant’s name, phone or e-mail', () => {
    const e = entryOf(
      hostelRegistration.map(
        {
          no: '1',
          region: 'Toshkent sh.',
          subject: '"ALFA" MChJ',
          name: 'ALFA HOSTEL',
          stir: '300 000 001',
          district: 'Yunusobod',
          address: 'Navoiy ko‘chasi, 1',
          registry_no: '№ 0009-02',
          registered_on: '01.02.2026',
          rooms: '14',
          beds: '40',
          jobs: '5',
        } as any,
        ctx,
      ),
    );
    expect(e).toMatchObject({
      inn: '300000001',
      number: '№ 0009-02',
      validFrom: '2026-02-01',
      fields: { hostel: 'ALFA HOSTEL', rooms: 14, beds: 40, jobs: 5 },
    });
  });

  it('keeps a hostel a person registered by PINFL, without the PINFL, name or street', () => {
    const r = entryOf(
      hostelRegistration.map(
        {
          no: '2',
          region: 'Toshkent sh.',
          subject: 'TOSHMATOV ESHMAT',
          name: 'ALFA HOSTEL',
          stir: '30000000000001',
          district: 'Yunusobod',
          address: 'Navoiy ko‘chasi, 1',
          registry_no: '05-00001',
          registered_on: '01.02.2026',
          rooms: '4',
          beds: '10',
          jobs: '2',
        } as any,
        ctx,
      ),
    );
    expect(r).toMatchObject({
      inn: null,
      pinfl: '30000000000001',
      name: null,
      fields: { hostel: 'ALFA HOSTEL', district: 'Yunusobod' },
    });
    expect(r.fields.address).toBeUndefined();
    const shown = JSON.stringify({
      key: r.sourceKey,
      raw: r.raw,
      fields: r.fields,
    });
    expect(shown).not.toContain('30000000000001');
    expect(shown).not.toContain('TOSHMATOV');
    expect(shown).not.toContain('Navoiy');
  });

  it('splits the medical register’s STIR from the registration number beside it', () => {
    const e = entryOf(
      medicalWellness.map(
        {
          no: '1',
          name: '"ALFA MED" MChJ',
          stir_reg: '300000001 / 123456',
          address: 'Toshkent sh.',
        } as any,
        ctx,
      ),
    );
    expect(e).toMatchObject({
      inn: '300000001',
      fields: {
        site_name: '"ALFA MED" MChJ',
        state_registration: '/ 123456',
        address: 'Toshkent sh.',
      },
    });
    expect(
      medicalWellness.map(
        {
          no: '2',
          name: 'Oilaviy shifokorlik punkti',
          stir_reg: '',
          address: '',
        } as any,
        ctx,
      ),
    ).toEqual({ skip: 'no STIR' });
  });

  describe('sanitary conclusions', () => {
    const product = (over: Record<string, string> = {}) => ({
      no: '1',
      applicant: '"ALFA FOOD" MChJ',
      applicant_inn: '300000001',
      importer: '"ALFA FOOD" MChJ',
      importer_inn: '300000001',
      exporter: 'GAMMA FOODS LTD',
      exporter_inn: '',
      application_no: '30000000120260000001',
      application_date: '25-06-2026',
      product: 'Напиток сокосодержащий',
      hs_code: '2202100009',
      direction: 'Импорт Импорт',
      permit_no: 'UZ-GSN-GSN23-2026-0000001',
      permit_date: '30-06-2026',
      status_code: '106',
      outcome: 'Одобрени е',
      ...over,
    });

    it('gathers a conclusion’s products per company, with every role it has', () => {
      const rows = sanepidRows(
        [
          product(),
          product({ product: 'Сок яблочный', hs_code: '2009790000' }),
        ],
        '2026Q3',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        inn: '300000001',
        roles: ['applicant', 'importer'],
        permitNo: 'UZ-GSN-GSN23-2026-0000001',
        direction: 'Импорт',
        status: 'approved',
        note: null,
        products: ['Напиток сокосодержащий', 'Сок яблочный'],
        hsCodes: ['2202100009', '2009790000'],
        counterparties: ['GAMMA FOODS LTD'],
        period: '2026Q3',
      });
    });

    it('keeps no application number that starts with a person’s PINFL', () => {
      const [row] = sanepidRows(
        [
          product({
            applicant: 'TOSHMATOV ESHMAT',
            applicant_inn: '30000000000001',
            application_no: '3000000000000120260001',
            permit_no: '',
          }),
        ],
        '2026Q3',
      );
      expect(row.roles).toEqual(['importer']);
      expect(row.applicationNo).toBeNull();
      const e = entryOf(sanitaryConclusion.map(row, ctx));
      expect(JSON.stringify(e)).not.toContain('30000000000001');
      expect(JSON.stringify(e)).not.toContain('TOSHMATOV');
    });

    it('names no person, and keeps the source’s words when they are not a state', () => {
      const [row] = sanepidRows(
        [
          product({
            importer_inn: '',
            importer: '',
            exporter: 'TOSHMATOV ESHMAT',
            outcome: 'Sklad manzili ko‘rsatilmagan',
          }),
        ],
        '2026Q3',
      );
      expect(row.counterparties).toEqual([]);
      expect(row.status).toBeNull();
      expect(row.note).toBe('Sklad manzili ko‘rsatilmagan');
    });

    it('reads the 2026 Q1 layout: products numbered in one cell, validity, remark', () => {
      const [row] = sanepidConclusionRows(
        [
          {
            no: '1',
            applicant: '"ALFA FOOD" MChJ',
            applicant_inn: '300000001',
            product: '1) Сыворотка молочная сухая\n2) Молоко сухое',
            country: 'Беларусь',
            permit_no: 'UZ-GSN-GSN23-2026-0000001',
            permit_date: '12-01-2026',
            validity: 'дан: 12-01-2026, гача: 12-01-2027',
            shortfall: '',
          },
          {
            no: '2',
            applicant: 'TOSHMATOV ESHMAT',
            applicant_inn: '30000000000001',
            product: '1) Сок',
            country: 'Турция',
            permit_no: 'UZ-GSN-GSN23-2026-0000002',
            permit_date: '13-01-2026',
            validity: '',
            shortfall: '',
          },
        ],
        '2026Q1',
      ).map((r) => r);
      expect(row).toMatchObject({
        inn: '300000001',
        roles: ['applicant'],
        products: ['Сыворотка молочная сухая', 'Молоко сухое'],
        country: 'Беларусь',
        permitDate: '2026-01-12',
        validTo: '2027-01-12',
        status: 'approved',
        period: '2026Q1',
      });
      // A person's PINFL row is not kept.
      expect(
        sanepidConclusionRows(
          [{ applicant_inn: '30000000000001', permit_no: 'UZ-1' } as any],
          '2026Q1',
        ),
      ).toEqual([]);
      const e = entryOf(sanitaryConclusion.map(row, ctx));
      expect(e).toMatchObject({
        validTo: '2027-01-12',
        fields: { country: 'Беларусь' },
      });
    });

    it('marks a 2026 Q1 conclusion whose products fall short, in its words', () => {
      const [row] = sanepidConclusionRows(
        [
          {
            applicant: '"ALFA" MChJ',
            applicant_inn: '300000001',
            product: '1) Сок',
            permit_no: 'UZ-GSN-GSN23-2026-0000003',
            permit_date: '14-01-2026',
            validity: '',
            shortfall: 'Не соответствует',
          } as any,
        ],
        '2026Q1',
      );
      expect(row).toMatchObject({ status: null, note: 'Не соответствует' });
    });

    it('reads the 2025 Q1 layout, its short days and quarter-keyed numbers', () => {
      const rows = sanepidCertificateRows(
        [
          {
            no: '1',
            certificate: '466592',
            issued: '03 01 25',
            valid_to: '02 01 28',
            organisation: 'ООО “ALFA SNACKS”',
            product: 'Протеиновый батончик',
            country: 'Россия',
            inn: '300000001',
          },
          {
            no: '1',
            certificate: '466593',
            issued: '03 01 25',
            valid_to: '',
            organisation: '"BETA" MChJ',
            product: 'Сок',
            country: 'Турция',
            inn: '',
          },
        ],
        '2025Q1',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        ref: '2025Q1:466592',
        permitNo: '466592',
        permitDate: '2025-01-03',
        validTo: '2028-01-02',
        products: ['Протеиновый батончик'],
        status: 'approved',
      });
    });

    it('maps a conclusion to an entry under its permit', () => {
      const [row] = sanepidRows([product()], '2026Q3');
      const e = entryOf(sanitaryConclusion.map(row, ctx));
      expect(e).toMatchObject({
        sourceKey: '2026Q3:UZ-GSN-GSN23-2026-0000001:300000001',
        number: 'UZ-GSN-GSN23-2026-0000001',
        validFrom: '2026-06-30',
        fields: {
          period: '2026Q3',
          direction: 'Импорт',
          hs_codes: '2202100009',
        },
      });
      expect(e.fields.role).toEqual({
        uz: 'Ariza beruvchi, Import qiluvchi',
        ru: 'Заявитель, Импортёр',
        en: 'Applicant, Importer',
      });
      expect(e.fields.outcome).toEqual({
        uz: 'Ruxsat berilgan',
        ru: 'Одобрено',
        en: 'Approved',
      });
    });
  });
});
