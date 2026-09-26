import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

const BASE_URL = 'https://ishapi.mehnat.uz/api/v1';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/**
 * The source pages with `per_page` (it ignores `limit` and would give 20).
 * Most employers fit in one page; the rest are walked to the last page.
 */
const PAGE_SIZE = 100;

/** Postings are read one by one after the list; a few at a time is polite. */
const DETAIL_CONCURRENCY = 6;

/**
 * The backend gives the whole call ~11s. Postings not read by this point are
 * left null — their list rows still go back — so a big employer returns a
 * full list with some summaries instead of timing out with nothing.
 */
const DETAIL_BUDGET_MS = 7000;

export interface MehnatVacanciesResult {
  tin: string;
  /** The list rows for this employer, exactly as the source sends them. */
  rows: any[];
  /** Each posting's page (`data` of `/vacancies/:id`) by id; null when it failed. */
  details: Record<string, any>;
}

/**
 * The national vacancy database behind ish.mehnat.uz (Ministry of Employment).
 *
 * The API is open — no captcha, no token — but its address range
 * (213.230.70.0/24, Uzbektelecom) does not answer from the production
 * hosting network, while it does from an Uzbek office line. So the box reads
 * it and hands the backend the raw rows; parsing stays in the backend, next
 * to the rest of the vacancies code.
 *
 * CROSS-SERVICE CONTRACT with humora-backend (MehnatVacancyProvider):
 * `GET /mehnat/vacancies?tin=` → `{ tin, rows[], details{} }`, upstream
 * shapes unchanged. A list that could not be read is a 502, never an empty
 * list, so the backend does not report a hiring company as having no openings.
 */
@Injectable()
export class MehnatService {
  private readonly logger = new Logger(MehnatService.name);

  constructor(private readonly http: HttpService) {}

  async getVacancies(tin: string): Promise<MehnatVacanciesResult> {
    const t = String(tin ?? '').trim();
    if (!/^\d{9}$/.test(t)) {
      throw new BadRequestException('tin must be 9 digits');
    }

    const startedAt = Date.now();
    let rows: any[];
    let pages: number;
    try {
      ({ rows, pages } = await this.listAll(t));
    } catch (err: any) {
      this.logger.warn(`[mehnat] tin=${t} list failed: ${err?.message ?? err}`);
      throw new BadGatewayException('ish.mehnat.uz did not answer');
    }

    const deadline = Date.now() + DETAIL_BUDGET_MS;
    const details: Record<string, any> = {};
    await mapLimit(rows, DETAIL_CONCURRENCY, async (r) => {
      const id = String(r?.id ?? '');
      if (!id) return;
      if (Date.now() > deadline) {
        details[id] = null;
        return;
      }
      try {
        const d = await this.fetchJson(
          `${BASE_URL}/vacancies/${encodeURIComponent(id)}`,
          {},
          10000,
        );
        details[id] = d?.data ?? null;
      } catch (err: any) {
        this.logger.warn(
          `[mehnat] vacancy ${id} failed: ${err?.message ?? err}`,
        );
        details[id] = null;
      }
    });

    const missing = Object.values(details).filter((d) => d === null).length;
    this.logger.log(
      `[mehnat] tin=${t} — ${rows.length} vacancy(ies) in ${pages} page(s), ${missing} detail(s) missing, ${Date.now() - startedAt}ms`,
    );
    return { tin: t, rows, details };
  }

  /**
   * Every list row of the employer, page by page. A page that fails fails the
   * whole list: half a list would read as a company hiring less than it is.
   */
  private async listAll(tin: string): Promise<{ rows: any[]; pages: number }> {
    const rows: any[] = [];
    let page = 1;
    let lastPage = 1;
    let pages = 0;
    do {
      pages++;
      const body = await this.fetchJson(
        `${BASE_URL}/vacancies`,
        { company_tin: tin, per_page: PAGE_SIZE, page },
        15000,
      );
      const pageRows: unknown = body?.data?.data;
      const all = Array.isArray(pageRows) ? pageRows : [];
      const mine = rowsForTin(body, tin);
      rows.push(...mine);
      // An unknown tin gets the whole national list back, unfiltered —
      // tens of thousands of rows. Never walk that.
      if (mine.length < all.length) break;
      lastPage = Number(body?.data?.last_page) || 1;
      page++;
    } while (page <= lastPage);
    return { rows, pages };
  }

  private async fetchJson(
    url: string,
    params: Record<string, string | number>,
    timeout: number,
  ): Promise<any> {
    const resp = await firstValueFrom(
      this.http.get(url, {
        params,
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        timeout,
        validateStatus: () => true,
      }),
    );
    if (resp.status !== 200) throw new Error(`HTTP ${resp.status}`);
    return resp.data;
  }
}

/**
 * The rows that belong to `tin`. The source ignores a `company_tin` it does
 * not know and sends a full unfiltered page instead of an empty one, so every
 * row is checked — another company's postings must never be passed on.
 */
export function rowsForTin(body: any, tin: string): any[] {
  const rows: unknown = body?.data?.data;
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => String(r?.company_tin) === tin);
}

async function mapLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
}
