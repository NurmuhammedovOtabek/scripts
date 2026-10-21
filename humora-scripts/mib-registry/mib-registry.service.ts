import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHash } from 'crypto';
import axios from 'axios';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BASE = 'https://mib.uz';

/** The two lists mib.uz publishes as plain pages, outside its service forms. */
export type MibRegistry = 'alimony' | 'wanted';

const PAGE_PATH: Record<MibRegistry, string> = {
  alimony: 'aliment_not_pay',
  wanted: 'wanted',
};

export interface MibRegistryRow {
  registry: MibRegistry;
  row_key: string;
  inn: string | null;
  full_name: string;
  birth_date: string | null;
  region: string | null;
  area: string | null;
  case_number: string | null;
  inspector_phone: string | null;
  decree_date: string | null;
}

export interface MibRegistrySyncResult {
  registry: MibRegistry;
  fetched: number;
  inserted: number;
  updated: number;
  removed: number;
  /** True when the source returned a full page and more rows may exist. */
  truncated: boolean;
}

/**
 * The alimony-debtor and wanted-person registries on mib.uz.
 *
 * These are not the captcha-gated debt lookup `MibScriptService` drives —
 * they are two ordinary pages whose table is filled by one AJAX call, with
 * no captcha anywhere on them. That is what makes bulk import possible at
 * all, and it is worth stating plainly because the neighbouring mib.uz
 * integration needs Tesseract to get a single answer.
 *
 * mib.uz is geo-restricted to Uzbekistan addresses (see CLAUDE.md), so this
 * only works from production or another Uzbek host.
 */
@Injectable()
export class MibRegistryService {
  private readonly logger = new Logger(MibRegistryService.name);

  /**
   * Rows requested in one call.
   *
   * The endpoint has no offset parameter — `page_count` is a plain "top N",
   * so this number is the whole coverage the import can have. It cannot
   * simply be raised: 3 000 answers, 10 000 and 50 000 both return
   * `504 Gateway Timeout` (measured 2026-08-26). Raising it means finding
   * the real ceiling by bisection, not guessing.
   */
  private readonly PAGE_COUNT = 3000;

  /** The list call is slow by nature — it serialises thousands of rows. */
  private readonly LIST_TIMEOUT_MS = 120_000;
  private readonly PAGE_TIMEOUT_MS = 30_000;

  constructor(
    @InjectDataSource('flottDb') private readonly remoteDb: DataSource,
  ) {}

  // ─── Reads ───────────────────────────────────────────────────────────────

  /**
   * Which of the two lists this STIR is currently on.
   *
   * Answers from storage, never from the source: the source cannot be
   * queried by STIR at all — its form filters on PINFL and passport only —
   * so a live answer would mean pulling the whole list per lookup.
   */
  async findByInn(inn: string): Promise<MibRegistryRow[]> {
    if (!/^\d{9}$/.test(String(inn || ''))) return [];
    try {
      return await this.remoteDb.query(
        `SELECT registry, row_key, inn, full_name, birth_date, region, area,
                case_number, inspector_phone, decree_date,
                first_seen_at, last_seen_at
           FROM public.person_mib_registry
          WHERE inn = $1 AND removed_at IS NULL
          ORDER BY registry, last_seen_at DESC`,
        [inn],
      );
    } catch (err: any) {
      this.logger.warn(
        `[mib-registry] lookup failed for ${inn}: ${err?.message ?? err}`,
      );
      return [];
    }
  }

  /**
   * Rows the registry published without a STIR.
   *
   * These are kept rather than dropped — each one is a real enforcement
   * record — but until a STIR is attached they cannot answer "is this trader
   * an alimony debtor". All the registry gives to identify the person is a
   * name and a birth date, so resolving them is a separate pass against
   * whatever we hold that carries both; this method is the queue that pass
   * reads from.
   */
  async findWithoutInn(
    registry?: MibRegistry,
    limit = 500,
  ): Promise<MibRegistryRow[]> {
    const cap = Math.min(Math.max(Number(limit) || 500, 1), 5000);
    try {
      return await this.remoteDb.query(
        `SELECT registry, row_key, full_name, birth_date, region, area,
                case_number, inspector_phone, decree_date, first_seen_at
           FROM public.person_mib_registry
          WHERE inn IS NULL
            AND removed_at IS NULL
            AND ($1::text IS NULL OR registry = $1)
          ORDER BY first_seen_at DESC
          LIMIT ${cap}`,
        [registry ?? null],
      );
    } catch (err: any) {
      this.logger.warn(
        `[mib-registry] unresolved lookup failed: ${err?.message ?? err}`,
      );
      return [];
    }
  }

  /**
   * Attaches a STIR to a row the registry left without one.
   *
   * Only fills a blank — an INN the registry itself published is what the
   * source said, and a resolution pass guessing over it would replace a fact
   * with an inference. Returns whether a row was actually filled.
   */
  async attachInn(
    registry: MibRegistry,
    rowKey: string,
    inn: string,
  ): Promise<boolean> {
    if (!/^\d{9}$/.test(String(inn || ''))) {
      throw new Error(`attachInn: "${inn}" is not a 9-digit STIR`);
    }
    const res = await this.remoteDb.query(
      `UPDATE public.person_mib_registry
          SET inn = $3, updated_at = now()
        WHERE registry = $1 AND row_key = $2 AND inn IS NULL
        RETURNING 1`,
      [registry, rowKey, inn],
    );
    return Array.isArray(res) && res.length > 0;
  }

  // ─── Sync ────────────────────────────────────────────────────────────────

  async syncAll(): Promise<MibRegistrySyncResult[]> {
    const out: MibRegistrySyncResult[] = [];
    for (const registry of ['alimony', 'wanted'] as const) {
      out.push(await this.sync(registry));
    }
    return out;
  }

  async sync(registry: MibRegistry): Promise<MibRegistrySyncResult> {
    const started = Date.now();
    const { rows, truncated } = await this.fetch(registry);

    let inserted = 0;
    let updated = 0;
    const seen: string[] = [];

    for (const row of rows) {
      const wasInserted = await this.upsert(row);
      if (wasInserted) inserted++;
      else updated++;
      seen.push(row.row_key);
    }

    // A truncated fetch saw a prefix of the list, not the list. Rows it did
    // not return are not absent from the registry — they are past the cap.
    // Marking them removed would record, on a credit subject, that an
    // enforcement case was closed when nothing of the sort happened.
    let removed = 0;
    if (truncated) {
      this.logger.warn(
        `[mib-registry] ${registry} — the answer filled a whole page ` +
          `(${rows.length} = page_count), so the list may be cut off. ` +
          `Marking missing rows as removed was skipped.`,
      );
    } else {
      removed = await this.markRemoved(registry, seen);
    }

    const result: MibRegistrySyncResult = {
      registry,
      fetched: rows.length,
      inserted,
      updated,
      removed,
      truncated,
    };
    this.logger.log(
      `[mib-registry] ${registry} — ${rows.length} qator ` +
        `(yangi=${inserted} yangilandi=${updated} olib tashlandi=${removed}` +
        `${truncated ? ' KESILGAN' : ''}) ${Date.now() - started}ms`,
    );
    return result;
  }

  // ─── Source ──────────────────────────────────────────────────────────────

  /**
   * One list, as the page's own JavaScript would fetch it.
   *
   * Two steps, and the first cannot be skipped: the data URL carries an
   * `xenc` token that is embedded in the page and changes, so it has to be
   * read out of the HTML each run rather than pinned in config.
   */
  async fetch(
    registry: MibRegistry,
  ): Promise<{ rows: MibRegistryRow[]; truncated: boolean }> {
    const path = PAGE_PATH[registry];
    const pageUrl = `${BASE}/${path}`;

    const page = await axios.get(pageUrl, {
      headers: { 'User-Agent': UA },
      timeout: this.PAGE_TIMEOUT_MS,
    });

    const dsPath = this.extractDsPath(String(page.data ?? ''));
    if (!dsPath) {
      throw new Error(
        `mib.uz ${path}: sahifada ds?xenc= havolasi topilmadi — sahifa o'zgargan bo'lishi mumkin`,
      );
    }

    const cookie = this.cookieHeader(page.headers['set-cookie']);
    // `page_count` is not optional. Without it the endpoint answers
    // `{"msg":"Тизим хатолиги…","total":-1,"rows":[]}` — an error dressed as
    // an empty result, which a caller that only checks `rows` reads as
    // "nobody is on this list".
    const dataUrl = `${BASE}/${dsPath}&page_count=${this.PAGE_COUNT}`;

    const resp = await axios.get(dataUrl, {
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        'X-Requested-With': 'XMLHttpRequest',
        Referer: pageUrl,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      timeout: this.LIST_TIMEOUT_MS,
    });

    const body = resp.data;
    const total = typeof body?.total === 'number' ? body.total : null;
    if (total === -1) {
      throw new Error(
        `mib.uz ${path}: manba xatolik qaytardi — "${body?.msg ?? 'noma`lum'}"`,
      );
    }

    const raw: any[] = Array.isArray(body?.rows) ? body.rows : [];
    const rows = raw
      .map((r) => this.mapRow(registry, r))
      .filter((r): r is MibRegistryRow => r !== null);

    return { rows, truncated: raw.length >= this.PAGE_COUNT };
  }

  /** `$.get('ds?xenc=…', …)` — the page's own data URL. */
  private extractDsPath(html: string): string | null {
    const m = html.match(/\$\.get\(\s*['"](ds\?xenc=[^'"]+)['"]/);
    return m ? m[1] : null;
  }

  private cookieHeader(setCookie: string[] | undefined): string {
    if (!setCookie?.length) return '';
    return setCookie
      .map((h) => h.split(';')[0].trim())
      .filter(Boolean)
      .join('; ');
  }

  private mapRow(registry: MibRegistry, r: any): MibRegistryRow | null {
    const full_name = this.text(r?.debtor);
    // A row with no name identifies nobody and cannot be deduplicated
    // against the next run; there is nothing useful to store.
    if (!full_name) return null;

    // The registry spells the debtor's own STIR here. It is a personal STIR
    // (prefix 4 or 5) far more often than a company one, which is exactly why
    // this list is worth joining against `individual_entrepreneurs`.
    const innRaw = this.text(r?.debtor_inn);
    const inn = innRaw && /^\d{9}$/.test(innRaw) ? innRaw : null;

    const row: Omit<MibRegistryRow, 'row_key'> = {
      registry,
      inn,
      full_name,
      birth_date: this.text(r?.debtor_birth_date),
      region: this.text(r?.region),
      area: this.text(r?.area),
      case_number: this.text(r?.doc_register_number),
      inspector_phone: this.text(r?.chief_inspector_phone),
      // Only the wanted list carries this.
      decree_date: this.text(r?.search_decree_date),
    };

    return { ...row, row_key: this.rowKey(row) };
  }

  /**
   * Identity of a row across runs.
   *
   * The enforcement document number would be the natural key, but the source
   * leaves it blank often enough that a unique index on it would either
   * reject good rows or, with nulls treated as distinct, re-insert the same
   * person on every sync. Hashing the identifying fields together sidesteps
   * both.
   *
   * `inn` is deliberately NOT part of it. The registry publishes a STIR on
   * some rows and not others, and a row that gains one later is the same
   * enforcement record — if the STIR were hashed in, that row would arrive
   * under a new key and be stored a second time instead of updating the one
   * we already have.
   */
  private rowKey(row: Omit<MibRegistryRow, 'row_key'>): string {
    return createHash('sha1')
      .update(
        [
          row.registry,
          row.case_number ?? '',
          row.full_name,
          row.birth_date ?? '',
        ].join('|'),
      )
      .digest('hex');
  }

  private text(v: unknown): string | null {
    if (v == null) return null;
    const s = String(v).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
    return s === '' ? null : s;
  }

  // ─── Storage ─────────────────────────────────────────────────────────────

  /** Returns true when the row was new to us. */
  private async upsert(row: MibRegistryRow): Promise<boolean> {
    const res = await this.remoteDb.query(
      `INSERT INTO public.person_mib_registry
         (registry, row_key, inn, full_name, birth_date, region, area,
          case_number, inspector_phone, decree_date,
          first_seen_at, last_seen_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(), now(), now(), now())
       ON CONFLICT (registry, row_key) DO UPDATE SET
         -- The source wins whenever it publishes a STIR. When it does not,
         -- a value already on the row is kept: it was put there by the
         -- resolution pass, and a plain overwrite would blank it again on
         -- every sync, so the row could never stay resolved.
         inn             = COALESCE(EXCLUDED.inn, person_mib_registry.inn),
         full_name       = EXCLUDED.full_name,
         birth_date      = EXCLUDED.birth_date,
         region          = EXCLUDED.region,
         area            = EXCLUDED.area,
         case_number     = EXCLUDED.case_number,
         inspector_phone = EXCLUDED.inspector_phone,
         decree_date     = EXCLUDED.decree_date,
         last_seen_at    = now(),
         -- A person who reappears is on the list again; the earlier removal
         -- must not keep the row invisible.
         removed_at      = NULL,
         updated_at      = now()
       RETURNING (xmax = 0) AS inserted`,
      [
        row.registry,
        row.row_key,
        row.inn,
        row.full_name,
        row.birth_date,
        row.region,
        row.area,
        row.case_number,
        row.inspector_phone,
        row.decree_date,
      ],
    );
    return res?.[0]?.inserted === true;
  }

  /** Marks every stored row of this registry that the run did not see. */
  private async markRemoved(
    registry: MibRegistry,
    seenKeys: string[],
  ): Promise<number> {
    // Nothing came back at all. That is far more likely to be a source
    // failure than every debtor being cleared at once, so nothing is touched.
    if (seenKeys.length === 0) {
      this.logger.warn(
        `[mib-registry] ${registry} — 0 qator qaytdi, hech narsa olib tashlanmadi`,
      );
      return 0;
    }

    const res = await this.remoteDb.query(
      `UPDATE public.person_mib_registry
          SET removed_at = now(), updated_at = now()
        WHERE registry = $1
          AND removed_at IS NULL
          AND row_key <> ALL($2::text[])
        RETURNING 1`,
      [registry, seenKeys],
    );
    return Array.isArray(res) ? res.length : 0;
  }
}
