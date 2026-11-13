import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import axios from 'axios';
import { randomBytes } from 'node:crypto';

const STAT_API = 'https://registr.stat.uz/api/v1/organization';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
const TIMEOUT_MS = 20_000;
const CALL_DELAY_MS = 5_000;
const DAILY_LIMIT = 50;

const KNOWN_BACKENDS: Record<string, string> = {
  test: 'https://test.humora.uz/api',
  prod: 'https://humora.uz/api',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

@Injectable()
export class ContactFillService implements OnModuleInit {
  private readonly logger = new Logger(ContactFillService.name);
  private readonly adminSecret: string;
  private running = false;
  private runningFor = '';
  private dailyUsed = 0;
  private lastResetDate = '';

  constructor() {
    this.adminSecret = process.env.ADMIN_SECRET || '';
  }

  onModuleInit() {
    if (process.env.CONTACT_FILL_AUTO === '1') {
      this.logger.log('[contact-fill] auto-start enabled, running in 10s');
      setTimeout(() => this.run('prod'), 10_000);
    }
  }

  async run(target: string = 'prod'): Promise<{
    asked: number;
    filled: number;
    phones: number;
    emails: number;
    failed: number;
    backend: string;
  }> {
    const backendUrl = this.resolveBackend(target);
    if (!backendUrl) {
      this.logger.warn(`[contact-fill] unknown target: ${target}`);
      return { asked: 0, filled: 0, phones: 0, emails: 0, failed: 0, backend: target };
    }

    if (this.running) {
      this.logger.log(`[contact-fill] already running for ${this.runningFor}`);
      return { asked: 0, filled: 0, phones: 0, emails: 0, failed: 0, backend: backendUrl };
    }

    this.resetDailyIfNeeded();
    const budget = Math.max(DAILY_LIMIT - this.dailyUsed, 0);
    if (budget === 0) {
      this.logger.log('[contact-fill] daily limit reached');
      return { asked: 0, filled: 0, phones: 0, emails: 0, failed: 0, backend: backendUrl };
    }

    this.running = true;
    this.runningFor = target;
    try {
      return await this.walk(budget, backendUrl);
    } finally {
      this.running = false;
      this.runningFor = '';
    }
  }

  private resolveBackend(target: string): string | null {
    if (KNOWN_BACKENDS[target]) return KNOWN_BACKENDS[target];
    if (target.startsWith('http')) return target.replace(/\/+$/, '');
    return null;
  }

  status() {
    this.resetDailyIfNeeded();
    return {
      running: this.running,
      dailyUsed: this.dailyUsed,
      remaining: Math.max(DAILY_LIMIT - this.dailyUsed, 0),
      limit: DAILY_LIMIT,
    };
  }

  private async walk(budget: number, backendUrl: string) {
    const inns = await this.fetchPending(budget, backendUrl);
    this.logger.log(
      `[contact-fill] got ${inns.length} pending INNs, budget=${budget}`,
    );

    let asked = 0;
    let filled = 0;
    let phones = 0;
    let emails = 0;
    let failed = 0;
    const results: Array<{
      inn: string;
      phone: string | null;
      email: string | null;
    }> = [];

    for (let i = 0; i < inns.length; i++) {
      const inn = inns[i];
      try {
        asked++;
        this.dailyUsed++;
        const r = await this.fetchFromStat(inn);
        results.push({ inn, phone: r.phone, email: r.email });

        if (r.phone || r.email) {
          filled++;
          if (r.phone) phones++;
          if (r.email) emails++;
        }
      } catch (err: any) {
        failed++;
        this.logger.warn(`[contact-fill] ${inn} — ${err.message}`);
        if (err.message?.includes('429')) {
          this.logger.warn('[contact-fill] 429 — stopping');
          break;
        }
      }

      if (i < inns.length - 1) await sleep(CALL_DELAY_MS);
    }

    if (results.length > 0) {
      await this.sendResults(results, backendUrl);
    }

    this.logger.log(
      `[contact-fill] done — asked=${asked} filled=${filled} ` +
        `phones=${phones} emails=${emails} failed=${failed} backend=${backendUrl}`,
    );
    return { asked, filled, phones, emails, failed, backend: backendUrl };
  }

  private async fetchPending(limit: number, backendUrl: string): Promise<string[]> {
    try {
      const res = await axios.get(
        `${backendUrl}/contact-fill/pending?limit=${limit}`,
        {
          headers: { 'x-admin-secret': this.adminSecret },
          timeout: 15_000,
        },
      );
      return res.data?.inns ?? [];
    } catch (err: any) {
      this.logger.error(
        `[contact-fill] failed to fetch pending: ${err.message}`,
      );
      return [];
    }
  }

  private async fetchFromStat(
    inn: string,
  ): Promise<{ phone: string | null; email: string | null }> {
    const deviceId = randomBytes(16).toString('hex');
    const res = await axios.get(`${STAT_API}/detail/${inn}/`, {
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
        'X-Device-ID': deviceId,
      },
    });

    if (res.status === 429) {
      throw new Error(`429 — IP limit hit for today`);
    }
    if (res.status === 400) {
      const retry = randomBytes(16).toString('hex');
      const r2 = await axios.get(`${STAT_API}/detail/${inn}/`, {
        timeout: TIMEOUT_MS,
        validateStatus: () => true,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'uz,ru;q=0.9,en;q=0.8',
          'X-Device-ID': retry,
        },
      });
      if (r2.status === 429) throw new Error('429 — IP limit hit for today');
      if (r2.status !== 200 || !r2.data) return { phone: null, email: null };
      return {
        phone: clean(r2.data.org_phone),
        email: clean(r2.data.org_elpochta),
      };
    }
    if (res.status === 404 || res.status !== 200 || !res.data) {
      return { phone: null, email: null };
    }

    return {
      phone: clean(res.data.org_phone),
      email: clean(res.data.org_elpochta),
    };
  }

  private async sendResults(
    results: Array<{
      inn: string;
      phone: string | null;
      email: string | null;
    }>,
    backendUrl: string,
  ): Promise<void> {
    try {
      const res = await axios.post(
        `${backendUrl}/contact-fill/results`,
        { results },
        {
          headers: {
            'x-admin-secret': this.adminSecret,
            'Content-Type': 'application/json',
          },
          timeout: 30_000,
        },
      );
      this.logger.log(
        `[contact-fill] sent ${results.length} results — ` +
          `filled=${res.data?.filled} phones=${res.data?.phones} emails=${res.data?.emails}`,
      );
    } catch (err: any) {
      this.logger.error(
        `[contact-fill] failed to send results: ${err.message}`,
      );
    }
  }

  private resetDailyIfNeeded() {
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.lastResetDate) {
      this.dailyUsed = 0;
      this.lastResetDate = today;
    }
  }
}

function clean(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
