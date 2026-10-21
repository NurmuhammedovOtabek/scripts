import { myorgRatingFallback } from './rating-fallback';

/**
 * The outage this exists for: on 7 August 2026 admin.chamber.uz answered every
 * INN with a 500 wrapping `Connection refused (192.168.1.10:7000)` from its own
 * Soliq backend, and companies with no chamber-fill row showed no rating.
 */
describe('myorgRatingFallback — chamber → myorg → DB', () => {
  const myorg = { trust: 'A', score: 100 };

  it('stands aside when chamber has a rating', () => {
    expect(myorgRatingFallback({ trust: 'BB', score: 72 }, myorg)).toBeNull();
  });

  it('serves myorg when chamber threw', () => {
    expect(myorgRatingFallback(null, myorg)).toEqual({
      trust: 'A',
      score: 100,
    });
  });

  // The company is simply not in chamber's register — same outcome for the
  // caller as a 500, and myorg may still carry a rating.
  it('serves myorg when chamber answered with no rating', () => {
    expect(myorgRatingFallback({ trust: null, score: null }, myorg)).toEqual({
      trust: 'A',
      score: 100,
    });
  });

  // Falling through to null is what leaves the DB value the merge produced in
  // place — that is the third step of the chain, not a missing answer.
  it('leaves the DB value alone when myorg has nothing either', () => {
    expect(myorgRatingFallback(null, null)).toBeNull();
    expect(myorgRatingFallback(null, {})).toBeNull();
    expect(myorgRatingFallback(null, { trust: null, score: null })).toBeNull();
  });

  it('passes through whichever half myorg has', () => {
    expect(myorgRatingFallback(null, { score: 64 })).toEqual({ score: 64 });
    expect(myorgRatingFallback(null, { trust: 'BB' })).toEqual({ trust: 'BB' });
  });

  // chamber fills the grade and the score together, so either one present
  // means it answered and its rating stands.
  it('treats a half-filled chamber answer as rated', () => {
    expect(myorgRatingFallback({ trust: 'BB', score: null }, myorg)).toBeNull();
    expect(myorgRatingFallback({ trust: null, score: 72 }, myorg)).toBeNull();
  });

  // 'D' and 0 are the bottom of the scale, not an absent rating.
  it('does not mistake the bottom of the scale for a missing rating', () => {
    expect(myorgRatingFallback({ trust: 'D', score: 0 }, myorg)).toBeNull();
    expect(myorgRatingFallback(null, { trust: 'D', score: 0 })).toEqual({
      trust: 'D',
      score: 0,
    });
  });
});
