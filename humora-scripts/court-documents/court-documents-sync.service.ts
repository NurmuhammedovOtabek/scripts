import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { S3Service } from '../../s3/s3.service';
import { TelegramAlertService } from '../common/telegram-alert.service';

/** One record as `publications/list` returns it. */
interface Publication {
  id: string;
  case_number: string;
  instance?: string;
  result?: string;
  hearing_date?: string | null;
  court_names?: Record<string, string>;
  pdf?: { id: string; name?: string; size?: number };
}

/**
 * The source answered and the body holds no PDF — an empty file, or another
 * format (a Word file; we keep PDFs only). Asking again will not change that,
 * so it is told apart from a failed request, which is worth another try on
 * the next walk.
 */
class NoPdfError extends Error {
  constructor(readonly reason: 'empty' | 'not_pdf') {
    super('response contains no PDF');
  }
}

export interface SyncOptions {
  resetCursor?: boolean;
  /** PDF downloads in flight. 1 by default — the source is a government site. */
  concurrency?: number;
  /** Stop after this many pages. Used to smoke-test against production data. */
  maxPages?: number;
  /** Walk the feed but store no files — reports what a real run would fetch. */
  dryRun?: boolean;
}

/**
 * Fills `company_court_documents` from public.sud.uz and keeps the PDFs in
 * MinIO.
 *
 * The court cases themselves have been in `company_court_cases` for a long
 * time; what was missing is the decision document. myorg leaves a reference
 * (`file: [{file_name, file_id}]`) but file_id is an opaque number with no
 * download route, which is why the court tab's document markup sat commented
 * out. public.sud.uz publishes the same decisions with an id that does resolve.
 *
 * Shape of the work:
 *  - The feed pages 100 at a time (`size` above 100 is ignored), so a full
 *    sweep is ~1,850 pages (184k publications on 2026-09-30).
 *  - **The feed is not in publication order, and cannot be put in one.** It
 *    echoes any `sort` it is sent (`id`, `-id`, `created_at`, `hearing_date`,
 *    …) and ignores it; page 0 mixes 2026 cases with 2021 ones. A new
 *    publication lands somewhere inside the feed, not on top: on 2026-09-30
 *    the total had grown by 72 overnight while page 0 still began with the
 *    same publication. So there is no "read until you meet what you saw last
 *    time" — the nightly run that did that read one page a night and found
 *    nothing for weeks, while ~23k publications went unrecorded. The only
 *    walk that sees everything is the whole feed, and that is what the
 *    Saturday run does.
 *  - Metadata is written for EVERY published decision, cheap at ~158k rows.
 *  - The PDF is fetched only when we hold that case, which is ~60% of them —
 *    the rest are disputes between individuals we have no company for.
 *  - A file already in MinIO is never downloaded again, so a repeat run costs
 *    the feed walk and nothing else. That is what makes it safe to re-run.
 *
 * ECONOMIC only: sampling 300 published cases per court type against
 * production matched 60% for ECONOMIC and 0% for both CIVIL and ADMINISTRATIVE.
 */
@Injectable()
export class CourtDocumentsSyncService {
  private readonly logger = new Logger(CourtDocumentsSyncService.name);
  private readonly CURSOR = 'court_documents_sync_cursor';
  private readonly LIST_URL = 'https://adolatapi1.sud.uz/publications/list';
  private readonly FILE_URL = 'https://adolatapi1.sud.uz/public/onStream';
  private readonly COURT_TYPE = 'ECONOMIC';
  private readonly PAGE_SIZE = 100;

  /**
   * How many pages may fail back-to-back before the sweep gives up.
   *
   * Each page is already retried four times inside getWithRetry, so ten in a
   * row is about forty failed requests over a minute — far past the one
   * connection in twenty this source drops, and far short of spending a night
   * asking a dead server for pages that do not exist.
   */
  private readonly MAX_CONSECUTIVE_FAILURES = 10;

  private readonly UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

  private isRunning = false;

  /**
   * How long a held lock stays believed without a sign of life. The Saturday
   * walk renews it on every page (a week of new decisions can keep it busy for
   * hours), so three hours of silence means the replica holding it is gone —
   * and a container killed mid-walk does not block a restart by hand.
   */
  private readonly LOCK_STALE_HOURS = 3;

  /**
   * Below this share of the feed's own total, the weekly report says the walk
   * came up short. Some pages answer with fewer than 100 rows (75 and 94 in a
   * 2026-09-30 sample), so a complete walk never reads exactly the total.
   */
  private readonly COVERAGE_WARN = 0.9;

  /**
   * The rows worth asking the source about: not stored, and not answered
   * without a PDF. The first sweep left 1,154 of those, refused every night
   * from August on: 636 the source itself lists with no file size, the rest
   * ~27 KB files under a template name where a real decision is ~110 KB under
   * its own. There is no timed recheck (user decision, 2026-09-30): a court
   * uploading the file shows up in the feed as a new id or size, and the
   * weekly walk drops the mark when it sees that (`upsertMetadata`).
   */
  private readonly ASKABLE = `d.stored_key IS NULL AND d.unavailable_at IS NULL`;

  constructor(
    @InjectDataSource('flottDb') private readonly db: DataSource,
    private readonly s3: S3Service,
    private readonly tg: TelegramAlertService,
  ) {}

  // ── Cross-replica lock ─────────────────────────────────────────────────────

  /**
   * Claim the right to run, across every replica.
   *
   * `isRunning` only ever guarded one Node process. Production runs three, and
   * on 7 August all three started the nightly sweep in the same second and
   * walked the same 1,621 pages. A single conditional UPDATE settles it: the
   * row can only be claimed by whoever the database serialises first.
   */
  private async tryLock(owner: string): Promise<boolean> {
    const rows = await this.db.query(
      `UPDATE public.${this.CURSOR}
          SET run_lock_at = now(), run_owner = $1, updated_at = now()
        WHERE id = 1
          AND (run_lock_at IS NULL
               OR run_lock_at < now() - ($2 || ' hours')::interval)
        RETURNING 1`,
      [owner, String(this.LOCK_STALE_HOURS)],
    );
    return rows.length > 0;
  }

  /** Hand the lock back. Best effort — a stale one expires on its own. */
  private async releaseLock(): Promise<void> {
    try {
      await this.db.query(
        `UPDATE public.${this.CURSOR}
            SET run_lock_at = NULL, run_owner = NULL, updated_at = now()
          WHERE id = 1`,
      );
    } catch (err: any) {
      this.logger.warn(`[court-docs] lock release failed: ${err.message}`);
    }
  }

  /** Bucket holding the decisions. */
  private get bucket(): string {
    return process.env.MINIO_COURT_BUCKET || 'court-documents';
  }

  /**
   * Key prefix, so a test environment writes into its own folder that can be
   * deleted wholesale once the feature is signed off (`MINIO_COURT_PREFIX=test/`).
   */
  private get prefix(): string {
    const p = process.env.MINIO_COURT_PREFIX || '';
    return p && !p.endsWith('/') ? `${p}/` : p;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async start(opts: SyncOptions = {}): Promise<Record<string, any>> {
    if (this.isRunning) return { status: 'already_running' };
    if (opts.resetCursor) await this.resetCursor();
    void this.sweep(opts);
    return {
      status: 'started',
      bucket: this.bucket,
      prefix: this.prefix || '(root)',
      concurrency: Math.max(1, opts.concurrency ?? 1),
      dryRun: !!opts.dryRun,
      cursor: await this.getCursor(),
    };
  }

  stop() {
    this.isRunning = false;
    return { stopped: true };
  }

  /**
   * One walk of the feed, start to finish. Never throws: a crash is reported
   * and the flag handed back, so whoever awaits it (the Saturday cron) can
   * release its lock, and whoever does not (the admin endpoint) loses nothing.
   */
  private async sweep(opts: SyncOptions): Promise<void> {
    this.isRunning = true;
    try {
      await this.runLoop(opts);
    } catch (err: any) {
      this.logger.error(`[court-docs] crashed: ${err.message}`);
      await this.tg.send(
        `🚨 <b>court-docs CRASHED</b>\nError: <code>${err.message}</code>`,
        { tag: 'court_docs' },
      );
    } finally {
      this.isRunning = false;
    }
  }

  async getCursor() {
    const r = await this.db.query(
      `SELECT * FROM public.${this.CURSOR} WHERE id = 1`,
    );
    const stats = await this.db.query(
      `SELECT count(*)::int AS rows,
              count(stored_key)::int AS stored
         FROM public.company_court_documents`,
    );
    return { ...r[0], ...stats[0], is_running: this.isRunning };
  }

  /**
   * Downloads decisions we already know about but never stored — the case
   * arrived in `company_court_cases` after the document was published, so the
   * sweep saw it as unmatched at the time. Cheap: no feed walk at all.
   *
   * By hand only (`POST /org/admin/court-documents/fill-pending`). It ran every
   * night until 2026-09-30; the Saturday walk downloads the same rows, so the
   * nightly run only brought a newly opened company's decisions a few days
   * sooner, and the user dropped it for the simpler schedule.
   */
  async fillPending(
    opts: { limit?: number; concurrency?: number } = {},
  ): Promise<Record<string, any>> {
    if (this.isRunning) return { status: 'already_running' };
    const limit = Math.min(Math.max(1, opts.limit ?? 5000), 50_000);
    const rows: Array<{ doc_id: string; pdf_id: string; case_number: string }> =
      await this.db.query(
        `SELECT d.doc_id, d.pdf_id, d.case_number
           FROM public.company_court_documents d
          WHERE ${this.ASKABLE}
            AND EXISTS (SELECT 1 FROM public.company_court_cases c
                         WHERE c.casenumber = d.case_number)
          ORDER BY d.id
          LIMIT $1`,
        [limit],
      );
    if (rows.length === 0) return { status: 'nothing_pending' };

    this.isRunning = true;
    try {
      await this.s3.ensureBucket(this.bucket);
      const r = await this.storeAll(rows, Math.max(1, opts.concurrency ?? 1));
      return { status: 'done', candidates: rows.length, ...r };
    } finally {
      this.isRunning = false;
    }
  }

  // ── Weekly ─────────────────────────────────────────────────────────────────

  /**
   * Saturday 23:00: the whole feed, page 0 to the end — the one scheduled run
   * (user decision, 2026-09-30: weekly is enough; when the source is quietest
   * and none of our other jobs runs; the Sunday 04:30 chain starts hours after
   * a normal walk ends). It finds new publications and downloads every
   * decision of ours not stored yet, including the cases that arrived during
   * the week.
   *
   * There used to be a nightly run too. It walked from page 0 and stopped at
   * the publication the previous night had seen first, which assumed a
   * newest-first feed; the feed is not (see the class note), so it read one
   * page a night and found nothing.
   *
   * Always from page 0, never resumed: a walk a deploy cut short last week is
   * simply done again whole. Awaited while the lock is held, and the lock is
   * renewed on every page, so no replica can start a second walk under it.
   */
  @Cron('0 23 * * 6', { timeZone: 'Asia/Tashkent' })
  async runWeekly(): Promise<void> {
    if (!this.mayRunScheduled('weekly walk')) return;

    if (!(await this.tryLock(this.owner()))) {
      this.logger.log(
        `[court-docs] weekly walk skipped — another replica holds the lock`,
      );
      return;
    }

    try {
      await this.resetCursor();
      await this.sweep({});
    } finally {
      await this.releaseLock();
    }
  }

  /** Production only, and never on top of a run this replica already has. */
  private mayRunScheduled(what: string): boolean {
    if (process.env.NODE_ENV !== 'production') {
      this.logger.warn(
        `[court-docs] ${what} skipped — NODE_ENV="${process.env.NODE_ENV ?? 'undefined'}"`,
      );
      return false;
    }
    if (this.isRunning) {
      this.logger.warn(`[court-docs] ${what} skipped — already running`);
      return false;
    }
    return true;
  }

  private owner(): string {
    return `${process.env.HOSTNAME || 'unknown'}:${process.pid}`;
  }

  // ── Loop ───────────────────────────────────────────────────────────────────

  private async runLoop(opts: SyncOptions): Promise<void> {
    const concurrency = Math.max(1, opts.concurrency ?? 1);
    const init = await this.db.query(
      `SELECT last_page, completed_cycles
         FROM public.${this.CURSOR} WHERE id = 1`,
    );
    let page = Number(init[0]?.last_page) || 0;
    const cycle = (Number(init[0]?.completed_cycles) || 0) + 1;

    // The feed's own count of what it holds, from the last page answered —
    // what the finished walk is measured against.
    let feedTotal = 0;

    if (!opts.dryRun) {
      const created = await this.s3.ensureBucket(this.bucket);
      if (created)
        this.logger.log(`[court-docs] created bucket ${this.bucket}`);
    }

    let seen = 0,
      stored = 0,
      skipped = 0,
      unmatched = 0,
      alreadyStored = 0,
      noPdf = 0,
      fail = 0,
      pages = 0;

    // Reported every 50 pages, and again when the sweep ends. Kept to that:
    // a full run is ~1,580 pages, so this is roughly every eight minutes
    // without a second timer competing with it.
    const startedAt = Date.now();
    let totalPages = 0; // learned from the first page the feed answers
    let consecutiveFailures = 0;

    await this.tg.send(
      `▶️ <b>court-docs started</b>\n` +
        `Cycle: <b>${cycle}</b> · from page <code>${page}</code>\n` +
        `MinIO: <code>${this.bucket}/${this.prefix || ''}</code> · ` +
        `concurrency ${concurrency}${opts.dryRun ? ' · DRY RUN' : ''}`,
      { tag: 'court_docs' },
    );

    while (this.isRunning) {
      if (opts.maxPages && pages >= opts.maxPages) break;

      let batch: Publication[];
      try {
        const fetched = await this.fetchPage(page);
        batch = fetched.rows;
        if (fetched.totalPages > 0) totalPages = fetched.totalPages;
        if (fetched.totalElements > 0) feedTotal = fetched.totalElements;
        consecutiveFailures = 0;
      } catch (err: any) {
        fail++;
        consecutiveFailures++;
        this.logger.warn(`[court-docs] page ${page} failed: ${err.message}`);

        // One page failing is noise; every page failing means the source is
        // gone, and stepping to the next one just asks a dead server the same
        // question with a different number. adolatapi1.sud.uz returned 502 on
        // everything — including its own root — for hours one night, and this
        // loop walked from page 879 to 2578 before anyone looked, long past
        // the ~1,580 pages the feed actually has.
        if (consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
          this.logger.error(
            `[court-docs] ${consecutiveFailures} pages in a row failed — ` +
              `stopping at page ${page}; the source looks down`,
          );
          await this.tg.send(
            `🚨 <b>court-docs stopped — source unreachable</b>\n` +
              `${consecutiveFailures} pages in a row failed at page <code>${page}</code>.\n` +
              `Last error: <code>${err.message}</code>\n` +
              `Nothing is lost — restart when the source is back and it resumes.`,
            { tag: 'court_docs' },
          );
          return;
        }
        page++; // one unreadable page is not a reason to stall the sweep
        continue;
      }

      if (batch.length === 0) {
        // The feed is exhausted: everything in it has been processed.
        await this.db.query(
          `UPDATE public.${this.CURSOR}
              SET last_page = 0, cycle_started_at = now(), cycle_seen = 0,
                  cycle_stored = 0, completed_cycles = completed_cycles + 1,
                  total_stored = total_stored + $1, total_fail = total_fail + $2,
                  last_total_elements = COALESCE($3, last_total_elements),
                  updated_at = now()
            WHERE id = 1`,
          [stored, fail, feedTotal || null],
        );
        await this.tg.send(
          `🏁 <b>court-docs cycle complete</b>\n` +
            `${pages} pages in ${this.humanMs(Date.now() - startedAt)}\n` +
            `${this.coverageLine(seen, feedTotal)}\n` +
            `Stored: <b>${stored}</b> · already stored: ${alreadyStored + skipped}\n` +
            `Not ours: ${unmatched} · no PDF at the source: ${noPdf} · fail: ${fail}`,
          { tag: 'court_docs' },
        );
        return;
      }

      // One bad page must not end a sweep that takes hours. Reading a page was
      // already guarded; writing it was not, and a single malformed batch threw
      // straight out of this loop — that is how the first production run died
      // four minutes in with 1,555 pages still to go. Record it and move on;
      // the page will be picked up by the next cycle.
      try {
        await this.upsertMetadata(batch);
        const wanted = await this.matchedOurs(batch);

        if (!opts.dryRun && wanted.length) {
          const r = await this.storeAll(wanted, concurrency);
          stored += r.stored;
          skipped += r.skipped;
          fail += r.failed;
          noPdf += r.noPdf;
        } else if (opts.dryRun) {
          skipped += wanted.length;
        }
        // `wanted` excludes both the publications that belong to no company we
        // hold AND the ones already downloaded, so the difference cannot be
        // reported as "not ours" — that is how the counter reached 159,080 on
        // a feed where 89,917 documents were simply already stored. Ask the
        // database which of the two it was.
        // Both counters are per page, and the running total must not be the
        // thing subtracted. Written as `batch.length - wanted.length -
        // unmatched` it took the total unmatched so far off a single page, so
        // the figure fell further behind on every page and the run reported
        // "Already stored: -22925".
        const pageUnmatched = await this.countUnmatched(batch);
        unmatched += pageUnmatched;
        alreadyStored += batch.length - wanted.length - pageUnmatched;
      } catch (err: any) {
        fail++;
        this.logger.error(
          `[court-docs] page ${page} could not be written: ${err.message}`,
        );
      }

      seen += batch.length;
      pages++;
      page++;

      // A held lock is renewed with every page, so a walk that runs for hours
      // (a week of new decisions to download) never looks abandoned. A run
      // started from the admin endpoint holds no lock and renews nothing.
      await this.db.query(
        `UPDATE public.${this.CURSOR}
            SET last_page = $1, last_case_number = $2, last_synced_at = now(),
                cycle_seen = $3, cycle_stored = $4, updated_at = now(),
                run_lock_at = CASE WHEN run_owner IS NOT NULL
                                   THEN now() ELSE run_lock_at END
          WHERE id = 1`,
        [page, batch[batch.length - 1]?.case_number ?? null, seen, stored],
      );

      if (pages % 50 === 0) {
        this.logger.log(
          `[court-docs] page=${page} seen=${seen} stored=${stored} skipped=${skipped} fail=${fail}`,
        );
        await this.tg.send(
          `⏳ <b>court-docs progress</b>\n` +
            `${this.progressLine(page, totalPages, startedAt, pages)}\n` +
            `Seen <b>${seen}</b> · stored <b>${stored}</b>\n` +
            `Already there: ${skipped} · not ours: ${unmatched} · fail: ${fail}`,
          { tag: 'court_docs' },
        );
      }
    }

    await this.tg.send(
      `⏹ <b>court-docs stopped</b>\n` +
        `${this.progressLine(page, totalPages, startedAt, pages)}\n` +
        `Seen <b>${seen}</b> · stored <b>${stored}</b>\n` +
        `Already there: ${skipped} · not ours: ${unmatched} · fail: ${fail}`,
      { tag: 'court_docs' },
    );
  }

  // ── Steps ──────────────────────────────────────────────────────────────────

  /**
   * "Page 340/1580 · 21% · 42m elapsed · ~2h 40m left".
   *
   * The remaining time is a straight extrapolation of the pages done so far,
   * which is honest enough: the cost per page is dominated by how many of its
   * decisions are ours, and that ratio holds across the feed. Falls back to
   * page-and-elapsed only when the feed has not told us a total yet.
   */
  private progressLine(
    page: number,
    totalPages: number,
    startedAt: number,
    pagesDone: number,
  ): string {
    const elapsed = Date.now() - startedAt;
    if (!totalPages || pagesDone === 0) {
      return `Page <code>${page}</code> · ${this.humanMs(elapsed)} elapsed`;
    }
    const pct = Math.min(100, Math.round((100 * page) / totalPages));
    const left = Math.max(0, totalPages - page);
    const eta = (elapsed / pagesDone) * left;
    return (
      `Page <code>${page}</code>/${totalPages} · <b>${pct}%</b> · ` +
      `${this.humanMs(elapsed)} elapsed · ~${this.humanMs(eta)} left`
    );
  }

  private humanMs(ms: number): string {
    const total = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m`;
    return `${total}s`;
  }

  /** Returns the page's usable records plus how many pages the feed claims. */
  private async fetchPage(page: number): Promise<{
    rows: Publication[];
    totalPages: number;
    totalElements: number;
  }> {
    const url =
      `${this.LIST_URL}?size=${this.PAGE_SIZE}&page=${page}` +
      `&court_type=${this.COURT_TYPE}`;
    const res = await this.getWithRetry(url);
    const body = (await res.json()) as {
      content?: Publication[];
      totalPages?: number;
      totalElements?: number;
    };
    return {
      rows: (body.content ?? []).filter((r) => r?.id && r?.case_number),
      // totalPages is derived from the page size we asked for — the same feed
      // reports 1,622 at size=100 and 81,060 at size=2. totalElements is the
      // figure that means something on its own, so the coverage check uses it.
      totalPages: Number(body.totalPages) || 0,
      totalElements: Number(body.totalElements) || 0,
    };
  }

  /**
   * Writes every published decision, whether or not the case is one of ours.
   *
   * The batch is de-duplicated on doc_id first. Postgres refuses to let one
   * `ON CONFLICT DO UPDATE` statement touch the same row twice, so a page that
   * lists a decision more than once — which happens when a file was uploaded
   * again and the publication kept its id — aborts the whole statement with
   * "command cannot affect row a second time" and takes the sweep down with it.
   * That is how the first production run died on page 25. Duplicates ACROSS
   * pages are fine: those are separate statements and the unique index absorbs
   * them.
   *
   * The first occurrence wins.
   */
  private async upsertMetadata(batch: Publication[]): Promise<void> {
    const seen = new Map<string, Publication>();
    for (const r of batch) {
      if (r.pdf?.id && !seen.has(r.id)) seen.set(r.id, r);
    }
    const rows = [...seen.values()];
    if (rows.length === 0) return;

    const values: any[] = [];
    const tuples = rows.map((r, i) => {
      const b = i * 9;
      values.push(
        r.id,
        r.pdf!.id,
        r.case_number,
        r.pdf!.name ?? null,
        r.pdf!.size ?? null,
        r.court_names?.uz ?? null,
        r.instance ?? null,
        r.result ?? null,
        r.hearing_date || null,
      );
      return `($${b + 1}::uuid, $${b + 2}::uuid, $${b + 3}, $${b + 4}, $${b + 5}::int4, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}::date)`;
    });

    // stored_key is deliberately not in the UPDATE list: re-running the sweep
    // must not forget a file we already have. A "no PDF" mark is dropped when
    // the source now names a different file (new id or size): the court has
    // uploaded one, and it is worth asking at once rather than in a month.
    // (Every right-hand side reads the row as it was before this UPDATE.)
    await this.db.query(
      `INSERT INTO public.company_court_documents
         (doc_id, pdf_id, case_number, pdf_name, pdf_size, court_name,
          instance, result, hearing_date)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (doc_id) DO UPDATE SET
         unavailable_at = CASE
           WHEN company_court_documents.pdf_id IS DISTINCT FROM EXCLUDED.pdf_id
             OR company_court_documents.pdf_size IS DISTINCT FROM EXCLUDED.pdf_size
           THEN NULL ELSE company_court_documents.unavailable_at END,
         unavailable_reason = CASE
           WHEN company_court_documents.pdf_id IS DISTINCT FROM EXCLUDED.pdf_id
             OR company_court_documents.pdf_size IS DISTINCT FROM EXCLUDED.pdf_size
           THEN NULL ELSE company_court_documents.unavailable_reason END,
         pdf_id       = EXCLUDED.pdf_id,
         case_number  = EXCLUDED.case_number,
         pdf_name     = EXCLUDED.pdf_name,
         pdf_size     = EXCLUDED.pdf_size,
         court_name   = EXCLUDED.court_name,
         instance     = EXCLUDED.instance,
         result       = EXCLUDED.result,
         hearing_date = EXCLUDED.hearing_date,
         updated_at   = now()`,
      values,
    );
  }

  /** Of this page, the decisions whose case we hold and have not stored yet. */
  /**
   * How many of this page belong to no company we hold.
   *
   * Kept apart from "already stored" because the two used to be reported as
   * one number: `batch.length - wanted.length` counts both, and with 89,917
   * documents already downloaded the nightly alert read "not ours: 159,080"
   * on a feed of 160,380 — a figure that says nothing about how much of the
   * feed is actually about companies we track.
   */
  private async countUnmatched(batch: Publication[]): Promise<number> {
    const caseNumbers = [...new Set(batch.map((r) => r.case_number))];
    if (caseNumbers.length === 0) return 0;
    const rows = await this.db.query(
      `SELECT count(DISTINCT c.casenumber)::int AS n
         FROM public.company_court_cases c
        WHERE c.casenumber = ANY($1::text[])`,
      [caseNumbers],
    );
    return caseNumbers.length - (Number(rows[0]?.n) || 0);
  }

  /**
   * "Feed: 184,268 · read: 183,950 (99.8%)" — the feed's own total against what
   * the walk read, flagged when it falls short enough to mean pages were lost
   * rather than the source's usual short pages.
   */
  private coverageLine(seen: number, feedTotal: number): string {
    if (!feedTotal) return `Read: <b>${seen}</b>`;
    const share = seen / feedTotal;
    const pct = (Math.floor(share * 1000) / 10).toFixed(1);
    const line =
      `Feed: ${feedTotal.toLocaleString('en-US')} · ` +
      `read: <b>${seen.toLocaleString('en-US')}</b> (${pct}%)`;
    return share < this.COVERAGE_WARN
      ? `⚠️ ${line} — the walk came up short`
      : line;
  }

  private async matchedOurs(
    batch: Publication[],
  ): Promise<Array<{ doc_id: string; pdf_id: string; case_number: string }>> {
    const ids = batch.filter((r) => r.pdf?.id).map((r) => r.id);
    if (ids.length === 0) return [];
    return this.db.query(
      `SELECT d.doc_id, d.pdf_id, d.case_number
         FROM public.company_court_documents d
        WHERE d.doc_id = ANY($1::uuid[])
          AND ${this.ASKABLE}
          AND EXISTS (SELECT 1 FROM public.company_court_cases c
                       WHERE c.casenumber = d.case_number)`,
      [ids],
    );
  }

  /**
   * Fetch + store, `concurrency` at a time.
   *
   * The loop checks `isRunning` so `stop()` lands mid-batch rather than at the
   * end of it. Any future caller that does not raise that flag first would get
   * exactly one file and a silent stop.
   */
  private async storeAll(
    rows: Array<{ doc_id: string; pdf_id: string; case_number: string }>,
    concurrency: number,
  ): Promise<{
    stored: number;
    skipped: number;
    failed: number;
    noPdf: number;
  }> {
    let stored = 0,
      skipped = 0,
      failed = 0,
      noPdf = 0;
    let next = 0;

    const worker = async () => {
      while (this.isRunning || next === 0) {
        const i = next++;
        if (i >= rows.length) return;
        try {
          const wasNew = await this.storeOne(rows[i]);
          if (wasNew) stored++;
          else skipped++;
        } catch (err: any) {
          if (err instanceof NoPdfError) {
            // The source's answer, not a failure: marked, and left alone
            // until the feed names another file.
            noPdf++;
            await this.markNoPdf(rows[i].doc_id, err.reason);
            continue;
          }
          failed++;
          this.logger.warn(
            `[court-docs] ${rows[i].case_number} failed: ${err.message}`,
          );
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, rows.length) }, worker),
    );
    return { stored, skipped, failed, noPdf };
  }

  /** Returns true when the file was actually downloaded this time. */
  private async storeOne(row: {
    doc_id: string;
    pdf_id: string;
    case_number: string;
  }): Promise<boolean> {
    const key = this.objectKey(row.case_number, row.doc_id);

    if (await this.s3.exists(this.bucket, key)) {
      await this.markStored(row.doc_id, key);
      return false;
    }

    const res = await this.getWithRetry(`${this.FILE_URL}/${row.pdf_id}`);
    const pdf = this.unwrap(Buffer.from(await res.arrayBuffer()));
    await this.s3.upload(this.bucket, key, pdf, 'application/pdf');
    await this.markStored(row.doc_id, key);
    return true;
  }

  private async markStored(docId: string, key: string): Promise<void> {
    await this.db.query(
      `UPDATE public.company_court_documents
          SET stored_key = $2, stored_at = now(), updated_at = now(),
              unavailable_at = NULL, unavailable_reason = NULL
        WHERE doc_id = $1::uuid`,
      [docId, key],
    );
  }

  /** Kept until the feed names another file for the decision. */
  private async markNoPdf(docId: string, reason: string): Promise<void> {
    try {
      await this.db.query(
        `UPDATE public.company_court_documents
            SET unavailable_at = now(), unavailable_reason = $2,
                updated_at = now()
          WHERE doc_id = $1::uuid`,
        [docId, reason],
      );
    } catch (err: any) {
      // Unmarked, it is simply asked again tomorrow.
      this.logger.warn(`[court-docs] ${docId} not marked: ${err.message}`);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * `{prefix}{case}/{doc_id}.pdf`, with the case number's slash flattened —
   * `4-1501-2503/20477` would otherwise split into two folder levels and make
   * the listing unreadable. The case number is in the path on purpose: it lets
   * a human find a decision in MinIO without going through the database.
   */
  private objectKey(caseNumber: string, docId: string): string {
    const safe = caseNumber.replace(/[/\\]/g, '_').replace(/[^\w.\-]/g, '');
    return `${this.prefix}${safe}/${docId}.pdf`;
  }

  /**
   * The file endpoint answers `multipart/form-data` — a boundary, a
   * Content-Disposition header and only then the real `%PDF`. Handing that
   * body to a browser downloads ~230 bytes of preamble glued to the document,
   * which no reader will open. Cut to the PDF itself.
   *
   * The line break that follows `%%EOF` is part of the document, not part of
   * the envelope, and the source counts it in the `pdf_size` it publishes.
   * Cutting at `%%EOF` exactly left our copy one byte short of the original on
   * every file that has one — readers accept either, but a stored size that
   * matches the declared one is an integrity check we get for free.
   *
   * The two cannot be told apart byte by byte: a real response tails off as
   * `%%EOF` `\n` `\r\n--boundary`, and one with no terminator of its own as
   * `%%EOF` `\r\n--boundary` — identical CRLFs, one the document's and one the
   * envelope's. What is unambiguous is the framing itself: multipart always
   * introduces a boundary with CRLF followed by two hyphens. So the document
   * ends where that sequence begins, and everything before it — terminator or
   * nothing — is the file.
   */
  private unwrap(raw: Buffer): Buffer {
    const start = raw.indexOf('%PDF');
    // Under 1 KB is the multipart envelope around nothing; anything bigger is
    // a file in some other format.
    if (start < 0) {
      throw new NoPdfError(raw.length < 1024 ? 'empty' : 'not_pdf');
    }
    const end = raw.lastIndexOf('%%EOF');
    if (end < start) return raw.subarray(start);

    const framing = raw.indexOf('\r\n--', end + 5);
    if (framing >= 0) return raw.subarray(start, framing);

    // No envelope at all. Take the document's own terminator if it has one,
    // but nothing beyond it — a bare body has no boundary to stop at.
    let stop = end + 5;
    if (raw[stop] === 0x0d) stop++; // \r
    if (raw[stop] === 0x0a) stop++; // \n
    return raw.subarray(start, stop);
  }

  /**
   * The source drops roughly one connection in twenty — measured, not guessed:
   * 15/15 sequential requests succeeded, then one of a parallel five failed
   * with no HTTP status at 45ms. Retrying covers it; without this the sweep
   * would lose a scattering of pages on every run.
   */
  private async getWithRetry(url: string, tries = 4): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: { 'User-Agent': this.UA },
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res;
      } catch (err) {
        lastErr = err;
        if (attempt < tries) await this.sleep(800 * attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async resetCursor(): Promise<void> {
    await this.db.query(
      `UPDATE public.${this.CURSOR}
          SET last_page = 0, cycle_seen = 0, cycle_stored = 0,
              cycle_started_at = now(), updated_at = now()
        WHERE id = 1`,
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
