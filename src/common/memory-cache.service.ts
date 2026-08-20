import { Injectable } from '@nestjs/common';

/**
 * A tiny in-process cache standing in for the backend's Redis-backed
 * cache-manager.
 *
 * This box is a scraper, not a source of truth: the backend keeps the real
 * cache. What is kept here only avoids re-scraping the same company twice in
 * quick succession, so a plain Map with expiry is enough and it deliberately
 * does not survive a restart.
 */
@Injectable()
export class MemoryCacheService {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();

  get<T>(key: string): Promise<T | undefined> {
    const hit = this.store.get(key);
    if (!hit) return Promise.resolve(undefined);
    if (hit.expiresAt <= Date.now()) {
      this.store.delete(key);
      return Promise.resolve(undefined);
    }
    return Promise.resolve(hit.value as T);
  }

  set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
    // Expiry is lazy, so a key nobody reads again would sit here forever.
    // Sweeping on write keeps the map bounded without a timer.
    if (this.store.size % 64 === 0) this.sweep();
    return Promise.resolve();
  }

  del(key: string): Promise<void> {
    this.store.delete(key);
    return Promise.resolve();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.store) {
      if (v.expiresAt <= now) this.store.delete(k);
    }
  }
}
