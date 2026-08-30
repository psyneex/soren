import { describe, expect, it } from 'vitest';
import { formatCompactNumber, formatUsdAmount, parseCompactNumber } from '../src/research/numeric.js';

describe('parseCompactNumber', () => {
  it('parses Nansen-style compact values', () => {
    expect(parseCompactNumber('5B')).toBe(5e9);
    expect(parseCompactNumber('320M')).toBe(320e6);
    expect(parseCompactNumber('1.4B')).toBe(1.4e9);
    expect(parseCompactNumber('850K')).toBe(850e3);
    expect(parseCompactNumber('$5.2M')).toBe(5.2e6);
    expect(parseCompactNumber('-1.2M')).toBe(-1.2e6);
    expect(parseCompactNumber('1,500')).toBe(1500);
    expect(parseCompactNumber(42)).toBe(42);
  });

  it('returns null for empty, invalid, or non-finite input', () => {
    expect(parseCompactNumber('')).toBeNull();
    expect(parseCompactNumber(null)).toBeNull();
    expect(parseCompactNumber(undefined)).toBeNull();
    expect(parseCompactNumber('abc')).toBeNull();
    expect(parseCompactNumber('1.2.3')).toBeNull();
    expect(parseCompactNumber(Number.NaN)).toBeNull();
  });
});

describe('formatting', () => {
  it('formats compact numbers and USD amounts', () => {
    expect(formatCompactNumber(1.5e9)).toBe('1.5B');
    expect(formatCompactNumber(850e3)).toBe('850K');
    expect(formatCompactNumber(null)).toBe('—');
    expect(formatUsdAmount(1_234_567)).toBe('$1,234,567');
  });
});