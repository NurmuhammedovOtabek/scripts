import axios from 'axios';
import { ProcurementScriptService } from './procurement.service';

jest.mock('axios');
const mockedPost = axios.post as jest.MockedFunction<typeof axios.post>;

/**
 * A deal exactly as `apietender.uzex.uz/api/common/DealsList` sends it — the
 * field names are the API's, including the ones that do not match ours:
 * `contract_file_sizes` for a single file's size, and the
 * `additional_protocol_*` prefix we shorten to `protocol_*`.
 */
const rawDeal = (over: Record<string, unknown> = {}) => ({
  deal_id: 55,
  trade_id: 77,
  display_no: 26120012509360,
  deal_date: '2026-09-10T00:00:00',
  start_cost: 10258639104,
  deal_cost: 9000000000,
  currency_name: 'Сум',
  participants_count: 4,
  customer_name: 'YANGI ANGREN IES',
  customer_type_name: 'Korporativ buyurtmachi',
  customer_inn: '203366731',
  provider_name: 'Yetkazuvchi MCHJ',
  provider_inn: '312387381',
  deal_status_name: 'Баённома шакллантирилган',
  proposal_status_name: 'Qabul qilingan',
  deal_contract_date: '2026-09-12T00:00:00',
  deal_contract_status_name: 'Imzolangan',
  deal_contract_kazna_status_name: 'Toʻlangan',
  deal_contract_kazna_status_id: 3,
  category_name: 'Umumstansiya energoqurilmalari',
  is_local_manufacturs: 1,
  beneficiary: 'Benefitsiar',
  founder: 'Muassis',
  contract_file_name: 'shartnoma',
  contract_file_path: '/files/2026/shartnoma.pdf',
  contract_file_ext: '.pdf',
  contract_file_sizes: '204800',
  contract_file_date: '2026-09-12T10:00:00',
  additional_protocol_file_name: 'qoshimcha',
  additional_protocol_file_path: '/files/2026/qoshimcha.pdf',
  additional_protocol_file_ext: '.pdf',
  additional_protocol_file_sizes: 4096,
  additional_protocol_file_date: '2026-09-13T10:00:00',
  rn: 1,
  total_count: 161367,
  ...over,
});

const rawTrade = (over: Record<string, unknown> = {}) => ({
  id: 9,
  display_no: 26120012500001,
  name: 'Lot nomi',
  start_date: '2026-09-01T00:00:00',
  end_date: '2026-09-20T00:00:00',
  clarific_date: '2026-09-10T00:00:00',
  cost: 500000,
  seller_name: 'Sotuvchi',
  seller_tin: '333333333',
  seller_id: 4242,
  region_name: 'Toshkent',
  district_name: 'Chilonzor',
  currency_name: 'Сум',
  category_name: 'Kategoriya',
  total_count: 688,
  ...over,
});

describe('ProcurementScriptService — reading what the API already sends', () => {
  let svc: ProcurementScriptService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new ProcurementScriptService();
  });

  const fetchOne = async (raw: Record<string, unknown>) => {
    mockedPost.mockResolvedValue({ data: [raw] } as never);
    const [row] = await svc.fetchDeals('203366731', 1, 1);
    return row;
  };

  it('keeps the contract document, which is the part people came for', async () => {
    const d = await fetchOne(rawDeal());
    expect(d.contract_file_path).toBe('/files/2026/shartnoma.pdf');
    expect(d.contract_file_name).toBe('shartnoma');
    expect(d.contract_file_ext).toBe('.pdf');
    expect(d.contract_file_date).toBe('2026-09-12T10:00:00.000+05:00');
    // `contract_file_sizes` upstream, for one file — and it arrives as text.
    expect(d.contract_file_size).toBe(204800);
  });

  it('shortens the additional-protocol prefix without losing a field', async () => {
    const d = await fetchOne(rawDeal());
    expect(d.protocol_file_name).toBe('qoshimcha');
    expect(d.protocol_file_path).toBe('/files/2026/qoshimcha.pdf');
    // KB here, unlike the contract's bytes — the API mixes the two units.
    expect(d.protocol_file_size_kb).toBe(4096);
    expect(d.protocol_file_date).toBe('2026-09-13T10:00:00.000+05:00');
  });

  it('carries the contract and treasury status', async () => {
    const d = await fetchOne(rawDeal());
    expect(d.deal_contract_status_name).toBe('Imzolangan');
    expect(d.deal_contract_kazna_status_name).toBe('Toʻlangan');
    expect(d.deal_contract_kazna_status_id).toBe(3);
    expect(d.deal_contract_date).toBe('2026-09-12T00:00:00.000+05:00');
  });

  it('carries the link back to the trade, and who stood behind the company', async () => {
    const d = await fetchOne(rawDeal());
    expect(d.trade_id).toBe(77);
    expect(d.beneficiary).toBe('Benefitsiar');
    expect(d.founder).toBe('Muassis');
    expect(d.customer_type_name).toBe('Korporativ buyurtmachi');
  });

  describe('is_local_manufacturs — three states, not two', () => {
    it.each([
      [1, true],
      [0, false],
      [null, null],
      [undefined, null],
    ])('%p becomes %p', async (given, expected) => {
      const d = await fetchOne(rawDeal({ is_local_manufacturs: given }));
      expect(d.is_local_manufacturs).toBe(expected);
    });
  });

  describe('numbers that arrive as text', () => {
    it('reads a digit string as a number', async () => {
      const d = await fetchOne(rawDeal({ contract_file_sizes: '1024' }));
      expect(d.contract_file_size).toBe(1024);
    });

    it.each([
      ['', 'boʻsh satr'],
      ['—', 'raqam emas'],
      [null, 'null'],
    ])('turns %p (%s) into null rather than 0', async (given) => {
      const d = await fetchOne(rawDeal({ contract_file_sizes: given }));
      // `Number('')` is 0, which would be a file of zero bytes.
      expect(d.contract_file_size).toBeNull();
    });
  });

  /**
   * `deal_contract_date` is the only `dd.MM.yyyy` field in the response, and
   * Postgres reads a bare one under `MDY`: `25.08.2026` was rejected as month
   * 25 and skipped the whole deal, while `08.09.2026` was quietly accepted as
   * the 9th of August. Both halves are the same bug, and only one of them
   * showed up in a log.
   */
  describe('the one date that is not ISO', () => {
    it.each([
      [
        '25.08.2026',
        '2026-08-25T00:00:00.000+05:00',
        'kun 12 dan katta — avval INSERT yiqilardi',
      ],
      [
        '08.09.2026',
        '2026-09-08T00:00:00.000+05:00',
        'kun 12 dan kichik — avval jimgina almashardi',
      ],
    ])('turns %p into %p (%s)', async (given, expected) => {
      const d = await fetchOne(rawDeal({ deal_contract_date: given }));
      expect(d.deal_contract_date).toBe(expected);
    });

    it('reads an ISO date on Tashkent clock', async () => {
      const d = await fetchOne(
        rawDeal({ deal_contract_date: '2026-09-12T00:00:00' }),
      );
      expect(d.deal_contract_date).toBe('2026-09-12T00:00:00.000+05:00');
    });

    it.each([null, undefined, ''])('turns %p into null', async (given) => {
      const d = await fetchOne(rawDeal({ deal_contract_date: given }));
      expect(d.deal_contract_date).toBeNull();
    });
  });

  it('reads the two fields a trade has of its own', async () => {
    mockedPost.mockResolvedValue({ data: [rawTrade()] } as never);
    const [t] = await svc.fetchTrades('333333333');
    expect(t.clarific_date).toBe('2026-09-10T00:00:00.000+05:00');
    expect(t.seller_id).toBe(4242);
  });

  it('still reads the fields it always did', async () => {
    const d = await fetchOne(rawDeal());
    expect(d.deal_id).toBe(55);
    expect(d.display_no).toBe('26120012509360');
    expect(d.deal_cost).toBe(9000000000);
    expect(d.provider_inn).toBe('312387381');
    expect(d.deal_status_name).toBe('Баённома шакллантирилган');
  });
});

/**
 * The API's `To` is exclusive: `From: 1, To: 3` returns two rows and
 * `From: 1, To: 1` returns none. The range was built as `from + count - 1`,
 * which asked for one fewer row than the caller wanted every time — and for
 * a single new deal asked for nothing at all, so that deal never arrived
 * until a second one appeared beside it.
 */
describe('ProcurementScriptService — the page range', () => {
  let svc: ProcurementScriptService;
  const body = () => mockedPost.mock.calls[0][1] as Record<string, number>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedPost.mockResolvedValue({ data: [] } as never);
    svc = new ProcurementScriptService();
  });

  it.each([
    [1, 1, 2],
    [1, 50, 51],
    [51, 50, 101],
  ])('asks From=%i for %i rows with To=%i', async (from, count, to) => {
    await svc.fetchDeals('203366731', from, count);
    expect(body().From).toBe(from);
    expect(body().To).toBe(to);
  });

  it('leaves room for one row when only one is missing', async () => {
    // The case that used to fetch nothing at all, forever.
    await svc.fetchDeals('203366731', 1, 1);
    expect(body().To - body().From).toBe(1);
  });

  it('uses the same range for the provider side', async () => {
    await svc.fetchDealsAsProvider('203366731', 1, 50);
    expect(body().To).toBe(51);
  });

  /**
   * `To` is inclusive on this endpoint and exclusive on `DealsList` — checked
   * against the source: `From: 1, To: 3` returns three rows here and two
   * there. The call asked for `TRADE_PAGE_SIZE + 1` on the exclusive belief,
   * so it read 101 rows and stopped; a company with more live lots than that
   * never had the rest.
   */
  it('asks for exactly the rows it was told to, inclusive of To', async () => {
    await svc.fetchTrades('203366731', 1, 100);
    expect(body().From).toBe(1);
    expect(body().To).toBe(100);
  });

  it('pages from anywhere, not only from the top', async () => {
    await svc.fetchTrades('203366731', 501, 250);
    expect(body().From).toBe(501);
    expect(body().To).toBe(750);
  });
});

/**
 * The two size fields on one response do not share a unit. Verified against
 * the files themselves: five contracts matched their byte count exactly, and
 * five protocols came back at roughly 1/1024 of theirs. Getting this wrong is
 * a thousandfold error in any storage estimate, so the names carry the unit.
 */
describe('ProcurementScriptService — the two size units', () => {
  let svc: ProcurementScriptService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new ProcurementScriptService();
  });

  it('keeps the contract size in the bytes it arrives as', async () => {
    mockedPost.mockResolvedValue({
      data: [rawDeal({ contract_file_sizes: 57563 })],
    } as never);
    const [d] = await svc.fetchDeals('203366731', 1, 1);
    expect(d.contract_file_size).toBe(57563);
  });

  it('keeps the protocol size in the kilobytes it arrives as', async () => {
    // 33 KB upstream for a file that downloads as ~34,546 bytes.
    mockedPost.mockResolvedValue({
      data: [rawDeal({ additional_protocol_file_sizes: 33 })],
    } as never);
    const [d] = await svc.fetchDeals('203366731', 1, 1);
    expect(d.protocol_file_size_kb).toBe(33);
  });
});

/**
 * `NotDealedList` is the third thing this API returns and it agrees with the
 * other two about almost nothing: its `To` is inclusive where `DealsList`'s
 * is exclusive, and its company filter works where the auction API's does
 * not. Both were checked against the live endpoint rather than assumed.
 */
describe('ProcurementScriptService — lots that came to nothing', () => {
  let svc: ProcurementScriptService;
  const body = () => mockedPost.mock.calls[0][1] as Record<string, unknown>;

  const rawLot = (over: Record<string, unknown> = {}) => ({
    trade_id: 510168,
    display_no: 26120012510168,
    start_date: '2026-09-03T16:58:32',
    end_date: '2026-09-10T16:58:32',
    category_name: '  Avtokran ijarasi  ',
    start_cost: 99315402,
    participants_count: 0,
    customer_name: '"O\'ZBEKNEFTGAZ" AJ',
    customer_inn: '200837914',
    is_local_manufacturs: true,
    status_id: 12,
    status_name: 'Торг не состоялся',
    total_count: 636,
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockedPost.mockResolvedValue({ data: [rawLot()] } as never);
    svc = new ProcurementScriptService();
  });

  it('narrows to one company — this filter, unlike the auction one, works', async () => {
    await svc.fetchNotDealed('200837914', 1, 10);
    expect(body().CustomerTin).toBe('200837914');
  });

  it.each([
    [1, 10, 10],
    [11, 10, 20],
    [1, 1, 1],
  ])(
    'treats To as inclusive: from=%i count=%i asks To=%i',
    async (from, count, to) => {
      await svc.fetchNotDealed('200837914', from, count);
      expect(body().From).toBe(from);
      // `DealsList` would want `from + count` here. They differ on the same API.
      expect(body().To).toBe(to);
    },
  );

  it('reads the lot and the reason it failed', async () => {
    const [lot] = await svc.fetchNotDealed('200837914', 1, 1);
    expect(lot.trade_id).toBe(510168);
    expect(lot.display_no).toBe('26120012510168');
    expect(lot.status_id).toBe(12);
    expect(lot.status_name).toBe('Торг не состоялся');
    expect(lot.participants_count).toBe(0);
    expect(lot.is_local_manufacturs).toBe(true);
  });

  it('trims the padding the API puts around a category', async () => {
    const [lot] = await svc.fetchNotDealed('200837914', 1, 1);
    expect(lot.category_name).toBe('Avtokran ijarasi');
  });

  it('keeps a participant count of zero, which is the whole point', async () => {
    mockedPost.mockResolvedValue({
      data: [rawLot({ participants_count: 0 })],
    } as never);
    const [lot] = await svc.fetchNotDealed('200837914', 1, 1);
    // Nobody bid. Turning that into null would lose the reason it failed.
    expect(lot.participants_count).toBe(0);
  });

  it('counts one company’s failures, not the catalogue’s', async () => {
    await expect(svc.getNotDealedTotalCount('200837914')).resolves.toBe(636);
    expect(body().CustomerTin).toBe('200837914');
  });
});

/**
 * The count is the caller's whole basis for how much to ask for, and it was
 * being read off a mapped row.
 *
 * `mapDirectPurchase` keeps the eighteen fields the table stores, and
 * `total_count` is not among them — so the read was always `undefined` and
 * the `?? page.length` beside it answered "three", the size of the probe.
 * Nothing noticed while the caller asked for rows 1..500 regardless. The
 * moment it started trusting the number, a company with 278 purchases synced
 * eight of them, in production, on the first page view after a merge.
 */
describe('ProcurementScriptService — how many direct purchases there are', () => {
  let svc: ProcurementScriptService;

  beforeEach(() => {
    jest.clearAllMocks();
    svc = new ProcurementScriptService();
  });

  const rawPurchase = (over: Record<string, unknown> = {}) => ({
    id: 4441405,
    display_id: 'DP-1',
    contract_num: 'C-1',
    contract_sum: 1000,
    status_name: 'Bajarildi',
    total_count: 278,
    ...over,
  });

  it('reads the total the source sends, not the size of the probe', async () => {
    mockedPost.mockResolvedValue({
      data: [rawPurchase(), rawPurchase()],
    } as any);
    await expect(
      svc.getDirectPurchasesTotalCount('203195074', 'customer'),
    ).resolves.toBe(278);
  });

  it('asks for a single row to learn it', async () => {
    mockedPost.mockResolvedValue({ data: [rawPurchase()] } as any);
    await svc.getDirectPurchasesTotalCount('203195074', 'customer');
    const body = mockedPost.mock.calls[0][1] as any;
    expect(body.from).toBe(1);
    expect(body.to).toBe(1);
  });

  it('sends the STIR on the side it was asked about', async () => {
    mockedPost.mockResolvedValue({ data: [rawPurchase()] } as any);
    await svc.getDirectPurchasesTotalCount('203195074', 'provider');
    const body = mockedPost.mock.calls[0][1] as any;
    expect(body.provider_tin).toBe('203195074');
    expect(body.tin).toBe('');
  });

  it('is zero for a company with none', async () => {
    mockedPost.mockResolvedValue({ data: [] } as any);
    await expect(
      svc.getDirectPurchasesTotalCount('203195074', 'customer'),
    ).resolves.toBe(0);
  });

  it('falls back to what it can see when the source sends no total', async () => {
    // Better to fetch the rows in hand than to call the company empty.
    mockedPost.mockResolvedValue({
      data: [rawPurchase({ total_count: undefined })],
    } as any);
    await expect(
      svc.getDirectPurchasesTotalCount('203195074', 'customer'),
    ).resolves.toBe(1);
  });

  it('still maps the rows for the fetch beside it', async () => {
    mockedPost.mockResolvedValue({ data: [rawPurchase()] } as any);
    const [row] = await svc.fetchDirectPurchases(
      '203195074',
      'customer',
      1,
      278,
    );
    // The mapper drops `total_count`, which is exactly why the count above
    // may not be read from here.
    expect(row).not.toHaveProperty('total_count');
    expect(row.purchase_id).toBe(4441405);
  });
});

describe('directPurchaseDay — uzex writes month first', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { directPurchaseDay } = require('./procurement.service');

  it.each([
    ['02/25/2026', '2026-02-25'],
    ['02/03/2026', '2026-02-03'],
    ['2/3/2026 00:00:00', '2026-02-03'],
    ['2026-02-03T00:00:00', '2026-02-03'],
    ['', null],
    [null, null],
  ])('%p → %p', (given, day) => {
    expect(directPurchaseDay(given)).toBe(day);
  });
});
