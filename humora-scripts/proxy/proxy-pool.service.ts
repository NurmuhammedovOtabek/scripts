import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';

/** A proxy we are willing to send a davreestr session through. */
interface PooledProxy {
  /** `host:port` — always plain HTTP, which is what the free lists carry. */
  endpoint: string;
  /** Consecutive session failures. Three and it is dropped. */
  failures: number;
  /** How long the entry probe took, so the fastest is used first. */
  latencyMs: number;
}

/**
 * A pool of Uzbek proxies for davreestr.uz.
 *
 * davreestr answers our own server and Tashkent addresses; it does not answer
 * proxies elsewhere. That is measured, not assumed: of sixty proxies pulled
 * worldwide, eighteen were alive and nine could tunnel HTTPS — and not one of
 * those nine reached davreestr, while a Tashkent proxy completed the whole
 * flow (session, csrf token, captcha, search POST). So the pool is Uzbek-only
 * and, at the time of writing, small: the two free lists between them carry
 * seven, of which one works.
 *
 * That is why nothing here waits. A request never blocks on a refill and never
 * fails because the pool is empty — it simply goes out on our own address,
 * exactly as it did before this existed. The pool is upside when it has
 * something and invisible when it does not.
 *
 * Refills are triggered by use rather than a timer: an hourly job would spend
 * the night refreshing a list nobody is going to read. When a session asks for
 * a proxy and there is none, the refill starts in the background and that
 * session goes out direct.
 */
@Injectable()
export class ProxyPoolService {
  private readonly logger = new Logger(ProxyPoolService.name);

  /** Where the free lists live. Both answer JSON and filter by country. */
  private readonly SOURCES = [
    'https://api.proxyscrape.com/v4/free-proxy-list/get' +
      '?request=display_proxies&country=uz&protocol=http' +
      '&proxy_format=ipport&format=json',
    'https://proxylist.geonode.com/api/proxy-list' +
      '?limit=500&page=1&sort_by=lastChecked&sort_type=desc&country=UZ',
  ];

  /**
   * What a candidate has to reach to get in. The homepage is enough: a proxy
   * that can load it can carry the rest of the session, and probing the search
   * endpoint would spend a captcha to learn nothing more.
   */
  private readonly PROBE_URL = 'https://davreestr.uz/uz';
  private readonly PROBE_TIMEOUT_MS = 8000;

  /** Consecutive failures before an entry is dropped. */
  private readonly MAX_FAILURES = 3;

  /**
   * How long a pool may be reused before the next empty-handed request
   * refreshes it. Free proxies rot within hours; this stops a pool that still
   * has one nominally-alive entry from being trusted for a whole day.
   */
  private readonly MAX_AGE_MS = 60 * 60 * 1000;

  private pool: PooledProxy[] = [];
  /** Whose turn it is. Wrapped on every acquire, reset on every refill. */
  private cursor = -1;
  private filledAt = 0;
  /**
   * The refill in flight, if any.
   *
   * A promise rather than a boolean so a second caller waits for the first
   * instead of being told "busy" and returning with nothing — an admin asking
   * for a refresh would otherwise get an instant answer that did nothing.
   */
  private refillPromise: Promise<void> | null = null;

  /**
   * A proxy for one davreestr session, or null to go direct.
   *
   * The caller must keep whatever it gets for the WHOLE session. davreestr's
   * captcha is bound to the cookies and User-Agent that fetched it, so
   * switching address between the captcha and the search invalidates it.
   *
   * Sessions take turns rather than all taking the fastest entry. The limit
   * davreestr enforces is per address, so handing every session the same one
   * would concentrate the traffic on a single IP and hit exactly the ceiling
   * this pool exists to raise.
   */
  acquire(): string | null {
    const stale = Date.now() - this.filledAt > this.MAX_AGE_MS;
    if (this.pool.length === 0 || stale) {
      void this.refill(); // background; this caller does not wait for it
    }
    if (this.pool.length === 0) return null;

    this.cursor = (this.cursor + 1) % this.pool.length;
    return this.pool[this.cursor].endpoint;
  }

  /**
   * How the session went. A proxy is dropped after three failures in a row
   * rather than the first, because davreestr itself returns the occasional
   * error and blaming the proxy for it would empty the pool in a morning.
   */
  report(endpoint: string, ok: boolean): void {
    const entry = this.pool.find((p) => p.endpoint === endpoint);
    if (!entry) return;

    if (ok) {
      entry.failures = 0;
      return;
    }

    entry.failures += 1;
    if (entry.failures >= this.MAX_FAILURES) {
      this.pool = this.pool.filter((p) => p.endpoint !== endpoint);
      this.logger.warn(
        `[proxy] dropped ${endpoint} after ${this.MAX_FAILURES} failures — ` +
          `${this.pool.length} left`,
      );
    }
  }

  /** What the pool holds right now — for the admin status endpoint. */
  status() {
    return {
      size: this.pool.length,
      filled_at: this.filledAt ? new Date(this.filledAt).toISOString() : null,
      refilling: this.refillPromise !== null,
      proxies: [...this.pool]
        .sort((a, b) => a.latencyMs - b.latencyMs)
        .map((p) => ({
          endpoint: p.endpoint,
          latency_ms: p.latencyMs,
          failures: p.failures,
        })),
    };
  }

  /**
   * Pull both lists, probe every candidate, keep what answers.
   *
   * Never throws — a refill that fails leaves the pool as it was, and callers
   * go direct in the meantime.
   */
  async refill(): Promise<void> {
    if (this.refillPromise) return this.refillPromise;
    this.refillPromise = this.runRefill().finally(() => {
      this.refillPromise = null;
    });
    return this.refillPromise;
  }

  private async runRefill(): Promise<void> {
    const startedAt = Date.now();

    try {
      const candidates = await this.collectCandidates();
      if (candidates.length === 0) {
        this.logger.warn('[proxy] no candidates from any source');
        return;
      }

      const probed = await Promise.all(
        candidates.map(async (endpoint) => {
          const latencyMs = await this.probe(endpoint);
          return latencyMs === null
            ? null
            : { endpoint, failures: 0, latencyMs };
        }),
      );
      const alive = probed.filter((p): p is PooledProxy => p !== null);

      // Replaced wholesale rather than merged: an entry that survived the last
      // refill but fails this probe has stopped working, and keeping it would
      // hand a dead address to the next session.
      // Fastest first, so a short pool still favours the good ones as the
      // cursor goes round.
      this.pool = alive.sort((a, b) => a.latencyMs - b.latencyMs);
      this.cursor = -1;
      this.filledAt = Date.now();
      this.logger.log(
        `[proxy] refilled — ${alive.length}/${candidates.length} usable ` +
          `in ${Math.round((Date.now() - startedAt) / 1000)}s`,
      );
    } catch (err: any) {
      this.logger.error(`[proxy] refill failed: ${err?.message ?? err}`);
    }
  }

  /**
   * The agent a caller routes its session through.
   *
   * `proxy: false` alongside it is not redundant — axios would otherwise read
   * HTTP_PROXY from the environment and layer its own handling on top of the
   * agent, and the two disagree about CONNECT.
   */
  agentFor(endpoint: string): HttpsProxyAgent {
    return new HttpsProxyAgent(`http://${endpoint}`);
  }

  /** Every `host:port` the sources offer, deduplicated. */
  private async collectCandidates(): Promise<string[]> {
    const found = new Set<string>();

    await Promise.all(
      this.SOURCES.map(async (url) => {
        try {
          const { data: body } = await axios.get<any>(url, {
            timeout: 15000,
            headers: { Accept: 'application/json' },
          });

          // proxyscrape answers { proxies: [{ip, port}] }, geonode answers
          // { data: [{ip, port}] }. Both are read rather than one being
          // normalised away, so a source changing shape is visible here.
          const rows: any[] = body?.proxies ?? body?.data ?? [];
          for (const r of rows) {
            if (r?.ip && r?.port) found.add(`${r.ip}:${r.port}`);
          }
        } catch (err: any) {
          this.logger.warn(
            `[proxy] source failed (${new URL(url).host}): ${err?.message ?? err}`,
          );
        }
      }),
    );

    return [...found];
  }

  /**
   * Milliseconds to reach davreestr through this proxy, or null if it cannot.
   *
   * axios rather than fetch on purpose: Node's built-in fetch is undici, which
   * ignores an `agent` entirely, so a proxied request through it silently goes
   * out on our own address and every candidate looks perfect.
   */
  private async probe(endpoint: string): Promise<number | null> {
    const startedAt = Date.now();
    try {
      const res = await axios.get(this.PROBE_URL, {
        httpsAgent: this.agentFor(endpoint),
        proxy: false,
        timeout: this.PROBE_TIMEOUT_MS,
        validateStatus: () => true,
      });
      return res.status === 200 ? Date.now() - startedAt : null;
    } catch {
      return null;
    }
  }
}
