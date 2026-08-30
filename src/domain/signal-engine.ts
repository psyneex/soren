/**
 * State-based signal generation (AGENTS.md Signal Model).
 *
 * Signals are state transitions, not repeated scores: a Telegram event and a
 * signal_events row are only produced when the watch state actually changes.
 * A token that previously generated a BUY signal stays continuously evaluated,
 * so deterioration produces EXIT / STOP_LOSS / INVALIDATED transitions.
 *
 * Evaluation order (deterministic):
 *   1. Barrier monitoring for tracked episodes (target/stop) — independent of
 *      feature availability so protection never depends on scoring inputs.
 *   2. Horizon expiry → HOLD (thesis timed out without a barrier).
 *   3. Risk-gate failure → INVALIDATED (independent of the score).
 *   4. INCOMPLETE evaluation → previous state preserved, no event.
 *   5. Score bands: >= buy keeps/starts BUY_CANDIDATE; >= exit keeps tracking
 *      as ACTIVE_WATCH; below exit emits EXIT; untracked tokens enter
 *      WATCH/BUY_CANDIDATE from the interpretation bands.
 */
import { TRIPLE_BARRIER_V0, GOLDEN_FORMULA_V0, type TripleBarrierConfig } from './config.js';
import { isTrackedState } from './types.js';
import type {
  EpisodeChange,
  SignalEngineInput,
  SignalEngineOutput,
  StateTransition,
  WatchState,
} from './types.js';

function transitionTo(from: WatchState, to: WatchState, reason: string): StateTransition {
  return { from, to, changed: from !== to, reason };
}

function stay(from: WatchState, reason: string): StateTransition {
  return { from, to: from, changed: false, reason };
}

export function advanceWatchState(
  input: SignalEngineInput,
  barrier: TripleBarrierConfig = TRIPLE_BARRIER_V0,
): SignalEngineOutput {
  const { previousState, evaluation, gates, priceUsd, entry, now } = input;
  const tracked = isTrackedState(previousState);
  const episode: EpisodeChange = {
    started: false,
    ended: false,
    endReason: null,
    entryPrice: null,
    entryAt: null,
  };

  // 1. Barriers first: protection is data-dependent, never score-dependent.
  if (tracked && entry && typeof priceUsd === 'number' && priceUsd > 0) {
    if (priceUsd <= entry.price * (1 + barrier.stopPct)) {
      episode.ended = true;
      episode.endReason = 'stop_barrier_reached';
      return {
        state: 'STOP_LOSS',
        transition: transitionTo(previousState, 'STOP_LOSS', 'stop_barrier_reached'),
        episode,
      };
    }
    if (priceUsd >= entry.price * (1 + barrier.targetPct)) {
      episode.ended = true;
      episode.endReason = 'target_barrier_reached';
      return {
        state: 'TAKE_PROFIT',
        transition: transitionTo(previousState, 'TAKE_PROFIT', 'target_barrier_reached'),
        episode,
      };
    }
  }

  // 2. Horizon expiry: the entry thesis timed out without either barrier.
  if (tracked && entry) {
    const elapsedHours = (Date.parse(now) - Date.parse(entry.at)) / 3_600_000;
    if (elapsedHours >= barrier.horizonHours) {
      episode.ended = true;
      episode.endReason = 'horizon_expired';
      return {
        state: 'HOLD',
        transition: transitionTo(previousState, 'HOLD', 'horizon_expired'),
        episode,
      };
    }
  }

  // 3. Risk gates are independent of the score; a failure invalidates.
  if (gates.verdict === 'FAIL') {
    const failing = gates.gates
      .filter((gate) => gate.verdict === 'FAIL')
      .map((gate) => gate.gate)
      .join('+');
    if (previousState === 'INVALIDATED') {
      return { state: previousState, transition: stay(previousState, 'risk_gates_still_failing'), episode };
    }
    if (tracked) {
      episode.ended = true;
      episode.endReason = 'risk_gate_failed';
    }
    return {
      state: 'INVALIDATED',
      transition: transitionTo(previousState, 'INVALIDATED', `risk_gate_failed:${failing}`),
      episode,
    };
  }

  // 4. INCOMPLETE evaluation: keep the previous state and emit nothing.
  if (evaluation.status === 'INCOMPLETE') {
    return { state: previousState, transition: stay(previousState, 'evaluation_incomplete'), episode };
  }

  // 5. Score-driven transitions using the thresholds of the evaluated formula version.
  const thresholds =
    (evaluation.formulaParams['thresholds'] as { buyCandidate: number; watch: number; exit: number }) ??
    GOLDEN_FORMULA_V0.thresholds;
  const score = evaluation.score as number;

  if (tracked) {
    if (score >= thresholds.buyCandidate) {
      return {
        state: 'BUY_CANDIDATE',
        transition: transitionTo(previousState, 'BUY_CANDIDATE', 'score_sustained_above_buy_threshold'),
        episode,
      };
    }
    if (score >= thresholds.exit) {
      return {
        state: 'ACTIVE_WATCH',
        transition: transitionTo(previousState, 'ACTIVE_WATCH', 'tracked_score_below_buy_threshold'),
        episode,
      };
    }
    episode.ended = true;
    episode.endReason = 'score_below_exit_threshold';
    return {
      state: 'EXIT',
      transition: transitionTo(previousState, 'EXIT', 'score_below_exit_threshold'),
      episode,
    };
  }

  // Untracked states: NEW | WATCH | HOLD | episode-ended.
  const priceValid = typeof priceUsd === 'number' && priceUsd > 0;
  if (score >= thresholds.buyCandidate) {
    if (gates.verdict === 'PASS' && priceValid) {
      episode.started = true;
      episode.entryPrice = priceUsd as number;
      episode.entryAt = now;
      return {
        state: 'BUY_CANDIDATE',
        transition: transitionTo(previousState, 'BUY_CANDIDATE', 'buy_candidate_qualified'),
        episode,
      };
    }
    // High score but gates not fully passed or no valid price: stay on the radar.
    return {
      state: 'WATCH',
      transition: transitionTo(previousState, 'WATCH', 'buy_blocked_by_gates_or_missing_price'),
      episode,
    };
  }
  if (score >= thresholds.watch) {
    return { state: 'WATCH', transition: transitionTo(previousState, 'WATCH', 'watch_band'), episode };
  }

  // IGNORE band: NEW and WATCH hold their state; ended episodes resume monitoring.
  if (previousState === 'NEW' || previousState === 'WATCH') {
    return { state: previousState, transition: stay(previousState, 'ignore_band'), episode };
  }
  return {
    state: 'WATCH',
    transition: transitionTo(previousState, 'WATCH', 'watchlist_resume_after_episode'),
    episode,
  };
}
