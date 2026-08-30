import { describe, expect, it } from 'vitest';
import { GOLDEN_FORMULA_V0 } from '../src/domain/config.js';
import { scoreGoldenFormula } from '../src/domain/golden-formula.js';
import { computeFeatures } from '../src/domain/features.js';
import type { FeatureComponentName, MarketObservation, RegimeObservation, SmartMoneyWalletFlow } from '../src/domain/types.js';

const WALLET_A = '86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY';
const WALLET_B = 'BhZRhq7AhE4LPnZP1hvDvpC5pSQtGN8kGGV5E1NQkRaj';

function okComponent(name: FeatureComponentName, value: number) {
  return {
    component: name,
    value,
    status: 'OK' as const,
    inputs: {},
    notes: [],
  };
}

function market(overrides: Partial<MarketObservation> = {}): MarketObservation {
  return {
    priceUsd: 5,
    liquidityUsd: 250_000,
    volume24hUsd: 100_000,
    volume6hUsd: 20_000,
    buys24h: 120,
    sells24h: 90,
    priceChange24hPct: 5,
    marketCapUsd: 1_000_000,
    fdvUsd: 2_000_000,
    provider: 'dexscreener',
    sourceRef: 'pair-1',
    available: true,
    fieldSources: {},
    notes: [],
    ...overrides,
  };
}

function regime(): RegimeObservation {
  return {
    available: true,
    btcChange24hPct: 1,
    btcChange7dPct: 3,
    nativeChange24hPct: 2,
    totalMarketCapChange24hPct: 1.5,
    benchmarkChange24hPct: 2,
    benchmarkId: 'solana',
    provider: 'coingecko',
    observedAt: '2026-08-30T12:00:00Z',
    notes: [],
  };
}

function smartMoney(): SmartMoneyWalletFlow[] {
  return [
    { wallet: WALLET_A, netFlow24h: 500, balance: 10_000, flow30d: 9000, notes: [] },
    { wallet: WALLET_B, netFlow24h: -100, balance: 5_000, flow30d: -5000, notes: [] },
  ];
}

const NOW = '2026-08-30T12:00:00Z';

describe('Golden Formula V0', () => {
  it('implements the exact AGENTS.md weights', () => {
    expect(GOLDEN_FORMULA_V0.weights).toEqual({
      smartMoneyAccumulation: 0.3,
      accumulationAcceleration: 0.2,
      relativeStrength: 0.2,
      volumeConfirmation: 0.15,
      marketRegime: 0.15,
    });
  });

  it('returns INCOMPLETE (no fabricated score) when any component is unavailable', () => {
    const evaluation = scoreGoldenFormula({
      components: {
        smartMoneyAccumulation: okComponent('smartMoneyAccumulation', 90),
        accumulationAcceleration: { component: 'accumulationAcceleration', value: null, status: 'UNAVAILABLE', inputs: {}, notes: [] },
        relativeStrength: okComponent('relativeStrength', 50),
        volumeConfirmation: okComponent('volumeConfirmation', 50),
        marketRegime: okComponent('marketRegime', 50),
      },
    });
    expect(evaluation.status).toBe('INCOMPLETE');
    expect(evaluation.score).toBeNull();
    expect(evaluation.missing).toEqual(['accumulationAcceleration']);
  });

  it('applies the experimental thresholds: >=80 BUY CANDIDATE, >=65 WATCH, else IGNORE', () => {
    const make = (value: number) => ({
      components: {
        smartMoneyAccumulation: okComponent('smartMoneyAccumulation', value),
        accumulationAcceleration: okComponent('accumulationAcceleration', value),
        relativeStrength: okComponent('relativeStrength', value),
        volumeConfirmation: okComponent('volumeConfirmation', value),
        marketRegime: okComponent('marketRegime', value),
      },
    });
    expect(scoreGoldenFormula(make(90)).interpretation).toBe('BUY_CANDIDATE');
    expect(scoreGoldenFormula(make(70)).interpretation).toBe('WATCH');
    expect(scoreGoldenFormula(make(40)).interpretation).toBe('IGNORE');
    expect(scoreGoldenFormula(make(90)).score).toBe(90);
  });

  it('computes the weighted score from the full feature pipeline', () => {
    const features = computeFeatures({
      market: market(),
      regime: regime(),
      smartMoney: smartMoney(),
      history: [],
      now: NOW,
    });
    const evaluation = scoreGoldenFormula(features);
    expect(evaluation.status).toBe('SCORED');
    expect(evaluation.score).toBeGreaterThanOrEqual(0);
    expect(evaluation.score).toBeLessThanOrEqual(100);
  });
});

describe('Feature engine', () => {
  it('computes all five components deterministically when data is complete', () => {
    const features = computeFeatures({
      market: market(),
      regime: regime(),
      smartMoney: smartMoney(),
      history: [
        { observedAt: '2026-08-29T12:00:00Z', priceUsd: 4, netFlow24h: 300, totalSmartBalance: 14_000 },
      ],
      now: NOW,
    });
    expect(Object.values(features.components).map((c) => c.status)).toEqual(['OK', 'OK', 'OK', 'OK', 'OK']);
  });

  it('handles a too-recent snapshot without fabricating acceleration', () => {
    const features = computeFeatures({
      market: market(),
      regime: regime(),
      smartMoney: [
        // No 30d baseline: acceleration must come from prior snapshot history.
        { wallet: WALLET_A, netFlow24h: 500, balance: 10_000, flow30d: null, notes: [] },
        { wallet: WALLET_B, netFlow24h: -100, balance: 5_000, flow30d: null, notes: [] },
      ],
      history: [
        { observedAt: '2026-08-30T11:30:00Z', priceUsd: 4, netFlow24h: 300, totalSmartBalance: 14_000 },
      ],
      now: NOW,
    });
    // Only 30 minutes of lag: the snapshot is too fresh to be a comparable
    // prior rate observation, so acceleration stays UNAVAILABLE rather than invented.
    expect(features.components.accumulationAcceleration.status).toBe('UNAVAILABLE');
  });

  it('never fabricates missing Smart Money flow into zero', () => {
    const features = computeFeatures({
      market: market(),
      regime: regime(),
      smartMoney: [
        { wallet: WALLET_A, netFlow24h: null, balance: null, flow30d: null, notes: ['lookup failed'] },
        { wallet: WALLET_B, netFlow24h: null, balance: null, flow30d: null, notes: ['lookup failed'] },
      ],
      history: [],
      now: NOW,
    });
    expect(features.components.smartMoneyAccumulation.status).toBe('UNAVAILABLE');
  });
});