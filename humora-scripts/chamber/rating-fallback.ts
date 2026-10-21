/**
 * Rating precedence: chamber → myorg → DB.
 *
 * chamber.uz is the canonical source and the only writer of `company_info`
 * trust/score. It is also the flakiest: `admin.chamber.uz` proxies to an
 * internal Soliq backend that refuses connections for days at a time, and
 * every one of those requests comes back as a 500. A company whose row was
 * never filled by `chamber-fill` then has no rating to show at all.
 *
 * myorg publishes its own rating on the entity payload, so it can stand in.
 * Both now speak letters, but they are NOT the same scale: myorg calls a
 * score of 100 an "A" where the chamber ladder grades that 'AAA'. So this
 * stays a display fallback — persisting it would leave the column chamber-fill
 * owns holding two scales at once, and flip every watched company's rating in
 * company_history each time chamber blinks.
 */

export interface ChamberRating {
  /** Letter grade since `TrustAsLetterGrade1781700000000`; only its presence matters here. */
  trust: string | null;
  score: number | null;
}

export interface MyorgRating {
  trust?: unknown;
  score?: unknown;
}

/**
 * What to serve in place of chamber's rating, or null to leave whatever the
 * DB merge already produced.
 *
 * A chamber that answered but holds no rating for this INN counts the same as
 * one that threw: either way nothing came back, and myorg may still know.
 */
export function myorgRatingFallback(
  chamber: ChamberRating | null | undefined,
  myorg: MyorgRating | null | undefined,
): { trust?: unknown; score?: unknown } | null {
  const chamberRated = chamber?.trust != null || chamber?.score != null;
  if (chamberRated) return null;

  const out: { trust?: unknown; score?: unknown } = {};
  if (myorg?.trust != null) out.trust = myorg.trust;
  if (myorg?.score != null) out.score = myorg.score;

  return Object.keys(out).length > 0 ? out : null;
}
