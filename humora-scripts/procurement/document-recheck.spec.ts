import { DOCUMENT_RECHECK_DAYS, recheckDealDocuments } from './deal-sync';
import type { ProcurementDealFields } from './procurement.service';

const deal = (
  over: Partial<ProcurementDealFields> = {},
): ProcurementDealFields =>
  ({
    deal_id: 174419,
    display_no: '26120012507419',
    deal_date: '2026-08-26T10:17:35',
    deal_cost: 9000000,
    currency_name: 'Сум',
    customer_inn: '203195074',
    provider_inn: '312387381',
    contract_file_path: null,
    protocol_file_path: 'tender/user-files/2026/9/3/protocol.pdf',
    ...over,
  }) as ProcurementDealFields;

/** A held row still missing a document, as the SELECT returns it. */
const held = (over: Record<string, unknown> = {}) => ({
  deal_id: '174419',
  lot_display_no: '26120012507419',
  no_contract: true,
  no_protocol: false,
  ...over,
});

/**
 * A fake table: the SELECT of each side answers with that side's held rows,
 * and every other statement is an upsert that reports the row it touched.
 */
const build = (missing: Record<string, unknown[]> = {}) => {
  const queries: { sql: string; params?: unknown[] }[] = [];
  const logs: string[] = [];
  let id = 100;
  const deps = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes('AS no_contract')) {
        return (
          missing[
            sql.includes('customer_inn = $1') ? 'customer' : 'provider'
          ] ?? []
        );
      }
      return [{ id: id++, inserted: false }];
    }),
    logger: {
      log: (m: string) => logs.push(`LOG ${m}`),
      error: (m: string) => logs.push(`ERROR ${m}`),
    },
  };
  return { deps, queries, logs };
};

/**
 * A deal is stored the week it closes, and its contract arrives later — a
 * median of 16 days after the deal. Once every deal is held the list is not
 * read again, so a contract attached after the first sync never reached the
 * page: deal 174419 of 203195074 is stored without the contract the source
 * has had since.
 */
describe('recheckDealDocuments', () => {
  it("asks only about this side's recent deals still missing a document", async () => {
    const { deps, queries } = build();
    await recheckDealDocuments(
      deps,
      '203195074',
      ['customer'],
      jest.fn(),
      new Set(),
    );
    const [select] = queries;
    expect(select.sql).toContain('customer_inn = $1');
    expect(select.sql).not.toContain('provider_inn = $1');
    expect(select.sql).toContain(
      '(contract_file_path IS NULL OR protocol_file_path IS NULL)',
    );
    expect(select.sql).toContain("lot_outcome = 'deal'");
    expect(select.params).toEqual(['203195074', DOCUMENT_RECHECK_DAYS]);
  });

  it('asks the source nothing when no held deal is missing a document', async () => {
    const { deps } = build();
    const fetchLot = jest.fn();
    const r = await recheckDealDocuments(
      deps,
      '203195074',
      ['customer', 'provider'],
      fetchLot,
      new Set(),
    );
    expect(fetchLot).not.toHaveBeenCalled();
    expect(r).toMatchObject({ asked: 0, filled: 0, ids: [] });
  });

  it('asks once per lot, even when the lot holds two deals', async () => {
    const { deps } = build({
      customer: [held({ deal_id: '158330' }), held({ deal_id: '174574' })],
    });
    const fetchLot = jest
      .fn()
      .mockResolvedValue([
        deal({ deal_id: 158330 }),
        deal({ deal_id: 174574 }),
      ]);
    const r = await recheckDealDocuments(
      deps,
      '203195074',
      ['customer'],
      fetchLot,
      new Set(),
    );
    expect(fetchLot).toHaveBeenCalledTimes(1);
    expect(fetchLot).toHaveBeenCalledWith('26120012507419', 'customer');
    expect(r.asked).toBe(1);
  });

  it('writes what the source now has and hands the rows on for mirroring', async () => {
    const { deps, queries } = build({ customer: [held()] });
    const fetchLot = jest
      .fn()
      .mockResolvedValue([
        deal({ contract_file_path: '/files/2026/9/14/contract.pdf' }),
      ]);
    const r = await recheckDealDocuments(
      deps,
      '203195074',
      ['customer'],
      fetchLot,
      new Set(),
    );
    expect(r.filled).toBe(1);
    expect(r.ids).toEqual([100]);
    expect(queries[1].sql).toContain(
      'ON CONFLICT (inn, lot_display_no, deal_id, trade_id)',
    );
  });

  it('does not count a deal that is still missing what it was missing', async () => {
    const { deps } = build({ customer: [held()] });
    // The protocol was never the gap; a contract still absent is not news.
    const fetchLot = jest.fn().mockResolvedValue([deal()]);
    const r = await recheckDealDocuments(
      deps,
      '203195074',
      ['customer'],
      fetchLot,
      new Set(),
    );
    expect(r.filled).toBe(0);
  });

  it('keeps going when the source will not answer for one lot', async () => {
    const { deps, logs } = build({
      provider: [
        held({ lot_display_no: '26120012500001', deal_id: '1' }),
        held({ lot_display_no: '26120012500002', deal_id: '2' }),
      ],
    });
    const fetchLot = jest
      .fn()
      .mockRejectedValueOnce(new Error('timeout of 15000ms exceeded'))
      .mockResolvedValueOnce([
        deal({
          deal_id: 2,
          display_no: '26120012500002',
          contract_file_path: '/files/2026/9/14/c.pdf',
        }),
      ]);
    const r = await recheckDealDocuments(
      deps,
      '203195074',
      ['provider'],
      fetchLot,
      new Set(),
    );
    expect(fetchLot).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ asked: 2, filled: 1 });
    expect(
      logs.some((l) => l.startsWith('ERROR') && l.includes('26120012500001')),
    ).toBe(true);
  });

  it('asks about the sides it is given, and only those', async () => {
    const { deps, queries } = build({
      customer: [held()],
      provider: [held({ lot_display_no: '26120012500009' })],
    });
    const fetchLot = jest.fn().mockResolvedValue([]);
    await recheckDealDocuments(
      deps,
      '203195074',
      ['provider'],
      fetchLot,
      new Set(),
    );
    expect(fetchLot).toHaveBeenCalledTimes(1);
    expect(fetchLot).toHaveBeenCalledWith('26120012500009', 'provider');
    expect(
      queries.filter((q) => q.sql.includes('AS no_contract')),
    ).toHaveLength(1);
  });
});
