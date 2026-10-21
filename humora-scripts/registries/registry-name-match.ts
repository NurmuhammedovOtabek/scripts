import { resolveCompanyStatus } from '../../org/company-status';
import { nameKey } from './registry-normalize';

interface Exec {
  query(sql: string, params?: unknown[]): Promise<any>;
}

/** Companies read per query while folding names. */
const COMPANY_BATCH = 20_000;

export interface NameMatchResult {
  source: string;
  rows: number;
  /** Exactly one active company has the row's folded name. */
  matched: number;
  /** Several active companies share it: left unmatched. */
  ambiguous: number;
  /** No active company has it. */
  unmatched: number;
  /** Rows whose match changed with this run (set, moved or cleared). */
  changed: number;
}

/**
 * Ties rows of registers that carry no STIR to a company — only when exactly
 * one active company has the same folded name (`nameKey`). Several companies,
 * or none: the row stays unmatched. No fuzzy matching, no best guess: a wrong
 * company is worse than none.
 *
 * The folded names of every active company are built once per run, by STIR
 * order in batches, and only for keys some row needs.
 */
export async function matchRegistryNames(
  db: Exec,
  sources: string[],
  opts: { dry?: boolean } = {},
): Promise<NameMatchResult[]> {
  if (!sources.length) return [];
  const rows: Array<{
    id: string;
    source: string;
    name_key: string;
    match_inn: string | null;
  }> = await db.query(
    `SELECT id::text, source, name_key, match_inn
       FROM public.registry_name_rows
      WHERE source = ANY($1::text[]) AND delisted_at IS NULL`,
    [sources],
  );
  const wanted = new Set(rows.map((r) => r.name_key));
  const owners = new Map<string, Set<string>>();
  let after = '';
  for (;;) {
    const batch: Array<{
      inn: string;
      company_name: string | null;
      short_name: string | null;
      status: unknown;
      status_description: unknown;
      activity_state: unknown;
    }> = await db.query(
      `SELECT inn, company_name, short_name, status, status_description, activity_state
         FROM public.company_info
        WHERE inn > $1
        ORDER BY inn
        LIMIT $2`,
      [after, COMPANY_BATCH],
    );
    if (!batch.length) break;
    after = batch[batch.length - 1].inn;
    for (const c of batch) {
      if (!/^\d{9}$/.test(c.inn ?? '')) continue;
      const status = resolveCompanyStatus({
        status: c.status as any,
        status_description: c.status_description as any,
        activity_state: c.activity_state as any,
      });
      if (status?.kind !== 'ACTIVE') continue;
      for (const n of new Set([
        nameKey(c.company_name),
        nameKey(c.short_name),
      ])) {
        if (!n || !wanted.has(n)) continue;
        const set = owners.get(n) ?? new Set<string>();
        set.add(c.inn);
        owners.set(n, set);
      }
    }
    if (batch.length < COMPANY_BATCH) break;
  }

  const results = new Map<string, NameMatchResult>();
  const updates: Array<{ id: string; inn: string | null }> = [];
  for (const r of rows) {
    const res =
      results.get(r.source) ??
      ({
        source: r.source,
        rows: 0,
        matched: 0,
        ambiguous: 0,
        unmatched: 0,
        changed: 0,
      } as NameMatchResult);
    results.set(r.source, res);
    res.rows++;
    const found = owners.get(r.name_key);
    const inn = found && found.size === 1 ? [...found][0] : null;
    if (inn) res.matched++;
    else if (found && found.size > 1) res.ambiguous++;
    else res.unmatched++;
    if (inn !== r.match_inn) {
      res.changed++;
      updates.push({ id: r.id, inn });
    }
  }

  if (!opts.dry) {
    for (let i = 0; i < updates.length; i += 1000) {
      await db.query(
        `UPDATE public.registry_name_rows t
            SET match_inn = x.inn,
                match_method = CASE WHEN x.inn IS NULL THEN NULL ELSE 'exact_unique' END,
                matched_at = CASE WHEN x.inn IS NULL THEN NULL ELSE now() END
           FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, inn text)
          WHERE t.id = x.id`,
        [JSON.stringify(updates.slice(i, i + 1000))],
      );
    }
  }
  return sources.map(
    (s) =>
      results.get(s) ?? {
        source: s,
        rows: 0,
        matched: 0,
        ambiguous: 0,
        unmatched: 0,
        changed: 0,
      },
  );
}
