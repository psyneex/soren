import { describe, expect, it } from 'vitest';
import { advanceWatchState } from '../src/domain/signal-engine.js';
import { TRIPLE_BARRIER_V0 } from '../src/domain/config.js';
import type { FormulaEvaluation, GateEvaluation, SignalEngineInput } from '../src/domain/types.js';

const NOW = '2026-08-30T12:00:00Z';

function scored(score: number): FormulaEvaluation {
  return {
    status: 'SCORED',
    score,
    interpretation: score >= 80 ? 'BUY_CANDIDATE' : score >= 65 ? 'WATCH' : 'IGNORE',
    missing: [],
    formulaVersion: 'golden_formula_v0',
    formulaParams: { weights: {}, thresholds: { buyCandidate: 80, watch: 65, exit: 50 } },
  };
}

function incomplete(): FormulaEvaluation {
  return {
    status: 'INCOMPLETE',
    score: null,
    interpretation: null,
    missing: ['relativeStrength'],
    formulaVersion: 'golden_formula_v0',
    formulaParams: { weights: {}, thresholds: { buyCandidate: 80, watch: 65, exit: 50 } },
  };
}

function gates(verdict: GateEvaluation['verdict']): GateEvaluation {
  return {
    verdict,
    gateVersion: 'risk_gates_v0',
    gates: [{ gate: 'liquidity', verdict, value: 100_000, threshold: 25_000, notes: [] }],
  };
}

function input(overrides: Partial<SignalEngineInput>): SignalEngineInput {
  return {
    previousState: 'NEW',
    evaluation: scored(70),
    gates: gates('PASS'),
    priceUsd: 5,
    entry: null,
    now: NOW,
    ...overrides,
  };
}

describe('advanceWatchState (state-based signal generation)', () => {
  it('starts a BUY_CANDIDATE episode only when the score, gates, and price all qualify', () => {
    const output = advanceWatchState(
      input({ previousState: 'NEW', evaluation: scored(90), gates: gates('PASS'), priceUsd: 5 }),
    );
    expect(output.state).toBe('BUY_CANDIDATE');
    expect(output.transition.changed).toBe(true);
    expect(output.episode.started).toBe(true);
    expect(output.episode.entryPrice).toBe(5);
    expect(output.episode.entryAt).toBe(NOW);
  });

  it('blocks a BUY CANDIDATE on gate failure even with a 90+ score', () => {
    const output = advanceWatchState(
      input({ previousState: 'NEW', evaluation: scored(95), gates: gates('FAIL'), priceUsd: 5 }),
    );
    expect(output.state).toBe('INVALIDATED');
  });

  it('keeps a WATCH token on WATCH in the IGNORE band without emitting a transition', () => {
    const output = advanceWatchState(input({ previousState: 'WATCH', evaluation: scored(40) }));
    expect(output.state).toBe('WATCH');
    expect(output.transition.changed).toBe(false);
  });

  it('stays in the current state when the evaluation is INCOMPLETE (state preserved, no event)', () => {
    const output = advanceWatchState(
      input({
        previousState: 'BUY_CANDIDATE',
        evaluation: incomplete(),
        priceUsd: 4.2, // inside the ±barriers so protection does not trigger
        entry: { price: 4, at: '2026-08-30T10:00:00Z' },
      }),
    );
    expect(output.state).toBe('BUY_CANDIDATE');
    expect(output.transition.changed).toBe(false);
    expect(output.episode.ended).toBe(false);
    expect(TRIPLE_BARRIER_V0.targetPct).toBe(0.15);
    expect(TRIPLE_BARRIER_V0.stopPct).toBe(-0.08);
    expect(TRIPLE_BARRIER_V0.horizonHours).toBe(48);
  });

  it('emits STOP_LOSS before any score consideration once the stop barrier is breached', () => {
    const output = advanceWatchState(
      input({
        previousState: 'BUY_CANDIDATE',
        evaluation: scored(95),
        gates: gates('PASS'),
        priceUsd: 3.5, // -12.5% vs the 4.0 entry; stop is -8%
        entry: { price: 4, at: '2026-08-30T10:00:00Z' },
      }),
    );
    expect(output.state).toBe('STOP_LOSS');
    expect(output.transition.reason).toBe('stop_barrier_reached');
    expect(output.episode.ended).toBe(true);
  });

  it('emits TAKE_PROFIT on target reached even while the score has already decayed', () => {
    const output = advanceWatchState(
      input({
        previousState: 'BUY_CANDIDATE',
        evaluation: scored(30),
        gates: gates('PASS'),
        priceUsd: 4.7, // +17.5% vs the 4.0 entry; target is +15%
        entry: { price: 4, at: '2026-08-30T10:00:00Z' },
      }),
    );
    expect(output.state).toBe('TAKE_PROFIT');
    expect(output.episode.ended).toBe(true);
  });

  it('transitions a degraded tracked token to ACTIVE_WATCH (not EXIT) while score >= exit', () => {
    const output = advanceWatchState(
      input({
        previousState: 'BUY_CANDIDATE',
        evaluation: scored(60),
        gates: gates('PASS'),
        priceUsd: 4.2,
        entry: { price: 4, at: '2026-08-30T10:00:00Z' },
      }),
    );
    expect(output.state).toBe('ACTIVE_WATCH');
    expect(output.episode.started).toBe(false);
    expect(output.episode.ended).toBe(false);
  });

  it('EXITs a previously-BUY token when the score falls below the exit threshold', () => {
    const output = advanceWatchState(
      input({
        previousState: 'BUY_CANDIDATE',
        evaluation: scored(35),
        gates: gates('PASS'),
        priceUsd: 4.2,
        entry: { price: 4, at: '2026-08-30T10:00:00Z' },
      }),
    );
    expect(output.state).toBe('EXIT');
    expect(output.transition.reason).toBe('score_below_exit_threshold');
    expect(output.episode.ended).toBe(true);
  });

  it('emits HOLD when the barrier horizon expires without a barrier hit', () => {
    const output = advanceWatchState(
      input({
        previousState: 'ACTIVE_WATCH',
        evaluation: scored(70),
        gates: gates('PASS'),
        priceUsd: 4.1,
        entry: { price: 4, at: '2026-08-27T00:00:00Z' }, // > 48h before now
      }),
    );
    expect(output.state).toBe('HOLD');
    expect(output.episode.ended).toBe(true);
    expect(output.episode.endReason).toBe('horizon_expired');
  });

  it('resumes watchlist monitoring from episode-ending states', () => {
    const output = advanceWatchState(input({ previousState: 'EXIT', evaluation: scored(70), priceUsd: 5 }));
    expect(output.state).toBe('WATCH');
    expect(output.transition.changed).toBe(true);
  });
});