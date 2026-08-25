import * as fs from 'fs';
import * as path from 'path';

/**
 * Where the log is kept.
 *
 * The box runs unattended in an office, so its output has to survive being
 * read later and from somewhere else. launchd already captures stdout, but
 * only to a path configured by hand on that one machine — nothing in this
 * repository knows it. Writing our own file makes the log something the
 * service can serve, wherever it is deployed.
 */
export const LOG_FILE =
  process.env.LOG_FILE ?? path.join(process.cwd(), 'logs', 'scraper.log');

/** Rotate at this size, keeping one previous file. */
const MAX_BYTES = parseInt(
  process.env.LOG_MAX_BYTES ?? String(20 * 1024 * 1024),
  10,
);

let stream: fs.WriteStream | null = null;
let written = 0;

function open(): fs.WriteStream {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  written = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
  return fs.createWriteStream(LOG_FILE, { flags: 'a' });
}

function rotate(): void {
  try {
    stream?.end();
    // One generation back. More would need pruning, and a scraper box's log
    // is for the last few days, not an archive.
    fs.renameSync(LOG_FILE, `${LOG_FILE}.1`);
  } catch {
    // A failed rotation must not stop the service logging.
  }
  stream = open();
}

/**
 * Sends everything printed to the console into the log file as well.
 *
 * Patching the streams rather than swapping Nest's logger is deliberate: it
 * catches Playwright's warnings, unhandled errors and the framework's own
 * bootstrap lines too — all the output that matters when something has gone
 * wrong and nobody was watching.
 *
 * Call before the Nest app is created.
 */
export function teeConsoleToFile(): void {
  if (stream) return;
  stream = open();

  for (const name of ['stdout', 'stderr'] as const) {
    const target = process[name];
    const original = target.write.bind(target);

    target.write = ((chunk: any, ...rest: any[]): boolean => {
      try {
        const text = typeof chunk === 'string' ? chunk : String(chunk);
        stream?.write(text);
        written += Buffer.byteLength(text);
        if (written >= MAX_BYTES) rotate();
      } catch {
        // Never let logging break the thing being logged.
      }
      return original(chunk, ...rest);
    }) as typeof target.write;
  }
}

/**
 * PINFL never leaves this machine, including through its logs.
 *
 * Some lookups are keyed by a person's PINFL, and the services that take one
 * log it through the same line they use for a company — `INN=` either way, so
 * the label cannot be trusted to tell them apart. Length can: a PINFL is
 * fourteen digits and a company's TIN is nine.
 *
 * Redacted whole rather than partially masked. A few visible digits narrow the
 * search enough to matter, and nothing in a log needs them — the timestamp
 * already tells you which request a line belongs to.
 */
export function redact(text: string): string {
  return text.replace(/\b\d{14}\b/g, '[pinfl]');
}

/**
 * Strips the colour codes Nest writes for a terminal.
 *
 * They are noise everywhere this log actually gets read — curl over the
 * network, a browser, a paste into a chat — and they are numerous enough to
 * roughly double the size of every line.
 */
// Built from a char code: the pattern needs the ESC byte, and an escape
// character written literally into source is invisible to whoever reads it.
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
export const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');

/**
 * The end of the log, newest last.
 *
 * Reads only the tail of the file: this is called over the network from a
 * machine that cannot reach the box's disk, and the file runs to megabytes.
 */
export function tail(
  lines: number,
  filter?: string,
): { lines: string[]; file: string; sizeBytes: number } {
  if (!fs.existsSync(LOG_FILE)) {
    return { lines: [], file: LOG_FILE, sizeBytes: 0 };
  }

  const size = fs.statSync(LOG_FILE).size;
  // Enough bytes to hold the requested lines at a generous width, capped so a
  // large request cannot read the whole file into memory.
  const want = Math.min(size, Math.min(lines, 2000) * 400);
  const buf = Buffer.alloc(want);
  const fd = fs.openSync(LOG_FILE, 'r');
  try {
    fs.readSync(fd, buf, 0, want, size - want);
  } finally {
    fs.closeSync(fd);
  }

  let out = buf
    .toString('utf8')
    .split('\n')
    // The first line is usually cut in half by where the read started.
    .slice(want < size ? 1 : 0)
    .filter((l) => l.trim().length > 0);

  if (filter) {
    const needle = filter.toLowerCase();
    out = out.filter((l) => l.toLowerCase().includes(needle));
  }

  return {
    lines: out.slice(-lines).map((l) => redact(stripAnsi(l))),
    file: LOG_FILE,
    sizeBytes: size,
  };
}
