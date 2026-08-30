import { describe, expect, it } from 'vitest';
import { evaluateRiskGates } from '../src/domain/risk-gates.js';
import type { MarketObservation, HolderConcentration, GateEvaluation } from '../src/domain/types.js';

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

function holders(overrides: Partial<HolderConcentration> = {}): HolderConcentration {
  return { censusComplete: true, top100ConcentrationPercent: 30, ...overrides };
}

function verdict(g: GateEvaluation): GateEvaluation['verdict'] {
  return g.verdict;
}

describe('evaluateRiskGates', () => {
  it('PASSES when liquidity, concentration, data validity, and conditions are healthy', () => {
    const result = evaluateRiskGates(market(), holders());
    expect(result.verdict).toBe('PASS');
    expect(result.gateVersion).toBe('risk_gates_v0');
    expect(result.gates.every((gate) => gate.verdict === 'PASS')).toBe(true);
  });

  it('FAILs a BUY candidate regardless of score on insufficient liquidity', () => {
    const result = evaluateRiskGates(market({ liquidityUsd: 5_000 }), holders());
    expect(result.verdict).toBe('FAIL');
    expect(result.gates.find((gate) => gate.gate === 'liquidity')?.verdict).toBe('FAIL');
  });

  it('FAILs on extreme concentration only when a complete census makes it measurable', () => {
    const result = evaluateRiskGates(market(), holders({ censusComplete: true, top100ConcentrationPercent: 98 }));
    expect(result.verdict).toBe('FAIL');
    expect(result.gates.find((gate) => gate.gate === 'holder_concentration')?.verdict).toBe('FAIL');
  });

  it('reports concentration as INCOMPLETE (never fail/pass) without a complete census', () => {
    const result = evaluateRiskGates(market(), holders({ censusComplete: false, top100ConcentrationPercent: null }));
    expect(result.gates.find((gate) => gate.gate === 'holder_concentration')?.verdict).toBe('INCOMPLETE');
    expect(verdict(result)).toBe('INCOMPLETE');
  });

  it('FAILs on abnormal market conditions (crash) independent of score', () => {
    const result = evaluateRiskGates(market({ priceChange24hPct: -70 }), holders());
    expect(result.verdict).toBe('FAIL');
    expect(result.gates.find((gate) => gate.gate === 'abnormal_conditions')?.verdict).toBe('FAIL');
  });

  it('FAILs on invalid provider data (no usable price)', () => {
    const result = evaluateRiskGates(
      market({ available: false, priceUsd: null, provider: null, sourceRef: null }),
      holders(),
    );
    expect(result.verdict).toBe('FAIL');
  });

  it('never converts an unavailable market into a pass', () => {
    const result = evaluateRiskGates(
      market({ available: false, liquidityUsd: null, priceUsd: null, priceChange24hPct: null }),
      holders({ censusComplete: false, top100ConcentrationPercent: null }),
    );
    // No gate PASSES vacuously: everything either FAILs or is INCOMPLETE.
    expect(result.verdict).toBe('FAIL');
    expect(result.gates.some((gate) => gate.verdict === 'PASS')).toBe(false);
  });
});