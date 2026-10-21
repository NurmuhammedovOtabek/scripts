import { ChamberFillService } from './chamber-fill.service';
import { RECORD_RATING_SQL } from './rating-history';

describe('ChamberFillService — rating history', () => {
  const build = (rating: { trust: string | null; score: number | null }) => {
    const db = { query: jest.fn().mockResolvedValue([]) };
    const chamber = { getByInn: jest.fn().mockResolvedValue(rating) };
    const svc = new ChamberFillService(
      db as any,
      chamber as any,
      { send: jest.fn() } as any,
    ) as any;
    svc.isRunning = true;
    const counters = {
      onRated: jest.fn(),
      onNotRated: jest.fn(),
      onFail: jest.fn(),
    };
    return { svc, db, counters };
  };

  it('records the rating right after writing it', async () => {
    const { svc, db, counters } = build({ trust: 'BBB', score: 77 });
    await expect(svc.processRow('300000001', 1, counters)).resolves.toBe(true);
    const sqls = db.query.mock.calls.map(([sql]: [string]) => sql);
    expect(sqls[0]).toContain('UPDATE public.company_info SET trust=$1');
    expect(db.query).toHaveBeenNthCalledWith(2, RECORD_RATING_SQL, [
      '300000001',
    ]);
    expect(counters.onRated).toHaveBeenCalled();
  });

  it('records nothing when chamber has no rating', async () => {
    const { svc, db, counters } = build({ trust: null, score: null });
    await svc.processRow('300000001', 1, counters);
    expect(db.query).not.toHaveBeenCalled();
    expect(counters.onNotRated).toHaveBeenCalled();
  });
});
