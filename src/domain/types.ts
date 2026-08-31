/**
 * Domain model shared by the feature engine, Golden Formula, risk gates,
 * signal engine, and the triple-barrier outcome evaluator. Pure data — no
 * provider or infrastructure assumptions.
 */

// ---------------------------------------------------------------------------
// Watch states (AGENTS.md Signal Model)
// ---------------------------------------------------------------------------

/**
 * NEW           — on the watchlist, never scored yet (internal).
 * WATCH         — scored 65–79 (WATCH interpretation band).
 * BUY_CANDIDATE — scored >= 80 with all risk gates passing; starts a tracked episode.
 * ACTIVE_WATCH  — tracked episode continuing with degraded (50–79) score.
 * HOLD          — entry thesis expired after the barrier horizon without a barrier hit.
 * TAKE_PROFIT   — target barrier reached.
 * STOP_LOSS     — stop barrier reached.
 * EXIT          — tracked episode deteriorated (score below exit threshold).
 * INVALIDATED   — risk gates failed (invalid data, illiquidity, abnormal conditions).
 */
export type WatchState =
  | 'NEW'
  | 'WATCH'
  | 'BUY_CANDIDATE'
  | 'ACTIVE_WATCH'
  | 'HOLD'
  | 'TAKE_PROFIT'
  | 'STOP_LOSS'
  | 'EXIT'
  | 'INVALIDATED';

/** States that own an open tracked episode with an entry reference price. */
export function isTrackedState(state: WatchState): boolean {
  return state === 'BUY_CANDIDATE' || state === 'ACTIVE_WATCH';
}

/** Episode-ending states; the next scored evaluation starts fresh. */
export function isEpisodeEndedState(state: WatchState): boolean {
  return (
    state === 'HOLD' ||
    state === 'TAKE_PROFIT' ||
    state === 'STOP_LOSS' ||
    state === 'EXIT' ||
    state === 'INVALIDATED'
  );
}

// ---------------------------------------------------------------------------
// Feature engine
// ---------------------------------------------------------------------------

export type FeatureComponentName =
  | 'smartMoneyAccumulation'
  | 'accumulationAcceleration'
  | 'relativeStrength'
  | 'volumeConfirmation'
  | 'marketRegime';

export const FEATURE_COMPONENTS: readonly FeatureComponentName[] = [
  'smartMoneyAccumulation',
  'accumulationAcceleration',
  'relativeStrength',
  'volumeConfirmation',
  'marketRegime',
];

export interface ComponentResult {
  component: FeatureComponentName;
  /** Normalized 0–100 value; null when UNAVAILABLE (missing data is never fabricated). */
  value: number | null;
  status: 'OK' | 'UNAVAILABLE';
  /** Provenance of every input used (or required-but-missing). */
  inputs: Record<string, unknown>;
  notes: string[];
}

export interface FeatureVector {
  components: Record<FeatureComponentName, ComponentResult>;
}

// ---------------------------------------------------------------------------
// Golden Formula
// ---------------------------------------------------------------------------

export type Interpretation = 'BUY_CANDIDATE' | 'WATCH' | 'IGNORE';

export interface FormulaEvaluation {
  status: 'SCORED' | 'INCOMPLETE';
  /** 0–100. An interpretable proxy for P(target before stop within horizon) — not a probability. */
  score: number | null;
  interpretation: Interpretation | null;
  missing: FeatureComponentName[];
  formulaVersion: string;
  formulaParams: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Risk gates (independent of the opportunity score)
// ---------------------------------------------------------------------------

export type GateVerdict = 'PASS' | 'FAIL' | 'INCOMPLETE';

export interface GateResult {
  gate: string;
  verdict: GateVerdict;
  value: number | null;
  threshold: number | null;
  notes: string[];
}

export interface GateEvaluation {
  verdict: GateVerdict;
  gates: GateResult[];
  gateVersion: string;
}

// ---------------------------------------------------------------------------
// Signal engine
// ---------------------------------------------------------------------------

export interface StateTransition {
  from: WatchState;
  to: WatchState;
  changed: boolean;
  reason: string;
}

export interface EpisodeChange {
  started: boolean;
  ended: boolean;
  endReason: string | null;
  /** Entry reference for a newly started episode (null when none started). */
  entryPrice: number | null;
  entryAt: string | null;
}

export interface SignalEngineInput {
  previousState: WatchState;
  evaluation: FormulaEvaluation;
  gates: GateEvaluation;
  priceUsd: number | null;
  /** Open episode reference; null when no episode is tracked. */
  entry: { price: number; at: string } | null;
  now: string;
}

export interface SignalEngineOutput {
  state: WatchState;
  transition: StateTransition;
  episode: EpisodeChange;
}

// ---------------------------------------------------------------------------
// Triple-barrier outcome evaluation
// ---------------------------------------------------------------------------

export interface BarrierSnapshot {
  observedAt: string;
  priceUsd: number;
}

export interface TripleBarrierResult {
  status: 'PENDING' | 'TARGET_HIT' | 'STOP_HIT' | 'TIMEOUT';
  outcomeAt: string | null;
  outcomePriceUsd: number | null;
  timeToOutcomeMinutes: number | null;
  mfePct: number | null;
  maePct: number | null;
  returnPct: number | null;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Observation views consumed by the feature engine
// ---------------------------------------------------------------------------

/** Merged market observation (DexScreener primary, provider fallback per field). */
export interface MarketObservation {
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  volume6hUsd: number | null;
  buys24h: number | null;
  sells24h: number | null;
  priceChange24hPct: number | null;
  marketCapUsd: number | null;
  fdvUsd: number | null;
  provider: string | null;
  sourceRef: string | null;
  available: boolean;
  /** Which provider supplied each field — explicit per-field provenance. */
  fieldSources: Record<string, string>;
  notes: string[];
}

/** Market-regime reference data (BTC / chain-native / broad market). */
export interface RegimeObservation {
  available: boolean;
  btcChange24hPct: number | null;
  btcChange7dPct: number | null;
  nativeChange24hPct: number | null;
  totalMarketCapChange24hPct: number | null;
  /** 24h change of the chain's benchmark (native) asset used by relative strength. */
  benchmarkChange24hPct: number | null;
  benchmarkId: string | null;
  provider: string | null;
  observedAt: string;
  notes: string[];
}

/** Per-wallet Smart Money view distilled from the enrichment. */
export interface SmartMoneyWalletFlow {
  wallet: string;
  /** 24h net token flow; null = unknown (never treated as zero). */
  netFlow24h: number | null;
  /** Current token balance; null = unknown. */
  balance: number | null;
  /** Optional bounded 30-day net flow; null when unavailable. */
  flow30d: number | null;
  notes: string[];
}

/** Holder concentration inputs for the risk gates. */
export interface HolderConcentration {
  censusComplete: boolean;
  top100ConcentrationPercent: number | null;
}

/** One prior snapshot reduced to the values the feature engine may reuse. */
export interface HistoryPoint {
  observedAt: string;
  priceUsd: number | null;
  netFlow24h: number | null;
  totalSmartBalance: number | null;
}
