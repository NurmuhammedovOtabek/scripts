import axios, { AxiosRequestConfig } from 'axios';

/** Between two requests to the same host. Government sites owe us nothing. */
export const HOST_GAP_MS = 1_500;
/** A whole request, connect included (axios's `timeout` alone is not that). */
export const REQUEST_TIMEOUT_MS = 90_000;
/** Before the one retry of a request that failed on the way or with a 5xx. */
const RETRY_PAUSE_MS = 5_000;

export const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * The source refused us (403, 429). Not retried: the rest of that source waits
 * for the next run, and the report says so.
 */
export class SourceRefusedError extends Error {
  constructor(
    readonly host: string,
    readonly status: number,
  ) {
    super(`${host} refused the request (HTTP ${status})`);
  }
}

export interface HttpAnswer<T = any> {
  status: number;
  data: T;
  headers: Record<string, unknown>;
}

type Send = (config: AxiosRequestConfig) => Promise<HttpAnswer>;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * When each host was last asked. One per run, shared by every source of it:
 * the fourteen data.egov.uz registers are one host and wait for one another.
 */
export class HostPacer {
  private readonly last = new Map<string, number>();

  constructor(
    readonly gapMs = HOST_GAP_MS,
    private readonly wait: (ms: number) => Promise<void> = sleep,
  ) {}

  async turn(host: string): Promise<void> {
    const at = this.last.get(host);
    if (at !== undefined) {
      const left = at + this.gapMs - Date.now();
      if (left > 0) await this.wait(left);
    }
    this.last.set(host, Date.now());
  }
}

/**
 * The requests of one source in one run: paced per host, each with a hard
 * deadline, one retry for a failure on the way or a 5xx, and no retry at all
 * for a refusal. `limit` (trial runs) caps how many requests the source may
 * make; an adapter reads `spent` and stops paging, its read marked incomplete.
 */
export class RegistryHttp {
  requests = 0;

  constructor(
    private readonly pacer: HostPacer,
    private readonly limit: number | null = null,
    private readonly send: Send = (config) =>
      axios.request(config) as Promise<HttpAnswer>,
    private readonly retryPauseMs = RETRY_PAUSE_MS,
  ) {}

  /** The trial limit is used up: no further request may be made. */
  get spent(): boolean {
    return this.limit !== null && this.requests >= this.limit;
  }

  get<T = any>(
    url: string,
    opts: Omit<AxiosRequestConfig, 'url' | 'method'> = {},
  ): Promise<HttpAnswer<T>> {
    return this.request<T>({ ...opts, url, method: 'GET' });
  }

  post<T = any>(
    url: string,
    data: unknown,
    opts: Omit<AxiosRequestConfig, 'url' | 'method' | 'data'> = {},
  ): Promise<HttpAnswer<T>> {
    return this.request<T>({ ...opts, url, method: 'POST', data });
  }

  /** A 200, or an error. A refusal throws `SourceRefusedError`. */
  async request<T = any>(config: AxiosRequestConfig): Promise<HttpAnswer<T>> {
    if (this.spent) {
      throw new Error(`request limit of ${this.limit} reached`);
    }
    const host = new URL(String(config.url)).host;
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (attempt === 2) await sleep(this.retryPauseMs);
      await this.pacer.turn(host);
      this.requests++;
      let answer: HttpAnswer;
      try {
        answer = await this.send({
          timeout: REQUEST_TIMEOUT_MS,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          validateStatus: () => true,
          maxRedirects: 3,
          ...config,
          headers: { 'User-Agent': USER_AGENT, ...(config.headers ?? {}) },
        });
      } catch (err) {
        lastError = new Error(`${host}: ${(err as Error).message}`);
        if (this.spent) break;
        continue;
      }
      if (answer.status === 200) return answer as HttpAnswer<T>;
      if (answer.status === 403 || answer.status === 429) {
        throw new SourceRefusedError(host, answer.status);
      }
      lastError = new Error(`${host} answered HTTP ${answer.status}`);
      if (answer.status < 500 || this.spent) break;
    }
    throw lastError ?? new Error(`${host}: no answer`);
  }
}
