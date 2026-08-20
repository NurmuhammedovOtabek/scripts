import { Injectable } from '@nestjs/common';

/**
 * Stands in for the backend's ProxyPoolService.
 *
 * On the backend, davreestr is reached through rotating proxies because the
 * production IP alone cannot stay under the site's 15 requests/minute. This box
 * IS that separate IP — routing its traffic through yet another proxy would
 * only add a hop and hide which address the site actually sees. So every method
 * is a deliberate no-op: requests go out directly.
 */
@Injectable()
export class NoProxyPool {
  acquire(): string | null {
    return null;
  }

  agentFor(_endpoint: string): undefined {
    return undefined;
  }

  report(_endpoint: string | null, _ok: boolean): void {
    // Nothing to score — there is only ever the one egress address.
  }
}
