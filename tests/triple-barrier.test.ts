import { describe, expect, it } from 'vitest';
import { evaluateTripleBarrier } from '../src/domain/triple-barrier.js';
import { TRIPLE_BARRIER_V0 } from '../src/domain/config.js';
import type { BarrierSnapshot } from '../src/domain/types.js';

const ENTRY = { priceUsd: 10, entryAt: '2026-08-28T00:00:00Z' };

function at(daysAfterEntry: number, price: number): BarrierSnapshot {
  return {
    observedAt: new Date(Date.parse(ENTRY.entryAt) + daysAfterEntry * 86_400_000).toISOString(),
    priceUsd: price,
  };
}

describe('evaluateTripleBarrier', () => {
  it('uses the initial experimental parameters: +15% target, -8% stop, 48h horizon', () => {
    expect(TRIPLE_BARRIER_V0).toEqual({ id: 'triple_barrier_v0', targetPct: 0.15, stopPct: -0.08, horizonHours: 48 });
  });

  it('labels TARGET_HIT when the target barrier is the first reached', () => {
    const result = evaluateTripleBarrier(ENTRY, [at(1, 11.6)], TRIPLE_BARRIER_V0, at(2, 11.6).observedAt);
    expect(result.status).toBe('TARGET_HIT');
    expect(result.timeToOutcomeMinutes).toBe(60 * 24);
    expect(result.outcomePriceUsd).toBe(11.6);
    expect(result.returnPct).toBeCloseTo(16, 0);
  });

  it('labels STOP_HIT when the stop barrier is the first reached', () => {
    const result = evaluateTripleBarrier(ENTRY, [at(0.5, 9.1)], TRIPLE_BARRIER_V0, at(1, 9.1).observedAt);
    expect(result.status).toBe('STOP_HIT');
    expect(result.mfePct).toBeGreaterThanOrEqual(result.maePct as number);
  });

  it('labels TIMEOUT when the horizon elapses without either barrier', () => {
    const points = [at(1, 10.5), at(2, 9.5)];
    const now = at(3, 9.5).observedAt;
    const result = evaluateTripleBarrier(ENTRY, points, TRIPLE_BARRIER_V0, now);
    expect(result.status).toBe('TIMEOUT');
    expect(result.timeToOutcomeMinutes).toBe(48 * 60);
    expect(result.mfePct).toBeCloseTo(5, 0);
    expect(result.maePct).toBeCloseTo(-5, 0);
  });

  it('is PENDING inside the horizon before either barrier is reached', () => {
    const now = at(1, 10.2).observedAt;
    const result = evaluateTripleBarrier(ENTRY, [at(0.5, 10.1)], TRIPLE_BARRIER_V0, now);
    expect(result.status).toBe('PENDING');
  });

  it('never reads observations BEFORE the entry or AFTER the horizon (no look-ahead)', () => {
    const now = at(1, 10.0).observedAt;
    const result = evaluateTripleBarrier(
      ENTRY,
      [at(-1, 15), at(1.5, 11.0), at(4, 13)], // before-entry, in-horizon (no breach), past-horizon
      TRIPLE_BARRIER_V0,
      now,
    );
    // The before-entry point (+50%) and the past-horizon point (+30%) must be
    // ignored; the only in-window point (+10%) did not breach +15%, so the
    // episode stays PENDING instead of being labeled by future/past data.
    expect(result.status).toBe('PENDING');
    expect(TRIPLE_BARRIER_V0.targetPct).toBe(0.15);
  });

  it('records a stop as soon as the price breaches the -8% stop barrier', () => {
    const now = at(1, 8.0).observedAt;
    const result = evaluateTripleBarrier(ENTRY, [at(0.5, 8.0)], TRIPLE_BARRIER_V0, now);
    // 8.0 is -20%: an observation this far through the barrier implies the
    // stop was crossed; the evaluator labels it conservatively.
    expect(result.status).toBe('STOP_HIT');
    expect(result.maePct).toBeCloseTo(-20, 0);
  });
});