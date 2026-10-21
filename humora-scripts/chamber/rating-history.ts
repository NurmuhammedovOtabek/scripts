/** Anything with `query`: a TypeORM DataSource or a pg client. */
export interface RatingDb {
  query: (sql: string, params?: unknown[]) => Promise<unknown>;
}

const VALID_INN = /^(\d{9}|\d{14})$/;

// company_info's current trust/score, unless it equals the INN's latest row or both are null.
export const RECORD_RATING_SQL = `
  INSERT INTO public.company_rating_history (inn, grade, score, origin)
  SELECT ci.inn, ci.trust::varchar(8), ci.score::numeric(6,2), 'live'
    FROM public.company_info ci
   WHERE ci.inn = $1
     AND (ci.trust IS NOT NULL OR ci.score IS NOT NULL)
     AND (ci.score IS NULL OR (ci.score::numeric >= 0 AND ci.score::numeric < 10000))
     AND NOT EXISTS (
       SELECT 1
         FROM (SELECT r.grade, r.score
                 FROM public.company_rating_history r
                WHERE r.inn = ci.inn
                ORDER BY r.recorded_at DESC, r.id DESC
                LIMIT 1) last
        WHERE last.grade IS NOT DISTINCT FROM ci.trust::varchar(8)
          AND last.score IS NOT DISTINCT FROM ci.score::numeric(6,2)
     )
   LIMIT 1`;

export function touchesRating(fields: string[]): boolean {
  return fields.includes('trust') || fields.includes('score');
}

// Call after every write of trust or score; never throws, so a company write cannot fail over history.
export async function recordRating(
  db: RatingDb,
  inn: string,
  logger?: { warn: (message: string) => void },
): Promise<void> {
  if (!VALID_INN.test(inn ?? '')) return;
  try {
    await db.query(RECORD_RATING_SQL, [inn]);
  } catch (err) {
    logger?.warn(
      `[rating-history] ${inn} not recorded: ${(err as Error)?.message ?? err}`,
    );
  }
}
