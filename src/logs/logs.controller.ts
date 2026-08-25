import {
  Controller,
  ForbiddenException,
  Get,
  Headers,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { LOG_FILE, tail } from '../common/log-file';

/**
 * Reading the box's log from somewhere else.
 *
 * The machine sits in an office and nobody is in front of it most of the time,
 * so a failure that only appears in its console is a failure nobody sees. Every
 * other endpoint here is unauthenticated because it returns public registry
 * data; a log is different — it carries the shape of our traffic and whatever
 * an error happened to include — so this one asks for a secret.
 *
 * Set LOGS_TOKEN on the box. Without it the endpoint refuses everyone, which
 * is the right default for a machine on someone's office network.
 */
@Controller('logs')
export class LogsController {
  private assertAllowed(token?: string): void {
    const expected = process.env.LOGS_TOKEN?.trim();
    if (!expected) {
      throw new ForbiddenException(
        'LOGS_TOKEN is not set on this box — the log endpoint is closed',
      );
    }
    if (token !== expected) {
      throw new ForbiddenException('bad or missing x-logs-token');
    }
  }

  /**
   * The tail of the log.
   *
   * `q` filters to matching lines before the tail is taken, which is what
   * makes this usable over a slow link: `?q=FAIL` or `?q=Turnstile` answers a
   * question without shipping thousands of lines.
   */
  @Get()
  read(
    @Res({ passthrough: true }) res: Response,
    @Headers('x-logs-token') token?: string,
    @Query('lines') lines?: string,
    @Query('q') q?: string,
  ): string {
    this.assertAllowed(token);

    // Set after the guard, not by a decorator: a decorator would stamp
    // text/plain onto the JSON error body too, which Nest warns about and
    // which no client wants.
    res.type('text/plain; charset=utf-8');

    const n = Math.min(Math.max(parseInt(lines ?? '200', 10) || 200, 1), 2000);
    const result = tail(n, q?.trim() || undefined);

    // Plain text, not JSON: this is read by a person, usually through curl,
    // and JSON-escaped newlines would make it unreadable.
    const header =
      `# ${result.file} (${(result.sizeBytes / 1024 / 1024).toFixed(1)} MB)` +
      `${q ? ` · filter="${q}"` : ''} · last ${result.lines.length} line(s)\n\n`;

    return result.lines.length
      ? header + result.lines.join('\n') + '\n'
      : header + '(nothing matched)\n';
  }

  /** Where the log lives and how big it is, without shipping any of it. */
  @Get('info')
  info(@Headers('x-logs-token') token?: string) {
    this.assertAllowed(token);
    const result = tail(1);
    return {
      file: LOG_FILE,
      sizeBytes: result.sizeBytes,
      sizeMb: +(result.sizeBytes / 1024 / 1024).toFixed(2),
      lastLine: result.lines[0] ?? null,
    };
  }
}
