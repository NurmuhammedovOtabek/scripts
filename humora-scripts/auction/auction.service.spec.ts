import axios from 'axios';
import { AuctionScriptService } from './auction.service';

jest.mock('axios');
const mockedPost = axios.post as jest.MockedFunction<typeof axios.post>;

describe('AuctionScriptService', () => {
  let svc: AuctionScriptService;
  const body = () => mockedPost.mock.calls[0][1] as Record<string, unknown>;
  const headers = () =>
    (mockedPost.mock.calls[0][2] as { headers: Record<string, string> })
      .headers;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedPost.mockResolvedValue({ data: [] } as never);
    svc = new AuctionScriptService();
  });

  describe('the date filter', () => {
    it('formats as dd.MM.yyyy HH:mm — an ISO date is rejected upstream', () => {
      expect(AuctionScriptService.formatDate(new Date(2026, 8, 9))).toBe(
        '09.09.2026 00:00',
      );
    });

    it('pads a single-digit day and month', () => {
      expect(AuctionScriptService.formatDate(new Date(2026, 0, 5))).toBe(
        '05.01.2026 00:00',
      );
    });

    it('closes the range at the end of the day, not its start', () => {
      expect(AuctionScriptService.formatDate(new Date(2026, 8, 9), true)).toBe(
        '09.09.2026 23:59',
      );
    });

    it('sends both ends when a range is given', async () => {
      await svc.fetchCompleted(1, {
        from: new Date(2026, 8, 9),
        to: new Date(2026, 8, 10),
      });
      expect(body().date_from).toBe('09.09.2026 00:00');
      expect(body().date_to).toBe('10.09.2026 23:59');
    });

    it('sends neither when no range is given', async () => {
      await svc.fetchCompleted(1);
      expect(body().date_from).toBeUndefined();
      expect(body().date_to).toBeUndefined();
    });
  });

  describe('paging', () => {
    it('asks the thin endpoint for a full 500-row page', async () => {
      await svc.fetchDeals(1);
      expect(body()).toMatchObject({ from: 1, to: 500 });
    });

    it('steps without gap or overlap', async () => {
      await svc.fetchDeals(501);
      expect(body()).toMatchObject({ from: 501, to: 1000 });
    });

    it('asks the rich endpoint for the 16 it always returns anyway', async () => {
      await svc.fetchCompleted(17);
      expect(body()).toMatchObject({ from: 17, to: 32 });
    });
  });

  it('always sends a User-Agent — without one the host answers 500', async () => {
    await svc.fetchDeals(1);
    expect(headers()['User-Agent']).toMatch(/Mozilla/);
  });

  describe('mapping', () => {
    it("reads the provider's name from the API's own misspelling", async () => {
      // `prvider_name` upstream. Reading `provider_name` gives null on
      // every single row of the thin endpoint.
      mockedPost.mockResolvedValue({
        data: [{ id: 1, prvider_name: 'YETKAZUVCHI MCHJ' }],
      } as never);
      const [d] = await svc.fetchDeals(1);
      expect(d.provider_name).toBe('YETKAZUVCHI MCHJ');
    });

    it('takes deal_id from `id` on the thin endpoint', async () => {
      mockedPost.mockResolvedValue({ data: [{ id: 330102 }] } as never);
      const [d] = await svc.fetchDeals(1);
      expect(d.deal_id).toBe(330102);
    });

    it('takes deal_id from `deal_id` on the rich one — the same number', async () => {
      mockedPost.mockResolvedValue({ data: [{ deal_id: 330100 }] } as never);
      const [d] = await svc.fetchCompleted(1);
      expect(d.deal_id).toBe(330100);
    });

    it('leaves the other endpoint’s columns null rather than absent', async () => {
      mockedPost.mockResolvedValue({ data: [{ id: 1, cost: 500 }] } as never);
      const [d] = await svc.fetchDeals(1);
      expect(d.cost).toBe(500);
      // A thin row has no treasury columns; they must exist and be null so the
      // upsert's COALESCE leaves whatever the rich endpoint wrote.
      expect(d).toHaveProperty('kazna_status', null);
      expect(d).toHaveProperty('deal_date', null);
    });

    it('turns the empty strings the API sends into nulls', async () => {
      mockedPost.mockResolvedValue({
        data: [{ id: 1, customer_inn: '  ', provider_inn: '', cost: '' }],
      } as never);
      const [d] = await svc.fetchDeals(1);
      expect(d.customer_inn).toBeNull();
      expect(d.provider_inn).toBeNull();
      // `Number('')` is 0, which would be a deal worth nothing.
      expect(d.cost).toBeNull();
    });

    it('reads 0/1 as a boolean and a missing flag as unknown', async () => {
      mockedPost.mockResolvedValue({
        data: [{ deal_id: 1, is_budget: 0 }, { deal_id: 2 }],
      } as never);
      const [a, b] = await svc.fetchCompleted(1);
      expect(a.is_budget).toBe(false);
      expect(b.is_budget).toBeNull();
    });
  });

  it('reads the total off the first row', async () => {
    mockedPost.mockResolvedValue({
      data: [{ id: 1, total_count: 219133 }],
    } as never);
    await expect(svc.countDeals()).resolves.toBe(219133);
  });

  it('answers zero rather than NaN when the list is empty', async () => {
    mockedPost.mockResolvedValue({ data: [] } as never);
    await expect(svc.countDeals()).resolves.toBe(0);
  });
});
