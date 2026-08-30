/**
 * Independent risk gates (AGENTS.md: "Risk is separate from the opportunity
 * score. A dangerous condition must be able to reject a BUY candidate
 * regardless of its score.").
 *
 * Verdicts: PASS / FAIL / INCOMPLETE. Missing inputs never fail silently into
 * a pass — they are reported as INCOMPLETE, and a BUY candidate requires every
 * gate to PASS. Concentration is only judged when a complete holder census
 * made it reliably measurable.
 */
import { RISK_GATES_V0, type RiskGatesConfig } from './config.js';
import type { GateEvaluation, GateResult, HolderConcentration, MarketObservation } from './types.js';

export function evaluateRiskGates(
  market: MarketObservation,
  holders: HolderConcentration,
  config: RiskGatesConfig = RISK_GATES_V0,
): GateEvaluation {
  const gates: GateResult[] = [];

  // 1. Liquidity.
  if (typeof market.liquidityUsd === 'number' && market.liquidityUsd >= 0) {
    const passed = market.liquidityUsd >= config.minLiquidityUsd;
    gates.push({
      gate: 'liquidity',
      verdict: passed ? 'PASS' : 'FAIL',
      value: market.liquidityUsd,
      threshold: config.minLiquidityUsd,
      notes: passed ? [] : [`DEX liquidity ${market.liquidityUsd} USD is below the ${config.minLiquidityUsd} USD minimum.`],
    });
  } else {
    gates.push({
      gate: 'liquidity',
      verdict: 'INCOMPLETE',
      value: null,
      threshold: config.minLiquidityUsd,
      notes: ['Liquidity unavailable; minimum depth could not be verified.'],
    });
  }

  // 2. Extreme concentration — only when reliably measurable (complete census).
  if (holders.censusComplete && typeof holders.top100ConcentrationPercent === 'number') {
    const passed = holders.top100ConcentrationPercent <= config.maxTop100ConcentrationPercent;
    gates.push({
      gate: 'holder_concentration',
      verdict: passed ? 'PASS' : 'FAIL',
      value: holders.top100ConcentrationPercent,
      threshold: config.maxTop100ConcentrationPercent,
      notes: passed
        ? []
        : [`Top-100 holders control ${holders.top100ConcentrationPercent}% of supply (max ${config.maxTop100ConcentrationPercent}%).`],
    });
  } else {
    gates.push({
      gate: 'holder_concentration',
      verdict: 'INCOMPLETE',
      value: null,
      threshold: config.maxTop100ConcentrationPercent,
      notes: ['Top-100 concentration not reliably measurable (complete holder census required).'],
    });
  }

  // 3. Invalid token / provider data.
  const priceValid =
    market.available &&
    typeof market.priceUsd === 'number' &&
    Number.isFinite(market.priceUsd) &&
    (market.priceUsd as number) > 0;
  gates.push({
    gate: 'market_data_validity',
    verdict: priceValid ? 'PASS' : 'FAIL',
    value: typeof market.priceUsd === 'number' ? market.priceUsd : null,
    threshold: null,
    notes: priceValid
      ? []
      : ['Market observation is missing or invalid for this token/provider combination.'],
  });

  // 4. Abnormal market conditions (crash).
  if (typeof market.priceChange24hPct === 'number') {
    const abnormal = market.priceChange24hPct <= config.max24hCrashPercent;
    gates.push({
      gate: 'abnormal_conditions',
      verdict: abnormal ? 'FAIL' : 'PASS',
      value: market.priceChange24hPct,
      threshold: config.max24hCrashPercent,
      notes: abnormal
        ? [`24h price change ${market.priceChange24hPct}% is an abnormal market condition.`]
        : [],
    });
  } else {
    gates.push({
      gate: 'abnormal_conditions',
      verdict: 'INCOMPLETE',
      value: null,
      threshold: config.max24hCrashPercent,
      notes: ['24h price change unavailable; abnormal-move check could not run.'],
    });
  }

  const verdict = gates.some((gate) => gate.verdict === 'FAIL')
    ? 'FAIL'
    : gates.some((gate) => gate.verdict === 'INCOMPLETE')
      ? 'INCOMPLETE'
      : 'PASS';

  return { verdict, gates, gateVersion: config.id };
}
