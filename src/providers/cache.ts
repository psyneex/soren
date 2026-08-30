/**
 * Small TTL cache used to reuse provider responses across enrichment calls and
 * worker cycles (AGENTS.md: cost control — caching, deduplication, bounded
 * requests).
 */
export interface TtlCacheLike {
  memoize<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T>;
}

export class TtlCache implements TtlCacheLike {
  private readonly store = new Map<string, { value: unknown; expiresAt: number }>();

  memoize<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> {
    const hit = this.store.get(key);
    if (hit && hit.expiresAt > Date.now()) {
      return Promise.resolve(hit.value as T);
    }
    return producer().then((value) => {
      this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return value;
    });
  }
}
