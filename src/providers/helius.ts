/**
 * Helius provider — primary Solana on-chain/indexing provider.
 *
 * The Helius JSON-RPC endpoint speaks standard Solana RPC plus Helius DAS
 * extensions (verified on the free tier: `getProgramAccountsV2` pagination).
 * The API key is only ever embedded in the request URL and is never logged.
 *
 * The client intentionally mirrors the Alchemy `RpcCaller.call(chain, method,
 * params)` shape so the Solana enrichment helpers can use either provider.
 */
import type { SupportedChain } from '../chains/registry.js';
import type { RpcParams } from './json-rpc.js';
import { base64ToBytes, bytesToBase64, bytesToHex } from '../lib/bytes.js';

export interface HeliusRpcClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

export class HeliusRpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'HeliusRpcError';
  }
}

export class HeliusRpcClient {
  private readonly fetcher: typeof globalThis.fetch;

  constructor(
    private readonly options: HeliusRpcClientOptions,
  ) {
    this.fetcher = options.fetch ?? globalThis.fetch;
  }

  private url(): string {
    const base = this.options.baseUrl ?? 'https://mainnet.helius-rpc.com/';
    return `${base}?api-key=${this.options.apiKey}`;
  }

  /** Chain is accepted for RpcCaller compatibility; Helius serves Solana mainnet. */
  async call(chain: SupportedChain, method: string, params: RpcParams, maxAttempts = 3): Promise<unknown> {
    void chain;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        const response = await this.fetcher(this.url(), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        });

        const body = (await response.json().catch(() => null)) as
          | { result?: unknown; error?: { code?: number; message?: string } }
          | null;

        if (response.ok && body && body.result !== undefined) {
          return body.result;
        }

        const serverMessage = body?.error?.message ?? `HTTP ${response.status}`;
        const retryable = response.status === 429 || response.status === 503 || response.status === 408 || (response.status >= 500 && response.status !== 501);
        throw new HeliusRpcError(
          `Helius ${method} failed: ${serverMessage}`,
          body?.error?.code,
          retryable,
        );
      } catch (error) {
        lastError = error;
        const rpcError = error instanceof HeliusRpcError ? error : null;
        const networkError = error instanceof TypeError;
        const shouldRetry = (rpcError !== null && rpcError.retryable) || networkError;
        if (!shouldRetry || attempt === maxAttempts - 1) break;

        await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

// ---------------------------------------------------------------------------
// Holder census (verified free-tier capability: getProgramAccountsV2 with
// paginationKey pagination and 40-byte data slices of owner + amount).
// ---------------------------------------------------------------------------

export const SPL_TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SPL_TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

/** Accounts fetched per getProgramAccountsV2 page (verified supported). */
export const CENSUS_PAGE_LIMIT = 1000;
/** Page budget per token program. 3 pages = up to 3000 accounts per program. */
export const CENSUS_MAX_PAGES = 3;

export interface CensusAccount {
  /** Token account pubkey (dedupe key across programs). */
  pubkey: string;
  /** Owner identity as hex (internal key; base58 rendering is not required for scoring). */
  owner: string;
  /** Raw integer token amount. */
  amount: bigint;
}

export interface CensusResult {
  accounts: CensusAccount[];
  accountsScanned: number;
  /** True only when a page returned fewer than the page limit within the budget. */
  complete: boolean;
}

/**
 * Decodes a 40-byte account slice (owner 32 bytes + amount 8 bytes LE).
 * Returns null for malformed/short slices instead of guessing.
 */
export function decodeHolderSlice(base64: string): { owner: string; amount: bigint } | null {
  const bytes = base64ToBytes(base64);
  if (bytes.length < 40) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    owner: bytesToHex(bytes.subarray(0, 32)),
    amount: view.getBigUint64(32, true),
  };
}

/** Merges census accounts, deduplicating token accounts by pubkey (keep max amount). */
export function mergeCensusAccounts(pages: CensusAccount[]): CensusAccount[] {
  const byPubkey = new Map<string, CensusAccount>();
  for (const account of pages) {
    const existing = byPubkey.get(account.pubkey);
    if (!existing || account.amount > existing.amount) {
      byPubkey.set(account.pubkey, account);
    }
  }
  return [...byPubkey.values()];
}

export interface HolderCensusSummary {
  /** Unique owners across the scanned accounts. */
  uniqueHolders: number;
  accountsScanned: number;
  /** Sum of the largest 100 owner balances (raw units). */
  top100RawSum: bigint;
  /** Top-100 share of supply in percent — exact only for a complete census. */
  top100ConcentrationPercent: number | null;
  holderCount: number | null;
}

/**
 * Summarizes a census. Holder count and top-100 concentration are only exact
 * when the census is complete; for a bounded census both stay null so a
 * sample is never reported as the true metric.
 */
export function summarizeHolderCensus(
  census: CensusResult,
  supplyRaw: bigint | null,
): HolderCensusSummary {
  // Multiple token accounts per owner (ATA + aux accounts): aggregate per owner.
  const perOwner = new Map<string, bigint>();
  for (const account of census.accounts) {
    const previous = perOwner.get(account.owner) ?? 0n;
    if (account.amount > previous) perOwner.set(account.owner, account.amount);
  }

  const balances = [...perOwner.values()].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const top100RawSum = balances.slice(0, 100).reduce((sum, value) => sum + value, 0n);

  const top100ConcentrationPercent =
    census.complete && supplyRaw != null && supplyRaw > 0n
      ? Number((top100RawSum * 10_000n) / supplyRaw) / 100
      : null;

  return {
    uniqueHolders: perOwner.size,
    accountsScanned: census.accountsScanned,
    top100RawSum,
    top100ConcentrationPercent,
    holderCount: census.complete ? perOwner.size : null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bounded holder census via getProgramAccountsV2. Scans the classic SPL token
 * program and Token-2022 (mint filter at offset 0, identical first-72-byte
 * layout). Pages are fetched sequentially with a small delay to respect the
 * free-tier rate limit; the census is `complete` only when a page returns
 * fewer than CENSUS_PAGE_LIMIT accounts within the page budget.
 */
export async function fetchHolderCensus(
  rpc: { call(chain: SupportedChain, method: string, params: RpcParams): Promise<unknown> },
  cache: { memoize<T>(key: string, ttlMs: number, producer: () => Promise<T>): Promise<T> },
  chain: SupportedChain,
  mint: string,
): Promise<CensusResult> {
  return cache.memoize(`sol:${chain}:census:${mint}`, 10 * 60_000, async () => {
    const collected: CensusAccount[] = [];
    let complete = true;

    for (const program of [SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]) {
      // Token-2022 accounts have variable sizes, so only the mint filter applies.
      const filters: Array<Record<string, unknown>> =
        program === SPL_TOKEN_PROGRAM
          ? [{ dataSize: 165 }, { memcmp: { offset: 0, bytes: mint } }]
          : [{ memcmp: { offset: 0, bytes: mint } }];

      let paginationKey: string | null = null;
      let pages = 0;

      while (pages < CENSUS_MAX_PAGES) {
        const config: Record<string, unknown> = {
          encoding: 'base64',
          filters,
          dataSlice: { offset: 32, length: 40 },
          limit: CENSUS_PAGE_LIMIT,
        };
        if (paginationKey) config.paginationKey = paginationKey;

        const page = (await rpc.call(chain, 'getProgramAccountsV2', [program, config])) as {
          accounts?: Array<{ pubkey?: string; account?: { data?: [string, string] } }>;
          paginationKey?: string | null;
        } | null;

        const rows = page?.accounts ?? [];
        for (const row of rows) {
          const pubkey = row.pubkey;
          const slice = row.account?.data?.[0];
          if (!pubkey || !slice) continue;
          const decoded = decodeHolderSlice(slice);
          if (!decoded) continue;
          collected.push({ pubkey, owner: decoded.owner, amount: decoded.amount });
        }

        if (rows.length < CENSUS_PAGE_LIMIT) break; // last page for this program

        pages += 1;
        if (pages >= CENSUS_MAX_PAGES) {
          complete = false; // budget exhausted with full pages: bounded census
          break;
        }

        paginationKey = page?.paginationKey ?? null;
        if (!paginationKey) break; // no continuation key: end of data
        await sleep(150);
      }
    }

    const merged = mergeCensusAccounts(collected);
    return { accounts: merged, accountsScanned: merged.length, complete } satisfies CensusResult;
  });
}

// ---------------------------------------------------------------------------
// 30-day wallet flow (verified free-tier capability: token-account signature
// pagination + getTransaction pre/postTokenBalances decoding).
// ---------------------------------------------------------------------------

/** Signatures fetched per getSignaturesForAddress page. */
export const FLOW_PAGE_LIMIT = 1000;
/** Hard page budget per wallet (prevents runaway history walks). */
export const FLOW_MAX_PAGES = 6;
/** Transactions actually decoded per wallet within the window. */
export const FLOW_TX_DECODE_LIMIT = 120;

export interface FlowWindow {
  signature: string;
  blockTime: number | null;
}

export interface FlowScan {
  signatures: FlowWindow[];
  reachedCutoff: boolean;
  pages: number;
}

/**
 * Walks the target account's signature history backwards until the cutoff
 * (default 30 days) or the page budget is hit. `reachedCutoff` false with a
 * full page budget means the window is bounded, not exhausted.
 */
export async function fetchSignaturesWithinWindow(
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

export interface TokenBalanceDelta {
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
export function walletTokenDelta(
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

