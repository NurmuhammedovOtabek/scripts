import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import {
  AUCTION_COMPLETED_PAGE,
  AUCTION_DEALS_PAGE,
  AuctionDealFields,
  AuctionScriptService,
} from './auction.service';
import { TelegramAlertService } from '../common/telegram-alert.service';
import { AuctionOutcome, auctionStatusClause } from './auction-status';

/** `parse_mode: HTML` — an error message with a `<` in it would break the send. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Advisory-lock id, distinct from every other nightly job's. */
const LOCK_ID = 8_140_416;

/** What one backfill call is allowed to spend before handing control back. */
const BACKFILL_PAGES_PER_RUN = 40;

/** How often a long backfill says where it has got to. */
const PROGRESS_EVERY_PAGES = 10;

/**
 * How close to the source counts as "we have the catalogue".
 *
 * Not 100%: the two sides are counted at different moments and the rich
 * endpoint can hold a deal the thin history has not listed, so an exact match
 * would cry wolf on a healthy mirror. Well under this is the state an
 * unfinished first load leaves behind.
 */
const COMPLETE_ENOUGH = 0.9;

/** New rows against ones already held — the two are not the same news. */
export interface SaveResult {
  inserted: number;
  updated: number;
}

/**
 * What one daily pass did.
 *
 * `seen` and `pages` are here for the nightly alert rather than for any
 * caller: "0 new" on its own cannot be told apart from "the job never
 * reached the source", and the difference is the whole point of alerting.
 * A night that read four pages and recognised every row is working; a night
 * that read none is not.
 */
export interface IncrementResult {
  rich: number;
  thin: number;
  seen: number;
  pages: number;
  /**
   * Whether the walk reached deals we already held, or ran out of budget.
   *
   * The thin endpoint has no date filter, so "stop at the first page I
   * already have" is the only thing bounding a daily pass — plus a hard cap
   * so a broken stop condition cannot walk 219k rows. Hitting that cap means
   * the pass did *not* reach familiar ground: there is more upstream than it
   * was allowed to take, and the table is behind by an unknown amount. That
   * is a different night from a quiet one and must not report as a quiet one.
   */
  caughtUp: boolean;
}

/**
 * The auction catalogue, held locally because the source cannot be asked by
 * company.
 *
 * `provider_tin` is accepted and ignored by xarid.uzex.uz — verified with a
 * STIR that is certainly in the data — so there is no request that answers
 * "what has this company won". Mirroring the catalogue turns that question
 * into an indexed lookup and removes the per-company call entirely.
 *
 * Two passes fill it, and they are deliberately separate jobs:
 *
 * - **`backfill()`** is the one-off first load — the thin endpoint's five
 *   years, 500 rows a page, from a cursor so it can be stopped and resumed.
 *   219k rows is ~440 pages. Driven by hand through the admin route, once.
 * - **`nightly()`** is the daily update, and only that. It takes the rich
 *   endpoint's last two days by date filter, and walks the thin endpoint —
 *   which has no date filter — from the top until it meets a deal it already
 *   has. Both are ordered newest-first, which is what makes stopping early
 *   correct. A dozen requests, a few seconds.
 *
 * The nightly job used to carry a slice of the backfill as well, so an
 * unfinished first load would finish itself over about eleven nights. That
 * quietly turned a one-off into a recurring job and made every night's run
 * five minutes instead of five seconds. The first load is a first load.
 */
@Injectable()
export class AuctionSyncService {
  private readonly logger = new Logger(AuctionSyncService.name);
  private isRunning = false;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly api: AuctionScriptService,
    private readonly telegram: TelegramAlertService,
  ) {}

  // ── Writing ────────────────────────────────────────────────────────────────

  /**
   * Upsert a page.
   *
   * `COALESCE(excluded.x, existing.x)` throughout: the two endpoints fill
   * different halves of a row, and the thin one arriving second must not blank
   * the treasury columns the rich one wrote. A deal seen twice is enriched,
   * never emptied.
   */
  async save(rows: AuctionDealFields[]): Promise<SaveResult> {
    const usable = rows.filter((r) => r.deal_id);
    if (!usable.length) return { inserted: 0, updated: 0 };

    const columns: Array<keyof AuctionDealFields> = [
      'deal_id',
      'lot_id',
      'lot_display_no',
      'customer_inn',
      'customer_name',
      'customer_region',
      'provider_inn',
      'provider_name',
      'deal_date',
      'lot_start_date',
      'lot_end_date',
      'deal_cost',
      'currency_name',
      'type_name',
      'category_name',
      'pcp_count',
      'is_budget',
      'kazna_status_id',
      'kazna_status',
      'kazna_payment_status',
      'kazna_created_date',
      'date_ini',
      'cost',
      'start_cost',
      'status',
      'region_name',
      'district_name',
    ];

    const params: unknown[] = [];
    const tuples = usable.map((row) => {
      const slots = columns.map((c) => {
        params.push(row[c]);
        return `$${params.length}`;
      });
      return `(${slots.join(', ')})`;
    });

    // `deal_id` is the key both endpoints agree on.
    const updates = columns
      .filter((c) => c !== 'deal_id')
      .map(
        (c) =>
          `${c} = COALESCE(excluded.${c}, public.company_auction_deals.${c})`,
      )
      .join(', ');

    // `xmax = 0` is true only for a row this statement inserted, which is how
    // an upsert tells new from re-seen. Counting the page instead reported
    // "500 written" on a nightly pass that had found nothing at all.
    const written = await this.db.query(
      `INSERT INTO public.company_auction_deals (${columns.join(', ')})
       VALUES ${tuples.join(', ')}
       ON CONFLICT (deal_id) DO UPDATE SET ${updates}, updated_at = now()
       RETURNING (xmax = 0) AS inserted`,
      params,
    );
    const inserted = (written as Array<{ inserted: boolean }>).filter(
      (r) => r.inserted,
    ).length;
    return { inserted, updated: written.length - inserted };
  }

  /** Which of these deals we already hold. */
  private async known(dealIds: number[]): Promise<Set<number>> {
    if (!dealIds.length) return new Set();
    const rows = await this.db.query(
      `SELECT deal_id FROM public.company_auction_deals WHERE deal_id = ANY($1)`,
      [dealIds],
    );
    return new Set(rows.map((r: { deal_id: string }) => Number(r.deal_id)));
  }

  // ── One-off backfill ───────────────────────────────────────────────────────

  /**
   * Walk the thin endpoint from the cursor, a bounded number of pages at a
   * time so a single call cannot run for an hour.
   *
   * Returns the cursor state so a caller can drive it to completion.
   */
  async backfill(
    pages = BACKFILL_PAGES_PER_RUN,
  ): Promise<{ from: number; written: number; done: boolean; total: number }> {
    const total = await this.api.countDeals();
    let { last_from: from } = await this.cursor();
    let written = 0;
    let failed = 0;
    const startedAt = Date.now();

    this.logger.log(
      `[auction] backfill started: from=${from}/${total}, ${pages} page(s)`,
    );

    for (let i = 0; i < pages; i++) {
      if (from > total) break;
      let rows: AuctionDealFields[];
      try {
        rows = await this.api.fetchDeals(from, AUCTION_DEALS_PAGE);
      } catch (err) {
        // One refused page must not end the run and lose the cursor's place;
        // the next pass picks it up from where this one stopped.
        failed++;
        this.logger.warn(
          `[auction] backfill page from=${from} failed: ${(err as Error).message}`,
        );
        break;
      }
      if (!rows.length) break;

      const { inserted } = await this.save(rows);
      written += inserted;
      from += AUCTION_DEALS_PAGE;
      await this.advance(from, inserted);

      if ((i + 1) % PROGRESS_EVERY_PAGES === 0) {
        const pct = ((from / total) * 100).toFixed(1);
        this.logger.log(
          `[auction] backfill ${pct}% — from=${from}/${total}, new=${written}`,
        );
      }
    }

    const done = from > total;
    if (done) await this.finish();
    const secs = ((Date.now() - startedAt) / 1000).toFixed(1);
    this.logger.log(
      `[auction] backfill done: from=${from}/${total} new=${written}` +
        `${failed ? ` failed=${failed}` : ''} (${secs}s)${done ? ' — complete' : ''}`,
    );
    return { from, written, done, total };
  }

  // ── Nightly ────────────────────────────────────────────────────────────────

  /**
   * Yesterday and today from the rich endpoint, then whatever the thin one has
   * added since we last looked.
   *
   * Two days rather than one because a deal recorded late on the 9th is not
   * visible to a job that only ever asks about the 10th, and re-reading a day
   * costs eleven requests.
   */
  async increment(): Promise<IncrementResult> {
    const to = new Date();
    const from = new Date(to);
    from.setDate(from.getDate() - 1);

    let rich = 0;
    let richSeen = 0;
    let pages = 0;
    const richTotal = await this.api.countCompleted({ from, to });
    for (let at = 1; at <= richTotal; at += AUCTION_COMPLETED_PAGE) {
      const rows = await this.api.fetchCompleted(at, { from, to });
      if (!rows.length) break;
      pages++;
      const saved = await this.save(rows);
      rich += saved.inserted;
      richSeen += saved.updated;
    }

    // The thin endpoint has no date filter, so it is walked from the newest
    // until a page turns out to be entirely familiar.
    let thin = 0;
    let thinSeen = 0;
    let caughtUp = false;
    for (let at = 1; at <= 20 * AUCTION_DEALS_PAGE; at += AUCTION_DEALS_PAGE) {
      const rows = await this.api.fetchDeals(at, AUCTION_DEALS_PAGE);
      // The source ran out before we did, so there is nothing left to miss.
      if (!rows.length) {
        caughtUp = true;
        break;
      }
      pages++;
      const seen = await this.known(rows.map((r) => r.deal_id));
      const saved = await this.save(rows);
      thin += saved.inserted;
      thinSeen += saved.updated;
      // Everything on this page was already ours, and the ordering is
      // newest-first, so nothing older can be new either.
      if (seen.size === rows.length) {
        caughtUp = true;
        break;
      }
    }

    this.logger.log(
      `[auction] daily: ${rich + thin} new ` +
        `(rich ${rich}, thin ${thin}) · already held ${richSeen + thinSeen} ` +
        `· ${pages} page(s) read`,
    );
    return { rich, thin, seen: richSeen + thinSeen, pages, caughtUp };
  }

  /**
   * 21:00 Asia/Tashkent, the slot the other nightly jobs share.
   *
   * Production only, and one replica only: Nest fires `@Cron` in every process
   * that loaded it, and three containers walking the same catalogue is three
   * times the load for one copy of the data. The advisory lock is held by the
   * session, so a container killed mid-run frees it by disconnecting.
   *
   * `AUCTION_CRON_ENABLED=1` runs it anyway, which is how the test
   * environment exercises the nightly pass before it is trusted in
   * production. It is a variable rather than an edit to the guard so that
   * turning it off again is deleting a line of config, not remembering to
   * revert a line of code — and so the log says plainly why a job ran
   * somewhere it normally would not.
   */
  @Cron('0 21 * * *', { timeZone: 'Asia/Tashkent' })
  async nightly(): Promise<void> {
    const forced = process.env.AUCTION_CRON_ENABLED === '1';
    if (process.env.NODE_ENV !== 'production' && !forced) {
      this.logger.warn(
        `[auction] nightly skipped — NODE_ENV="${process.env.NODE_ENV ?? 'undefined'}" ` +
          `(set AUCTION_CRON_ENABLED=1 to run it anyway)`,
      );
      return;
    }
    if (forced && process.env.NODE_ENV !== 'production') {
      this.logger.warn(
        `[auction] nightly running because AUCTION_CRON_ENABLED=1 ` +
          `(NODE_ENV="${process.env.NODE_ENV ?? 'undefined'}") — temporary setting`,
      );
    }
    if (this.isRunning) {
      this.logger.warn('[auction] nightly skipped — already running');
      return;
    }

    const runner = this.db.createQueryRunner();
    let locked = false;
    try {
      await runner.connect();
      const rows = await runner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [LOCK_ID],
      );
      locked = rows?.[0]?.locked === true;
      if (!locked) {
        this.logger.log(
          '[auction] nightly skipped — another replica holds the lock',
        );
        return;
      }

      this.isRunning = true;
      const startedAt = Date.now();
      const result = await this.increment();
      await this.announce(result, Date.now() - startedAt);
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`[auction] nightly failed: ${message}`);
      // A night that fails is the night worth hearing about, so this is sent
      // before anything else in the cleanup can throw.
      await this.alert(
        `❌ <b>Auction daily sync — failed</b>\n<code>${escapeHtml(message)}</code>`,
      );
    } finally {
      this.isRunning = false;
      try {
        if (locked) {
          await runner.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
        }
      } catch {
        // Releasing the connection drops the lock anyway.
      }
      await runner.release().catch(() => undefined);
    }
  }

  /**
   * Tell Telegram what the night did.
   *
   * "0 new" is a normal result and also what a broken job looks like, so the
   * message never stops at the new-row count: `pages` says the source was
   * actually reached and `seen` says rows came back and were recognised. A
   * night that read no pages at all is called out rather than reported as a
   * quiet success — nothing threw, but nothing happened either, and that is
   * the failure this alert exists to catch.
   *
   * The size of the table is checked against the source for a reason the cap
   * alone does not cover. A daily pass that has filled the newest slice and
   * then meets familiar rows has genuinely caught up *with today*, and says
   * so — while the years behind it can still be missing entirely, because a
   * pass that always starts from the newest row will never reach them. That
   * is precisely the state an unfinished first load leaves behind, and it is
   * silent: every night afterwards is a correct, fast, green night on top of
   * a table holding a tenth of the catalogue.
   */
  private async announce(
    result: IncrementResult,
    elapsedMs: number,
  ): Promise<void> {
    const secs = (elapsedMs / 1000).toFixed(1);
    const total = await this.count();
    const upstream = await this.upstreamCount();

    // Well short of the source, and not because tonight was short — the
    // history behind us was never loaded.
    const incomplete = upstream > 0 && total < upstream * COMPLETE_ENOUGH;

    let head = '✅ <b>Auction daily sync</b>';
    let note = '';
    if (result.pages === 0) {
      head = '⚠️ <b>Auction daily sync — nothing came back from the source</b>';
    } else if (!result.caughtUp) {
      // The walk stopped because it ran out of pages, not because it met a
      // deal we already had — so an unknown amount upstream was left behind.
      // A first load looks exactly like this, and so does a night that fell
      // far enough behind to matter; both want the same answer.
      head = '⚠️ <b>Auction daily sync — hit the page cap</b>';
      note =
        `\n<i>The daily pass never reached a deal we already had, so there is ` +
        `more upstream than it was allowed to take. If the one-off first ` +
        `load is unfinished, run /auction/backfill.</i>`;
    } else if (incomplete) {
      // Today is up to date and the years behind it are not. Without this the
      // message is a green tick on a tenth of the catalogue, every night,
      // forever: the daily pass starts from the newest row and can never
      // reach back that far.
      head = '⚠️ <b>Auction daily sync — history incomplete</b>';
      note =
        `\n<i>Today is up to date, but the table holds only ` +
        `${Math.round((total / upstream) * 100)}% of the source. The daily ` +
        `pass starts from the newest row and cannot reach back that far — ` +
        `drive /auction/backfill to completion.</i>`;
    }

    await this.alert(
      `${head}\n` +
        `New: <b>${result.rich + result.thin}</b> ` +
        `(rich ${result.rich}, thin ${result.thin})\n` +
        `Already held: ${result.seen}\n` +
        `Pages read: ${result.pages}\n` +
        `Rows in table: ${total}` +
        (upstream > 0 ? ` / upstream ${upstream}` : '') +
        `\nTook: ${secs}s` +
        note,
    );
  }

  /**
   * How many the source holds, or 0 when it will not say.
   *
   * One extra request a night, and it is the only thing that can tell a
   * finished mirror from a half-finished one — our own row count says
   * nothing without it.
   */
  private async upstreamCount(): Promise<number> {
    try {
      return await this.api.countDeals();
    } catch {
      // Not knowing is not a reason to call the night a failure.
      return 0;
    }
  }

  /** How many rows the mirror holds, for the nightly message. */
  private async count(): Promise<number> {
    try {
      const [row] = await this.db.query(
        'SELECT COUNT(*)::int AS n FROM public.company_auction_deals',
      );
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /** Never let a missing bot token turn into a failed sync. */
  private async alert(text: string): Promise<void> {
    try {
      await this.telegram.send(text, { tag: 'auction' });
    } catch (err) {
      this.logger.warn(`[auction] alert not sent: ${(err as Error).message}`);
    }
  }

  // ── Cursor ─────────────────────────────────────────────────────────────────

  async cursor(): Promise<{
    last_from: number;
    rows_written: string;
    finished_at: Date | null;
  }> {
    const [row] = await this.db.query(
      `SELECT last_from, rows_written, finished_at
         FROM public.auction_fill_cursor WHERE id = 1`,
    );
    return row ?? { last_from: 1, rows_written: '0', finished_at: null };
  }

  private async advance(from: number, written: number): Promise<void> {
    await this.db.query(
      `UPDATE public.auction_fill_cursor
          SET last_from = $1, rows_written = rows_written + $2, updated_at = now()
        WHERE id = 1`,
      [from, written],
    );
  }

  private async finish(): Promise<void> {
    await this.db.query(
      `UPDATE public.auction_fill_cursor
          SET finished_at = now(),
              completed_cycles = completed_cycles + 1,
              updated_at = now()
        WHERE id = 1`,
    );
  }

  async resetCursor(): Promise<void> {
    await this.db.query(
      `UPDATE public.auction_fill_cursor
          SET last_from = 1, rows_written = 0, finished_at = NULL, updated_at = now()
        WHERE id = 1`,
    );
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  /**
   * Everything one company has done at auction, as either side.
   *
   * This is what the whole table is for — the question the source itself
   * cannot answer.
   */
  async findByInn(
    inn: string,
    limit = 50,
    offset = 0,
    filters?: { role?: 'customer' | 'provider'; outcome?: AuctionOutcome },
  ): Promise<{ rows: unknown[]; total: number }> {
    if (!inn) return { rows: [], total: 0 };

    const params: unknown[] = [inn];
    // A company sits on one side or the other; unfiltered means either.
    const conditions =
      filters?.role === 'customer'
        ? ['customer_inn = $1']
        : filters?.role === 'provider'
          ? ['provider_inn = $1']
          : ['(customer_inn = $1 OR provider_inn = $1)'];

    if (filters?.outcome) {
      const clause = auctionStatusClause(filters.outcome, params.length + 1);
      conditions.push(clause.sql);
      params.push(...clause.params);
    }

    const where = conditions.join(' AND ');
    const rows = await this.db.query(
      `SELECT * FROM public.company_auction_deals
        WHERE ${where}
        ORDER BY COALESCE(deal_date, date_ini) DESC NULLS LAST, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const [count] = await this.db.query(
      `SELECT COUNT(*)::int AS total FROM public.company_auction_deals WHERE ${where}`,
      params,
    );
    return { rows, total: count?.total ?? 0 };
  }
}
