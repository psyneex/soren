/**
 * Enrichment gateway for the monitoring phase.
 *
 * Provider-agnostic per AGENTS.md: Alchemy and Helius are interchangeable
 * providers, never domain dependencies. The gateway picks whatever on-chain
 * provider is configured:
 *   - Alchemy key present  → the full multi-chain AlchemyProvider (Solana + EVM),
 *     with optional Helius enrichment (holder census, 30-day flow).
 *   - Only a Helius key    → a Solana-only provider that uses the Helius RPC
 *     endpoint (standard Solana JSON-RPC) for balances/activity and Helius for
 *     the census/flow — Helius is used because it is available, not because the
 *     domain requires it.
 *   - Neither key          → construction fails fast with an explicit error.
 *
 * Helius is never a mandatory scoring dependency: without it, accumulation
 * simply runs on the standard-RPC 24h activity and the census/30d inputs are
 * reported as unavailable.
 */
import { AlchemyProvider } from './alchemy.js';
import { TtlCache } from './cache.js';
import { DexScreenerClient } from './dexscreener.js';
import { HeliusRpcClient } from './helius.js';
import { enrichSolanaToken } from './alchemy-solana.js';
import type { ProviderAdapter, TokenEnrichment } from './provider.js';

export interface EnrichmentGatewayOptions {
  alchemyApiKey?: string;
  heliusApiKey?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

class HeliusSolanaProvider implements ProviderAdapter {
  readonly providerName = 'helius' as const;
  private readonly helius: HeliusRpcClient;
  private readonly dexscreener: DexScreenerClient;
  private readonly cache: TtlCache;
  private readonly now: () => Date;

  constructor(options: EnrichmentGatewayOptions) {
    this.helius = new HeliusRpcClient({ apiKey: options.heliusApiKey as string, fetch: options.fetch });
    this.dexscreener = new DexScreenerClient({ fetch: options.fetch });
    this.cache = new TtlCache();
    this.now = options.now ?? (() => new Date());
  }

  supportsChain(chain: string): boolean {
    return chain === 'solana';
  }

  enrichToken(
    chain: string,
    tokenAddress: string,
    options: { smartMoneyWallets?: string[]; now?: Date } = {},
  ): Promise<TokenEnrichment> {
    if (chain !== 'solana') {
      return Promise.reject(
        new Error(`Helius-only enrichment supports Solana; requested chain "${chain}" is unavailable.`),
      );
    }
    return enrichSolanaToken(
      this.helius, // Helius speaks standard Solana RPC — provider-agnostic caller shape
      null, // no Alchemy Prices fallback in Helius-only mode
      this.cache,
      'solana',
      tokenAddress,
      options.smartMoneyWallets ?? [],
      options.now ?? this.now(),
      this.helius, // census + bounded 30-day flow
      this.dexscreener,
    );
  }
}

export function createEnrichmentGateway(options: EnrichmentGatewayOptions): ProviderAdapter {
  if (options.alchemyApiKey) {
    return new AlchemyProvider({
      apiKey: options.alchemyApiKey,
      heliusApiKey: options.heliusApiKey,
      fetch: options.fetch,
      now: options.now,
    });
  }
  if (options.heliusApiKey) {
    return new HeliusSolanaProvider(options);
  }
  throw new Error(
    'No on-chain provider configured: set ALCHEMY_API_KEY (multi-chain) or HELIUS_API_KEY (Solana).',
  );
}
