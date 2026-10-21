import { Injectable, Inject, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { randomUUID } from 'crypto';
import axios from 'axios';
import * as FormData from 'form-data';
import { buildProxyAgents } from './cbu-proxy.util';

const CACHE_KEY = 'cbu:access_token';

@Injectable()
export class CbuAuthService {
  private readonly logger = new Logger(CbuAuthService.name);
  private readonly baseUrl = process.env.FACTORING_BASE_URL ?? '';
  private readonly username = process.env.FACTORING_USERNAME ?? '';
  private readonly password = process.env.FACTORING_PASSWORD ?? '';
  private fetchInFlight: Promise<string> | null = null;

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async getToken(): Promise<string> {
    const cached = await this.cache.get<string>(CACHE_KEY);
    if (cached) return cached;
    if (!this.fetchInFlight) {
      this.fetchInFlight = this.fetchFreshToken().finally(() => {
        this.fetchInFlight = null;
      });
    }
    return this.fetchInFlight;
  }

  private async fetchFreshToken(): Promise<string> {
    this.logger.log('[cbu-auth] fetching fresh token');
    const form = new FormData();
    form.append('username', this.username);
    form.append('password', this.password);

    // CBU support locates a request in their own logs by X-Trace-Id.
    const traceId = randomUUID();
    const res = await axios.post(
      `${this.baseUrl}/integration/auth/login`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'X-Trace-Id': traceId,
          'X-Correlation-ID': traceId,
        },
        timeout: 15000,
        ...buildProxyAgents(),
      },
    );

    const { access_token, expires_in } = res.data?.data ?? {};
    if (!access_token) {
      throw new Error('[cbu-auth] login response missing access_token');
    }

    const ttlMs = (Number(expires_in ?? 3600) - 60) * 1000;
    await this.cache.set(CACHE_KEY, access_token, ttlMs);
    this.logger.log(`[cbu-auth] token cached for ${ttlMs / 1000}s`);
    return access_token;
  }

  /** Call after a 401 to force-refresh the token */
  async invalidate(): Promise<void> {
    await this.cache.del(CACHE_KEY);
  }
}
