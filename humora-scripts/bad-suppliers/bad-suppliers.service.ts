import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { firstValueFrom } from 'rxjs';
import { logFieldChanges } from '../../common/change-log';

const RPC_URL = 'https://api.xt-xarid.uz/rpc';
const PAGE_URL = 'https://xt-xarid.uz/registry/bad_suppliers';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

export interface BadSupplierRecord {
  inn: string;
  name: string;
  note: string | null;
  date_begin: string | null;
  date_end: string | null;
}

export interface BadSupplierCheck {
  inn: string;
  is_bad_supplier: boolean;
  record?: BadSupplierRecord;
}

/**
 * xt-xarid.uz "Insofsiz yetkazib beruvchilar" reyestri.
 * JSON-RPC 2.0 API, captcha yo'q.
 */
@Injectable()
export class BadSuppliersService {
  private readonly logger = new Logger(BadSuppliersService.name);

  constructor(
    private readonly httpService: HttpService,
    @InjectDataSource('flottDb') private readonly remoteDb: DataSource,
  ) {}

  /** Is this INN on the blacklist? */
  async checkByInn(inn: string): Promise<BadSupplierCheck> {
    this.logger.log(`[bad-suppliers] INN=${inn}`);
    const items = await this.rpc<any[]>('read', { code: inn });
    const match = items.find((r) => String(r.code) === inn) || items[0];

    if (!match) {
      await this.upsertBadSupplier(inn, false, null);
      return { inn, is_bad_supplier: false };
    }

    this.logger.log(`[bad-suppliers] ⚠️ INN=${inn} found: ${match.name}`);
    const record = this.mapRecord(match);
    await this.upsertBadSupplier(inn, true, record);
    return {
      inn,
      is_bad_supplier: true,
      record,
    };
  }

  /**
   * Upsert into `company_bad_suppliers`. Called on every `checkByInn`
   * so the row stays fresh — even `false` checks are recorded so we
   * know "this INN was checked at T and was clean".
   *
   * `inn` has UNIQUE constraint, so `ON CONFLICT DO UPDATE` is enough.
   */
  private async upsertBadSupplier(
    inn: string,
    isBad: boolean,
    record: BadSupplierRecord | null,
  ): Promise<void> {
    try {
      const [stored] = await this.remoteDb.query(
        `SELECT is_bad, name, note, date_begin, date_end
           FROM public.company_bad_suppliers WHERE inn = $1`,
        [inn],
      );
      await this.remoteDb.query(
        `INSERT INTO public.company_bad_suppliers
           (inn, is_bad, name, note, date_begin, date_end, checked_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, now(), now(), now())
         ON CONFLICT (inn) DO UPDATE SET
           is_bad     = EXCLUDED.is_bad,
           name       = EXCLUDED.name,
           note       = EXCLUDED.note,
           date_begin = EXCLUDED.date_begin,
           date_end   = EXCLUDED.date_end,
           checked_at = now(),
           updated_at = now()`,
        [
          inn,
          isBad,
          record?.name ?? null,
          record?.note ?? null,
          record?.date_begin ?? null,
          record?.date_end ?? null,
        ],
      );
      // A listing the company has left is kept, not nulled away.
      await logFieldChanges(
        this.remoteDb,
        {
          entity: 'company_bad_suppliers',
          inn,
          key: null,
          source: 'bad-suppliers',
        },
        stored,
        {
          is_bad: isBad,
          name: record?.name ?? null,
          note: record?.note ?? null,
          date_begin: record?.date_begin ?? null,
          date_end: record?.date_end ?? null,
        },
        ['is_bad', 'name', 'note', 'date_begin', 'date_end'],
      ).catch((e) =>
        this.logger.warn(`[bad-suppliers] change log ${inn}: ${e.message}`),
      );
      this.logger.log(`[bad-suppliers] DB UPSERT inn=${inn} isBad=${isBad}`);
    } catch (err: any) {
      this.logger.error(
        `[bad-suppliers] DB upsert failed for ${inn}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * The whole blacklist, in pages.
   *
   * This asked for 500 in one call, and xt-xarid refuses anything above 100
   * — `{"code":"bad_params","data":[{"name":"limit","message":"Значение
   * должно быть <= 100"}]}`. rpcRaw turns an RPC error into a throw and
   * nothing here caught it, so the endpoint answered 500 every time. It was
   * unauthenticated until 2026-08-30, so this was not a regression from
   * guarding it; it had simply never worked. `checkByInn` was unaffected
   * because it uses the default limit of 51.
   *
   * Paged rather than pinned to 100, because the ceiling and the size of the
   * registry are converging: the comment here used to say "~14 records" and
   * the count is 41 today. A fixed 100 would work now and then quietly start
   * returning a partial blacklist — the wrong failure for a list whose whole
   * purpose is to be complete.
   */
  async listAll(): Promise<BadSupplierRecord[]> {
    const PAGE = 100; // xt-xarid's maximum
    const MAX_PAGES = 50; // 5,000 records — a stop, not an expectation

    const all: BadSupplierRecord[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const items = await this.rpc<any[]>(
        'read',
        {},
        { limit: PAGE, offset: page * PAGE },
      );
      all.push(...items.map((r) => this.mapRecord(r)));

      // A short page is the last page.
      if (items.length < PAGE) return all;
    }

    this.logger.warn(
      `[bad-suppliers] stopped at ${MAX_PAGES} pages (${all.length} records) — ` +
        `the registry may be larger than this loop expects`,
    );
    return all;
  }

  /** Total number of bad suppliers currently on the registry. */
  async count(): Promise<number> {
    const resp = await this.rpcRaw('count', {});
    return resp?.count ?? 0;
  }

  private mapRecord(r: any): BadSupplierRecord {
    return {
      inn: String(r.code ?? r.id ?? ''),
      name: r.name ?? null,
      note: r.note ?? null,
      date_begin: this.toDateString(r.date_begin),
      date_end: this.toDateString(r.date_end),
    };
  }

  /**
   * xt-xarid returns ISO timestamps like "2025-09-23T00:00:00.000000Z" — for
   * a `date` column / UI display we just need "2025-09-23". Returns null
   * unchanged; preserves any plain "YYYY-MM-DD" already in that form.
   */
  private toDateString(raw: unknown): string | null {
    if (raw == null) return null;
    const s = String(raw).trim();
    if (!s) return null;
    // already YYYY-MM-DD?
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // ISO timestamp — slice off the time component
    const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (m) return m[1];
    // fallback: try Date()
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
  }

  private async rpc<T>(
    op: 'read' | 'count',
    filters: Record<string, any>,
    extra: { limit?: number; offset?: number } = {},
  ): Promise<T> {
    const result = await this.rpcRaw(op, filters, extra);
    return (result ?? []) as T;
  }

  private async rpcRaw(
    op: 'read' | 'count',
    filters: Record<string, any>,
    extra: { limit?: number; offset?: number } = {},
  ): Promise<any> {
    const body = {
      id: 1,
      jsonrpc: '2.0',
      method: 'ref',
      params: {
        ref: 'ref_bad_suppliers',
        op,
        ...(op === 'read'
          ? { limit: extra.limit ?? 51, offset: extra.offset ?? 0 }
          : {}),
        filters,
      },
    };

    const resp = await firstValueFrom(
      this.httpService.post(RPC_URL, body, {
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Origin: 'https://xt-xarid.uz',
          Referer: PAGE_URL,
        },
        timeout: 15000,
        validateStatus: () => true,
      }),
    );

    if (resp.data?.error) {
      throw new Error(`xt-xarid RPC error: ${JSON.stringify(resp.data.error)}`);
    }
    return resp.data?.result ?? null;
  }
}
