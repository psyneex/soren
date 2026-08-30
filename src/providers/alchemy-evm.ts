import { getChainDefinition, type SupportedChain } from '../chains/registry.js';
import type { TtlCache } from './cache.js';
import type { JsonRpcClient } from './json-rpc.js';
import type { AlchemyPricesClient, HistoricalPricePoint } from './prices.js';
import type {
  MarketDataModel,
  TokenAgeModel,
  TokenEnrichment,
  TokenMetadataModel,
  TokenSupplyModel,
  TransferModel,
  WalletActivityModel,
  WalletBalanceModel,
} from './provider.js';

const WINDOW_HOURS = 24;
const RECENT_TRANSFER_LIMIT = 25;
const WALLET_TRANSFER_LIMIT = 25;

const UNKNOWN_MARKET: MarketDataModel = {
  priceUsd: null,
  marketCapUsd: null,
  fdvUsd: null,
  volume24hUsd: null,
  priceChange24hPct: null,
  liquidityUsd: null,
  provider: null,
  sourceRef: null,
  available: false,
  notes: [],
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortWallet(wallet: string): string {
  return wallet.length > 10 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

function fromHexBigInt(hex: string): bigint {
  return BigInt(hex);
}

function isoFromBlockTimestampSeconds(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return new Date(value * 1000).toISOString();
}

async function blockTimestamp(
  rpc: JsonRpcClient,
  cache: TtlCache,
  chain: SupportedChain,
  blockHex: string,
): Promise<string | null> {
  const key = `evm:${chain}:block-time:${blockHex}`;
  return cache.memoize(key, 60 * 60_000, async () => {
    const block = (await rpc.call(chain, 'eth_getBlockByNumber', [blockHex, false])) as { timestamp?: string } | null;
    const seconds = block?.timestamp ? Number(fromHexBigInt(block.timestamp)) : null;
    return isoFromBlockTimestampSeconds(seconds);
  });
}

async function mapTransfers(
  rpc: JsonRpcClient,
  cache: TtlCache,
  chain: SupportedChain,
  transfers: Array<{
    hash?: string;
    from?: string;
    to?: string;
    value?: number;
    asset?: string;
    blockNum?: string;
    category?: string;
  }>,
): Promise<TransferModel[]> {
  if (!Array.isArray(transfers) || transfers.length === 0) return [];

  // Timestamp lookups are bounded: at most 5 distinct blocks are resolved.
  const uniqueBlocks = [...new Set(transfers.map((t) => t.blockNum).filter(Boolean))];
  const times = new Map<string, string | null>();
  for (const block of uniqueBlocks.slice(0, 5)) {
    times.set(block!, await blockTimestamp(rpc, cache, chain, block!));
  }

  return transfers.slice(0, 20).map((t) => ({
    hash: t.hash ?? null,
    from: t.from ?? null,
    to: t.to ?? null,
    amount: typeof t.value === 'number' ? t.value : null,
    asset: t.asset ?? null,
    block: t.blockNum ? Number(fromHexBigInt(t.blockNum)) : null,
    timestamp: t.blockNum ? (times.get(t.blockNum) ?? null) : null,
    category: t.category === 'erc20' ? 'erc20' : 'unknown',
  }));
}

async function fetchEvmMarket(
  prices: AlchemyPricesClient,
  network: string,
  tokenAddress: string,
  supply: TokenSupplyModel,
  now: Date,
): Promise<MarketDataModel> {
  let price: number | null = null;
  let points: HistoricalPricePoint[] = [];

  try {
    const priceMap = await prices.getPricesByAddress(network, [tokenAddress]);
    price = priceMap.get(tokenAddress) ?? null;
  } catch {
    // Price by-address failed; historical may still provide market data.
  }

  try {
    points = await prices.getHistorical(network, tokenAddress, {
      startTime: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
      endTime: now.toISOString(),
      interval: '1d',
      withMarketData: true,
    });
  } catch {
    // Historical feed unavailable; proceed with what we have.
  }

  if (price == null && points.length === 0) {
    return {
      ...UNKNOWN_MARKET,
      notes: ['No price or market data returned by the Alchemy Prices API for this token.'],
    };
  }

  // Fall back to the latest historical close for the current price.
  if (price == null && points.length > 0) {
    price = points[points.length - 1].value;
  }

  let marketCapUsd: number | null = null;
  let volume24hUsd: number | null = null;
  let priceChange24hPct: number | null = null;

  if (points.length >= 2) {
    const latest = points[points.length - 1];
    const previous = points[points.length - 2];
    marketCapUsd = latest.marketCapUsd;
    volume24hUsd = previous.totalVolumeUsd;
    if (previous.value != null && latest.value != null && previous.value !== 0) {
      priceChange24hPct = ((latest.value - previous.value) / previous.value) * 100;
    }
  } else if (points.length === 1) {
    marketCapUsd = points[0].marketCapUsd;
    volume24hUsd = points[0].totalVolumeUsd;
  }

  const fdvUsd = price != null && supply.totalSupply != null ? price * supply.totalSupply : null;

  return {
    priceUsd: price,
    marketCapUsd,
    fdvUsd,
    volume24hUsd,
    priceChange24hPct,
    liquidityUsd: null,
    provider: 'alchemy',
    sourceRef: null,
    available: true,
    notes: ['Price change is approximated from the two most recent daily closes.'],
  };
}

async function estimateWindowStartBlock(
  rpc: JsonRpcClient,
  cache: TtlCache,
  chain: SupportedChain,
  avgBlockSeconds: number,
): Promise<number> {
  const latestHex = (await cache.memoize(`evm:${chain}:latest-block`, 60_000, () =>
    rpc.call(chain, 'eth_blockNumber', []))) as string;
  const latest = Number(fromHexBigInt(latestHex));
  const offset = Math.floor((WINDOW_HOURS * 3600) / avgBlockSeconds);
  return Math.max(0, latest - offset);
}

async function fetchEvmWalletActivity(
  rpc: JsonRpcClient,
  cache: TtlCache,
  chain: SupportedChain,
  tokenAddress: string,
  wallet: string,
  startBlock: number,
): Promise<WalletActivityModel> {
  const baseParams = {
    fromBlock: `0x${startBlock.toString(16)}`,
    toBlock: 'latest',
    contractAddresses: [tokenAddress],
    category: ['erc20'],
    order: 'desc',
    maxCount: WALLET_TRANSFER_LIMIT,
    withMetadata: false,
  };

  const incomingResult = (await cache.memoize(
    `evm:${chain}:flow-in:${tokenAddress}:${wallet}:${startBlock}`,
    2 * 60_000,
    () => rpc.call(chain, 'alchemy_getAssetTransfers', [{ ...baseParams, toAddress: wallet }]),
  )) as { transfers: Array<{ value?: number }> };

  const outgoingResult = (await cache.memoize(
    `evm:${chain}:flow-out:${tokenAddress}:${wallet}:${startBlock}`,
    2 * 60_000,
    () => rpc.call(chain, 'alchemy_getAssetTransfers', [{ ...baseParams, fromAddress: wallet }]),
  )) as { transfers: Array<{ value?: number }> };

  let incoming = 0;
  let outgoing = 0;
  let transferCount = 0;
  for (const transfer of incomingResult.transfers ?? []) {
    if (typeof transfer.value === 'number') incoming += transfer.value;
    transferCount += 1;
  }
  for (const transfer of outgoingResult.transfers ?? []) {
    if (typeof transfer.value === 'number') outgoing += transfer.value;
    transferCount += 1;
  }

  const note = `Approximated over an estimated ${WINDOW_HOURS}h block window (up to ${WALLET_TRANSFER_LIMIT} transfers per direction).`;

  if (transferCount === 0) {
    return {
      wallet,
      window: { value: WINDOW_HOURS, unit: 'hours' },
      incomingTokenAmount: null,
      outgoingTokenAmount: null,
      netTokenFlow: null,
      transferCount: 0,
      firstSeenAt: null,
      sampleLimitNote: note,
    };
  }

  return {
    wallet,
    window: { value: WINDOW_HOURS, unit: 'hours' },
    incomingTokenAmount: incoming,
    outgoingTokenAmount: outgoing,
    netTokenFlow: incoming - outgoing,
    transferCount,
    firstSeenAt: null,
    sampleLimitNote: note,
  };
}

export async function enrichEvmToken(
  rpc: JsonRpcClient,
  prices: AlchemyPricesClient,
  cache: TtlCache,
  chain: SupportedChain,
  tokenAddress: string,
  wallets: string[],
  now: Date,
): Promise<TokenEnrichment> {
  const definition = getChainDefinition(chain);
  const observedAt = now.toISOString();
  const notes: string[] = [];
  const memo = <T>(key: string, ttlMs: number, producer: () => Promise<T>) =>
    cache.memoize(`evm:${chain}:${key}`, ttlMs, producer);

  // --- token metadata ---
  let metadata: TokenMetadataModel = { name: null, symbol: null, decimals: null, logo: null };
  try {
    const md = (await memo(`metadata:${tokenAddress}`, 15 * 60_000, () =>
      rpc.call(chain, 'alchemy_getTokenMetadata', [tokenAddress]))) as {
      name?: string;
      symbol?: string;
      decimals?: number;
      logo?: string;
    };
    metadata = {
      name: typeof md.name === 'string' && md.name ? md.name : null,
      symbol: typeof md.symbol === 'string' && md.symbol ? md.symbol : null,
      decimals: typeof md.decimals === 'number' ? md.decimals : null,
      logo: typeof md.logo === 'string' && md.logo ? md.logo : null,
    };
  } catch (error) {
    notes.push(`Token metadata unavailable: ${errorMessage(error)}`);
  }

  // --- total supply ---
  let supply: TokenSupplyModel = { totalSupply: null, totalSupplyRaw: null, decimals: metadata.decimals };
  try {
    const hex = (await memo(`supply:${tokenAddress}`, 15 * 60_000, () =>
      rpc.call(chain, 'eth_call', [{ to: tokenAddress, data: '0x18160ddd' }, 'latest']))) as string;
    const raw = fromHexBigInt(hex);
    supply = {
      totalSupplyRaw: raw.toString(),
      totalSupply: metadata.decimals != null ? Number(raw) / 10 ** metadata.decimals : null,
      decimals: metadata.decimals,
    };
  } catch (error) {
    notes.push(`Total supply unavailable: ${errorMessage(error)}`);
  }

  // --- market data (Prices API) ---
  let market: MarketDataModel;
  if (definition.supportsHistoricalPrices) {
    market = await fetchEvmMarket(prices, definition.pricesNetwork, tokenAddress, supply, now);
  } else {
    market = { ...UNKNOWN_MARKET, notes: ['Historical price feed is not supported on this chain.'] };
  }

  // --- token age from the earliest ERC-20 transfer ---
  let age: TokenAgeModel = { createdAt: null, ageDays: null, method: null };
  try {
    const earliest = (await memo(`earliest-transfer:${tokenAddress}`, 60 * 60_000, () =>
      rpc.call(chain, 'alchemy_getAssetTransfers', [{
        fromBlock: '0x0',
        toBlock: 'latest',
        contractAddresses: [tokenAddress],
        category: ['erc20'],
        order: 'asc',
        maxCount: 1,
        withMetadata: false,
      }]))) as { transfers?: Array<{ blockNum?: string }> };

    const block = earliest?.transfers?.[0]?.blockNum;
    if (block) {
      const timestamp = await blockTimestamp(rpc, cache, chain, block);
      if (timestamp) {
        const createdMs = new Date(timestamp).getTime();
        age = {
          createdAt: timestamp,
          ageDays: Math.max(0, (now.getTime() - createdMs) / 86_400_000),
          method: 'earliest_transfer',
        };
      }
    }
  } catch (error) {
    notes.push(`Token age unavailable: ${errorMessage(error)}`);
  }

  // --- token-wide recent transfers ---
  let recentTransfers: TransferModel[] = [];
  try {
    const res = (await memo(`recent-transfers:${tokenAddress}`, 2 * 60_000, () =>
      rpc.call(chain, 'alchemy_getAssetTransfers', [{
        fromBlock: '0x0',
        toBlock: 'latest',
        contractAddresses: [tokenAddress],
        category: ['erc20'],
        order: 'desc',
        maxCount: RECENT_TRANSFER_LIMIT,
        withMetadata: false,
      }]))) as { transfers: Array<{
        hash?: string;
        from?: string;
        to?: string;
        value?: number;
        asset?: string;
        blockNum?: string;
        category?: string;
      }> };
    recentTransfers = await mapTransfers(rpc, cache, chain, res.transfers ?? []);
  } catch (error) {
    notes.push(`Recent transfers unavailable: ${errorMessage(error)}`);
  }

  // --- smart-money wallet balances ---
  const walletBalances: WalletBalanceModel[] = [];
  for (const wallet of wallets) {
    try {
      const res = (await memo(`balance:${tokenAddress}:${wallet}`, 2 * 60_000, () =>
        rpc.call(chain, 'alchemy_getTokenBalances', [wallet, [tokenAddress]]))) as {
        tokenBalances?: Array<{ tokenBalance?: string }>;
      };
      const raw = res?.tokenBalances?.[0]?.tokenBalance ?? null;
      walletBalances.push({
        wallet,
        rawBalance: raw ?? null,
        balance:
          raw && metadata.decimals != null
            ? Number(fromHexBigInt(raw)) / 10 ** metadata.decimals
            : null,
      });
    } catch (error) {
      notes.push(`Balance for ${shortWallet(wallet)} unavailable: ${errorMessage(error)}`);
      walletBalances.push({ wallet, balance: null, rawBalance: null });
    }
  }

  // --- smart-money wallet activity (24h net flow) ---
  const walletActivity: WalletActivityModel[] = [];
  if (definition.avgBlockSeconds != null) {
    try {
      const startBlock = await estimateWindowStartBlock(rpc, cache, chain, definition.avgBlockSeconds);
      for (const wallet of wallets) {
        try {
          walletActivity.push(
            await fetchEvmWalletActivity(rpc, cache, chain, tokenAddress, wallet, startBlock),
          );
        } catch (error) {
          notes.push(`Activity for ${shortWallet(wallet)} unavailable: ${errorMessage(error)}`);
          walletActivity.push({
            wallet,
            window: { value: WINDOW_HOURS, unit: 'hours' },
            incomingTokenAmount: null,
            outgoingTokenAmount: null,
            netTokenFlow: null,
            transferCount: 0,
            firstSeenAt: null,
            sampleLimitNote: null,
          });
        }
      }
    } catch (error) {
      notes.push(`Wallet activity window unavailable: ${errorMessage(error)}`);
    }
  }

  return {
    provider: 'alchemy',
    chain,
    tokenAddress,
    source: 'ONCHAIN_RPC',
    observedAt,
    metadata,
    supply,
    market,
    age,
    recentTransfers,
    walletBalances,
    walletActivity,
    walletFlow30d: [],
    holders: {
      holderCount: null,
      top100ConcentrationPercent: null,
      accountsScanned: 0,
      censusComplete: false,
      provider: null,
      observedAt,
      notes: ['Holder census is not available for EVM chains; no holder enumeration API exists.'],
    },
    notes,
  };
}