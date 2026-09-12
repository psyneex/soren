/**
 * Observation collector — assembles a single monitoring observation for one
 * watchlist token from the provider gateway (on-chain enrichment), DexScreener
 * (primary free market data), and the Binance market-reference regime data.
 *
 * Every part retains explicit provenance; provider failures degrade to notes
 * and nulls instead of fabricated values. Honest zeros (a wallet with no token
 * account has exactly zero balance and flow) are distinguished from unknowns
 * (a failed lookup), never conflated.
 */
import type { ProviderAdapter, TokenEnrichment } from '../providers/provider.js';
import type { DexScreenerClient } from '../providers/dexscreener.js';
import type { MarketReferenceClient } from '../providers/market-reference.js';
import type {
  HolderConcentration,
  MarketObservation,
  RegimeObservation,
  SmartMoneyWalletFlow,
} from '../domain/types.js';

export interface TokenObservation {
  chain: string;
  tokenAddress: string;
  symbol: string | null;
  observedAt: string;
  enrichmentProvider: string;
  /** Full raw enrichment, persisted verbatim for provenance. */
  enrichment: TokenEnrichment;
  market: MarketObservation;
  regime: RegimeObservation | null;
  smartMoney: SmartMoneyWalletFlow[];
  holders: HolderConcentration;
  notes: string[];
}

export interface ObservationDeps {
  provider: ProviderAdapter;
  dexscreener: DexScreenerClient;
  marketReference: MarketReferenceClient | null;
}

const UNKNOWN_MARKET: MarketObservation = {
  priceUsd: null,
  liquidityUsd: null,
  volume24hUsd: null,
  volume6hUsd: null,
  buys24h: null,
  sells24h: null,
  priceChange24hPct: null,
  marketCapUsd: null,
  fdvUsd: null,
  provider: null,
  sourceRef: null,
  available: false,
  fieldSources: {},
  notes: [],
};

export async function collectObservation(
  deps: ObservationDeps,
  chain: string,
  tokenAddress: string,
  smartMoneyWallets: string[],
  now: Date,
): Promise<TokenObservation> {
  const notes: string[] = [];

  const enrichment = await deps.provider.enrichToken(chain, tokenAddress, {
    smartMoneyWallets,
    now,
  });

  // DexScreener: primary free market data on every supported chain. The client
  // degrades internally to an unavailable market on provider failure.
  let dexDetail;
  try {
    dexDetail = await deps.dexscreener.fetchTokenMarketDetail(tokenAddress, chain);
  } catch (error) {
    notes.push(`DexScreener market fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    dexDetail = {
      market: { ...UNKNOWN_MARKET, provider: 'dexscreener', sourceRef: null },
      earliestPairCreatedAt: null,
      extras: {
        volume6hUsd: null,
        volume1hUsd: null,
        buys24h: null,
        sells24h: null,
        buys6h: null,
        sells6h: null,
      },
    };
  }

  const dex = dexDetail.market;
  const ens = enrichment.market;
  if (!dex.available && ens.available) {
    notes.push('DexScreener market data unavailable; provider market data used as fallback.');
  }

  const fieldSources: Record<string, string> = {};
  const pick = (field: string, primary: number | null, fallback: number | null): number | null => {
    if (primary != null && Number.isFinite(primary)) {
      fieldSources[field] = 'dexscreener';
      return primary;
    }
    if (fallback != null && Number.isFinite(fallback)) {
      fieldSources[field] = ens.provider ?? 'provider';
      return fallback;
    }
    return null;
  };

  const market: MarketObservation = {
    priceUsd: pick('priceUsd', dex.priceUsd, ens.priceUsd),
    liquidityUsd: pick('liquidityUsd', dex.liquidityUsd, ens.liquidityUsd),
    volume24hUsd: pick('volume24hUsd', dex.volume24hUsd, ens.volume24hUsd),
    volume6hUsd: dexDetail.extras.volume6hUsd,
    buys24h: dexDetail.extras.buys24h,
    sells24h: dexDetail.extras.sells24h,
    priceChange24hPct: pick('priceChange24hPct', dex.priceChange24hPct, ens.priceChange24hPct),
    marketCapUsd: pick('marketCapUsd', dex.marketCapUsd, ens.marketCapUsd),
    fdvUsd: pick('fdvUsd', dex.fdvUsd, ens.fdvUsd),
    provider: dex.available ? 'dexscreener' : (ens.provider ?? null),
    sourceRef: dex.sourceRef ?? ens.sourceRef,
    available: dex.available || ens.available,
    fieldSources,
    notes: [...dex.notes],
  };

  const regime = deps.marketReference ? await deps.marketReference.fetchRegime(chain) : null;
  if (!regime) {
    notes.push('No regime provider configured; market regime unavailable.');
  }

  const balanceByWallet = new Map(enrichment.walletBalances.map((entry) => [entry.wallet, entry.balance]));
  const flow30ByWallet = new Map(
    (enrichment.walletFlow30d ?? []).map((entry) => [entry.wallet, entry.netTokenFlow]),
  );

  const smartMoney: SmartMoneyWalletFlow[] = enrichment.walletActivity.map((activity) => ({
    wallet: activity.wallet,
    netFlow24h: activity.netTokenFlow,
    balance: balanceByWallet.get(activity.wallet) ?? null,
    flow30d: flow30ByWallet.get(activity.wallet) ?? null,
    notes: activity.sampleLimitNote ? [activity.sampleLimitNote] : [],
  }));
  for (const wallet of smartMoneyWallets) {
    if (!smartMoney.some((entry) => entry.wallet === wallet)) {
      notes.push(`24h activity missing for wallet ${wallet}; flow treated as unknown.`);
      smartMoney.push({
        wallet,
        netFlow24h: null,
        balance: balanceByWallet.get(wallet) ?? null,
        flow30d: flow30ByWallet.get(wallet) ?? null,
        notes: [],
      });
    }
  }

  return {
    chain,
    tokenAddress,
    symbol: enrichment.metadata.symbol,
    observedAt: now.toISOString(),
    enrichmentProvider: enrichment.provider,
    enrichment,
    market,
    regime,
    smartMoney,
    holders: {
      censusComplete: enrichment.holders.censusComplete === true,
      top100ConcentrationPercent: enrichment.holders.top100ConcentrationPercent ?? null,
    },
    notes,
  };
}
