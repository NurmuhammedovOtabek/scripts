import axios from 'axios';
import { toVendorRating, VendorRatingService } from './vendor-rating.service';

jest.mock('axios');
const post = axios.post as jest.Mock;

const vendor = (rn: number, inn: string, total = 1500) => ({
  year: 2026,
  month: 8,
  vendor_name: `VENDOR ${rn}`,
  vendor_inn: inn,
  region_name: 'Toshkent shahri',
  total_rate: 0.5,
  rate_range: 0,
  place_range: rn,
  rn,
  total_count: total,
});

/** A page as the source returns it: one group holding the vendors. */
const page = (vendors: unknown[]) => ({
  data: [{ category: 'A', vendors }],
});

describe('VendorRatingService', () => {
  let db: { query: jest.Mock };
  let service: VendorRatingService;

  beforeEach(() => {
    jest.clearAllMocks();
    db = { query: jest.fn().mockResolvedValue([]) };
    service = new VendorRatingService(db as any);
  });

  describe('syncAll', () => {
    it('pages through the whole list and stops at the source count', async () => {
      const first = Array.from({ length: 1000 }, (_, i) =>
        vendor(i + 1, String(300000000 + i)),
      );
      const second = Array.from({ length: 500 }, (_, i) =>
        vendor(i + 1001, String(301000000 + i)),
      );
      post
        .mockResolvedValueOnce(page(first))
        .mockResolvedValueOnce(page(second));

      const result = await service.syncAll();

      expect(post).toHaveBeenCalledTimes(2);
      expect(post.mock.calls[0][1]).toEqual({ From: 1, To: 1000 });
      expect(post.mock.calls[1][1]).toEqual({ From: 1001, To: 2000 });
      // The host refuses a server without a browser User-Agent.
      expect(post.mock.calls[0][2].headers['User-Agent']).toContain('Mozilla');
      expect(result).toEqual({ saved: 1500, total: 1500, period: '2026-08' });
      expect(db.query).toHaveBeenCalledTimes(2);
    });

    it('stops when a page comes back empty', async () => {
      post.mockResolvedValueOnce(page([]));

      const result = await service.syncAll();

      expect(result.saved).toBe(0);
      expect(db.query).not.toHaveBeenCalled();
    });

    it('saves an INN once per page, so the upsert never touches a row twice', async () => {
      post.mockResolvedValueOnce(
        page([vendor(1, '300000001', 2), vendor(2, '300000001', 2)]),
      );

      const result = await service.syncAll();

      expect(result.saved).toBe(1);
      const [, params] = db.query.mock.calls[0];
      expect(params[0]).toEqual(['300000001']);
    });
  });

  describe('getLatestByInn', () => {
    it("reads the company's latest month", async () => {
      db.query.mockResolvedValue([
        {
          total_rate: '0.87775',
          place_range: 1,
          rn: 1,
          total_count: 31403,
          year: 2026,
          month: 8,
        },
      ]);

      expect(await service.getLatestByInn('300000001')).toEqual({
        score: 0.87775,
        place: 1,
        rank: 1,
        total: 31403,
        period: '2026-08',
      });
    });

    it('answers null for a company the list does not rate', async () => {
      expect(await service.getLatestByInn('300000001')).toBeNull();
    });
  });

  it('toVendorRating treats a row with no score as no rating', () => {
    expect(
      toVendorRating({
        total_rate: null,
        place_range: 1,
        rn: 1,
        total_count: 1,
        year: 2026,
        month: 8,
      }),
    ).toBeNull();
  });
});
