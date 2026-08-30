/**
 * Versioned, immutable scoring / gate / barrier parameters.
 *
 * AGENTS.md: "Store formula version and parameters with every score. Do not
 * silently change weights or thresholds." Changing any value here requires a
 * new version id plus a documented hypothesis test against stored historical
 * snapshots. Thresholds are experimental parameters, not established facts.
 */

export interface GoldenFormulaConfig {
  id: string;
  weights: {
    smartMoneyAccumulation: number;
    accumulationAcceleration: number;
    relativeStrength: number;
    volumeConfirmation: number;
    marketRegime: number;
  };
  thresholds: {
    /** score >= buyCandidate → BUY CANDIDATE (80–100). */
    buyCandidate: number;
    /** score >= watch → WATCH (65–79); below → IGNORE. */
    watch: number;
    /** A tracked episode whose score falls below this emits EXIT. */
    exit: number;
  };
}

/** Golden Formula V0 — exactly as specified in AGENTS.md. */
export const GOLDEN_FORMULA_V0: GoldenFormulaConfig = {
  id: 'golden_formula_v0',
  weights: {
    smartMoneyAccumulation: 0.3,
    accumulationAcceleration: 0.2,
    relativeStrength: 0.2,
    volumeConfirmation: 0.15,
    marketRegime: 0.15,
  },
  thresholds: { buyCandidate: 80, watch: 65, exit: 50 },
};

export interface RiskGatesConfig {
  id: string;
  /** DEX liquidity in USD below which a token fails the liquidity gate. */
  minLiquidityUsd: number;
  /** Top-100 holder share (percent, complete census only) above which the concentration gate fails. */
  maxTop100ConcentrationPercent: number;
  /** 24h price change at or below this percent is an abnormal market condition. */
  max24hCrashPercent: number;
}

export const RISK_GATES_V0: RiskGatesConfig = {
  id: 'risk_gates_v0',
  minLiquidityUsd: 25_000,
  maxTop100ConcentrationPercent: 85,
  max24hCrashPercent: -60,
};

export interface TripleBarrierConfig {
  id: string;
  /** Take-profit barrier as a fraction of the entry reference price. */
  targetPct: number;
  /** Stop barrier as a (negative) fraction of the entry reference price. */
  stopPct: number;
  /** Evaluation horizon in hours; the first barrier inside the horizon decides. */
  horizonHours: number;
}

/** Initial experimental research labels (AGENTS.md: target +15%, stop −8%, 48h). */
export const TRIPLE_BARRIER_V0: TripleBarrierConfig = {
  id: 'triple_barrier_v0',
  targetPct: 0.15,
  stopPct: -0.08,
  horizonHours: 48,
};

export interface FeatureConfig {
  id: string;
  /** Score points per 1 percentage point of relative outperformance vs the chain benchmark. */
  relativeStrengthPerPoint: number;
  /** Daily turnover fraction (volume24h / liquidity) that maps to a neutral 50. */
  turnoverHalfSaturation: number;
  /** Score points per 1.0 of daily accumulation-rate delta (acceleration). */
  accumulationRateScale: number;
  /** Score points applied to volume-trend ratio deviations from 1. */
  volumeTrendSensitivity: number;
  regime: {
    btc: number;
    native: number;
    broad: number;
    changePerPoint: number;
    volatilityThresholdPct: number;
    volatilityFullPenaltyPct: number;
    volatilityPenaltyMax: number;
  };
  accumulation: { position: number; direction: number; conviction: number };
  volume: { turnover: number; trend: number; confirmation: number };
  /** How far back previous snapshots may be used for cross-snapshot acceleration. */
  historyLookbackDays: number;
  /** Minimum age of a history point used as the prior accumulation-rate observation. */
  accelerationMinLagHours: number;
}

export const FEATURE_CONFIG_V0: FeatureConfig = {
  id: 'feature_config_v0',
  relativeStrengthPerPoint: 2.5,
  turnoverHalfSaturation: 0.1,
  accumulationRateScale: 1000,
  volumeTrendSensitivity: 50,
  regime: {
    btc: 0.4,
    native: 0.3,
    broad: 0.3,
    changePerPoint: 2.5,
    volatilityThresholdPct: 15,
    volatilityFullPenaltyPct: 50,
    volatilityPenaltyMax: 10,
  },
  accumulation: { position: 0.45, direction: 0.35, conviction: 0.2 },
  volume: { turnover: 0.4, trend: 0.3, confirmation: 0.3 },
  historyLookbackDays: 14,
  accelerationMinLagHours: 1,
};
