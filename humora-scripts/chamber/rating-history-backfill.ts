// One statement -> its rows, e.g. (sql, p) => client.query(sql, p).then((r) => r.rows).
export type RowsQuery = (sql: string, params?: unknown[]) => Promise<any[]>;

export interface BackfillOptions {
  dryRun?: boolean;
  batch?: number;
  log?: (line: string) => void;
}

export interface BackfillTotals {
  companies: number;
  fromHistory: number;
  current: number;
}

const GRADE_OF_NUM = `CASE
  WHEN s.num IS NULL THEN NULL
  WHEN s.num >= 96 THEN 'AAA'
  WHEN s.num >= 91 THEN 'AA'
  WHEN s.num >= 86 THEN 'A'
  WHEN s.num >= 76 THEN 'BBB'
  WHEN s.num >= 66 THEN 'BB'
  WHEN s.num >= 56 THEN 'B'
  WHEN s.num >= 51 THEN 'CCC'
  WHEN s.num >= 36 THEN 'CC'
  WHEN s.num >= 26 THEN 'C'
  ELSE 'D'
END`;

// Before (created_at - 1 ms) and after (created_at) of each rating change, older than the INN's first live row.
export const HISTORY_POINTS_SQL = `
  SELECT p.inn, p.grade, p.score, p.recorded_at
    FROM (
      SELECT v.inn, v.recorded_at, v.grade, v.score,
             lag(v.grade) OVER w AS prev_grade,
             lag(v.score) OVER w AS prev_score,
             row_number() OVER w AS rn
        FROM (
          SELECT s.inn, s.recorded_at, s.seq, s.num AS score,
                 COALESCE(s.letter, ${GRADE_OF_NUM}) AS grade
            FROM (
              SELECT h.inn, h.recorded_at, h.seq,
                     CASE
                       WHEN jsonb_typeof(h.v -> 'trust') = 'string'
                        AND btrim(h.v ->> 'trust') <> ''
                        AND btrim(h.v ->> 'trust') !~ '^[0-9]+(\\.[0-9]+)?$'
                       THEN upper(btrim(h.v ->> 'trust'))::varchar(8)
                     END AS letter,
                     COALESCE(
                       CASE WHEN btrim(h.v ->> 'score') ~ '^[0-9]{1,4}(\\.[0-9]+)?$'
                            THEN btrim(h.v ->> 'score')::numeric(6,2) END,
                       CASE WHEN btrim(h.v ->> 'trust') ~ '^[0-9]{1,4}(\\.[0-9]+)?$'
                            THEN btrim(h.v ->> 'trust')::numeric(6,2) END
                     ) AS num
                FROM (
                  SELECT ch.inn::text AS inn,
                         ch.created_at::timestamptz - interval '1 millisecond' AS recorded_at,
                         ch.before::jsonb AS v, ch.id * 2 AS seq
                    FROM public.company_history ch
                   WHERE ch.inn = ANY($1::text[])
                     AND ch.changed_fields::jsonb ?| array['trust', 'score']
                     AND ch.created_at IS NOT NULL
                  UNION ALL
                  SELECT ch.inn::text, ch.created_at::timestamptz, ch.after::jsonb, ch.id * 2 + 1
                    FROM public.company_history ch
                   WHERE ch.inn = ANY($1::text[])
                     AND ch.changed_fields::jsonb ?| array['trust', 'score']
                     AND ch.created_at IS NOT NULL
                ) h
               WHERE h.recorded_at < COALESCE(
                       (SELECT min(r.recorded_at) FROM public.company_rating_history r
                         WHERE r.inn = h.inn AND r.origin = 'live'),
                       'infinity'::timestamptz)
            ) s
        ) v
       WHERE v.grade IS NOT NULL OR v.score IS NOT NULL
      WINDOW w AS (PARTITION BY v.inn ORDER BY v.recorded_at, v.seq)
    ) p
   WHERE (p.rn = 1 OR p.grade IS DISTINCT FROM p.prev_grade OR p.score IS DISTINCT FROM p.prev_score)
     AND NOT EXISTS (
       SELECT 1 FROM public.company_rating_history r
        WHERE r.inn = p.inn
          AND r.recorded_at = p.recorded_at
          AND r.grade IS NOT DISTINCT FROM p.grade
          AND r.score IS NOT DISTINCT FROM p.score
     )`;

// The current rating where it differs from the latest row, at updated_at (or just after the latest row).
export const CURRENT_POINTS_SQL = `
  SELECT ci.inn, ci.trust::varchar(8) AS grade, ci.score::numeric(6,2) AS score,
         GREATEST(
           COALESCE(ci.updated_at::timestamptz, now()),
           COALESCE(last.recorded_at + interval '1 millisecond', '-infinity'::timestamptz)
         ) AS recorded_at
    FROM public.company_info ci
    LEFT JOIN LATERAL (
      SELECT r.grade, r.score, r.recorded_at
        FROM public.company_rating_history r
       WHERE r.inn = ci.inn
       ORDER BY r.recorded_at DESC, r.id DESC
       LIMIT 1
    ) last ON true
   WHERE ci.inn = ANY($1::text[])
     AND (ci.trust IS NOT NULL OR ci.score IS NOT NULL)
     AND (ci.score IS NULL OR (ci.score::numeric >= 0 AND ci.score::numeric < 10000))
     AND (last.recorded_at IS NULL
          OR last.grade IS DISTINCT FROM ci.trust::varchar(8)
          OR last.score IS DISTINCT FROM ci.score::numeric(6,2))`;

export const NEXT_INNS_SQL = `
  SELECT inn FROM public.company_info
   WHERE inn > $1 AND inn ~ '^([0-9]{9}|[0-9]{14})$'
   ORDER BY inn
   LIMIT $2`;

const countOf = (points: string) =>
  `SELECT count(*)::int AS n FROM (${points}) c`;
const insertOf = (points: string) => `
  WITH ins AS (
    INSERT INTO public.company_rating_history (inn, grade, score, recorded_at, origin)
    SELECT c.inn, c.grade, c.score, c.recorded_at, 'backfill' FROM (${points}) c
    RETURNING 1
  )
  SELECT count(*)::int AS n FROM ins`;

// Short statements, a batch of companies at a time; idempotent; a dry run only counts.
export async function backfillRatingHistory(
  query: RowsQuery,
  options: BackfillOptions = {},
): Promise<BackfillTotals> {
  const batch = options.batch ?? 5000;
  const log = options.log ?? (() => undefined);
  const run = (points: string) =>
    options.dryRun ? countOf(points) : insertOf(points);
  const totals: BackfillTotals = { companies: 0, fromHistory: 0, current: 0 };
  let after = '';
  for (;;) {
    const rows = await query(NEXT_INNS_SQL, [after, batch]);
    if (rows.length === 0) break;
    const inns = rows.map((r) => String(r.inn));
    const [history] = await query(run(HISTORY_POINTS_SQL), [inns]);
    const [current] = await query(run(CURRENT_POINTS_SQL), [inns]);
    totals.companies += inns.length;
    totals.fromHistory += Number(history.n);
    totals.current += Number(current.n);
    after = inns[inns.length - 1];
    const currentText = options.dryRun
      ? `${totals.current} current values (upper bound in dry run)`
      : `${totals.current} current values`;
    log(
      `${totals.companies} companies, ${totals.fromHistory} history points, ${currentText}${options.dryRun ? ' (dry run)' : ''}`,
    );
  }
  return totals;
}

export interface BackfillArgs {
  dryRun: boolean;
  batch: number;
}

export const BACKFILL_USAGE =
  'usage: rating-history-backfill.cli.js [--dry-run] [--batch <positive integer>]';

// Only --dry-run and --batch <n> are accepted; returns null on anything else.
export function parseBackfillArgs(argv: string[]): BackfillArgs | null {
  const out: BackfillArgs = { dryRun: false, batch: 5000 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') {
      out.dryRun = true;
    } else if (argv[i] === '--batch') {
      const value = argv[++i];
      if (value === undefined || !/^[1-9][0-9]*$/.test(value)) return null;
      out.batch = Number(value);
      if (!Number.isSafeInteger(out.batch)) return null;
    } else {
      return null;
    }
  }
  return out;
}
