import {
  Controller,
  Get,
  Headers,
  Logger,
  Query,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import axios from 'axios';

/**
 * The scraper box's log, fetched through the backend.
 *
 * The box answers only on the private network, so reading its log means being
 * on that network — which is the one thing that is not true when something has
 * broken out of hours. This endpoint sits on the public API instead and
 * forwards the request, holding the box's own token server-side so it never
 * has to be carried around.
 *
 * Guarded by `x-admin-secret` rather than a login, matching the other
 * maintenance endpoints: this is read with curl, not from a browser session.
 *
 * Whatever comes back has already had PINFL removed by the box itself — the
 * redaction lives at the source, not here, so nothing can reach this proxy
 * unredacted in the first place.
 */
@ApiExcludeController()
@Controller('org/admin/scraper')
export class ScraperLogsController {
  private readonly logger = new Logger(ScraperLogsController.name);

  private assertAdmin(secret?: string): void {
    const expected = process.env.ADMIN_SECRET;
    if (!expected) {
      throw new UnauthorizedException('ADMIN_SECRET is not configured');
    }
    if (!secret || secret !== expected) {
      throw new UnauthorizedException(
        'Invalid or missing x-admin-secret header',
      );
    }
  }

  /**
   * The tail of the box's log.
   *
   *   GET /api/org/admin/scraper/logs?lines=200&q=Turnstile
   *   header: x-admin-secret: <ADMIN_SECRET>
   */
  @Get('logs')
  async logs(
    @Res({ passthrough: true }) res: Response,
    @Headers('x-admin-secret') secret?: string,
    @Query('lines') lines?: string,
    @Query('q') q?: string,
  ): Promise<string> {
    this.assertAdmin(secret);

    const base = process.env.SCRIPT_SERVICE_URL?.trim().replace(/\/+$/, '');
    const token = process.env.SCRIPT_LOGS_TOKEN?.trim();
    if (!base) {
      throw new ServiceUnavailableException(
        'SCRIPT_SERVICE_URL is not set — this deployment has no scraper box',
      );
    }
    if (!token) {
      throw new ServiceUnavailableException(
        'SCRIPT_LOGS_TOKEN is not set — it must match LOGS_TOKEN on the box',
      );
    }

    try {
      const r = await axios.get(`${base}/logs`, {
        params: { lines: lines ?? '200', ...(q ? { q } : {}) },
        headers: { 'x-logs-token': token },
        // Short: this is a person waiting on a terminal, and a box that is not
        // answering is itself the answer they were looking for.
        timeout: 20_000,
        responseType: 'text',
        transformResponse: [(d: string) => d],
        validateStatus: () => true,
      });

      if (r.status !== 200) {
        // 403 here means the two tokens disagree — the single most likely
        // misconfiguration, and worth saying plainly rather than passing a
        // bare status back.
        const hint =
          r.status === 403
            ? ' — SCRIPT_LOGS_TOKEN here does not match LOGS_TOKEN on the box'
            : '';
        throw new ServiceUnavailableException(
          `Scraper box answered ${r.status}${hint}`,
        );
      }

      res.type('text/plain; charset=utf-8');
      return String(r.data);
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const message = (err as Error).message;
      this.logger.warn(`[scraper-logs] could not reach the box: ${message}`);
      throw new ServiceUnavailableException(
        `Could not reach the scraper box at ${base}: ${message}`,
      );
    }
  }

  /** Size and location of the box's log, without shipping any of it. */
  @Get('logs/info')
  async info(@Headers('x-admin-secret') secret?: string) {
    this.assertAdmin(secret);

    const base = process.env.SCRIPT_SERVICE_URL?.trim().replace(/\/+$/, '');
    const token = process.env.SCRIPT_LOGS_TOKEN?.trim();
    if (!base || !token) {
      throw new ServiceUnavailableException(
        'SCRIPT_SERVICE_URL or SCRIPT_LOGS_TOKEN is not set',
      );
    }

    try {
      const r = await axios.get(`${base}/logs/info`, {
        headers: { 'x-logs-token': token },
        timeout: 20_000,
        validateStatus: () => true,
      });
      if (r.status !== 200) {
        throw new ServiceUnavailableException(
          `Scraper box answered ${r.status}`,
        );
      }
      return r.data;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException(
        `Could not reach the scraper box: ${(err as Error).message}`,
      );
    }
  }
}
