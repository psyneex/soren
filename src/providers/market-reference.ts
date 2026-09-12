/**
 * Market reference client — keyless, free exchange public APIs for regime data.
 *
 * Primary: Binance public API (no key, no monthly limit, no rate-limit concern
 * for our usage level — a few requests per hour per chain).
 *
 * Provides BTC and chain-native 24h price changes for the market regime
 * feature. Degrades to an unavailable observation with notes on failure —
 * never fabricated values.
 */
import type { RegimeObservation } from '../domain/types.js';

import type { TtlCacheLike } from './cache.js';

/** Chain → Binance symbol of the benchmark (native) asset. */
export const CHAIN_NATIVE_BINANCE_SYMBOL: Record<string, string> = {
  solana: 'SOLUSDT',
  ethereum: 'ETHUSDT',
  polygon: 'MATICUSDT',
  arbitrum: 'ETHUSDT',
  base: 'ETHUSDT',
  bsc: 'BNBUSDT',
};

export interface MarketReferenceClientOptions {
  fetch?: typeof globalThis.fetch;
  cache?: TtlCacheLike;
  now?: () => Date;
  /** Bounded retry attempts for transient failures (429 / 5xx / network). */
  maxAttempts?: number;
}

interface BinanceTicker24h {
  symbol?: string;
  priceChangePercent?: string;
  lastPrice?: string;
}

/** Binance kline: [openTime, open, high, low, close, volume, closeTime, ...] */
type BinanceKline = [number, string, string, string, string, string, number, ...number[]];

export class MarketReferenceClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly cache: TtlCacheLike | null;
  private readonly now: () => Date;
  private readonly maxAttempts: number;

  constructor(options: MarketReferenceClientOptions = {}) {
    const fallback = globalThis.fetch;
    this.fetcher = options.fetch ?? fallback.bind(globalThis);
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
      provider: 'market-reference',
      observedAt,
      notes,
    });

    const nativeSymbol = CHAIN_NATIVE_BINANCE_SYMBOL[chain] ?? null;
    if (!nativeSymbol) {
      return empty([`No benchmark asset configured for chain "${chain}".`]);
    }

    const produce = async (): Promise<RegimeObservation> => {
      try {
        const [btcTicker, nativeTicker] = await Promise.all([
          this.fetchJson<BinanceTicker24h>('/api/v3/ticker/24hr?symbol=BTCUSDT'),
          this.fetchJson<BinanceTicker24h>(`/api/v3/ticker/24hr?symbol=${nativeSymbol}`),
        ]);

        const btc24 = btcTicker?.priceChangePercent != null ? parseFloat(btcTicker.priceChangePercent) : null;
        const native24 =
          nativeTicker?.priceChangePercent != null ? parseFloat(nativeTicker.priceChangePercent) : null;

        // 7d change from klines (optional — used for the volatility penalty).
        let btc7d: number | null = null;
        try {
          const klines = await this.fetchJson<BinanceKline[]>(
            '/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=8',
          );
          if (klines && klines.length >= 2) {
            const oldestClose = parseFloat(klines[0][4]);
            const latestClose = parseFloat(klines[klines.length - 1][4]);
            if (oldestClose > 0) {
              btc7d = ((latestClose - oldestClose) / oldestClose) * 100;
            }
          }
        } catch {
          // 7d change is optional; don't fail the regime if unavailable.
        }

        const available = btc24 != null || native24 != null;
        return {
          available,
          btcChange24hPct: btc24,
          btcChange7dPct: btc7d,
          nativeChange24hPct: native24,
          totalMarketCapChange24hPct: null, // Not available from exchanges; regime renormalizes over available parts.
          benchmarkChange24hPct: native24,
          benchmarkId: nativeSymbol,
          provider: 'market-reference',
          observedAt,
          notes: [
            `Benchmark for ${chain}: ${nativeSymbol} (Binance).`,
            ...(available ? [] : ['Binance returned no usable regime data.']),
          ],
        };
      } catch (error) {
        return empty([`Market reference unavailable: ${error instanceof Error ? error.message : String(error)}`]);
      }
    };

    if (this.cache) {
      // 30-minute window: regime inputs are 24h-scale changes; wider caching
      // trades negligible staleness for far fewer API hits.
      return this.cache.memoize(`market-reference:regime:${chain}`, 30 * 60_000, produce);
    }
    return produce();
  }

  private async fetchJson<T>(path: string): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      try {
        const response = await this.fetcher(`https://api.binance.com${path}`, {
          method: 'GET',
          headers: {
            'User-Agent': 'soren/0.1 (+https://github.com/psyneex/soren)',
            Accept: 'application/json',
          },
        });
        if (!response.ok) {
          throw new Error(`Binance HTTP ${response.status} for ${path.split('?')[0]}`);
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
