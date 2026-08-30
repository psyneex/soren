/**
 * Nansen-style compact number parsing and formatting.
 *
 * Accepts values such as: `5B`, `320M`, `1.4B`, `850K`, `$5.2M`, `2,500`, `-1.2M`, `42`.
 * Normalizes them to full numeric values. Invalid or empty values return `null`
 * so that callers can distinguish "not provided" from a numeric zero.
 */

const COMPACT_MULTIPLIERS: Record<string, number> = {
  k: 1e3,
  m: 1e6,
  b: 1e9,
  t: 1e12,
};

export function parseCompactNumber(input: unknown): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;

  let text = String(input).trim();
  if (!text) return null;

  // Remove thousands separators and an optional leading currency symbol.
  text = text.replace(/,/g, '').replace(/^\s*[$€£]\s*/, '').trim();
  if (!text) return null;

  const match = text.match(/^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*([kKmMbBtT])?$/);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = (match[2] ?? '').toLowerCase();
  const multiplier = COMPACT_MULTIPLIERS[suffix] ?? 1;
  const result = value * multiplier;
  return Number.isFinite(result) ? result : null;
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trimDecimals(value / 1e12)}T`;
  if (abs >= 1e9) return `${trimDecimals(value / 1e9)}B`;
  if (abs >= 1e6) return `${trimDecimals(value / 1e6)}M`;
  if (abs >= 1e3) return `${trimDecimals(value / 1e3)}K`;
  return trimDecimals(value);
}

export function formatUsdAmount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `$${Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)}`;
}

function trimDecimals(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}