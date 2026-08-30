import { getPricesNetwork, type SupportedChain } from '../chains/registry.js';
import { base64FromBase58 } from '../chains/base58.js';
import type { TtlCache } from './cache.js';
import type { JsonRpcClient, RpcParams } from './json-rpc.js';
import type { AlchemyPricesClient } from './prices.js';
import type { HeliusRpcClient } from './helius.js';
import type { DexScreenerClient } from './dexscreener.js';
import {
  FLOW_TX_DECODE_LIMIT,
  fetchHolderCensus,
  fetchSignaturesWithinWindow,
  summarizeHolderCensus,
  walletTokenDelta,
} from './helius.js';
import type {
  MarketDataModel,
  TokenAgeModel,
  TokenEnrichment,
  TokenHoldersModel,
  TokenMetadataModel,
  TokenSupplyModel,
  WalletActivityModel,
  WalletBalanceModel,
} from './provider.js';

const WINDOW_HOURS = 24;
const FLOW_WINDOW_DAYS = 30;
const TOKEN_ACCOUNT_SIG_LIMIT = 25;
const TX_SAMPLE_LIMIT = 5;
const AGE_PAGE_LIMIT = 1000;
const AGE_MAX_PAGES = 5;
const METAPLEX_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
/** Metaplex metadata layout: name length at offset 65, symbol length at offset 101. */
const METADATA_NAME_LEN_OFFSET = 65;
const METADATA_SYMBOL_LEN_OFFSET = 101;

/**
 * Structural caller shape shared by JsonRpcClient and HeliusRpcClient so
 * Solana helpers can use either provider without depending on a class.
 */
export type SolanaRpcCaller = {
  call(chain: SupportedChain, method: string, params: RpcParams): Promise<unknown>;
};

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
  return wallet.length > 14 ? `${wallet.slice(0, 8)}…${wallet.slice(-6)}` : wallet;
}

interface ParsedTokenAmount {
  amount?: string;
  decimals?: number;
  uiAmount?: number | null;
}

async function fetchMintMetadata(
  rpc: SolanaRpcCaller,
  cache: TtlCache,
  chain: SupportedChain,
  mint: string,
): Promise<TokenMetadataModel> {
  const parsed = (await cache.memoize(`sol:${chain}:mint-meta:${mint}`, 15 * 60_000, () =>
    rpc.call(chain, 'getAccountInfo', [mint, { encoding: 'jsonParsed' }]))) as {
    value?: { data?: { parsed?: { info?: { decimals?: number; supply?: string } } } };
  };
  const info = parsed?.value?.data?.parsed?.info;

  const metadata: TokenMetadataModel = {
    name: null,
    symbol: null,
    decimals: typeof info?.decimals === 'number' ? info.decimals : null,
    logo: null,
  };

  // Look up the on-chain Metaplex metadata account (memcmp on the mint at offset 33).
  try {
    const accounts = (await cache.memoize(`sol:${chain}:metadata:${mint}`, 60 * 60_000, () =>
      rpc.call(chain, 'getProgramAccounts', [METAPLEX_PROGRAM, {
        encoding: 'base64',
        filters: [{ memcmp: { offset: 33, bytes: base64FromBase58(mint) } }],
      }]))) as Array<{ account?: { data?: [string] } }>;

    const raw = accounts?.[0]?.account?.data?.[0];
    if (raw) {
      const buffer = Buffer.from(raw, 'base64');
      if (buffer.length >= METADATA_SYMBOL_LEN_OFFSET + 8) {
        const nameLength = buffer.readUInt32LE(METADATA_NAME_LEN_OFFSET);
        const name = buffer.toString('utf8', METADATA_NAME_LEN_OFFSET + 4, METADATA_NAME_LEN_OFFSET + 4 + nameLength);
        const symbolLength = buffer.readUInt32LE(METADATA_SYMBOL_LEN_OFFSET);
        const symbol = buffer.toString('utf8', METADATA_SYMBOL_LEN_OFFSET + 4, METADATA_SYMBOL_LEN_OFFSET + 4 + symbolLength);
        metadata.name = name || null;
        metadata.symbol = symbol || null;
      }
    }
  } catch {
    // Metadata fetch failed; mint metadata still provides decimals.
  }

  return metadata;
}

async function fetchTokenSupply(
  rpc: SolanaRpcCaller,
  cache: TtlCache,
  chain: SupportedChain,
  mint: string,
  decimals: number | null,
): Promise<TokenSupplyModel> {
  const result = (await cache.memoize(`sol:${chain}:supply:${mint}`, 15 * 60_000, () =>
    rpc.call(chain, 'getTokenSupply', [mint]))) as {
    value?: ParsedTokenAmount;
  };
  const value = result?.value;
  return {
    totalSupplyRaw: typeof value?.amount === 'string' ? value.amount : null,
    totalSupply: typeof value?.uiAmount === 'number' ? value.uiAmount : null,
    decimals: typeof value?.decimals === 'number' ? value.decimals : decimals,
  };
}

/**
 * Bounded earliest-signature search used as a token age anchor. The mint's
 * first signature is close to its creation time. For active tokens the search
 * is capped at a few pages and reported as approximate when capped.
 */
async function findEarliestMintSignatureTime(
  rpc: SolanaRpcCaller,
  cache: TtlCache,
  chain: SupportedChain,
  mint: string,
): Promise<{ blockTime: number; approximate: boolean } | null> {
  const key = `sol:${chain}:age:${mint}`;
  return cache.memoize(key, 60 * 60_000, async () => {
    let oldestBlockTime: number | null = null;
    let before: string | null = null;
    let pages = 0;
    let exhausted = false;

    while (pages < AGE_MAX_PAGES) {
      const sigs = (await rpc.call(chain, 'getSignaturesForAddress', [
        mint,
        { limit: AGE_PAGE_LIMIT, ...(before ? { before } : {}) },
      ])) as Array<{ signature?: string; blockTime?: number | null }>;

      if (!Array.isArray(sigs) || sigs.length === 0) {
        exhausted = true;
        break;
      }

      const times = sigs
        .map((s) => s.blockTime)
        .filter((t): t is number => typeof t === 'number');
      if (times.length > 0) {
        oldestBlockTime = Math.min(oldestBlockTime ?? Infinity, ...times);
      }

      if (sigs.length < AGE_PAGE_LIMIT) {
        exhausted = true;
        break;
      }
      before = sigs[sigs.length - 1].signature ?? null;
      if (!before) break;
      pages += 1;
    }

    if (oldestBlockTime == null) return null;
    return { blockTime: oldestBlockTime, approximate: !exhausted };
  });
}

async function fetchWalletTokenBalance(
  rpc: SolanaRpcCaller,
  cache: TtlCache,
  chain: SupportedChain,
  mint: string,
  wallet: string,
): Promise<WalletBalanceModel> {
  const result = (await cache.memoize(`sol:${chain}:balance:${mint}:${wallet}`, 2 * 60_000, () =>
    rpc.call(chain, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]))) as {
    value?: Array<{
      account?: { data?: { parsed?: { info?: { mint?: string; owner?: string; tokenAmount?: ParsedTokenAmount } } } };
    }>;
  };

  const accounts = result?.value ?? [];
  // No token account for this mint ⇒ the wallet owns exactly zero of the token
  // (an honest zero, not an unknown).
  if (accounts.length === 0) {
    return { wallet, rawBalance: '0', balance: 0 };
  }
  const holderAccount = accounts.find((a) => a.account?.data?.parsed?.info?.mint === mint);
  const info = holderAccount?.account?.data?.parsed?.info;

  return {
    wallet,
    rawBalance: typeof info?.tokenAmount?.amount === 'string' ? info.tokenAmount.amount : null,
    balance: typeof info?.tokenAmount?.uiAmount === 'number' ? info.tokenAmount.uiAmount : null,
  };
}

function tokenAmountDelta(
  pre: Array<{ accountIndex: number; mint?: string; owner?: string; uiTokenAmount?: ParsedTokenAmount }>,
  post: Array<{ accountIndex: number; uiTokenAmount?: ParsedTokenAmount }>,
  mint: string,
  wallet: string,
): number | null {
  let total = 0;
  let matched = false;
  for (const entry of pre) {
    if (entry.mint !== mint) continue;
    if (wallet && entry.owner !== wallet) continue;
    const postEntry = post.find((p) => p.accountIndex === entry.accountIndex);
    const before = entry.uiTokenAmount?.uiAmount ?? 0;
    const after = postEntry?.uiTokenAmount?.uiAmount ?? before;
    if (after == null) continue;
    total += after - before;
    matched = true;
  }
  return matched ? total : null;
}

async function fetchWalletActivity(
  rpc: SolanaRpcCaller,
  cache: TtlCache,
  chain: SupportedChain,
  mint: string,
  wallet: string,
  tokenAccount: string,
  now: Date,
): Promise<WalletActivityModel> {
  const signatures = (await cache.memoize(`sol:${chain}:act-sigs:${tokenAccount}`, 2 * 60_000, () =>
    rpc.call(chain, 'getSignaturesForAddress', [tokenAccount, { limit: TOKEN_ACCOUNT_SIG_LIMIT }]))) as Array<{
    signature?: string;
    blockTime?: number | null;
  }>;

  const sigs = signatures ?? [];
  const cutoffSeconds = now.getTime() / 1000 - WINDOW_HOURS * 3600;
  const inWindow = sigs.filter((s) => typeof s.blockTime === 'number' && (s.blockTime as number) >= cutoffSeconds);

  // No token-account transactions in the window ⇒ the 24h net flow is exactly zero.
  if (inWindow.length === 0) {
    return {
      wallet,
      window: { value: WINDOW_HOURS, unit: 'hours' },
      incomingTokenAmount: 0,
      outgoingTokenAmount: 0,
      netTokenFlow: 0,
      transferCount: 0,
      firstSeenAt: null,
      sampleLimitNote: `No token-account transactions for this mint in the last ${WINDOW_HOURS}h; net flow is exactly zero.`,
    };
  }

  let incoming = 0;
  let outgoing = 0;
  let transferCount = 0;
  let net = 0;

  const sampled = inWindow.slice(0, TX_SAMPLE_LIMIT);
  for (const sig of sampled) {
    if (!sig.signature) continue;
    const tx = (await cache.memoize(`sol:${chain}:tx:${sig.signature}`, 60 * 60_000, () =>
      rpc.call(chain, 'getTransaction', [sig.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]))) as {
      meta?: {
        preTokenBalances?: Array<{ accountIndex: number; mint?: string; owner?: string; uiTokenAmount?: ParsedTokenAmount }>;
        postTokenBalances?: Array<{ accountIndex: number; uiTokenAmount?: ParsedTokenAmount }>;
      };
    };
    const delta = tokenAmountDelta(tx?.meta?.preTokenBalances ?? [], tx?.meta?.postTokenBalances ?? [], mint, wallet);
    if (delta != null && delta !== 0) {
      net += delta;
      if (delta > 0) incoming += delta;
      else outgoing += -delta;
      transferCount += 1;
    }
  }

  const blockTimes = sigs.map((s) => s.blockTime).filter((t): t is number => typeof t === 'number');
  const firstSeen = blockTimes.length > 0 ? Math.min(...blockTimes) : null;
  const note =
    `Sampled from the wallet's token-account transfer history within the last ${WINDOW_HOURS}h ` +
    `(up to ${TX_SAMPLE_LIMIT} transactions decoded via getTransaction; transfer count excludes zero-value moves).`;

  return {
    wallet,
    window: { value: WINDOW_HOURS, unit: 'hours' },
    incomingTokenAmount: transferCount > 0 ? incoming : null,
    outgoingTokenAmount: transferCount > 0 ? outgoing : null,
    netTokenFlow: transferCount > 0 ? net : null,
    transferCount,
    firstSeenAt: firstSeen ? new Date(firstSeen * 1000).toISOString() : null,
    sampleLimitNote: note,
  };
}

async function fetchWalletTokenAccountPubkey(
  rpc: SolanaRpcCaller,
  cache: TtlCache,
  chain: SupportedChain,
  mint: string,
  wallet: string,
): Promise<string | null> {
  // Reuses the same cache entry as fetchWalletTokenBalance to avoid a second RPC call.
  const result = (await cache.memoize(`sol:${chain}:balance:${mint}:${wallet}`, 2 * 60_000, () =>
    rpc.call(chain, 'getTokenAccountsByOwner', [wallet, { mint }, { encoding: 'jsonParsed' }]))) as {
    value?: Array<{ account?: { data?: { parsed?: { info?: { mint?: string } } } }; pubkey?: string }>;
  };
  return result?.value?.find((a) => a.account?.data?.parsed?.info?.mint === mint)?.pubkey ?? null;
}

type TokenBalanceTx = Parameters<typeof walletTokenDelta>[0];

/**
 * Placeholder 30-day flow entry. `zero` marks the honest zero case (the wallet
 * has no token account on this mint, so flow is exactly zero); otherwise the
 * flow is unknown and stays null.
 */
function emptyFlowEntry(wallet: string, note: string, zero = false): WalletActivityModel {
  return {
    wallet,
    window: { value: FLOW_WINDOW_DAYS * 24, unit: 'hours' },
    incomingTokenAmount: zero ? 0 : null,
    outgoingTokenAmount: zero ? 0 : null,
    netTokenFlow: zero ? 0 : null,
    transferCount: 0,
    firstSeenAt: null,
    sampleLimitNote: note,
  };
}

/**
 * Bounded 30-day per-wallet token flow via Helius: walks the wallet's token
 * account signature history back to the cutoff (or the page budget) and
 * decodes up to FLOW_TX_DECODE_LIMIT transactions for pre/post balance
 * deltas. Bounds are always disclosed in sampleLimitNote.
 */
async function fetchWalletFlow30d(
  helius: HeliusRpcClient,
  cache: TtlCache,
  chain: SupportedChain,
  mint: string,
  wallet: string,
  tokenAccount: string,
  now: Date,
): Promise<WalletActivityModel> {
  const cutoffSeconds = Math.floor(now.getTime() / 1000) - FLOW_WINDOW_DAYS * 86_400;
  const scan = await fetchSignaturesWithinWindow(helius, cache, chain, tokenAccount, cutoffSeconds);

  let incoming = 0;
  let outgoing = 0;
  let net = 0;
  let transferCount = 0;

  const timed = scan.signatures.filter((s) => typeof s.blockTime === 'number');
  const sampled = timed.slice(0, FLOW_TX_DECODE_LIMIT);

  for (const sig of sampled) {
    const tx = (await cache.memoize(`sol:${chain}:tx:${sig.signature}`, 60 * 60_000, () =>
      helius.call(chain, 'getTransaction', [
        sig.signature,
        { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 },
      ]))) as TokenBalanceTx;
    const { delta, matched } = walletTokenDelta(tx, mint, wallet);
    if (matched && delta !== 0) {
      net += delta;
      if (delta > 0) incoming += delta;
      else outgoing += -delta;
      transferCount += 1;
    }
  }

  const bounds: string[] = [
    `Signature walk ${scan.reachedCutoff ? 'reached' : 'did not reach'} the ${FLOW_WINDOW_DAYS}-day cutoff ` +
      `(${scan.pages} page(s) of history scanned).`,
  ];
  if (timed.length > sampled.length) {
    bounds.push(
      `Decoded the ${sampled.length} most recent in-window transactions of ${timed.length}; flow is a lower bound.`,
    );
  }
  bounds.push('Flow covers this mint only; zero-value balance moves are excluded.');

  const firstSeen = timed.length > 0 ? Math.min(...timed.map((s) => s.blockTime as number)) : null;

  // Only report numeric flow when the walk actually covered the full window;
  // a partially scanned window would understate the flow, so it stays unknown.
  const windowCovered = scan.reachedCutoff;
  return {
    wallet,
    window: { value: FLOW_WINDOW_DAYS * 24, unit: 'hours' },
    incomingTokenAmount: windowCovered ? incoming : null,
    outgoingTokenAmount: windowCovered ? outgoing : null,
    netTokenFlow: windowCovered ? net : null,
    transferCount,
    firstSeenAt: firstSeen != null ? new Date(firstSeen * 1000).toISOString() : null,
    sampleLimitNote: bounds.join(' '),
  };
}

function safeBigInt(value: string): bigint | null {
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Honest zero: no token account means the wallet holds none of this mint. */
const EMPTY_ACTIVITY: Omit<WalletActivityModel, 'wallet'> = {
  window: { value: WINDOW_HOURS, unit: 'hours' },
  incomingTokenAmount: 0,
  outgoingTokenAmount: 0,
  netTokenFlow: 0,
  transferCount: 0,
  firstSeenAt: null,
  sampleLimitNote: 'No token account found for this wallet on this mint; 24h net flow is exactly zero.',
};

/** Unknown flow: the activity lookup itself failed — never reported as zero. */
const FAILED_ACTIVITY: Omit<WalletActivityModel, 'wallet'> = {
  window: { value: WINDOW_HOURS, unit: 'hours' },
  incomingTokenAmount: null,
  outgoingTokenAmount: null,
  netTokenFlow: null,
  transferCount: 0,
  firstSeenAt: null,
  sampleLimitNote: '24h activity lookup failed; flow unknown.',
};

export async function enrichSolanaToken(
  rpc: SolanaRpcCaller,
  prices: AlchemyPricesClient | null,
  cache: TtlCache,
  chain: SupportedChain,
  tokenAddress: string,
  wallets: string[],
  now: Date,
  helius: HeliusRpcClient | null = null,
  dexscreener: DexScreenerClient | null = null,
): Promise<TokenEnrichment> {
  const observedAt = now.toISOString();
  const notes: string[] = [];

  const metadata = await fetchMintMetadata(rpc, cache, chain, tokenAddress);
  if (!metadata.symbol) {
    notes.push('Metaplex metadata account not found; only chain-level decimals were available.');
  }

  const supplyModel = await fetchTokenSupply(rpc, cache, chain, tokenAddress, metadata.decimals);

  // --- market data: DexScreener primary, Alchemy spot price fallback ---
  let market: MarketDataModel = { ...UNKNOWN_MARKET, notes: [] };
  let dexPairCreatedAt: number | null = null;

  if (dexscreener) {
    try {
      const detail = await dexscreener.fetchTokenMarketDetail(tokenAddress, 'solana');
      dexPairCreatedAt = detail.earliestPairCreatedAt;
      market = detail.market;
      if (market.available) {
        if (market.fdvUsd == null && market.priceUsd != null && supplyModel.totalSupply != null) {
          market.fdvUsd = market.priceUsd * supplyModel.totalSupply;
          market.notes.push('FDV derived as DexScreener price × on-chain total supply.');
        }
        if (market.marketCapUsd == null && market.priceUsd != null && supplyModel.totalSupply != null) {
          market.notes.push('Market cap not reported by DexScreener for any pair.');
        }
      }
    } catch (error) {
      notes.push(`DexScreener market data unavailable: ${errorMessage(error)}`);
    }
  }

  if (!market.available && prices) {
    let price: number | null = null;
    try {
      const priceMap = await prices.getPricesByAddress(getPricesNetwork(chain), [tokenAddress]);
      price = priceMap.get(tokenAddress) ?? null;
    } catch (error) {
      notes.push(`Prices API unavailable for Solana: ${errorMessage(error)}`);
    }
    market =
      price != null
        ? {
            priceUsd: price,
            marketCapUsd: null,
            fdvUsd: supplyModel.totalSupply != null ? price * supplyModel.totalSupply : null,
            volume24hUsd: null,
            priceChange24hPct: null,
            liquidityUsd: null,
            provider: 'alchemy',
            sourceRef: null,
            available: true,
            notes: ['Spot price from the Alchemy Prices API; DexScreener market data was unavailable.'],
          }
        : {
            ...UNKNOWN_MARKET,
            notes: [
              'No market data available: DexScreener returned no usable base-side pairs and the Alchemy Prices API has no coverage for this Solana token.',
            ],
          };
  }
  if (!market.available && !prices) {
    notes.push('No market data available: DexScreener returned no usable pairs and no price-fallback provider is configured.');
  }

  // Token age: earliest mint signatures (bounded search), DexScreener earliest pair as fallback.
  let age: TokenAgeModel = { createdAt: null, ageDays: null, method: null };
  const earliest = await findEarliestMintSignatureTime(rpc, cache, chain, tokenAddress);
  if (earliest) {
    if (earliest.approximate) {
      // The search was capped before reaching the mint's first signature (very
      // high activity token). Surfacing the last visited blockTime as the
      // creation time would be misleading, so the age is reported as unknown.
      notes.push('Token age is indeterminate for this mint: its signature history exceeded the bounded search window.');
    } else {
      age = {
        createdAt: new Date(earliest.blockTime * 1000).toISOString(),
        ageDays: Math.max(0, (now.getTime() / 1000 - earliest.blockTime) / 86_400),
        method: 'mint_signatures',
      };
    }
  }
  if (age.createdAt == null && dexPairCreatedAt != null) {
    age = {
      createdAt: new Date(dexPairCreatedAt).toISOString(),
      ageDays: Math.max(0, (now.getTime() - dexPairCreatedAt) / 86_400_000),
      method: 'dex_pair_created_at',
    };
    notes.push('Token age anchored to the earliest DexScreener pair creation time.');
  }
  if (age.createdAt == null) {
    notes.push('Token age unavailable: no usable mint signature history and no DexScreener pair age.');
  }

  // Holder census via Helius. Exact metrics only when the census scanned every
  // token account; otherwise the derived values are withheld, not sampled.
  let holders: TokenHoldersModel = {
    holderCount: null,
    top100ConcentrationPercent: null,
    accountsScanned: 0,
    censusComplete: false,
    provider: null,
    observedAt,
    notes: [],
  };
  if (helius) {
    try {
      const census = await fetchHolderCensus(helius, cache, chain, tokenAddress);
      const supplyRaw = supplyModel.totalSupplyRaw != null ? safeBigInt(supplyModel.totalSupplyRaw) : null;
      const summary = summarizeHolderCensus(census, supplyRaw);
      holders = {
        holderCount: summary.holderCount,
        top100ConcentrationPercent: summary.top100ConcentrationPercent,
        accountsScanned: summary.accountsScanned,
        censusComplete: census.complete,
        provider: 'helius',
        observedAt,
        notes: census.complete
          ? []
          : [
              `Census bounded at ${summary.accountsScanned} token accounts; holder count and top-100 concentration are withheld rather than reported from a sample.`,
            ],
      };
    } catch (error) {
      holders.notes.push(`Holder census unavailable: ${errorMessage(error)}`);
    }
  }

  // Smart-money wallet balances + 24h activity (+ bounded 30-day flow via Helius).
  const walletBalances: WalletBalanceModel[] = [];
  const walletActivity: WalletActivityModel[] = [];
  const walletFlow30d: WalletActivityModel[] = [];
  for (const wallet of wallets) {
    try {
      walletBalances.push(await fetchWalletTokenBalance(rpc, cache, chain, tokenAddress, wallet));
    } catch (error) {
      notes.push(`Balance for ${shortWallet(wallet)} unavailable: ${errorMessage(error)}`);
      walletBalances.push({ wallet, balance: null, rawBalance: null });
    }

    let pubkey: string | null = null;
    try {
      pubkey = await fetchWalletTokenAccountPubkey(rpc, cache, chain, tokenAddress, wallet);
    } catch (error) {
      notes.push(`Token account lookup for ${shortWallet(wallet)} unavailable: ${errorMessage(error)}`);
    }

    if (pubkey) {
      try {
        walletActivity.push(await fetchWalletActivity(rpc, cache, chain, tokenAddress, wallet, pubkey, now));
      } catch (error) {
        notes.push(`Activity for ${shortWallet(wallet)} unavailable: ${errorMessage(error)}`);
        walletActivity.push({ ...FAILED_ACTIVITY, wallet });
      }
    } else {
      walletActivity.push({ ...EMPTY_ACTIVITY, wallet });
    }

    if (helius) {
      if (pubkey) {
        try {
          walletFlow30d.push(await fetchWalletFlow30d(helius, cache, chain, tokenAddress, wallet, pubkey, now));
        } catch (error) {
          notes.push(`30-day flow for ${shortWallet(wallet)} unavailable: ${errorMessage(error)}`);
          walletFlow30d.push(emptyFlowEntry(wallet, '30-day flow lookup failed.'));
        }
      } else {
        walletFlow30d.push(emptyFlowEntry(wallet, 'No token account found for this wallet on this mint.', true));
      }
    }
  }

  if (!helius) {
    notes.push('Helius client not configured; 30-day wallet flow and the holder census were skipped.');
  }
  notes.push('Token-wide transfer history is not enumerable via standard Solana RPC; per-wallet activity is provided instead.');

  return {
    provider: helius ? 'helius' : 'alchemy',
    chain,
    tokenAddress,
    source: 'ONCHAIN_RPC',
    observedAt,
    metadata,
    supply: supplyModel,
    market,
    age,
    recentTransfers: [],
    walletBalances,
    walletActivity,
    walletFlow30d,
    holders,
    notes,
  };
}