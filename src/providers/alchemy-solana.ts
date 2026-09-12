import { getPricesNetwork, type SupportedChain } from '../chains/registry.js';
import { base64FromBase58 } from '../chains/base58.js';
import { base64ToBytes } from '../lib/bytes.js';
import type { TtlCache } from './cache.js';
import type { JsonRpcClient, RpcParams } from './json-rpc.js';
import type { AlchemyPricesClient } from './prices.js';
import type { DexScreenerClient } from './dexscreener.js';
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

/** Signatures fetched per getSignaturesForAddress page. */
const FLOW_PAGE_LIMIT = 1000;
/** Hard page budget per wallet (prevents runaway history walks). */
const FLOW_MAX_PAGES = 6;
/** Transactions actually decoded per wallet within the window. */
const FLOW_TX_DECODE_LIMIT = 120;

/**
 * RPC caller shape for Solana enrichment helpers.
 */
type SolanaRpcCaller = {
  call(chain: SupportedChain, method: string, params: RpcParams): Promise<unknown>;
  callBatch(chain: SupportedChain, method: string, paramsList: RpcParams[]): Promise<Array<unknown | null>>;
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
      const bytes = base64ToBytes(raw);
      if (bytes.length >= METADATA_SYMBOL_LEN_OFFSET + 8) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const utf8 = new TextDecoder();
        const nameLength = view.getUint32(METADATA_NAME_LEN_OFFSET, true);
        const name = utf8.decode(bytes.subarray(METADATA_NAME_LEN_OFFSET + 4, METADATA_NAME_LEN_OFFSET + 4 + nameLength));
        const symbolLength = view.getUint32(METADATA_SYMBOL_LEN_OFFSET, true);
        const symbol = utf8.decode(bytes.subarray(METADATA_SYMBOL_LEN_OFFSET + 4, METADATA_SYMBOL_LEN_OFFSET + 4 + symbolLength));
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

/**
 * Decodes transactions in bounded JSON-RPC batches: each HTTP request carries
 * up to TX_BATCH_SIZE getTransaction calls, so Cloudflare's per-invocation
 * subrequest budget (50 on the free plan) is not exhausted by per-signature
 * fetches (previously up to 120+ individual calls per wallet). Results are
 * per-entry: failed/errored entries resolve to null (treated as undecodable,
 * never fabricated).
 */
const TX_BATCH_SIZE = 20;

async function fetchTransactionsBatched(
  rpc: SolanaRpcCaller,
  chain: SupportedChain,
  signatures: string[],
): Promise<Map<string, unknown | null>> {
  const unique = [...new Set(signatures.filter((sig) => typeof sig === 'string' && sig.length > 0))];
  const results = new Map<string, unknown | null>();
  for (let offset = 0; offset < unique.length; offset += TX_BATCH_SIZE) {
    const chunk = unique.slice(offset, offset + TX_BATCH_SIZE);
    const batch = await rpc.callBatch(
      chain,
      'getTransaction',
      chunk.map((signature) => [signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]),
    );
    chunk.forEach((signature, index) => results.set(signature, batch[index] ?? null));
  }
  return results;
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
  const transactions = await fetchTransactionsBatched(
    rpc,
    chain,
    sampled.map((sig) => sig.signature ?? ''),
  );
  for (const sig of sampled) {
    if (!sig.signature) continue;
    const tx = transactions.get(sig.signature) as {
      meta?: {
        preTokenBalances?: Array<{ accountIndex: number; mint?: string; owner?: string; uiTokenAmount?: ParsedTokenAmount }>;
        postTokenBalances?: Array<{ accountIndex: number; uiTokenAmount?: ParsedTokenAmount }>;
      };
    } | null;
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
 * Bounded 30-day per-wallet token flow: walks the wallet's token
 * account signature history back to the cutoff (or the page budget) and
 * decodes up to FLOW_TX_DECODE_LIMIT transactions for pre/post balance
 * deltas. Bounds are always disclosed in sampleLimitNote.
 */
async function fetchWalletFlow30d(
  rpc: SolanaRpcCaller,
  cache: TtlCache,
  chain: SupportedChain,
  mint: string,
  wallet: string,
  tokenAccount: string,
  now: Date,
): Promise<WalletActivityModel> {
  const cutoffSeconds = Math.floor(now.getTime() / 1000) - FLOW_WINDOW_DAYS * 86_400;
  const scan = await fetchSignaturesWithinWindow(rpc, cache, chain, tokenAccount, cutoffSeconds);

  let incoming = 0;
  let outgoing = 0;
  let net = 0;
  let transferCount = 0;

  const timed = scan.signatures.filter((s) => typeof s.blockTime === 'number');
  const sampled = timed.slice(0, FLOW_TX_DECODE_LIMIT);

  const transactions = await fetchTransactionsBatched(
    rpc,
    chain,
    sampled.map((sig) => sig.signature),
  );
  for (const sig of sampled) {
    const tx = transactions.get(sig.signature) as TokenBalanceTx | null;
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

// ---------------------------------------------------------------------------
// Signature window + token-balance delta helpers (standard Solana RPC)
// ---------------------------------------------------------------------------

interface FlowWindow {
  signature: string;
  blockTime: number | null;
}

interface FlowScan {
  signatures: FlowWindow[];
  reachedCutoff: boolean;
  pages: number;
}

/**
 * Walks the target account's signature history backwards until the cutoff
 * (default 30 days) or the page budget is hit. `reachedCutoff` false with a
 * full page budget means the window is bounded, not exhausted.
 */
async function fetchSignaturesWithinWindow(
  rpc: { call(chain: SupportedChain, method: string, params: RpcParams): Promise<unknown> },
  cache: { memoize<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> },
  chain: SupportedChain,
  address: string,
  cutoffSeconds: number,
): Promise<FlowScan> {
  const cacheKey = `sol:${chain}:win-sigs:${address}:${Math.floor(cutoffSeconds / 3600)}`;
  return cache.memoize(cacheKey, 5 * 60_000, async () => {
    const signatures: FlowWindow[] = [];
    let before: string | null = null;
    let pages = 0;
    let reachedCutoff = false;

    while (pages < FLOW_MAX_PAGES) {
      const options: Record<string, unknown> = { limit: FLOW_PAGE_LIMIT };
      if (before) options.before = before;

      const batch = (await rpc.call(chain, 'getSignaturesForAddress', [address, options])) as Array<{
        signature?: string;
        blockTime?: number | null;
      }>;

      if (!Array.isArray(batch) || batch.length === 0) break;
      pages += 1;

      for (const entry of batch) {
        if (!entry.signature) continue;
        if (typeof entry.blockTime === 'number' && entry.blockTime < cutoffSeconds) {
          reachedCutoff = true;
          break;
        }
        signatures.push({ signature: entry.signature, blockTime: entry.blockTime ?? null });
      }

      if (reachedCutoff || batch.length < FLOW_PAGE_LIMIT) break;
      before = batch[batch.length - 1].signature ?? null;
      if (!before) break;
    }

    return { signatures, reachedCutoff, pages };
  });
}

interface TokenBalanceDelta {
  /** Net token-amount change for the wallet across the transaction. */
  delta: number;
  /** True when the wallet's token balances appear in pre/post state. */
  matched: boolean;
}

/**
 * Computes the wallet's net token-amount delta for one mint from a
 * transaction's pre/postTokenBalances. Returns matched:false when the wallet
 * holds no accounts for the mint in this transaction.
 */
function walletTokenDelta(
  tx: {
    meta?: {
      preTokenBalances?: Array<{ accountIndex: number; owner?: string; uiTokenAmount?: { uiAmount?: number | null } }>;
      postTokenBalances?: Array<{ accountIndex: number; owner?: string; uiTokenAmount?: { uiAmount?: number | null } }>;
    } | null;
  } | null,
  mint: string,
  wallet: string,
): TokenBalanceDelta {
  const pre = tx?.meta?.preTokenBalances ?? [];
  const post = tx?.meta?.postTokenBalances ?? [];
  const indexes = new Set<number>();
  for (const entry of [...pre, ...post]) {
    if (entry.owner === wallet) indexes.add(entry.accountIndex);
  }
  if (indexes.size === 0) return { delta: 0, matched: false };

  let delta = 0;
  for (const index of indexes) {
    const before = pre.find((p) => p.accountIndex === index)?.uiTokenAmount?.uiAmount ?? 0;
    const after = post.find((p) => p.accountIndex === index)?.uiTokenAmount?.uiAmount ?? before;
    delta += (after ?? 0) - (before ?? 0);
  }
  return { delta, matched: true };
}

export async function enrichSolanaToken(
  rpc: SolanaRpcCaller,
  prices: AlchemyPricesClient | null,
  cache: TtlCache,
  chain: SupportedChain,
  tokenAddress: string,
  wallets: string[],
  now: Date,
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

  // Holder census is not available via standard Alchemy RPC; report as unavailable.
  const holders: TokenHoldersModel = {
    holderCount: null,
    top100ConcentrationPercent: null,
    accountsScanned: 0,
    censusComplete: false,
    provider: null,
    observedAt,
    notes: ['Holder census not available via Alchemy RPC; this input is withheld rather than reported from a sample.'],
  };

  // Smart-money wallet balances + 24h activity (+ bounded 30-day flow via standard RPC).
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

    if (pubkey) {
      try {
        walletFlow30d.push(await fetchWalletFlow30d(rpc, cache, chain, tokenAddress, wallet, pubkey, now));
      } catch (error) {
        notes.push(`30-day flow for ${shortWallet(wallet)} unavailable: ${errorMessage(error)}`);
        walletFlow30d.push(emptyFlowEntry(wallet, '30-day flow lookup failed.'));
      }
    } else {
      walletFlow30d.push(emptyFlowEntry(wallet, 'No token account found for this wallet on this mint.', true));
    }
  }

  notes.push('Token-wide transfer history is not enumerable via standard Solana RPC; per-wallet activity is provided instead.');

  return {
    provider: 'alchemy',
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