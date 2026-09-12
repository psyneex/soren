import { describe, expect, it, vi } from 'vitest';
import { CoinGeckoClient } from '../src/providers/coingecko.js';

function marketsRows() {
  return [
    { id: 'bitcoin', price_change_percentage_24h: 1.2, price_change_percentage_7d_in_currency: 4.0 },
    { id: 'solana', price_change_percentage_24h: 2.4, price_change_percentage_7d_in_currency: -3.0 },
  ];
}

function globalRows() {
  return { data: { market_cap_change_percentage_24h_usd: 0.8 } };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('CoinGeckoClient.fetchRegime', () => {
  it('parses BTC, chain-native, and broad market references (benchmark = native)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(marketsRows()))
      .mockResolvedValueOnce(json(globalRows()));
    const client = new CoinGeckoClient({ fetch: fetchMock });
    const regime = await client.fetchRegime('solana');

    expect(regime.available).toBe(true);
    expect(regime.btcChange24hPct).toBe(1.2);
    expect(regime.btcChange7dPct).toBe(4.0);
    expect(regime.nativeChange24hPct).toBe(2.4);
    expect(regime.totalMarketCapChange24hPct).toBe(0.8);
    expect(regime.benchmarkChange24hPct).toBe(2.4);
    expect(regime.benchmarkId).toBe('solana');
    expect(regime.provider).toBe('coingecko');
  });

  it('sends a descriptive User-Agent (CoinGecko 403s bare cloud default UAs)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(marketsRows()))
      .mockResolvedValueOnce(json(globalRows()));
    const client = new CoinGeckoClient({ fetch: fetchMock });
    await client.fetchRegime('solana');

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect((init.headers as Record<string, string>)['User-Agent']).toContain('soren/');
    }
  });

  it('retries transient 429/5xx failures and succeeds on a later attempt', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(json(marketsRows()))
      .mockResolvedValueOnce(json(globalRows()));
    const client = new CoinGeckoClient({ fetch: fetchMock });
    const regime = await client.fetchRegime('solana');

    expect(regime.available).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 failed markets + retry + global
  });

  it('degrades to an unavailable observation (never fabricated) on persistent errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('forbidden', { status: 403 }));
    const client = new CoinGeckoClient({ fetch: fetchMock, maxAttempts: 2 });
    const regime = await client.fetchRegime('solana');

    expect(regime.available).toBe(false);
    expect(regime.btcChange24hPct).toBeNull();
    expect(regime.benchmarkChange24hPct).toBeNull();
    expect(regime.notes[0]).toContain('CoinGecko unavailable');
    expect(regime.notes[0]).toContain('403');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
