import { describe, expect, it, vi } from 'vitest';
import { DexScreenerClient } from '../src/providers/dexscreener.js';

const TOKEN = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function pairResponse(pairs: unknown[]) {
  return new Response(JSON.stringify({ schemaVersion: '1.0.0', pairs }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function basePair(overrides: Record<string, unknown>) {
  return {
    chainId: 'solana',
    dexId: 'raydium',
    pairAddress: 'pair-1',
    baseToken: { address: TOKEN, symbol: 'MOCK', name: 'Mock Token' },
    quoteToken: { symbol: 'SOL' },
    priceUsd: '1.5',
    marketCap: 1000,
    fdv: 2000,
    liquidity: { usd: 1000 },
    volume: { h24: 500, h6: 200, h1: 50 },
    priceChange: { h24: -5, h6: 1, h1: 0 },
    pairCreatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('DexScreenerClient.fetchTokenMarketDetail', () => {
  it('aggregates base-side pairs only and ignores quote-side pairs', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      pairResponse([
        basePair({ pairAddress: 'main', liquidity: { usd: 1000 } }),
        basePair({ pairAddress: 'secondary', liquidity: { usd: 500 }, volume: { h24: 250 }, priceUsd: '9.9', marketCap: 1, fdv: 1, pairCreatedAt: 1_650_000_000_000 }),
        // Token sits on the quote side here: price 2.74-style trap — must be excluded.
        basePair({
          pairAddress: 'quote-side',
          baseToken: { address: 'So11111111111111111111111111111111111111112', symbol: 'SOL' },
          quoteToken: { symbol: 'MOCK' },
          priceUsd: '2.74',
          liquidity: { usd: 99_999 },
          volume: { h24: 42_000 },
        }),
      ]),
    );
    const client = new DexScreenerClient({ fetch: fetchMock });
    const { market, earliestPairCreatedAt } = await client.fetchTokenMarketDetail(TOKEN);

    expect(market.available).toBe(true);
    expect(market.provider).toBe('dexscreener');
    expect(market.priceUsd).toBe(1.5); // from the most liquid base-side pair
    expect(market.marketCapUsd).toBe(1000);
    expect(market.fdvUsd).toBe(2000);
    expect(market.priceChange24hPct).toBe(-5);
    expect(market.liquidityUsd).toBe(1500); // 1000 + 500, quote-side 99999 excluded
    expect(market.volume24hUsd).toBe(750); // 500 + 250
    expect(market.sourceRef).toBe('main');
    expect(earliestPairCreatedAt).toBe(1_650_000_000_000);
  });

  it('reports an unavailable market when the token is never the base asset', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      pairResponse([basePair({ baseToken: { address: 'other-mint', symbol: 'OTHER' } })]),
    );
    const client = new DexScreenerClient({ fetch: fetchMock });
    const { market, earliestPairCreatedAt } = await client.fetchTokenMarketDetail(TOKEN);

    expect(market.available).toBe(false);
    expect(market.priceUsd).toBeNull();
    expect(market.liquidityUsd).toBeNull();
    expect(market.notes[0]).toContain('base asset');
    expect(earliestPairCreatedAt).toBeNull();
  });

  it('degrades to an unavailable market on persistent provider errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('boom', { status: 500 }));
    const client = new DexScreenerClient({ fetch: fetchMock, maxAttempts: 2 });
    const { market } = await client.fetchTokenMarketDetail(TOKEN);

    expect(market.available).toBe(false);
    expect(market.notes[0]).toContain('DexScreener unavailable');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fetchMarket returns just the market model', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(pairResponse([basePair({})]));
    const client = new DexScreenerClient({ fetch: fetchMock });
    const market = await client.fetchMarket(TOKEN);
    expect(market.available).toBe(true);
    expect(market.priceUsd).toBe(1.5);
  });
});
