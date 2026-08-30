import { describe, expect, it, vi } from 'vitest';
import { AlchemyProvider } from '../src/providers/alchemy.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WALLET = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY';
const TOKEN = '0x1234567890123456789012345678901234567890';
const WALLET_EVM = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';

const NOW = new Date('2026-08-28T12:00:00Z');
const TEN_DAYS_AGO = Math.floor((NOW.getTime() - 10 * 86_400_000) / 1000);
const BLOCK_TS_HEX = '0x5f8da4d6';

const json = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
  status: 200,
  headers: { 'content-type': 'application/json' },
});

interface MockOptions {
  priceFound?: boolean;
}

function cannedFetch(options: MockOptions = {}) {
  const priceFound = options.priceFound ?? true;
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null;

    if (url.includes('/prices/v1/tokens/by-address')) {
      const addresses = (body?.addresses ?? []) as Array<{ network: string; address: string }>;
      return new Response(JSON.stringify({
        data: addresses.map((entry) => ({
          network: entry.network,
          address: entry.address,
          prices: priceFound ? [{ currency: 'usd', value: '1.0' }] : [],
          error: priceFound ? null : { message: 'Price not found' },
        })),
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/prices/v1/tokens/historical')) {
      if (!priceFound) return new Response(JSON.stringify({ error: { message: 'Unsupported network' } }), { status: 400 });
      return new Response(JSON.stringify({
        network: 'eth-mainnet',
        address: TOKEN,
        currency: 'usd',
        data: [
          { value: '0.5', timestamp: '2026-08-26T00:00:00Z', marketCap: '500000', totalVolume: '100000' },
          { value: '1.0', timestamp: '2026-08-27T00:00:00Z', marketCap: '1000000', totalVolume: '200000' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    const method = body?.method as string;
    const params: Array<unknown> | Record<string, unknown> = body?.params ?? [];
    const first = Array.isArray(params) ? String(params[0] ?? '') : '';

    switch (method) {
      case 'getAccountInfo':
        return json({ value: { data: { parsed: { info: { decimals: 6, supply: '1000000' } } } } });
      case 'getTokenSupply':
        return json({ value: { amount: '1000000', decimals: 6, uiAmount: 1 } });
      case 'getProgramAccounts':
        return json([]);
      case 'getSignaturesForAddress':
        return first === MINT
          ? json([{ signature: 'sig-age', blockTime: TEN_DAYS_AGO, err: null }])
          : json([]);
      case 'getTokenAccountsByOwner':
        return json({
          value: [{
            account: { data: { parsed: { info: { mint: MINT, owner: first, tokenAmount: { amount: '42000000', decimals: 6, uiAmount: 42 } } } } },
            pubkey: 'token-account-pk',
          }],
        });
      case 'alchemy_getTokenMetadata':
        return json({ name: 'Mock USD Coin', symbol: 'MOCK', decimals: 6, logo: 'https://example.com/logo.png' });
      case 'eth_call':
        return json('0x0000000000000000000000000000000000000000000000000000000000989680');
      case 'eth_blockNumber':
        return json('0x100');
      case 'eth_getBlockByNumber':
        return json({ timestamp: BLOCK_TS_HEX });
      case 'alchemy_getTokenBalances':
        return json({ address: first, tokenBalances: [{ contractAddress: TOKEN, tokenBalance: '0x0de0b6b3a7640000' }] });
      case 'alchemy_getAssetTransfers':
        return json({
          transfers: [{
            hash: '0xabc', from: '0x1', to: '0x2', value: 5, asset: 'MOCK',
            blockNum: '0x1', category: 'erc20',
          }],
        });
      default:
        throw new Error(`Unexpected RPC method in test mock: ${method}`);
    }
  });
}

describe('AlchemyProvider (normalized enrichment)', () => {
  it('supports solana + EVM chains and excludes optimism', () => {
    const provider = new AlchemyProvider({ apiKey: 'test-key', fetch: cannedFetch(), now: () => NOW });
    expect(provider.supportsChain('solana')).toBe(true);
    expect(provider.supportsChain('ethereum')).toBe(true);
    expect(provider.supportsChain('optimism')).toBe(false);
  });

  it('enriches a Solana mint into normalized models', async () => {
    // Simulate the real-world state: Alchemy's Prices API currently reports no
    // Solana token coverage, so the market feed degrades gracefully.
    const fetchMock = cannedFetch({ priceFound: false });
    const provider = new AlchemyProvider({ apiKey: 'test-key', fetch: fetchMock, now: () => NOW });
    const enrichment = await provider.enrichToken('solana', MINT, { smartMoneyWallets: [WALLET], now: NOW });

    expect(enrichment.chain).toBe('solana');
    expect(enrichment.source).toBe('ONCHAIN_RPC');
    expect(enrichment.metadata.decimals).toBe(6);
    expect(enrichment.supply.totalSupply).toBe(1);
    expect(enrichment.age.method).toBe('mint_signatures');
    expect(Math.round(enrichment.age.ageDays ?? 0)).toBe(10);
    expect(enrichment.market.available).toBe(false);
    expect(enrichment.walletBalances[0].balance).toBe(42);
    expect(enrichment.walletActivity[0].transferCount).toBe(0);
    expect(enrichment.recentTransfers).toHaveLength(0);
    expect(enrichment.notes.length).toBeGreaterThan(0);
  });
  it('enriches an EVM token including market data and transfers', async () => {
    const fetchMock = cannedFetch({ priceFound: true });
    const provider = new AlchemyProvider({ apiKey: 'test-key', fetch: fetchMock, now: () => NOW });
    const enrichment = await provider.enrichToken('base', TOKEN, { smartMoneyWallets: [WALLET_EVM], now: NOW });

    expect(enrichment.chain).toBe('base');
    expect(enrichment.metadata.symbol).toBe('MOCK');
    expect(enrichment.supply.totalSupply).toBe(10);
    expect(enrichment.market.priceUsd).toBe(1);
    expect(enrichment.market.marketCapUsd).toBe(1_000_000);
    expect(enrichment.market.fdvUsd).toBe(10);
    expect(enrichment.market.priceChange24hPct).toBe(100);
    expect(enrichment.age.method).toBe('earliest_transfer');
    expect(enrichment.age.createdAt).not.toBeNull();
    expect(enrichment.walletBalances[0].balance).toBe(1e12); // 1e18 raw / 1e6
    expect(enrichment.recentTransfers[0]).toMatchObject({ category: 'erc20', asset: 'MOCK' });
    expect(enrichment.walletActivity[0]).toMatchObject({
      incomingTokenAmount: 5,
      outgoingTokenAmount: 5,
      netTokenFlow: 0,
      transferCount: 2, // one sampled transfer in each direction
    });
  });
});
