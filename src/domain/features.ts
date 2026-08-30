/**
 * Feature engine — deterministic, pure calculations for the five Golden
 * Formula feature groups, computed from the current observation plus prior
 * snapshot history (AGENTS.md Feature Engine).
 *
 * Missing data yields status UNAVAILABLE with provenance notes; values are
 * never fabricated and unavailable data is never converted to zero. All
 * components are normalized to 0–100.
 */
import { FEATURE_CONFIG_V0, type FeatureConfig } from './config.js';
import { clamp01, clampScore, roundScore } from './math.js';
import type {
  ComponentResult,
  FeatureComponentName,
  FeatureVector,
  HistoryPoint,
  MarketObservation,
  RegimeObservation,
  SmartMoneyWalletFlow,
} from './types.js';

function ok(
  component: FeatureComponentName,
  value: number,
  inputs: Record<string, unknown>,
  notes: string[],
): ComponentResult {
  return { component, value: roundScore(clampScore(value)), status: 'OK', inputs, notes };
}

function unavailable(
  component: FeatureComponentName,
  inputs: Record<string, unknown>,
  notes: string[],
): ComponentResult {
  return { component, value: null, status: 'UNAVAILABLE', inputs, notes };
}

/** Weighted mean of scored sub-parts; weights renormalized over available parts (explicit partial coverage). */
function combine(parts: Array<{ key: string; weight: number; value: number }>): {
  value: number;
  contributions: Record<string, number>;
} {
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  const value = parts.reduce((sum, part) => sum + (part.value * part.weight) / totalWeight, 0);
  const contributions: Record<string, number> = {};
  for (const part of parts) contributions[part.key] = roundScore(part.value);
  return { value, contributions };
}

function aggregateBalances(smartMoney: readonly SmartMoneyWalletFlow[]): number | null {
  const balances = smartMoney
    .map((entry) => entry.balance)
    .filter((balance): balance is number => typeof balance === 'number');
  return balances.length > 0 ? balances.reduce((sum, balance) => sum + balance, 0) : null;
}

/**
 * Daily accumulation rate normalized by the aggregate Smart Money position:
 * net flow divided by max(balance, |net|), bounded to [-1, 1]. Scale-free so
 * tokens of different magnitudes stay comparable.
 */
function accumulationRate(net: number, balance: number | null): number {
  return net / Math.max(balance ?? 0, Math.abs(net), 1e-12);
}

// ---------------------------------------------------------------------------
// 1. Smart Money Accumulation (weight 0.30)
// ---------------------------------------------------------------------------

export function computeSmartMoneyAccumulation(
  smartMoney: readonly SmartMoneyWalletFlow[],
  config: FeatureConfig = FEATURE_CONFIG_V0,
): ComponentResult {
  const known = smartMoney.filter((entry) => typeof entry.netFlow24h === 'number');
  if (known.length === 0) {
    return unavailable(
      'smartMoneyAccumulation',
      { wallets: smartMoney.map((entry) => entry.wallet) },
      ['No Smart Money wallet reported a numeric 24h net flow; the aggregate is withheld rather than substituted.'],
    );
  }

  const totalNet = known.reduce((sum, entry) => sum + (entry.netFlow24h as number), 0);
  const totalBalance = aggregateBalances(smartMoney);

  // Direction: share of wallets accumulating (flat wallets count as neutral 0.5).
  const inflowCount = known.filter((entry) => (entry.netFlow24h as number) > 0).length;
  const flatCount = known.filter((entry) => (entry.netFlow24h as number) === 0).length;
  const directionScore = (100 * (inflowCount + 0.5 * flatCount)) / known.length;

  // Conviction: volume-weighted share of flow that is accumulation.
  const inflowVolume = known.reduce((sum, entry) => sum + Math.max(0, entry.netFlow24h as number), 0);
  const outflowVolume = known.reduce(
    (sum, entry) => sum + Math.max(0, -(entry.netFlow24h as number)),
    0,
  );
  const convictionScore =
    inflowVolume + outflowVolume > 0
      ? (100 * inflowVolume) / (inflowVolume + outflowVolume)
      : 50;

  const parts: Array<{ key: string; weight: number; value: number }> = [
    { key: 'direction', weight: config.accumulation.direction, value: directionScore },
    { key: 'conviction', weight: config.accumulation.conviction, value: convictionScore },
  ];

  // Position change: net flow relative to the aggregate position.
  if (totalBalance != null) {
    const positionChange = totalNet / Math.max(totalBalance, Math.abs(totalNet), 1e-12);
    parts.push({ key: 'position', weight: config.accumulation.position, value: ((positionChange + 1) / 2) * 100 });
  }

  const { value, contributions } = combine(parts);
  const notes = [
    `24h net token flow across ${known.length} tracked wallet(s): ${inflowCount} accumulating, ` +
      `${known.length - inflowCount - flatCount} distributing, ${flatCount} flat.`,
  ];
  if (totalBalance == null) {
    notes.push('Aggregate balance unknown; the position-change sub-score was omitted instead of estimated.');
  }

  return ok(
    'smartMoneyAccumulation',
    value,
    {
      windowHours: 24,
      wallets: smartMoney.map((entry) => ({
        wallet: entry.wallet,
        netFlow24h: entry.netFlow24h,
        balance: entry.balance,
      })),
      totalNet24h: totalNet,
      totalBalance,
      contributions,
    },
    notes,
  );
}

// ---------------------------------------------------------------------------
// 2. Accumulation Acceleration (weight 0.20)
// ---------------------------------------------------------------------------

export function computeAccumulationAcceleration(
  smartMoney: readonly SmartMoneyWalletFlow[],
  history: readonly HistoryPoint[],
  now: string,
  config: FeatureConfig = FEATURE_CONFIG_V0,
): ComponentResult {
  const inputs: Record<string, unknown> = { historyPoints: history.length };
  const known = smartMoney.filter((entry) => typeof entry.netFlow24h === 'number');
  if (known.length === 0) {
    return unavailable('accumulationAcceleration', inputs, [
      'No numeric 24h flow for any tracked wallet; accumulation acceleration unavailable.',
    ]);
  }
  const totalNet = known.reduce((sum, entry) => sum + (entry.netFlow24h as number), 0);
  const totalBalance = aggregateBalances(smartMoney);
  if (totalBalance == null) {
    return unavailable(
      'accumulationAcceleration',
      { ...inputs, totalNet24h: totalNet },
      ['Aggregate Smart Money balance unknown; the accumulation rate cannot be normalized.'],
    );
  }
  const rateNow = accumulationRate(totalNet, totalBalance);

  // Path A — rate change vs the most recent comparable prior snapshot.
  const nowMs = Date.parse(now);
  const lookbackMs = config.historyLookbackDays * 86_400_000;
  const minLagMs = config.accelerationMinLagHours * 3_600_000;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = history[index];
    const ageMs = nowMs - Date.parse(point.observedAt);
    if (ageMs > lookbackMs) break; // history is ascending; everything older is out of window
    if (ageMs < minLagMs) continue; // too fresh / future-dated points are skipped
    if (point.netFlow24h == null || point.totalSmartBalance == null) continue;
    const ratePrev = accumulationRate(point.netFlow24h, point.totalSmartBalance);
    const delta = rateNow - ratePrev;
    return ok(
      'accumulationAcceleration',
      50 + delta * config.accumulationRateScale,
      { ...inputs, path: 'history', rateNow, ratePrev, delta, priorObservedAt: point.observedAt },
      [
        `Accumulation-rate change vs the prior snapshot from ${point.observedAt}: ` +
          `${roundScore(delta * 10000) / 100}pp of position per day.`,
      ],
    );
  }

  // Path B — within-snapshot: 24h rate vs the 30-day baseline daily rate.
  // Only when the bounded 30-day flow is complete for every tracked wallet.
  const flow30dKnown = smartMoney.filter((entry) => typeof entry.flow30d === 'number');
  if (smartMoney.length > 0 && flow30dKnown.length === smartMoney.length) {
    const flow30dTotal = flow30dKnown.reduce((sum, entry) => sum + (entry.flow30d as number), 0);
    const baselineDaily = flow30dTotal / 30;
    const rateBaseline = accumulationRate(baselineDaily, totalBalance);
    const delta = rateNow - rateBaseline;
    return ok(
      'accumulationAcceleration',
      50 + delta * config.accumulationRateScale,
      { ...inputs, path: 'flow30d', rateNow, rateBaseline, delta },
      ['Accumulation-rate change vs the 30-day baseline daily rate (bounded Helius flow).'],
    );
  }

  return unavailable(
    'accumulationAcceleration',
    { ...inputs, rateNow },
    [
      'No comparable prior snapshot within the lookback window and no complete 30-day baseline; acceleration withheld.',
    ],
  );
}

// ---------------------------------------------------------------------------
// 3. Relative Strength (weight 0.20)
// ---------------------------------------------------------------------------

export function computeRelativeStrength(
  market: MarketObservation,
  regime: RegimeObservation | null,
  config: FeatureConfig = FEATURE_CONFIG_V0,
): ComponentResult {
  const tokenChange = market.priceChange24hPct;
  const benchmarkChange = regime?.benchmarkChange24hPct ?? null;
  const inputs = {
    tokenChange24hPct: tokenChange,
    benchmarkChange24hPct: benchmarkChange,
    benchmarkId: regime?.benchmarkId ?? null,
    benchmarkProvider: regime?.provider ?? null,
  };

  if (typeof tokenChange !== 'number' || typeof benchmarkChange !== 'number') {
    return unavailable('relativeStrength', inputs, [
      typeof tokenChange !== 'number'
        ? 'Token 24h price change unavailable.'
        : 'Benchmark 24h change unavailable; relative strength requires a market reference and was withheld instead of using the absolute token return.',
    ]);
  }

  const relativePoints = tokenChange - benchmarkChange;
  return ok(
    'relativeStrength',
    50 + relativePoints * config.relativeStrengthPerPoint,
    { ...inputs, relativePoints },
    [
      `Token 24h change ${roundScore(tokenChange)}pp vs benchmark ${roundScore(benchmarkChange)}pp → relative ${roundScore(relativePoints)}pp.`,
    ],
  );
}

// ---------------------------------------------------------------------------
// 4. Volume Confirmation (weight 0.15)
// ---------------------------------------------------------------------------

export function computeVolumeConfirmation(
  market: MarketObservation,
  config: FeatureConfig = FEATURE_CONFIG_V0,
): ComponentResult {
  const parts: Array<{ key: string; weight: number; value: number }> = [];
  const liquidity = market.liquidityUsd;
  const volume24 = market.volume24hUsd;

  // Relative volume: daily turnover vs DEX depth (saturating curve).
  if (typeof liquidity === 'number' && liquidity > 0 && typeof volume24 === 'number' && volume24 >= 0) {
    const turnover = volume24 / liquidity;
    parts.push({
      key: 'turnover',
      weight: config.volume.turnover,
      value: (100 * turnover) / (turnover + config.turnoverHalfSaturation),
    });
  }

  // Volume change: recent 6h rate vs the 24h average rate.
  if (typeof volume24 === 'number' && volume24 > 0 && typeof market.volume6hUsd === 'number' && market.volume6hUsd >= 0) {
    const trendRatio = market.volume6hUsd / 6 / Math.max(volume24 / 24, 1e-9);
    parts.push({
      key: 'trend',
      weight: config.volume.trend,
      value: clampScore(config.volumeTrendSensitivity + (trendRatio - 1) * config.volumeTrendSensitivity),
    });
  }

  // Price/volume confirmation: taker buy/sell balance aligned with price direction.
  if (
    typeof market.buys24h === 'number' &&
    typeof market.sells24h === 'number' &&
    market.buys24h + market.sells24h > 0 &&
    typeof market.priceChange24hPct === 'number'
  ) {
    const netTakerRatio = (market.buys24h - market.sells24h) / (market.buys24h + market.sells24h);
    const priceDirection = (market.priceChange24hPct as number) >= 0 ? 1 : -1;
    parts.push({
      key: 'confirmation',
      weight: config.volume.confirmation,
      value: clampScore(50 + 50 * netTakerRatio * priceDirection),
    });
  }

  if (parts.length === 0) {
    return unavailable(
      'volumeConfirmation',
      {
        liquidityUsd: liquidity,
        volume24hUsd: volume24,
        volume6hUsd: market.volume6hUsd,
        buys24h: market.buys24h,
        sells24h: market.sells24h,
      },
      ['Volume confirmation requires DEX liquidity/volume/transaction data; no sub-part could be computed.'],
    );
  }

  const { value, contributions } = combine(parts);
  const contributed = parts.map((part) => part.key).join(', ');
  return ok(
    'volumeConfirmation',
    value,
    {
      liquidityUsd: liquidity,
      volume24hUsd: volume24,
      volume6hUsd: market.volume6hUsd,
      buys24h: market.buys24h,
      sells24h: market.sells24h,
      contributions,
      partsUsed: contributed,
    },
    [`Sub-parts computed: ${contributed}; weights renormalized over available parts.`],
  );
}

// ---------------------------------------------------------------------------
// 5. Market Regime (weight 0.15)
// ---------------------------------------------------------------------------

export function computeMarketRegime(
  regime: RegimeObservation | null,
  config: FeatureConfig = FEATURE_CONFIG_V0,
): ComponentResult {
  const inputs: Record<string, unknown> = {
    provider: regime?.provider ?? null,
    observedAt: regime?.observedAt ?? null,
  };
  if (!regime) {
    return unavailable('marketRegime', inputs, ['No market-regime observation was collected this cycle.']);
  }

  const map = (change: number) => 50 + change * config.regime.changePerPoint;
  const parts: Array<{ key: string; weight: number; value: number }> = [];
  if (typeof regime.btcChange24hPct === 'number') {
    parts.push({ key: 'btc', weight: config.regime.btc, value: map(regime.btcChange24hPct) });
  }
  if (typeof regime.nativeChange24hPct === 'number') {
    parts.push({ key: 'native', weight: config.regime.native, value: map(regime.nativeChange24hPct) });
  }
  if (typeof regime.totalMarketCapChange24hPct === 'number') {
    parts.push({ key: 'broad', weight: config.regime.broad, value: map(regime.totalMarketCapChange24hPct) });
  }

  if (parts.length === 0) {
    return unavailable('marketRegime', { ...inputs, regimeNotes: regime.notes }, [
      'All regime reference inputs (BTC, chain-native, broad market) were unavailable.',
      ...regime.notes,
    ]);
  }

  const { value, contributions } = combine(parts);

  // Volatility penalty from extreme BTC weekly moves.
  let penalty = 0;
  if (typeof regime.btcChange7dPct === 'number') {
    const span = config.regime.volatilityFullPenaltyPct - config.regime.volatilityThresholdPct;
    penalty =
      clamp01((Math.abs(regime.btcChange7dPct) - config.regime.volatilityThresholdPct) / span) *
      config.regime.volatilityPenaltyMax;
  }

  const notes: string[] = [];
  if (parts.length < 3) {
    notes.push(`Regime renormalized over ${parts.length}/3 available reference inputs (explicit partial coverage).`);
  }
  if (penalty > 0) {
    notes.push(
      `Volatility penalty −${roundScore(penalty)} from |BTC 7d change| ${roundScore(Math.abs(regime.btcChange7dPct as number))}%.`,
    );
  }

  return ok(
    'marketRegime',
    value - penalty,
    { ...inputs, contributions, btcChange7dPct: regime.btcChange7dPct, volatilityPenalty: roundScore(penalty) },
    notes,
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

export interface FeatureComputationInput {
  market: MarketObservation;
  regime: RegimeObservation | null;
  smartMoney: readonly SmartMoneyWalletFlow[];
  /** Prior snapshots, ascending by observedAt — never includes the current observation. */
  history: readonly HistoryPoint[];
  now: string;
  config?: FeatureConfig;
}

export function computeFeatures(input: FeatureComputationInput): FeatureVector {
  const config = input.config ?? FEATURE_CONFIG_V0;
  return {
    components: {
      smartMoneyAccumulation: computeSmartMoneyAccumulation(input.smartMoney, config),
      accumulationAcceleration: computeAccumulationAcceleration(input.smartMoney, input.history, input.now, config),
      relativeStrength: computeRelativeStrength(input.market, input.regime, config),
      volumeConfirmation: computeVolumeConfirmation(input.market, config),
      marketRegime: computeMarketRegime(input.regime, config),
    },
  };
}
