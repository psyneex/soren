export type ProviderSource = 'ONCHAIN_RPC';
export type ProviderName = 'alchemy' | 'helius' | 'dexscreener';

export interface TokenMetadataModel {
  name: string | null;
  symbol: string | null;
  decimals: number | null;
  logo: string | null;
}

export interface TokenSupplyModel {
  /** Human-readable (decimal-scaled) total supply. */
  totalSupply: number | null;
  /** Raw integer supply string (hex on EVM, base-10 on Solana). */
  totalSupplyRaw: string | null;
  decimals: number | null;
}

export interface MarketDataModel {
  priceUsd: number | null;
  marketCapUsd: number | null;
  /** Derived: price × total supply. */
  fdvUsd: number | null;
  volume24hUsd: number | null;
  priceChange24hPct: number | null;
  /** DEX liquidity in USD where the provider exposes it (DexScreener on Solana). */
  liquidityUsd: number | null;
  /** Which provider supplied this market observation. */
  provider: ProviderName | null;
  /** Source reference where practical (e.g. the primary DEX pair address). */
  sourceRef: string | null;
  /** Whether a price/market feed was reachable for this token/chain. */
  available: boolean;
  notes: string[];
}

export interface TokenAgeModel {
  createdAt: string | null;
  /** Derived: now − createdAt, in days. */
  ageDays: number | null;
  method: 'earliest_transfer' | 'mint_signatures' | 'dex_pair_created_at' | null;
}

/**
 * Holder census. Exact values are only reported when the census scanned every
 * token account for the mint; a bounded census is reported as bounded and the
 * derived metrics stay null instead of becoming sample-based proxies.
 */
export interface TokenHoldersModel {
  /** Exact unique holder count — only when `censusComplete` is true. */
  holderCount: number | null;
  /** Exact share of supply held by the top 100 holders (percent) — only when `censusComplete` is true. */
  top100ConcentrationPercent: number | null;
  /** Number of token accounts scanned by the census. */
  accountsScanned: number;
  /** True when every token account for the mint was scanned within the page budget. */
  censusComplete: boolean;
  /** Provider that produced the census. */
  provider: ProviderName | null;
  observedAt: string | null;
  notes: string[];
}

export type TransferCategory = 'external' | 'internal' | 'erc20' | 'erc721' | 'erc1155' | 'spl' | 'unknown';

export interface TransferModel {
  hash: string | null;
  from: string | null;
  to: string | null;
  /** Human-readable amount in token units where decoding was possible. */
  amount: number | null;
  asset: string | null;
  block: number | null;
  timestamp: string | null;
  category: TransferCategory;
}

export interface WalletBalanceModel {
  wallet: string;
  balance: number | null;
  rawBalance: string | null;
}

export interface WalletActivityModel {
  wallet: string;
  /** Structured duration window used to derive the flow metrics. */
  window: { value: number; unit: 'hours' };
  incomingTokenAmount: number | null;
  outgoingTokenAmount: number | null;
  netTokenFlow: number | null;
  transferCount: number;
  firstSeenAt: string | null;
  sampleLimitNote: string | null;
}

export interface TokenEnrichment {
  provider: ProviderName;
  chain: string;
  tokenAddress: string;
  source: ProviderSource;
  observedAt: string;
  metadata: TokenMetadataModel;
  supply: TokenSupplyModel;
  market: MarketDataModel;
  age: TokenAgeModel;
  /** Token-wide transfer history where technically available (EVM). */
  recentTransfers: TransferModel[];
  walletBalances: WalletBalanceModel[];
  /** Short-window (24h) wallet activity. */
  walletActivity: WalletActivityModel[];
  /** Bounded 30-day wallet flow used by the accumulation analysis (Solana via Helius). */
  walletFlow30d: WalletActivityModel[];
  /** Holder census (Solana via Helius). Exact only when the census completed. */
  holders: TokenHoldersModel;
  notes: string[];
}

export interface EnrichmentOptions {
  smartMoneyWallets?: string[];
  now?: Date;
}

export interface ProviderAdapter {
  readonly providerName: ProviderName;
  supportsChain(chain: string): boolean;
  enrichToken(chain: string, tokenAddress: string, options?: EnrichmentOptions): Promise<TokenEnrichment>;
}
