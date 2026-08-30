export const SUPPORTED_CHAINS = ['ethereum', 'polygon', 'arbitrum', 'base', 'bsc', 'solana'] as const;

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number];

export const DEFAULT_CHAIN: SupportedChain = 'solana';

export const EVM_CHAINS: readonly SupportedChain[] = ['ethereum', 'polygon', 'arbitrum', 'base', 'bsc'];

export type ChainKind = 'evm' | 'solana';

export interface ChainDefinition {
  chain: SupportedChain;
  chainId: string;
  rpcBaseUrl: string;
  addressFormat: 'evm' | 'solana';
  /** Network id used by the Alchemy Prices API (`eth-mainnet`, `sol-mainnet`, ...). */
  pricesNetwork: string;
  /** Approximate seconds per block, used for EVM time-window enrichment. Null for Solana. */
  avgBlockSeconds: number | null;
  /** Whether the Prices API historical/market-data feed supports this chain. */
  supportsHistoricalPrices: boolean;
}
