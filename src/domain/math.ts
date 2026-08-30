/**
 * Shared numeric helpers for deterministic 0–100 scoring.
 */
export function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function roundScore(value: number): number {
  return Math.round(value * 100) / 100;
}
