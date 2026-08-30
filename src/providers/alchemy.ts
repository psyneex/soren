import {
  ALCHEMY_EVM_CHAINS,
  ALCHEMY_SUPPORTED_CHAINS,
  assertSupportedChain,
  getChainKind,
} from '../chains/registry.js';
import { TtlCache } from './cache.js';
import { JsonRpcClient } from './json-rpc.js';
import { AlchemyPricesClient } from './prices.js';
import { HeliusRpcClient } from './helius.js';
import { DexScreenerClient } from './dexscreener.js';
import type { EnrichmentOptions, ProviderAdapter, TokenEnrichment } from './provider.js';
import { enrichEvmToken } from './alchemy-evm.js';
import { enrichSolanaToken } from './alchemy-solana.js';

export { ALCHEMY_SUPPORTED_CHAINS, ALCHEMY_EVM_CHAINS };

export interface AlchemyProviderOptions {
  apiKey: string;
  /** Optional Helius key; when absent, Solana holder census and 30d flow are skipped. */
  heliusApiKey?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

/**
 * Provider orchestrator. API keys are only ever injected into the RPC URL /
 * Authorization header and are never included in logs or error messages.
 */
export class AlchemyProvider implements ProviderAdapter {
  readonly providerName = 'alchemy' as const;
  private readonly rpc: JsonRpcClient;
  private readonly prices: AlchemyPricesClient;
  private readonly helius: HeliusRpcClient | null;
  private readonly dexscreener: DexScreenerClient;
  private readonly cache: TtlCache;
  private readonly now: () => Date;

  constructor(options: AlchemyProviderOptions) {
    this.rpc = new JsonRpcClient({ apiKey: options.apiKey, fetch: options.fetch });
    this.prices = new AlchemyPricesClient(options.apiKey, { fetch: options.fetch });
    this.helius = options.heliusApiKey
      ? new HeliusRpcClient({ apiKey: options.heliusApiKey, fetch: options.fetch })
      : null;
    this.cache = new TtlCache();
    this.dexscreener = new DexScreenerClient({ fetch: options.fetch, cache: this.cache });
    this.now = options.now ?? (() => new Date());
  }

  supportsChain(chain: string): boolean {
    try {
      assertSupportedChain(chain);
      return true;
    } catch {
      return false;
    }
  }

  enrichToken(
    chain: string,
    tokenAddress: string,
    options: EnrichmentOptions = {},
  ): Promise<TokenEnrichment> {
    const normalized: 'ethereum' | 'polygon' | 'arbitrum' | 'base' | 'bsc' | 'solana' =
      assertSupportedChain(chain);
    const wallets = options.smartMoneyWallets ?? [];
    const now = options.now ?? this.now();

    return getChainKind(normalized) === 'solana'
      ? enrichSolanaToken(this.rpc, this.prices, this.cache, normalized, tokenAddress, wallets, now, this.helius, this.dexscreener)
      : enrichEvmToken(this.rpc, this.prices, this.cache, normalized, tokenAddress, wallets, now);
  }
}
