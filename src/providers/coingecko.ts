/**
 * CoinGecko free API client — market-regime reference data (keyless, free).
 *
 * Bounded usage: a single cached markets + global request pair per chain per
 * cache window (10 minutes), so a 60-minute monitoring cycle costs 2 requests.
 * Failures degrade to an unavailable observation with notes — never fabricated
 * values.
 */
import type { RegimeObservation } from '../domain/types.js';

import type { TtlCacheLike } from './cache.js';

/** Chain → CoinGecko asset id of the benchmark (native) asset. */
export const CHAIN_NATIVE_COINGECKO_ID: Record<string, string> = {
  solana: 'solana',
  ethereum: 'ethereum',
  polygon: 'matic-network',
  arbitrum: 'ethereum',
  base: 'ethereum',
  bsc: 'binancecoin',
};

export interface CoinGeckoClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  cache?: TtlCacheLike;
  now?: () => Date;
  /** Bounded retry attempts for transient failures (429 / 5xx / network). */
  maxAttempts?: number;
}

interface MarketRow {
  id?: string;
  price_change_percentage_24h?: number | null;
  price_change_percentage_7d_in_currency?: number | null;
}

interface GlobalResponse {
  data?: { market_cap_change_percentage_24h_usd?: number | null };
}

export class CoinGeckoClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly cache: TtlCacheLike | null;
  private readonly now: () => Date;
  private readonly maxAttempts: number;

  constructor(options: CoinGeckoClientOptions = {}) {
    const fallback = globalThis.fetch;
    this.fetcher = options.fetch ?? fallback.bind(globalThis);
    this.baseUrl = (options.baseUrl ?? 'https://api.coingecko.com/api/v3').replace(/\/$/, '');
    this.cache = options.cache ?? null;
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 2;
  }

  async fetchRegime(chain: string): Promise<RegimeObservation> {
    const observedAt = this.now().toISOString();
    const empty = (notes: string[]): RegimeObservation => ({
      available: false,
      btcChange24hPct: null,
      btcChange7dPct: null,
      nativeChange24hPct: null,
      totalMarketCapChange24hPct: null,
      benchmarkChange24hPct: null,
      benchmarkId: null,
      provider: 'coingecko',
      observedAt,
      notes,
    });

    const nativeId = CHAIN_NATIVE_COINGECKO_ID[chain] ?? null;
    if (!nativeId) {
      return empty([`No benchmark asset configured for chain "${chain}".`]);
    }

    const produce = async (): Promise<RegimeObservation> => {
      try {
        const ids = [...new Set(['bitcoin', nativeId])].join(',');
        const markets = await this.fetchJson<MarketRow[]>(
          `/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids)}&price_change_percentage=24h,7d`,
        );
        const global = await this.fetchJson<GlobalResponse>('/global');

        const btc = markets.find((row) => row.id === 'bitcoin') ?? null;
        const native = markets.find((row) => row.id === nativeId) ?? null;
        const btc24 = typeof btc?.price_change_percentage_24h === 'number' ? btc.price_change_percentage_24h : null;
        const btc7d =
          typeof btc?.price_change_percentage_7d_in_currency === 'number'
            ? btc.price_change_percentage_7d_in_currency
            : null;
        const native24 =
          typeof native?.price_change_percentage_24h === 'number' ? native.price_change_percentage_24h : null;
        const broad =
          typeof global?.data?.market_cap_change_percentage_24h_usd === 'number'
            ? global.data.market_cap_change_percentage_24h_usd
            : null;

        const available = btc24 != null || native24 != null || broad != null;
        return {
          available,
          btcChange24hPct: btc24,
          btcChange7dPct: btc7d,
          nativeChange24hPct: native24,
          totalMarketCapChange24hPct: broad,
          benchmarkChange24hPct: native24,
          benchmarkId: nativeId,
          provider: 'coingecko',
          observedAt,
          notes: [
            `Benchmark for ${chain}: ${nativeId} (CoinGecko).`,
            ...(available ? [] : ['CoinGecko returned no usable regime data.']),
          ],
        };
      } catch (error) {
        return empty([`CoinGecko unavailable: ${error instanceof Error ? error.message : String(error)}`]);
      }
    };

    if (this.cache) {
      // 30-minute window: regime inputs are 24h-scale changes; wider caching
      // trades negligible staleness for far fewer CoinGecko public-API hits
      // (the keyless endpoint saturates with 429s otherwise).
      return this.cache.memoize(`coingecko:regime:${chain}`, 30 * 60_000, produce);
    }
    return produce();
  }

  private async fetchJson<T>(path: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetcher(`${this.baseUrl}${path}`, {
          method: 'GET',
          headers: {
            // CoinGecko's edge blocks bare/cloud default User-Agents with HTTP
            // 403 (observed in production); a descriptive UA is required for
            // the free public API.
            'User-Agent': 'soren/0.1 (+https://github.com/psyneex/soren)',
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          throw new Error(`CoinGecko HTTP ${response.status} for ${path.split('?')[0]}`);
        }
        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt < this.maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
