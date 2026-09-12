import { describe, expect, it, vi } from 'vitest';
import { MarketReferenceClient } from '../src/providers/market-reference.js';

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function ticker24h(symbol: string, changePercent: string, lastPrice = '100') {
  return { symbol, priceChangePercent: changePercent, lastPrice };
}

function klines() {
  return [
    [1700000000000, '90', '100', '85', '95', '1000', 1700086400000, 0, 0, 0, 0, 0],
    [1700086400000, '95', '105', '90', '98', '1100', 1700172800000, 0, 0, 0, 0, 0],
    [1700172800000, '98', '110', '95', '102', '1200', 1700259200000, 0, 0, 0, 0, 0],
    [1700259200000, '102', '115', '98', '105', '1300', 1700345600000, 0, 0, 0, 0, 0],
    [1700345600000, '105', '120', '100', '108', '1400', 1700432000000, 0, 0, 0, 0, 0],
    [1700432000000, '108', '125', '103', '110', '1500', 1700518400000, 0, 0, 0, 0, 0],
    [1700518400000, '110', '130', '105', '115', '1600', 1700604800000, 0, 0, 0, 0, 0],
    [1700604800000, '115', '135', '110', '100', '1700', 1700691200000, 0, 0, 0, 0, 0],
  ];
}

describe('MarketReferenceClient.fetchRegime', () => {
  it('parses BTC and chain-native 24h changes from Binance tickers (benchmark = native)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(ticker24h('BTCUSDT', '1.5')))
      .mockResolvedValueOnce(json(ticker24h('SOLUSDT', '2.4')))
      .mockResolvedValueOnce(json(klines()));

    const client = new MarketReferenceClient({ fetch: fetchMock });
    const regime = await client.fetchRegime('solana');

    expect(regime.available).toBe(true);
    expect(regime.provider).toBe('market-reference');
    expect(regime.btcChange24hPct).toBe(1.5);
    expect(regime.nativeChange24hPct).toBe(2.4);
    expect(regime.benchmarkChange24hPct).toBe(2.4);
    expect(regime.benchmarkId).toBe('SOLUSDT');
    expect(regime.btcChange7dPct).not.toBeNull();
    expect(regime.totalMarketCapChange24hPct).toBeNull();
    expect(regime.notes[0]).toContain('Binance');
    expect(regime.notes[0]).toContain('SOLUSDT');
  });

  it('sends a descriptive User-Agent', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(ticker24h('BTCUSDT', '1')))
      .mockResolvedValueOnce(json(ticker24h('SOLUSDT', '2')))
      .mockResolvedValueOnce(json(klines()));

    const client = new MarketReferenceClient({ fetch: fetchMock });
    await client.fetchRegime('solana');

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('api.binance.com'),
      expect.objectContaining({
        headers: expect.objectContaining({
          'User-Agent': 'soren/0.1 (+https://github.com/psyneex/soren)',
        }),
      }),
    );
  });

  it('retries on transient 503 and succeeds', async () => {
    // First call fails with 503; subsequent calls succeed with fresh Response objects
    // (a Response body can only be read once).
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('service unavailable', { status: 503 }))
      .mockImplementation(() => Promise.resolve(json(ticker24h('BTCUSDT', '1'))));

    const client = new MarketReferenceClient({ fetch: fetchMock, maxAttempts: 2 });
    const regime = await client.fetchRegime('solana');

    expect(regime.available).toBe(true);
    expect(typeof regime.btcChange24hPct).toBe('number');
    expect(typeof regime.nativeChange24hPct).toBe('number');
    // At least 3 calls: 1 failed + 2 successful (BTC + native), plus optional klines.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('degrades to an unavailable observation (never fabricated) on persistent errors', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('bad gateway', { status: 502 }));

    const client = new MarketReferenceClient({ fetch: fetchMock, maxAttempts: 2 });
    const regime = await client.fetchRegime('solana');

    expect(regime.available).toBe(false);
    expect(regime.btcChange24hPct).toBeNull();
    expect(regime.nativeChange24hPct).toBeNull();
    expect(regime.benchmarkChange24hPct).toBeNull();
    expect(regime.notes[0]).toContain('Market reference unavailable');
    expect(regime.notes[0]).toContain('502');
    // Promise.all runs BTC + native concurrently; each retries maxAttempts times,
    // but Promise.all short-circuits on first rejection, so the exact count is
    // non-deterministic. Just verify it retried more than once.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(2);
  });

  it('returns unavailable for an unsupported chain', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = new MarketReferenceClient({ fetch: fetchMock });
    const regime = await client.fetchRegime('unsupported-chain');

    expect(regime.available).toBe(false);
    expect(regime.notes[0]).toContain('No benchmark asset configured');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('computes 7d change from klines when available', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(ticker24h('BTCUSDT', '1')))
      .mockResolvedValueOnce(json(ticker24h('SOLUSDT', '2')))
      .mockResolvedValueOnce(json(klines()));

    const client = new MarketReferenceClient({ fetch: fetchMock });
    const regime = await client.fetchRegime('solana');

    // oldest close = 95, latest close = 100 → ((100-95)/95)*100 ≈ 5.263%
    expect(regime.btcChange7dPct).toBeCloseTo(5.263, 1);
  });

  it('still succeeds when 7d klines fail (optional data)', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(ticker24h('BTCUSDT', '1')))
      .mockResolvedValueOnce(json(ticker24h('SOLUSDT', '2')))
      .mockResolvedValueOnce(new Response('error', { status: 500 }));

    const client = new MarketReferenceClient({ fetch: fetchMock });
    const regime = await client.fetchRegime('solana');

    expect(regime.available).toBe(true);
    expect(regime.btcChange24hPct).toBe(1);
    expect(regime.btcChange7dPct).toBeNull();
  });
});
