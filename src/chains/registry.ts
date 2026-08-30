import {
  DEFAULT_CHAIN,
  EVM_CHAINS,
  SUPPORTED_CHAINS,
  type ChainDefinition,
  type ChainKind,
  type SupportedChain,
} from './types.js';

export type { ChainDefinition, ChainKind, SupportedChain } from './types.js';

const CHAIN_REGISTRY: Record<SupportedChain, ChainDefinition> = {
  ethereum: {
    chain: 'ethereum',
    chainId: '0x1',
    rpcBaseUrl: 'https://eth-mainnet.g.alchemy.com/v2/',
    addressFormat: 'evm',
    pricesNetwork: 'eth-mainnet',
    avgBlockSeconds: 12,
    supportsHistoricalPrices: true,
  },
  polygon: {
    chain: 'polygon',
    chainId: '0x89',
    rpcBaseUrl: 'https://polygon-mainnet.g.alchemy.com/v2/',
    addressFormat: 'evm',
    pricesNetwork: 'polygon-mainnet',
    avgBlockSeconds: 2,
    supportsHistoricalPrices: true,
  },
  arbitrum: {
    chain: 'arbitrum',
    chainId: '0xa4b1',
    rpcBaseUrl: 'https://arb-mainnet.g.alchemy.com/v2/',
    addressFormat: 'evm',
    pricesNetwork: 'arb-mainnet',
    avgBlockSeconds: 0.3,
    supportsHistoricalPrices: true,
  },
  base: {
    chain: 'base',
    chainId: '0x2105',
    rpcBaseUrl: 'https://base-mainnet.g.alchemy.com/v2/',
    addressFormat: 'evm',
    pricesNetwork: 'base-mainnet',
    avgBlockSeconds: 2,
    supportsHistoricalPrices: true,
  },
  bsc: {
    chain: 'bsc',
    chainId: '0x38',
    rpcBaseUrl: 'https://bnb-mainnet.g.alchemy.com/v2/',
    addressFormat: 'evm',
    pricesNetwork: 'bnb-mainnet',
    avgBlockSeconds: 3,
    supportsHistoricalPrices: true,
  },
  solana: {
    chain: 'solana',
    chainId: 'solana-mainnet',
    rpcBaseUrl: 'https://solana-mainnet.g.alchemy.com/v2/',
    addressFormat: 'solana',
    pricesNetwork: 'sol-mainnet',
    avgBlockSeconds: null,
    supportsHistoricalPrices: false,
  },
};

export const ALCHEMY_SUPPORTED_CHAINS = [...SUPPORTED_CHAINS] as const;
export const ALCHEMY_EVM_CHAINS = [...EVM_CHAINS] as const;

export function getDefaultChain(): SupportedChain {
  return DEFAULT_CHAIN;
}

export function isSupportedChain(chain: string): chain is SupportedChain {
  return SUPPORTED_CHAINS.includes(chain as SupportedChain);
}

export function getChainDefinition(chain: SupportedChain): ChainDefinition {
  return CHAIN_REGISTRY[chain];
}

export function getChainKind(chain: SupportedChain): ChainKind {
  return chain === 'solana' ? 'solana' : 'evm';
}

export function getRpcUrl(chain: SupportedChain, apiKey: string): string {
  return `${CHAIN_REGISTRY[chain].rpcBaseUrl}${apiKey}`;
}

export function getPricesNetwork(chain: string): string {
  return getChainDefinition(assertSupportedChain(chain)).pricesNetwork;
}

export function getAvgBlockSeconds(chain: string): number | null {
  return getChainDefinition(assertSupportedChain(chain)).avgBlockSeconds;
}

export function isValidAddress(value: string, chain: string): boolean {
  const normalized = value.trim();
  if (chain === 'solana') {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(normalized);
  }
  return /^0x[a-fA-F0-9]{40}$/.test(normalized);
}

export function isValidEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function assertSupportedChain(chain: string): SupportedChain {
  if (!isSupportedChain(chain)) {
    throw new Error(`Unsupported chain: ${chain}. Supported chains: ${SUPPORTED_CHAINS.join(', ')}`);
  }
  return chain;
}
