/**
 * DexScreener client — Solana market/liquidity data (free, keyless).
 *
 * Verified live: `GET /latest/dex/tokens/{address}` returns per-pair records
 * on Solana with priceUsd, marketCap, fdv, liquidity.usd, volume.h24,
 * priceChange.h24 and pairCreatedAt (no API key, ~300 req/min limit).
 *
 * Pairs where the token sits on the quote side are excluded, otherwise the
 * reported price is the quote asset's (e.g. USDC pools showing "price 2.74").
 */
import type { MarketDataModel } from './provider.js';
import type { TtlCacheLike } from './cache.js';

export interface DexScreenerClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  maxAttempts?: number;
  /** Optional TTL cache so repeated reads within a cycle reuse one request. */
  cache?: TtlCacheLike;
}

interface DexPair {
  chainId?: string;
  dexId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  quoteToken?: { symbol?: string };
  priceUsd?: string;
  marketCap?: number;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number; h6?: number; h1?: number };
  priceChange?: { h24?: number; h6?: number; h1?: number };
  /** Taker transaction counts exposed by DexScreener (free, same endpoint). */
  txns?: {
    h24?: { buys?: number; sells?: number };
    h6?: { buys?: number; sells?: number };
    h1?: { buys?: number; sells?: number };
  };
  pairCreatedAt?: number;
}

/** Additional per-pair aggregates used by the volume-confirmation feature. */
export interface DexMarketExtras {
  volume6hUsd: number | null;
  volume1hUsd: number | null;
  buys24h: number | null;
  sells24h: number | null;
  buys6h: number | null;
  sells6h: number | null;
}

const NO_EXTRAS: DexMarketExtras = {
  volume6hUsd: null,
  volume1hUsd: null,
  buys24h: null,
  sells24h: null,
  buys6h: null,
  sells6h: null,
};

const EMPTY_MARKET: Omit<MarketDataModel, 'fdvUsd'> = {
  priceUsd: null,
  marketCapUsd: null,
  volume24hUsd: null,
  priceChange24hPct: null,
  liquidityUsd: null,
  provider: null,
  sourceRef: null,
  available: false,
  notes: [],
};

export class DexScreenerClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly cache: TtlCacheLike | null;

  constructor(private readonly options: DexScreenerClientOptions = {}) {
    const fallback = globalThis.fetch;
    this.fetcher = options.fetch ?? fallback.bind(globalThis);
    this.cache = options.cache ?? null;
  }

  async fetchTokenPairs(tokenAddress: string): Promise<DexPair[]> {
    const produce = async (): Promise<DexPair[]> => {
      const base = this.options.baseUrl ?? 'https://api.dexscreener.com';
      const url = `${base}/latest/dex/tokens/${encodeURIComponent(tokenAddress)}`;
      const maxAttempts = this.options.maxAttempts ?? 3;
      let lastError: unknown;

      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const response = await this.fetcher(url, { method: 'GET' });
          if (response.status === 429 || response.status >= 500) {
            throw new Error(`DexScreener HTTP ${response.status}`);
          }
          if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
          const body = (await response.json().catch(() => null)) as { pairs?: DexPair[] | null } | null;
          return body?.pairs ?? [];
        } catch (error) {
          lastError = error;
          if (attempt < maxAttempts - 1) {
            await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          }
        }
      }
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    };

    if (this.cache) {
      return this.cache.memoize(`dexscreener:pairs:${tokenAddress}`, 2 * 60_000, produce);
    }
    return produce();
  }

  /**
   * Aggregates a token's market data from its base-side DEX pairs. The most
   * liquid pair supplies price/marketCap/fdv/priceChange; liquidity and 24h
   * volume are summed across all distinct base-side pairs. Also returns the
   * earliest pair creation timestamp (ms) as a token-age anchor.
   */
  async fetchTokenMarketDetail(
    tokenAddress: string,
    chainId = 'solana',
    derivedFdvUsd: number | null = null,
  ): Promise<{ market: MarketDataModel; earliestPairCreatedAt: number | null; extras: DexMarketExtras }> {
    let pairs: DexPair[];
    try {
      pairs = await this.fetchTokenPairs(tokenAddress);
    } catch (error) {
      return {
        market: {
          ...EMPTY_MARKET,
          fdvUsd: null,
          notes: [`DexScreener unavailable: ${error instanceof Error ? error.message : String(error)}`],
        },
        earliestPairCreatedAt: null,
        extras: { ...NO_EXTRAS },
      };
    }

    const basePairs = pairs.filter(
      (p) => (p.chainId ?? chainId) === chainId && p.baseToken?.address === tokenAddress,
    );
    if (basePairs.length === 0) {
      return {
        market: {
          ...EMPTY_MARKET,
          fdvUsd: null,
          notes: ['No DexScreener pairs found with this token as the base asset.'],
        },
        earliestPairCreatedAt: null,
        extras: { ...NO_EXTRAS },
      };
    }

    const byLiquidity = [...basePairs].sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    );
    const primary = byLiquidity[0];

    const priceUsd = primary.priceUsd != null ? Number(primary.priceUsd) : null;
    const liquidityUsd = byLiquidity.reduce((sum, p) => sum + (p.liquidity?.usd ?? 0), 0);
    const volume24hUsd = byLiquidity.reduce((sum, p) => sum + (p.volume?.h24 ?? 0), 0);

    const earliestPairCreatedAt =
      byLiquidity
        .map((p) => p.pairCreatedAt)
        .filter((t): t is number => typeof t === 'number')
        .sort((a, b) => a - b)[0] ?? null;

    // Aggregated transaction/volume extras; null when no pair reports the field.
    const sumOptional = (pick: (p: DexPair) => number | undefined): number | null => {
      const values = byLiquidity
        .map(pick)
        .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
      return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) : null;
    };
    const extras: DexMarketExtras = {
      volume6hUsd: sumOptional((p) => p.volume?.h6),
      volume1hUsd: sumOptional((p) => p.volume?.h1),
      buys24h: sumOptional((p) => p.txns?.h24?.buys),
      sells24h: sumOptional((p) => p.txns?.h24?.sells),
      buys6h: sumOptional((p) => p.txns?.h6?.buys),
      sells6h: sumOptional((p) => p.txns?.h6?.sells),
    };

    const market: MarketDataModel = {
      priceUsd: priceUsd != null && Number.isFinite(priceUsd) ? priceUsd : null,
      marketCapUsd: typeof primary.marketCap === 'number' ? primary.marketCap : null,
      fdvUsd: typeof primary.fdv === 'number' ? primary.fdv : derivedFdvUsd,
      volume24hUsd,
      priceChange24hPct: typeof primary.priceChange?.h24 === 'number' ? primary.priceChange.h24 : null,
      liquidityUsd,
      provider: 'dexscreener',
      sourceRef: primary.pairAddress ?? null,
      available: true,
      notes: [
        `Aggregated from ${byLiquidity.length} base-side pair(s) on ${chainId}; ` +
          'price/marketCap/fdv/24h-change from the most liquid pair.',
      ],
    };

    return { market, earliestPairCreatedAt, extras };
  }

  /** Market data only (see fetchTokenMarketDetail). */
  async fetchMarket(
    tokenAddress: string,
    chainId = 'solana',
    derivedFdvUsd: number | null = null,
  ): Promise<MarketDataModel> {
    const { market } = await this.fetchTokenMarketDetail(tokenAddress, chainId, derivedFdvUsd);
    return market;
  }
}
