import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { recentJobRuns, recordJobRun } from '../common/job-runs';
import { jobStopRequested } from '../common/job-control';
import { csNumber, csText, fetchCsDataset } from '../common/cs-egov';
import {
  MhobtIndex,
  NsHow,
  TaxOffice,
  decideNsSoato,
  foldCyrillic,
  taxOfficeLabel,
} from './ns-soato-decide';

/** cs.egov.uz 083-4-001 — the Tax Committee's territorial inspections. */
const TAX_OFFICES_ID = '61a5d33db83d3e9e6a91c95c';
/** cs.egov.uz 082-3-007 — Statistics' MHOBT (SOATO) classifier. */
const MHOBT_ID = '61a5d234b83d3e9e6a91c958';

export const LOCK_ID = 8_150_935;
export const JOB = 'ns_soato_map';
/** Fewer than this is a cut-off answer, not a smaller country. */
const MIN_OFFICES = 150;
const MIN_PLACES = 150;
/** The company check speaks only with this many companies behind a pair. */
const EVIDENCE_MIN = 20;
const LONG_QUERY_MS = 120_000;

export interface NsPairChange {
  ns10: number;
  ns11: number;
  name: string | null;
  from: string | null;
  to: string | null;
  /** Why: the classifier match, or why the value was cleared. */
  how: NsHow | 'invalid_code';
  matched: string | null;
  /** company_branches rows that carried `from` for this pair. */
  branches: number;
}

export interface NsPairNote {
  ns10: number;
  ns11: number;
  name: string | null;
  soato: string | null;
  how: string;
  detail?: string;
}

export interface NsSoatoSyncResult {
  dry: boolean;
  elapsedMs: number;
  /** Tax offices listed by the source, and MHOBT districts and cities. */
  offices: number;
  places: number;
  /** Pairs held here. */
  held: number;
  /** Held values the classifiers confirm as they are. */
  confirmed: number;
  changed: NsPairChange[];
  inserted: NsPairChange[];
  /** The classifiers cannot say; the value held is kept as it is. */
  unconfirmed: NsPairNote[];
  /** A change the companies contradict: not made, for a person to look at. */
  held_back: NsPairNote[];
  /** Pairs whose companies mostly carry another district than the one kept. */
  companies_disagree: NsPairNote[];
  company_check: string | null;
  branches_corrected: number;
}

/**
 * Whether the weekly sync (Sunday 04:30, ridden by the company mahalla run)
 * happens here: on a deployment (TG_WEBHOOK_URL set — dev and prod), not on a
 * laptop. `NS_SOATO_SYNC_ENABLED=1|0` overrides.
 */
export function nsSoatoSyncEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NS_SOATO_SYNC_ENABLED === '1') return true;
  if (env.NS_SOATO_SYNC_ENABLED === '0') return false;
  return Boolean(env.TG_WEBHOOK_URL);
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const key = (ns10: number, ns11: number) => `${ns10}/${ns11}`;
const clean = (v: unknown): string | null => {
  const s = v == null ? '' : String(v).trim();
  return s ? s : null;
};

/**
 * Keeps `ns_soato_map` — mysoliq's ns10/ns11 tax-office pair → SOATO district
 * — in line with the two official classifiers on cs.egov.uz, instead of a
 * seed file nobody can re-derive. The seed sent ten regional cities to the
 * rural district of the same name and Uchquduq to Zarafshon; the rule that
 * decides each pair is in `ns-soato-decide.ts`.
 *
 * What it changes, and what it leaves:
 * - a pair the classifiers decide: the value becomes theirs;
 * - a pair they cannot decide (a renamed district, a district MHOBT does not
 *   list yet): the value held is kept and listed as unconfirmed — no answer
 *   from the source is not evidence against it;
 * - a value that is no district in either classifier (MHOBT, спр.125
 *   `territory`), or an administration that is no place: cleared, because a
 *   company without a district is better than one in a place that does not
 *   exist;
 * - `company_branches.soato_code`, stored from this table, follows every
 *   change for the rows that still carry the old value.
 *
 * Companies that carry both a SOATO and a pair are the check on every write
 * — a change, a filled blank, a new pair: with at least 20 of them, a
 * district fewer than 20% are in, or a clear of a value 80% carry, is held
 * back and reported instead of made. A real run that cannot run the check
 * writes nothing. The table is never emptied, and a pair the source
 * stopped listing is kept.
 *
 * No cron of its own: `CompanyMahallaService.weekly` runs it after the bank
 * registry and before the mahalla run, so the mahallas follow the same
 * morning. By hand: POST /ns-soato-map/sync[?dry=1].
 */
@Injectable()
export class NsSoatoMapSyncService {
  private readonly logger = new Logger(NsSoatoMapSyncService.name);

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly telegram: TelegramAlertService,
  ) {}

  /**
   * One sync under the lock, reported to Telegram and kept in `job_runs`
   * whatever happened. Null when another replica holds the lock. Throws after
   * reporting when the sync failed.
   */
  async run(
    opts: { dry?: boolean },
    trigger: string,
  ): Promise<NsSoatoSyncResult | null> {
    const runner = this.db.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [LOCK_ID],
      );
      if (!locked) {
        this.logger.log(
          `[ns-soato-map] ${trigger}: skipped — another replica is syncing`,
        );
        return null;
      }
      const startedAt = new Date();
      try {
        const result = await this.sync(opts.dry === true, startedAt);
        const text = this.describe(result, trigger);
        this.logger.log(
          `[ns-soato-map] ${trigger}: ${result.changed.length} changed, ${result.inserted.length} new, ` +
            `${result.held_back.length} held back, ${result.branches_corrected} branches` +
            (result.dry ? ' (dry run)' : ''),
        );
        const alertSent = await this.telegram.deliver(text, {
          tag: 'ns_soato',
        });
        await recordJobRun(this.db, {
          job: JOB,
          trigger,
          dry: result.dry,
          startedAt,
          ok: true,
          summary: text,
          report: result,
          alertSent,
        });
        return result;
      } catch (err) {
        const message = (err as Error).message;
        this.logger.error(
          `[ns-soato-map] ${trigger}: sync failed — ${message}`,
        );
        const text = [
          `❌ <b>Tax office → SOATO map (${escapeHtml(trigger)}) — sync failed</b>`,
          `<code>${escapeHtml(message)}</code>`,
          'The map is untouched. Retry by hand: POST /api/ns-soato-map/sync',
        ].join('\n');
        const alertSent = await this.telegram.deliver(text, {
          tag: 'ns_soato',
        });
        await recordJobRun(this.db, {
          job: JOB,
          trigger,
          dry: opts.dry === true,
          startedAt,
          ok: false,
          summary: text,
          error: message,
          alertSent,
        });
        throw err;
      } finally {
        await runner
          .query('SELECT pg_advisory_unlock($1)', [LOCK_ID])
          .catch(() => undefined);
      }
    } finally {
      await runner.release().catch(() => undefined);
    }
  }

  private async sync(
    dry: boolean,
    startedAt: Date,
  ): Promise<NsSoatoSyncResult> {
    const t0 = Date.now();
    // POST /api/jobs/ns_soato_map/stop: obeyed before the slow company check
    // and before anything is written, never half-way through the writes.
    const stopIfAsked = async (where: string) => {
      if (await jobStopRequested(this.db, JOB, startedAt)) {
        throw new Error(`stopped by hand ${where}; nothing written`);
      }
    };
    const [officeRows, mhobtRows] = await Promise.all([
      fetchCsDataset(TAX_OFFICES_ID),
      fetchCsDataset(MHOBT_ID),
    ]);
    const offices = new Map<string, TaxOffice>();
    // A pair the source lists twice under different names: which one it
    // means cannot be told, so it is decided by neither.
    const listedTwice = new Set<string>();
    for (const r of officeRows) {
      const c = r.tableColumn ?? {};
      const ns10 = csNumber(c.RegionCode);
      const ns11 = csNumber(c.PNREgion);
      const name = csText(c.Name, 'uzbKrText');
      if (ns10 == null || ns11 == null || !name) continue;
      const k = key(ns10, ns11);
      const before = offices.get(k);
      if (before && foldCyrillic(before.name) !== foldCyrillic(name)) {
        listedTwice.add(k);
      }
      offices.set(k, { ns10, ns11, name });
    }
    const mhobt = new MhobtIndex(
      mhobtRows.map((r) => ({
        code: csText(r.tableColumn?.MHOBT, 'uzbKrText') ?? '',
        name: csText(r.tableColumn?.NAME, 'uzbKrText') ?? '',
      })),
    );
    if (offices.size < MIN_OFFICES || mhobt.size < MIN_PLACES) {
      throw new Error(
        `cs.egov.uz sent ${offices.size} tax offices and ${mhobt.size} MHOBT districts — too few to trust`,
      );
    }

    const held: Array<{
      ns10_code: number;
      ns11_code: number;
      ns10_name: string | null;
      ns11_name: string | null;
      soato: string | null;
    }> = await this.db.query(
      `SELECT ns10_code, ns11_code, ns10_name, ns11_name, soato FROM public.ns_soato_map`,
    );
    const territory = new Set<string>(
      (
        await this.db.query(`SELECT code FROM public.territory WHERE level = 3`)
      ).map((r: { code: string }) => String(r.code).trim()),
    );
    // спр.125 has 235 districts. A partial or empty copy cannot say a code
    // does not exist — a district MHOBT has not caught up with would be
    // cleared — so without it nothing is cleared as unknown.
    const territoryComplete = territory.size >= MIN_PLACES;
    const heldByKey = new Map(
      held.map((h) => [key(Number(h.ns10_code), Number(h.ns11_code)), h]),
    );
    const regionName = new Map<number, string>();
    for (const h of held) {
      if (h.ns10_name) regionName.set(Number(h.ns10_code), h.ns10_name);
    }

    const result: NsSoatoSyncResult = {
      dry,
      elapsedMs: 0,
      offices: offices.size,
      places: mhobt.size,
      held: held.length,
      confirmed: 0,
      changed: [],
      inserted: [],
      unconfirmed: [],
      held_back: [],
      companies_disagree: [],
      company_check: null,
      branches_corrected: 0,
    };

    const keys = new Set([...offices.keys(), ...heldByKey.keys()]);
    for (const k of keys) {
      const h = heldByKey.get(k);
      const source = offices.get(k);
      const [ns10, ns11] = k.split('/').map(Number);
      // The source's name when it lists the office; otherwise the name the
      // table was seeded with (ДЕНОВ ШАҲАР, ҚОРАСУВ ШАҲАР are not listed).
      const name = source?.name ?? clean(h?.ns11_name);
      const current = clean(h?.soato);
      const d = listedTwice.has(k)
        ? { soato: null, how: 'ambiguous' as NsHow, matched: null }
        : name
          ? decideNsSoato({ ns10, ns11, name }, mhobt)
          : { soato: null, how: 'unparsed' as NsHow, matched: null };
      const change = (to: string | null, how: NsPairChange['how']) => ({
        ns10,
        ns11,
        name,
        from: current,
        to,
        how,
        matched: d.matched,
        branches: 0,
      });
      const district = current ? current.slice(0, 7) : null;

      if (!h) {
        if (d.soato) result.inserted.push(change(d.soato, d.how));
        continue;
      }
      if (d.soato) {
        if (d.soato === current) result.confirmed++;
        else result.changed.push(change(d.soato, d.how));
      } else if (d.how === 'not_territorial') {
        if (current) result.changed.push(change(null, d.how));
        else result.confirmed++;
      } else if (
        district &&
        territoryComplete &&
        !mhobt.hasDistrict(district) &&
        !territory.has(district)
      ) {
        result.changed.push(change(null, 'invalid_code'));
      } else {
        result.unconfirmed.push({
          ns10,
          ns11,
          name,
          soato: current,
          how: d.how,
          ...(listedTwice.has(k)
            ? { detail: 'listed twice by the source under different names' }
            : {}),
        });
      }
    }

    // The companies' own word, where they carry both a SOATO and a pair. A
    // real run does not write without it: the classifiers alone once said
    // things the table then served for months.
    await stopIfAsked('before the company check');
    let evidenceError: string | null = null;
    const evidence = await this.companyEvidence().catch((err: Error) => {
      evidenceError = err.message;
      return null;
    });
    if (!evidence) {
      if (!dry) {
        throw new Error(
          `the company check could not run (${evidenceError}); nothing written`,
        );
      }
      result.company_check = `skipped — ${evidenceError}`;
    }
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    /** Why the companies contradict this change, or null when they do not. */
    const contradiction = (c: NsPairChange): string | null => {
      const e = evidence?.get(key(c.ns10, c.ns11));
      if (!e || e.total < EVIDENCE_MIN) return null;
      const share = (v: string | null) =>
        v ? (e.by.get(v.slice(0, 7)) ?? 0) / e.total : 0;
      if (c.to) {
        // A district the pair's own companies are hardly ever in.
        if (share(c.to) >= 0.2) return null;
        const [top, n] = [...e.by].sort((a, b) => b[1] - a[1])[0];
        return `classifiers say ${c.to}, ${pct(share(c.to))} of ${e.total} companies are there; most (${pct(n / e.total)}) say ${top}`;
      }
      // Clearing a value nearly all of them carry.
      if (c.from && share(c.from) >= 0.8) {
        return `classifiers say none, ${pct(share(c.from))} of ${e.total} companies say ${c.from}`;
      }
      return null;
    };
    const holdBack = (list: NsPairChange[]) =>
      list.filter((c) => {
        const why = contradiction(c);
        if (!why) return true;
        result.held_back.push({
          ns10: c.ns10,
          ns11: c.ns11,
          name: c.name,
          soato: c.from,
          how: c.how,
          detail: why,
        });
        return false;
      });
    result.changed = holdBack(result.changed);
    result.inserted = holdBack(result.inserted);

    // The value exactly as stored, spaces and all: the conditions below must
    // match the row that was read, and the branches were copied from it.
    const stored = (c: NsPairChange) =>
      heldByKey.get(key(c.ns10, c.ns11))?.soato ?? null;
    const raced = new Set<NsPairChange>();
    await stopIfAsked('before writing');
    await this.db.transaction(async (m: EntityManager) => {
      await m.query(`SET LOCAL statement_timeout = ${LONG_QUERY_MS}`);
      for (const c of result.changed) {
        if (dry) {
          const [{ n }] = await m.query(
            `SELECT count(*)::int AS n FROM public.company_branches
              WHERE ns10_code = $1 AND ns11_code = $2
                AND soato_code IS NOT DISTINCT FROM $3`,
            [c.ns10, c.ns11, stored(c)],
          );
          c.branches = n;
          continue;
        }
        const [, mapped] = await m.query(
          `UPDATE public.ns_soato_map SET soato = $3
            WHERE ns10_code = $1 AND ns11_code = $2
              AND soato IS NOT DISTINCT FROM $4`,
          [c.ns10, c.ns11, c.to, stored(c)],
        );
        // Someone changed the row since it was read (a person, or another
        // run): theirs stands, and the branches are not touched.
        if (!Number(mapped)) {
          raced.add(c);
          continue;
        }
        const [, n] = await m.query(
          `UPDATE public.company_branches
              SET soato_code = $3, updated_at = now()
            WHERE ns10_code = $1 AND ns11_code = $2
              AND soato_code IS NOT DISTINCT FROM $4`,
          [c.ns10, c.ns11, c.to, stored(c)],
        );
        c.branches = Number(n) || 0;
      }
      if (!dry) {
        for (const c of result.inserted) {
          await m.query(
            `INSERT INTO public.ns_soato_map (ns10_code, ns11_code, ns10_name, ns11_name, soato)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (ns10_code, ns11_code) DO NOTHING`,
            [
              c.ns10,
              c.ns11,
              regionName.get(c.ns10) ?? null,
              (c.name && taxOfficeLabel(c.name)) ?? c.name,
              c.to,
            ],
          );
        }
      }
    });
    for (const c of raced) {
      result.held_back.push({
        ns10: c.ns10,
        ns11: c.ns11,
        name: c.name,
        soato: c.from,
        how: c.how,
        detail: `the row changed while syncing; left as it is (classifiers say ${c.to ?? 'none'})`,
      });
    }
    result.changed = result.changed.filter((c) => !raced.has(c));
    result.branches_corrected = result.changed.reduce(
      (s, c) => s + c.branches,
      0,
    );

    if (evidence) {
      // After the changes: which pairs do their companies still place
      // elsewhere? Reported only — nothing here decides a value.
      const now = new Map<string, string | null>();
      for (const [k, h] of heldByKey) now.set(k, clean(h.soato));
      for (const c of [...result.changed, ...result.inserted]) {
        now.set(key(c.ns10, c.ns11), c.to);
      }
      for (const [k, value] of now) {
        const e = evidence.get(k);
        if (!value || !e || e.total < EVIDENCE_MIN) continue;
        const agree = (e.by.get(value.slice(0, 7)) ?? 0) / e.total;
        if (agree >= 0.5) continue;
        const [ns10, ns11] = k.split('/').map(Number);
        const [top, n] = [...e.by].sort((a, b) => b[1] - a[1])[0];
        result.companies_disagree.push({
          ns10,
          ns11,
          name: offices.get(k)?.name ?? clean(heldByKey.get(k)?.ns11_name),
          soato: value,
          how: 'companies',
          detail: `${pct(agree)} of ${e.total} companies on ${value}; most (${pct(n / e.total)}) on ${top}`,
        });
      }
    }

    result.elapsedMs = Date.now() - t0;
    return result;
  }

  /** pair → district (first seven SOATO digits) → companies. */
  private async companyEvidence(): Promise<
    Map<string, { total: number; by: Map<string, number> }>
  > {
    const rows: Array<{ ns10: number; ns11: number; d: string; n: number }> =
      await this.db.transaction(async (m: EntityManager) => {
        await m.query(`SET LOCAL statement_timeout = ${LONG_QUERY_MS}`);
        return m.query(
          `SELECT ns10_code AS ns10, ns11_code AS ns11,
                  left(btrim(soato_code::text), 7) AS d, count(*)::int AS n
             FROM public.company_info
            WHERE ns10_code IS NOT NULL AND ns11_code IS NOT NULL
              AND nullif(btrim(soato_code::text), '') IS NOT NULL
            GROUP BY 1, 2, 3`,
        );
      });
    const out = new Map<string, { total: number; by: Map<string, number> }>();
    for (const r of rows) {
      const k = key(Number(r.ns10), Number(r.ns11));
      const e = out.get(k) ?? { total: 0, by: new Map<string, number>() };
      e.total += r.n;
      e.by.set(r.d, (e.by.get(r.d) ?? 0) + r.n);
      out.set(k, e);
    }
    return out;
  }

  /**
   * Whether a real (not dry) sync has ever succeeded here. The weekly run
   * waits for it: the first sync changes values other features read (a
   * trader's SOATO, branch SOATO), so a person runs it — dry first — and the
   * schedule only keeps it current afterwards.
   */
  async started(): Promise<boolean> {
    const rows = await this.db.query(
      `SELECT 1 FROM public.job_runs WHERE job = $1 AND ok AND NOT dry LIMIT 1`,
      [JOB],
    );
    return rows.length > 0;
  }

  /** What the table holds and the last runs. */
  async status(): Promise<Record<string, unknown>> {
    const [map] = await this.db.query(
      `SELECT count(*)::int AS pairs,
              count(soato)::int AS with_district
         FROM public.ns_soato_map`,
    );
    return {
      weekly_enabled: nsSoatoSyncEnabled(),
      started: await this.started(),
      schedule:
        'Sunday 04:30 Asia/Tashkent, after the bank registry, before the company mahalla run; ' +
        'only once a real sync has been run by hand',
      sources: {
        tax_offices: `cs.egov.uz 083-4-001 (${TAX_OFFICES_ID})`,
        mhobt: `cs.egov.uz 082-3-007 (${MHOBT_ID})`,
      },
      map,
      recent_runs: await recentJobRuns(this.db, [JOB], 10),
    };
  }

  private describe(r: NsSoatoSyncResult, trigger: string): string {
    const pair = (x: { ns10: number; ns11: number; name: string | null }) =>
      `${x.ns10}/${x.ns11} ${x.name ?? ''}`.trim();
    const HOW: Record<string, string> = {
      name: 'same name',
      district_rank_city: 'city of district rank',
      close_name: 'one letter off',
      not_territorial: 'not a place',
      invalid_code: 'code in neither classifier',
      unparsed: 'name not understood',
      ambiguous: 'name fits two places',
      no_match: 'no such place',
    };
    const list = (label: string, xs: string[], max = 15) =>
      xs.length
        ? [
            `${label}${xs.length > max ? ` (${max} of ${xs.length})` : ''}:`,
            ...xs.slice(0, max).map((x) => `  • ${escapeHtml(x)}`),
          ]
        : [];
    const moved = r.changed.length + r.inserted.length;
    return [
      `${r.dry ? '🧪' : moved ? '🗺️' : '✅'} <b>Tax office → SOATO map — ${escapeHtml(trigger)}</b>` +
        `${r.dry ? ' (dry run, nothing written)' : ''}`,
      `Took: ${Math.round(r.elapsedMs / 1000)} s · source: cs.egov.uz (tax offices ${r.offices}, MHOBT ${r.places})`,
      `Pairs: ${r.held} · confirmed ${r.confirmed} · ${r.dry ? 'would change' : 'changed'} ${r.changed.length} · new ${r.inserted.length} · ` +
        `unconfirmed (kept) ${r.unconfirmed.length}` +
        (r.held_back.length ? ` · held back ${r.held_back.length}` : ''),
      `Branches ${r.dry ? 'to correct' : 'corrected'}: ${r.branches_corrected}`,
      ...(moved ? [] : ['No changes.']),
      ...list(
        r.dry ? 'Would change' : 'Changed',
        r.changed.map(
          (c) =>
            `${pair(c)}: ${c.from ?? 'none'} → ${c.to ?? 'none'} (${HOW[c.how] ?? c.how}${c.matched ? `: ${c.matched}` : ''})` +
            (c.branches ? `, ${c.branches} branches` : ''),
        ),
        30,
      ),
      ...list(
        'New pairs',
        r.inserted.map((c) => `${pair(c)} → ${c.to} (${HOW[c.how] ?? c.how})`),
      ),
      ...list(
        '⚠️ Held back — the companies say otherwise',
        r.held_back.map((x) => `${pair(x)}: ${x.detail}`),
      ),
      ...list(
        'Unconfirmed, kept as they are',
        r.unconfirmed.map(
          (x) => `${pair(x)}: ${x.soato ?? 'none'} (${HOW[x.how] ?? x.how})`,
        ),
      ),
      ...list(
        '⚠️ Companies place these elsewhere',
        r.companies_disagree.map((x) => `${pair(x)}: ${x.detail}`),
      ),
      ...(r.company_check ? [`Company check ${r.company_check}`] : []),
      ...(!r.dry && moved
        ? [
            '👉 Mahallas follow at the next full run: POST /api/company-mahalla/run',
          ]
        : []),
    ].join('\n');
  }
}
