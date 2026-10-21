import { Inject, Injectable, Logger } from '@nestjs/common';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import axios from 'axios';

/**
 * MFO → bank name, from the state registry at cs.egov.uz.
 *
 * Cached, and that is what makes it safe to ask every time. The list is about
 * 1,700 entries and changes when a bank opens, merges or renames — a handful
 * of times a year. Callers used to resolve a name only when they had none,
 * which meant a company that changed bank kept the old bank's name against the
 * new bank's code for ever: 4,318 rows carried a name that did not belong to
 * their MFO, and the one that got reported showed Trastbank's code under
 * NBU's name. Asking on every sync removes the possibility rather than
 * patching the path that produced it.
 */
@Injectable()
export class BankScriptService {
  private readonly logger = new Logger(BankScriptService.name);

  private readonly API_URL = 'https://cs.egov.uz/apiData/MainData/Get';
  private readonly TABLE_ID = '61a5af415e335967803edc8b';

  /** A week: long enough that the registry is asked ~1,700 times in total. */
  private readonly TTL_MS = parseInt(
    process.env.BANK_NAME_TTL_MS || String(7 * 24 * 60 * 60 * 1000),
    10,
  );

  constructor(@Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async getByMfo(
    mfo: string,
  ): Promise<{ bank_name: string; bank_code: string } | null> {
    const key = `bank:mfo:${mfo}`;

    try {
      // `null` is a remembered "no such MFO" — see below. Distinguishing it
      // from a miss is what stops an unknown code being looked up on every
      // sync of every company that carries it.
      const hit = await this.cache.get<{ bank_name: string } | null>(key);
      if (hit === null) return null;
      if (hit) return { bank_name: hit.bank_name, bank_code: mfo };
    } catch (e: any) {
      this.logger.warn(`cs.egov.uz: cache read failed: ${e.message}`);
    }

    this.logger.log(`cs.egov.uz: MFO=${mfo}`);

    try {
      const res = await axios.post(
        this.API_URL,
        {
          id: this.TABLE_ID,
          offset: 0,
          limit: 1,
          query: { BANK_ID: mfo },
        },
        { timeout: 10000, headers: { 'Content-Type': 'application/json' } },
      );

      const data = res.data?.result?.data;
      if (!data || data.length === 0) {
        this.logger.warn(`cs.egov.uz: MFO=${mfo} — not found`);
        await this.remember(key, null);
        return null;
      }

      const col = data[0].tableColumn;
      const bankName = col?.BANK_NAME?.data?.trim() || null;

      if (!bankName) {
        this.logger.warn(`cs.egov.uz: MFO=${mfo} — BANK_NAME empty`);
        await this.remember(key, null);
        return null;
      }

      this.logger.log(`cs.egov.uz: MFO=${mfo} → ${bankName}`);
      await this.remember(key, { bank_name: bankName });
      return { bank_name: bankName, bank_code: mfo };
    } catch (err) {
      // Deliberately not cached: an outage now must not withhold the name for
      // a week. The caller keeps whatever it already had.
      this.logger.error(`cs.egov.uz: MFO=${mfo} — failed: ${err.message}`);
      return null;
    }
  }

  private async remember(
    key: string,
    value: { bank_name: string } | null,
  ): Promise<void> {
    try {
      await this.cache.set(key, value, this.TTL_MS);
    } catch (e: any) {
      this.logger.warn(`cs.egov.uz: cache write failed: ${e.message}`);
    }
  }
}
