/**
 * Triple-Barrier-style outcome evaluator (AGENTS.md Entry/Exit Research Model).
 *
 * Initial experimental parameters: target +15%, stop −8%, horizon 48h. The
 * first barrier reached inside the horizon determines the outcome label. The
 * evaluator only consumes observations strictly AFTER the entry time and
 * within the horizon — future information can never leak into an evaluation
 * made before it exists (no look-ahead).
 *
 * Excursion bounds (MFE/MAE) are measured on the snapshot price series and are
 * therefore bounded by the observation cadence; this is disclosed rather than
 * smoothed over.
 */
import { TRIPLE_BARRIER_V0, type TripleBarrierConfig } from './config.js';
import { roundScore } from './math.js';
import type { BarrierSnapshot, TripleBarrierResult } from './types.js';

export function evaluateTripleBarrier(
  entry: { priceUsd: number; entryAt: string },
  snapshots: readonly BarrierSnapshot[],
  config: TripleBarrierConfig = TRIPLE_BARRIER_V0,
  now: string,
): TripleBarrierResult {
  const entryMs = Date.parse(entry.entryAt);
  const horizonMs = entryMs + config.horizonHours * 3_600_000;

  const inWindow = snapshots
    .filter((snapshot) => {
      const at = Date.parse(snapshot.observedAt);
      return (
        Number.isFinite(at) &&
        at > entryMs &&
        at <= horizonMs &&
        Number.isFinite(snapshot.priceUsd) &&
        snapshot.priceUsd > 0
      );
    })
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));

  const targetPrice = entry.priceUsd * (1 + config.targetPct);
  const stopPrice = entry.priceUsd * (1 + config.stopPct);

  let mfe: number | null = null;
  let mae: number | null = null;
  for (const snapshot of inWindow) {
    const move = (snapshot.priceUsd - entry.priceUsd) / entry.priceUsd;
    mfe = mfe == null ? move : Math.max(mfe, move);
    mae = mae == null ? move : Math.min(mae, move);
  }

  const notes: string[] = [];

  if (inWindow.length === 0) {
    if (Date.parse(now) >= horizonMs) {
      return {
        status: 'TIMEOUT',
        outcomeAt: new Date(horizonMs).toISOString(),
        outcomePriceUsd: null,
        timeToOutcomeMinutes: config.horizonHours * 60,
        mfePct: null,
        maePct: null,
        returnPct: null,
        notes: ['Horizon elapsed with no in-horizon price observations; timeout recorded without excursion data.'],
      };
    }
    return {
      status: 'PENDING',
      outcomeAt: null,
      outcomePriceUsd: null,
      timeToOutcomeMinutes: null,
      mfePct: null,
      maePct: null,
      returnPct: null,
      notes: ['Awaiting in-horizon observations.'],
    };
  }

  const pct = (fraction: number) => roundScore(fraction * 100);

  for (const snapshot of inWindow) {
    const hitStop = snapshot.priceUsd <= stopPrice;
    const hitTarget = snapshot.priceUsd >= targetPrice;
    const shared: Omit<TripleBarrierResult, 'status'> = {
      outcomeAt: snapshot.observedAt,
      outcomePriceUsd: snapshot.priceUsd,
      timeToOutcomeMinutes: roundScore((Date.parse(snapshot.observedAt) - entryMs) / 60_000),
      mfePct: pct(mfe as number),
      maePct: pct(mae as number),
      returnPct: pct((snapshot.priceUsd - entry.priceUsd) / entry.priceUsd),
      notes,
    };
    // First barrier reached decides; if both sit inside one observation the
    // stop is recorded first (conservative labeling, explicitly noted).
    if (hitStop) {
      if (hitTarget) {
        notes.push('Target and stop thresholds were both inside this observation; the stop is recorded first (conservative).');
      }
      return { status: 'STOP_HIT', ...shared };
    }
    if (hitTarget) {
      return { status: 'TARGET_HIT', ...shared };
    }
  }

  if (Date.parse(now) >= horizonMs) {
    const last = inWindow[inWindow.length - 1];
    notes.push('Horizon elapsed without either barrier; timeout at the last in-horizon observation.');
    return {
      status: 'TIMEOUT',
      outcomeAt: last.observedAt,
      outcomePriceUsd: last.priceUsd,
      timeToOutcomeMinutes: roundScore((Date.parse(last.observedAt) - entryMs) / 60_000),
      mfePct: pct(mfe as number),
      maePct: pct(mae as number),
      returnPct: pct((last.priceUsd - entry.priceUsd) / entry.priceUsd),
      notes,
    };
  }

  return {
    status: 'PENDING',
    outcomeAt: null,
    outcomePriceUsd: null,
    timeToOutcomeMinutes: null,
    mfePct: pct(mfe as number),
    maePct: pct(mae as number),
    returnPct: null,
    notes: ['Within horizon; neither barrier reached yet.'],
  };
}
