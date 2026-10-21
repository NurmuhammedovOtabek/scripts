import {
  factContentOf,
  mapFactListItem,
  mapOrganization,
  parseAmount,
  reportLines,
  stirOf,
} from './openinfo-map';
import {
  MASK,
  factHighlight,
  renderFact,
} from '../../org/openinfo/openinfo-catalogue';

describe('openinfo map', () => {
  it('reads amounts in the portal’s spellings, and nothing else', () => {
    expect(parseAmount('503 395 875,00')).toBe(503395875);
    expect(parseAmount('334700000.00')).toBe(334700000);
    expect(parseAmount('1 280,5')).toBe(1280.5);
    expect(parseAmount('1.234,56')).toBe(1234.56);
    expect(parseAmount('1,234.56')).toBe(1234.56);
    expect(parseAmount(42)).toBe(42);
    expect(parseAmount('12 mln')).toBeNull();
    expect(parseAmount('1.2.3')).toBeNull();
    expect(parseAmount('')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });

  it('ties an organisation to a company only by a nine-digit STIR', () => {
    expect(stirOf(300000001)).toBe('300000001');
    expect(stirOf('12345678')).toBeNull();
    expect(stirOf('30000000112345')).toBeNull();
    const row = mapOrganization({
      id: 7,
      inn: 300000001,
      full_name_text: ' "NAMUNA" AJ ',
      exchange_ticket_name: 'NMNA',
      is_listing: true,
      listing_date: '2020-05-14',
      is_subscribed: true,
    });
    expect(row).toMatchObject({
      org_id: 7,
      inn: '300000001',
      full_name: '"NAMUNA" AJ',
      ticker: 'NMNA',
      is_listing: true,
      listing_date: '2020-05-14',
    });
    // A reader's subscription is not the organisation's content.
    expect(row.raw).not.toHaveProperty('is_subscribed');
    const again = mapOrganization({
      id: 7,
      inn: 300000001,
      full_name_text: ' "NAMUNA" AJ ',
      exchange_ticket_name: 'NMNA',
      is_listing: true,
      listing_date: '2020-05-14',
      is_subscribed: false,
    });
    expect(again.content_hash).toBe(row.content_hash);
  });

  it('reads a fact list item, its time on Tashkent’s clock', () => {
    const row = mapFactListItem({
      id: 99837,
      organization: 7,
      fact_number: 8,
      object_id: 123,
      fact_title: 'Изменения в НС',
      pub_date: '2026-10-16 10:21:47',
    });
    expect(row).toMatchObject({ id: 99837, org_id: 7, fact_number: 8 });
    expect(row?.pub_date).toBe('2026-10-16T10:21:47.000+05:00');
    expect(
      mapFactListItem({ id: 1, organization: 7, fact_number: 'x' }),
    ).toBeNull();
  });

  it('keeps a fact’s own content, not the organisation it repeats', () => {
    expect(
      factContentOf({
        id: 1,
        fact: [
          {
            organization: { id: 7 },
            organization_name: 'NAMUNA',
            org_email: 'a@b.uz',
            transaction_amount: '100',
          },
        ],
      }),
    ).toEqual({ transaction_amount: '100' });
    expect(factContentOf({ id: 1, fact: [] })).toBeNull();
    expect(factContentOf(null)).toBeNull();
  });

  it('keeps statement line codes, not the portal’s ids', () => {
    const lines = reportLines({
      id: 1,
      reporting_year: 2025,
      accounting_report: [
        {
          title_id: 24,
          title: 'АКТИВ',
          tnum: '000',
          value1: 0,
          value2: 0,
          is_title: true,
        },
        {
          title_id: 27,
          title: 'Основные средства',
          tnum: '010',
          value1: 5,
          value2: 6,
        },
        { title_id: 235, title: 'Доходы', value: 7 },
      ],
    });
    expect(lines.map((l) => l.code)).toEqual([null, '010', null]);
    expect(lines[1]).toMatchObject({ start: 5, end: 6 });
    expect(lines[2]).toMatchObject({ value: 7 });
  });
});

describe('openinfo catalogue', () => {
  const deal = {
    id: 1,
    fact_number: '21',
    author_first_name: 'ESHMAT',
    name_counterparty: '"NAMUNA SAVDO" MChJ',
    transaction_amount: '503 395 875,00',
    carrying_value: 1200,
    date_transaction: '2026-10-10',
    head_person_name: 'TOSHMATOV ESHMAT',
    protocol_meeting_pdf: 'https://openinfo.uz/media/x.pdf',
    factslistaffiliates: [
      {
        id: 3,
        main: 1,
        num: 1,
        all_name: 'TOSHMATOV ESHMAT',
        basis: 27,
        basis_name: 'Rahbar',
        date_ground: '2026-10-15',
      },
    ],
  };

  it('labels the fields, states the units, keeps the signatories apart', () => {
    const out = renderFact(21, deal, false);
    const keys = out.fields.map((f) => f.key);
    expect(keys).toEqual([
      'name_counterparty',
      'transaction_amount',
      'carrying_value',
      'date_transaction',
    ]);
    expect(out.fields[1]).toMatchObject({ kind: 'som', value: 503395875 });
    expect(out.fields[2]).toMatchObject({ kind: 'thousand_som', value: 1200 });
    expect(out.signatories).toEqual([
      expect.objectContaining({
        key: 'head_person_name',
        value: 'TOSHMATOV ESHMAT',
      }),
    ]);
    // The portal's poster, its uploads and its codes are not shown.
    expect(JSON.stringify(out)).not.toContain('author');
    expect(JSON.stringify(out)).not.toContain('.pdf');
    expect(out.tables[0].columns.map((c) => c.key)).toEqual([
      'num',
      'all_name',
      'basis_name',
      'date_ground',
    ]);
  });

  it('shows a reader without full access the labels and dates only', () => {
    const out = renderFact(21, deal, true);
    const byKey = Object.fromEntries(out.fields.map((f) => [f.key, f.value]));
    expect(byKey).toEqual({
      name_counterparty: MASK,
      transaction_amount: MASK,
      carrying_value: MASK,
      date_transaction: '2026-10-10',
    });
    expect(out.signatories[0].value).toBe(MASK);
    expect(out.tables[0].rows[0]).toEqual({
      num: 1,
      all_name: MASK,
      basis_name: MASK,
      date_ground: '2026-10-15',
    });
    expect(factHighlight(21, deal, true)).toEqual({
      label: expect.objectContaining({ en: 'Deal amount' }),
      amount: MASK,
      kind: 'som',
      party: MASK,
    });
    expect(factHighlight(21, deal, false)).toEqual({
      label: expect.objectContaining({ en: 'Deal amount' }),
      amount: 503395875,
      kind: 'som',
      party: '"NAMUNA SAVDO" MChJ',
    });
  });

  it('leaves out a class of security the company does not have', () => {
    const out = renderFact(
      32,
      {
        sum_aksiya: '1280.0000',
        one_procent: '128.00',
        sum_aksiya2: '0.0000',
        one_procent2: '0.00',
        person_emitet: 'extraordinary_general_meeting',
      },
      false,
    );
    // The decision first, then the fact's own fields (the stored jsonb has
    // lost the portal's order).
    expect(out.fields.map((f) => f.key)).toEqual([
      'person_emitet',
      'sum_aksiya',
      'one_procent',
    ]);
    expect(out.fields[0].value).toEqual(
      expect.objectContaining({ en: 'Extraordinary general meeting' }),
    );
  });

  it('highlights the first class of security a dividend is declared on', () => {
    const h = factHighlight(
      32,
      { sum_aksiya: '0.0000', sum_aksiya2: '633.0000' },
      false,
    );
    expect(h).toMatchObject({
      amount: 633,
      kind: 'som',
      label: expect.objectContaining({ en: 'Dividend per preferred share' }),
    });
  });

  it('shows no unexplained numeric code', () => {
    const out = renderFact(
      27,
      { organ: 3, paper_type: 1, date_decision: '2024-04-02' },
      false,
    );
    expect(out.fields.map((f) => f.key)).toEqual(['date_decision']);
  });
});

describe('mapFactListItem — a fact with no object', () => {
  it('keeps object_id null, not 0', () => {
    for (const object_id of [null, undefined, '']) {
      const row = mapFactListItem({
        id: 1,
        organization: 7,
        fact_number: 25,
        object_id,
      } as never);
      expect(row?.object_id).toBeNull();
    }
    expect(
      mapFactListItem({
        id: 1,
        organization: 7,
        fact_number: 25,
        object_id: '0',
      } as never)?.object_id,
    ).toBe(0);
  });
});
