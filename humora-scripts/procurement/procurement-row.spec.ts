import { dealInsert, notDealedInsert, tradeInsert } from './procurement-row';
import type {
  ProcurementDealFields,
  ProcurementTradeFields,
} from './procurement.service';

/**
 * The statement and its parameters are built from one list precisely so they
 * cannot drift apart. These check that they haven't — a misaligned INSERT
 * writes the wrong value into the wrong column and reports success.
 */

const deal = (
  over: Partial<ProcurementDealFields> = {},
): ProcurementDealFields =>
  ({
    deal_id: 1,
    display_no: '26120012509360',
    deal_date: '2026-09-10',
    start_cost: 100,
    deal_cost: 90,
    currency_name: 'Сум',
    participants_count: 3,
    customer_name: 'Buyurtmachi',
    customer_inn: '111111111',
    provider_name: 'Yetkazuvchi',
    provider_inn: '222222222',
    deal_status_name: 'Baённома',
    category_name: 'Lot nomi',
    trade_id: 7,
    customer_type_name: 'Korporativ buyurtmachi',
    proposal_status_name: 'Qabul qilingan',
    deal_contract_date: '2026-09-11',
    deal_contract_status_name: 'Imzolangan',
    deal_contract_kazna_status_name: 'Toʻlangan',
    deal_contract_kazna_status_id: 4,
    is_local_manufacturs: true,
    beneficiary: 'B',
    founder: 'F',
    contract_file_name: 'shartnoma.pdf',
    contract_file_path: '/files/shartnoma.pdf',
    contract_file_ext: 'pdf',
    contract_file_size: 12345,
    contract_file_date: '2026-09-11',
    protocol_file_name: 'bayonnoma.pdf',
    protocol_file_path: '/files/bayonnoma.pdf',
    protocol_file_ext: 'pdf',
    protocol_file_size_kb: 999,
    protocol_file_date: '2026-09-12',
    ...over,
  }) as ProcurementDealFields;

const trade = (
  over: Partial<ProcurementTradeFields> = {},
): ProcurementTradeFields =>
  ({
    id: 5,
    display_no: '26120012509999',
    name: 'Lot nomi',
    start_date: '2026-09-01',
    end_date: '2026-09-20',
    cost: 500,
    seller_name: 'Sotuvchi',
    seller_tin: '333333333',
    region_name: 'Toshkent',
    district_name: 'Chilonzor',
    currency_name: 'Сум',
    category_name: 'Kategoriya',
    clarific_date: '2026-09-10',
    seller_id: 42,
    ...over,
  }) as ProcurementTradeFields;

/** `$1, $2, …` in the VALUES list, in the order they appear. */
const placeholders = (sql: string) => sql.match(/\$\d+/g) ?? [];
/** The column list between the first pair of parentheses. */
const columns = (sql: string) =>
  (sql.match(/\(([^)]*)\)/)?.[1] ?? '').split(',').map((c) => c.trim());

describe.each([
  ['dealInsert', () => dealInsert('999999999', deal())],
  ['tradeInsert', () => tradeInsert('999999999', trade())],
])('%s — the statement matches its parameters', (_name, make) => {
  it('numbers its placeholders 1..n with no gaps or repeats', () => {
    const { sql } = make();
    const nums = placeholders(sql).map((p) => Number(p.slice(1)));
    expect(nums).toEqual(nums.map((_, i) => i + 1));
  });

  it('passes exactly one parameter per placeholder', () => {
    const { sql, params } = make();
    expect(params).toHaveLength(placeholders(sql).length);
  });

  it('names one column per value, counting the literal ones', () => {
    const { sql, params } = make();
    // Up to the clause that follows, not to the first `)` — one of the
    // literals is `now()`, and stopping inside it reads half the list.
    const values = (
      sql.match(/VALUES \((.*?)\) (?:ON CONFLICT|RETURNING)/)?.[1] ?? ''
    ).split(',');
    expect(columns(sql)).toHaveLength(values.length);
    // A value is either a placeholder with a parameter behind it or a
    // literal: `is_completed` on both kinds, and `enriched_at` on a deal.
    const literals = values.filter((v) => !v.trim().startsWith('$'));
    expect(literals.length).toBeGreaterThanOrEqual(1);
    expect(values.length - literals.length).toBe(params.length);
  });

  it('writes to company_deals', () => {
    expect(make().sql).toContain('INSERT INTO public.company_deals');
  });
});

describe('dealInsert', () => {
  it('marks the row completed', () => {
    const { sql } = dealInsert('999999999', deal());
    const i = columns(sql).indexOf('is_completed');
    expect(i).toBeGreaterThan(-1);
    expect(
      (sql.match(/VALUES \(([^)]*)\)/)?.[1] ?? '').split(',')[i].trim(),
    ).toBe('1');
  });

  it('lands each value in the column of the same name', () => {
    const { sql, params } = dealInsert('999999999', deal());
    const cols = columns(sql);
    const at = (c: string) => params[cols.indexOf(c)];

    expect(at('inn')).toBe('999999999');
    expect(at('contract_file_path')).toBe('/files/shartnoma.pdf');
    expect(at('contract_file_size')).toBe(12345);
    expect(at('protocol_file_name')).toBe('bayonnoma.pdf');
    // Declared in the mapper for a long time with nowhere to land.
    expect(at('deal_status_name')).toBe('Baённома');
    // A bigint column that existed but was never filled — it takes the id,
    // and the name it belongs to now has a column of its own.
    expect(at('kazna_status')).toBe(4);
    expect(at('kazna_status_name')).toBe('Toʻlangan');
    expect(at('is_local_manufacturs')).toBe(true);
    expect(at('trade_id')).toBe(7);
  });

  it('keeps the participant count as text, the way the column stores it', () => {
    const { sql, params } = dealInsert(
      '999999999',
      deal({ participants_count: 3 }),
    );
    expect(params[columns(sql).indexOf('pcp_count')]).toBe('3');
  });

  it('stores an unknown participant count as the empty string, not "null"', () => {
    const { sql, params } = dealInsert(
      '999999999',
      deal({ participants_count: null }),
    );
    expect(params[columns(sql).indexOf('pcp_count')]).toBe('');
  });
});

describe('tradeInsert', () => {
  it('marks the row not completed — a trade is still open', () => {
    const { sql } = tradeInsert('999999999', trade());
    const i = columns(sql).indexOf('is_completed');
    expect(
      (sql.match(/VALUES \(([^)]*)\)/)?.[1] ?? '').split(',')[i].trim(),
    ).toBe('0');
  });

  it('files the seller as the customer, which is what a trade has', () => {
    const { sql, params } = tradeInsert('999999999', trade());
    const cols = columns(sql);
    expect(params[cols.indexOf('customer_inn')]).toBe('333333333');
    expect(params[cols.indexOf('customer_name')]).toBe('Sotuvchi');
    // The lot's own name, not a category.
    expect(params[cols.indexOf('product_name')]).toBe('Lot nomi');
    expect(params[cols.indexOf('clarific_date')]).toBe('2026-09-10');
  });
});

/**
 * All three outcomes land in `company_deals`. `is_completed` stays the
 * boolean every existing reader treats it as, and `lot_outcome` carries the
 * distinction a third value would have hidden.
 */
describe('lot_outcome — three fates, one table', () => {
  const lot = (over: Record<string, unknown> = {}) =>
    ({
      trade_id: 510168,
      display_no: '26120012510168',
      start_date: '2026-09-03',
      end_date: '2026-09-10',
      category_name: 'Avtokran ijarasi',
      start_cost: 99315402,
      participants_count: 0,
      customer_name: 'OZBEKNEFTGAZ',
      customer_inn: '200837914',
      is_local_manufacturs: true,
      status_id: 12,
      status_name: 'Торг не состоялся',
      ...over,
    }) as never;

  const at = (q: { sql: string; params: unknown[] }, column: string) =>
    q.params[
      (q.sql.match(/\(([^)]*)\)/)?.[1] ?? '')
        .split(',')
        .map((c) => c.trim())
        .indexOf(column)
    ];

  const literal = (q: { sql: string }, column: string) => {
    const cols = (q.sql.match(/\(([^)]*)\)/)?.[1] ?? '')
      .split(',')
      .map((c) => c.trim());
    const values = (q.sql.match(/VALUES \(([^)]*)\)/)?.[1] ?? '').split(',');
    return values[cols.indexOf(column)]?.trim();
  };

  it.each([
    ['dealInsert', () => dealInsert('9', deal()), 'deal', '1'],
    ['tradeInsert', () => tradeInsert('9', trade()), 'active', '0'],
    ['notDealedInsert', () => notDealedInsert('9', lot()), 'not_dealed', '0'],
  ])('%s marks the row %s', (_n, make, outcome, completed) => {
    const q = make();
    expect(at(q, 'lot_outcome')).toBe(outcome);
    expect(literal(q, 'is_completed')).toBe(completed);
  });

  it('files a failed lot with its reason and no provider', () => {
    const q = notDealedInsert('9', lot());
    expect(at(q, 'lot_status_name')).toBe('Торг не состоялся');
    expect(at(q, 'lot_status_id')).toBe(12);
    expect(at(q, 'trade_id')).toBe(510168);
    // Nobody won it, so there is nothing to record on the provider side.
    const cols = (q.sql.match(/\(([^)]*)\)/)?.[1] ?? '').split(',');
    expect(cols.map((c) => c.trim())).not.toContain('provider_inn');
  });

  it('keeps "nobody bid" as a zero, not an empty string', () => {
    const q = notDealedInsert('9', lot({ participants_count: 0 }));
    expect(at(q, 'pcp_count')).toBe('0');
  });

  it('writes an unknown bidder count as empty, the way the column stores it', () => {
    const q = notDealedInsert('9', lot({ participants_count: null }));
    expect(at(q, 'pcp_count')).toBe('');
  });
});
