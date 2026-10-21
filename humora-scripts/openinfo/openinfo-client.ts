import { Injectable, Logger } from '@nestjs/common';
import axios, { AxiosError } from 'axios';

/** The portal's API host; `openinfo.uz/api/v2/` answers 404 since 2026. */
export const OPENINFO_API = 'https://new-api.openinfo.uz/api/v2/';
/** The portal's own page for an organisation — the one link the site shows. */
export const OPENINFO_ORG_PAGE = (orgId: number) =>
  `https://openinfo.uz/ru/organizations/${orgId}`;
/** The portal's signed PDF of one fact (by its list id). */
export const OPENINFO_FACT_PDF = (factId: number) =>
  `https://openinfo.uz/ru/facts/to_pdf/${factId}`;

/**
 * One request every 1.5 s, start to start, across the whole process — the
 * nightly walk and a reader opening a fact share it. The portal allows 200 a
 * minute (`X-RateLimit-Limit`); this is 40.
 */
const INTERVAL_MS = 1_500;
const TIMEOUT_MS = 30_000;
/** A 429 waits what the portal asks, but never longer than this. */
const MAX_RETRY_AFTER_MS = 120_000;
const BACKOFF_MS = [2_000, 5_000];

export interface OpeninfoPage<T> {
  count: number;
  total_pages?: number;
  next: string | null;
  results: T[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A request that failed: `status` is the portal's HTTP answer, if it gave
 * one, and `detail` the reason it wrote (`{"error": "…"}`).
 */
export class OpeninfoHttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly detail: string | null = null,
  ) {
    super(message);
  }
}

/**
 * The portal answered, but refused (a 4xx other than 404 and 429): it cannot
 * give this, and says why. Seen on dev's first fill (2026-10-17):
 * "Micro-finance organizations only have quarterly reports.", "Unknown
 * organization type: LLC", and its indicator calculation failing for some
 * companies ("local variable 'long_term_bank_loans' referenced before
 * assignment"). Asking again changes nothing.
 */
export const portalRefused = (err: unknown): boolean =>
  err instanceof OpeninfoHttpError &&
  err.status !== null &&
  err.status >= 400 &&
  err.status < 500;

/**
 * GETs to openinfo.uz's open API (no key). `get` answers the JSON body, null
 * for a 404 — the portal's way of saying a record is not there — and throws
 * for anything else once its retries are spent: a failed request is never an
 * empty answer.
 */
@Injectable()
export class OpeninfoClient {
  private readonly logger = new Logger(OpeninfoClient.name);
  /** When the next request may start (ms since epoch). */
  private nextSlot = 0;

  /** Waits for this process's next slot; reserved before any await. */
  private async slot(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.nextSlot);
    this.nextSlot = at + INTERVAL_MS;
    if (at > now) await sleep(at - now);
  }

  async get<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    opts: { attempts?: number; timeoutMs?: number } = {},
  ): Promise<T | null> {
    const attempts = opts.attempts ?? 3;
    const timeout = opts.timeoutMs ?? TIMEOUT_MS;
    let lastError: OpeninfoHttpError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await this.slot();
      try {
        const res = await axios.get<T>(OPENINFO_API + path, {
          params,
          timeout,
          signal: AbortSignal.timeout(timeout + 5_000),
          headers: { 'User-Agent': 'Humora/1.0', Accept: 'application/json' },
          validateStatus: (s) => s === 200 || s === 404,
        });
        if (res.status === 404) return null;
        if (res.data === null || typeof res.data !== 'object') {
          throw new Error(`openinfo ${path}: the answer is not JSON`);
        }
        return res.data;
      } catch (err) {
        const status = (err as AxiosError).response?.status;
        const said = (err as AxiosError<{ error?: unknown }>).response?.data
          ?.error;
        const detail = typeof said === 'string' ? said.slice(0, 200) : null;
        lastError = new OpeninfoHttpError(
          `openinfo ${path}: ${status ? `HTTP ${status}` : (err as Error).message}${detail ? ` — ${detail}` : ''}`,
          status ?? null,
          detail,
        );
        if (attempt === attempts) break;
        if (status === 429) {
          const header = Number(
            (err as AxiosError).response?.headers?.['retry-after'],
          );
          const wait =
            Number.isFinite(header) && header > 0 ? header * 1000 : 60_000;
          this.logger.warn(
            `[openinfo] 429 on ${path} — waiting ${Math.round(Math.min(wait, MAX_RETRY_AFTER_MS) / 1000)} s`,
          );
          await sleep(Math.min(wait, MAX_RETRY_AFTER_MS));
        } else if (status && status < 500) {
          break; // A 4xx other than 404/429 will not change on a retry.
        } else {
          await sleep(BACKOFF_MS[attempt - 1] ?? 5_000);
        }
      }
    }
    throw lastError ?? new Error(`openinfo ${path}: no answer`);
  }

  /** Every page of a list, `page_size` at a time. */
  async all<T>(
    path: string,
    params: Record<string, string | number | undefined> = {},
    pageSize = 100,
  ): Promise<{ count: number; rows: T[]; pages: number }> {
    const rows: T[] = [];
    const { count, pages } = await this.eachPage<T>(
      path,
      params,
      async (page) => {
        rows.push(...page);
      },
      pageSize,
    );
    return { count, rows, pages };
  }

  /**
   * Every page of a list, handed over as it arrives — for a list too long to
   * hold whole (the facts: ~650 pages, 16 minutes). What a page's handler
   * stored stays stored if a later page fails. A handler answering `false`
   * stops the walk. `ended` says whether the list was read to its end.
   */
  async eachPage<T>(
    path: string,
    params: Record<string, string | number | undefined>,
    onPage: (rows: T[]) => Promise<void | false>,
    pageSize = 100,
  ): Promise<{ count: number; pages: number; read: number; ended: boolean }> {
    let count = 0;
    let pages = 0;
    let read = 0;
    for (let page = 1; ; page++) {
      const body = await this.get<OpeninfoPage<T>>(path, {
        ...params,
        page,
        page_size: pageSize,
      });
      if (!body) return { count, pages, read, ended: false };
      pages++;
      count = body.count ?? count;
      const rows = body.results ?? [];
      read += rows.length;
      if ((await onPage(rows)) === false) {
        return { count, pages, read, ended: false };
      }
      if (!body.next || !rows.length) {
        return { count, pages, read, ended: !count || read >= count };
      }
    }
  }
}
