import { isMainThread, parentPort, Worker, workerData } from 'worker_threads';
import {
  anchoredRows,
  readPdf,
  tableRows,
  TableRow,
  TableSpec,
} from './pdf-table';

/**
 * A PDF table read in a worker thread.
 *
 * pdfjs in Node runs its own "worker" on the calling thread and chains every
 * step through promises, so the event loop gets no turn until the whole file
 * is read: Sanepid's quarterly files held the API still for 8–50 s each
 * (measured 2026-10-15). Here the file is read on a thread of its own, with
 * a heap of its own and a deadline, and only the rows come back.
 */

/** One table layout to look for. */
export interface PdfTableLayout {
  spec: TableSpec;
  /** Rows told by this value in the anchor column (`anchoredRows`); by lines otherwise. */
  anchor?: RegExp;
}

export interface PdfTableRequest {
  /** Layouts tried in order on the one read of the file; the first giving rows wins. */
  layouts: PdfTableLayout[];
}

export interface PdfTableResult {
  rows: TableRow[];
  /** Which layout gave the rows; -1 when none did. */
  layout: number;
  /** The first page's text, for the "as of" day a register prints there. */
  firstPageText: string;
  pages: number;
}

/**
 * The reader's heap. Measured 2026-10-21 on every gov.uz PDF register: the
 * five registers' files (0.4–0.7 MB, 10–68 pages) read within 192 MB, and
 * Sanepid's largest quarter (6.9 MB, 34 dense pages) within 384 MB — 256 is
 * not enough. 512 leaves room for a larger edition; it was 1024, a ceiling
 * never measured, inside the same container as the API.
 * `REGISTRY_PDF_HEAP_MB` overrides it. A file that needs more fails alone
 * (ERR_WORKER_OUT_OF_MEMORY kills the thread, not the process).
 */
const PDF_WORKER_HEAP_MB = (() => {
  const v = Number(process.env.REGISTRY_PDF_HEAP_MB);
  return Number.isFinite(v) && v >= 128 ? v : 512;
})();
/** One file, however large: the 613-page quarter reads in under a minute. */
const PDF_WORKER_TIMEOUT_MS = 10 * 60_000;

const TAG = 'registriesPdfTable';

interface Job {
  data: Uint8Array;
  request: PdfTableRequest;
}

/** The table in `data`, read on a worker thread. Rejects on a bad file, no memory or the deadline. */
export function readPdfTable(
  data: Uint8Array,
  request: PdfTableRequest,
  opts: { timeoutMs?: number; heapMb?: number } = {},
): Promise<PdfTableResult> {
  const timeoutMs = opts.timeoutMs ?? PDF_WORKER_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // Only the layouts' data crosses to the thread: a caller's own fields
    // (functions among them) cannot be cloned.
    const job: Job = {
      data,
      request: {
        layouts: request.layouts.map(({ spec, anchor }) => ({ spec, anchor })),
      },
    };
    const options = {
      workerData: { [TAG]: job },
      resourceLimits: {
        maxOldGenerationSizeMb: opts.heapMb ?? PDF_WORKER_HEAP_MB,
      },
    };
    // Under ts-node (tests, the local harness) the thread compiles this file
    // too; the build runs the compiled .js directly.
    const worker = __filename.endsWith('.ts')
      ? new Worker(
          `require('ts-node').register({ transpileOnly: true }); require(${JSON.stringify(__filename)});`,
          { ...options, eval: true },
        )
      : new Worker(__filename, options);
    let settled = false;
    const finish = (err: Error | null, result?: PdfTableResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      if (err) reject(err);
      else resolve(result!);
    };
    const timer = setTimeout(
      () =>
        finish(new Error(`PDF not read in ${Math.round(timeoutMs / 1000)} s`)),
      timeoutMs,
    );
    worker.once(
      'message',
      (m: (PdfTableResult & { error?: undefined }) | { error: string }) =>
        m.error !== undefined
          ? finish(new Error(m.error))
          : finish(null, m as PdfTableResult),
    );
    // ERR_WORKER_OUT_OF_MEMORY lands here: the thread dies, the process lives.
    worker.once('error', (err) => finish(err));
    worker.once('exit', (code) =>
      finish(new Error(`PDF reader stopped (exit ${code})`)),
    );
  });
}

async function work(job: Job): Promise<PdfTableResult> {
  const pages = await readPdf(job.data);
  const firstPageText = pages[0]?.texts.map((t) => t.text).join(' ') ?? '';
  for (const [i, { spec, anchor }] of job.request.layouts.entries()) {
    const rows = anchor
      ? anchoredRows(pages, spec, anchor)
      : tableRows(pages, spec);
    if (rows.length) {
      return { rows, layout: i, firstPageText, pages: pages.length };
    }
  }
  return { rows: [], layout: -1, firstPageText, pages: pages.length };
}

if (!isMainThread && workerData?.[TAG]) {
  work(workerData[TAG] as Job).then(
    (result) => parentPort!.postMessage(result),
    (err) =>
      parentPort!.postMessage({
        error: String((err as Error)?.message ?? err),
      }),
  );
}
