/**
 * Enrichment gateway for the monitoring phase.
 *
 * Alchemy is the primary on-chain provider for all chains (EVM + Solana).
 * The gateway uses Alchemy's multi-chain RPC and Prices API for enrichment.
 *
 * Without Alchemy, construction fails fast with an explicit error.
 */
import { AlchemyProvider } from './alchemy.js';
import type { ProviderAdapter } from './provider.js';

export interface EnrichmentGatewayOptions {
  alchemyApiKey?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export function createEnrichmentGateway(options: EnrichmentGatewayOptions): ProviderAdapter {
  if (options.alchemyApiKey) {
    return new AlchemyProvider({
      apiKey: options.alchemyApiKey,
      fetch: options.fetch,
      now: options.now,
    });
  }
  throw new Error(
    'No on-chain provider configured: set ALCHEMY_API_KEY for multi-chain enrichment (EVM + Solana).',
  );
}
