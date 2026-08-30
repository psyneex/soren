/**
 * Golden Formula V0 (AGENTS.md):
 *
 *   GoldenScore =
 *     0.30 * SmartMoneyAccumulation +
 *     0.20 * AccumulationAcceleration +
 *     0.20 * RelativeStrength +
 *     0.15 * VolumeConfirmation +
 *     0.15 * MarketRegime
 *
 * Every component is normalized to 0–100 by the feature engine. When any
 * component is unavailable the evaluation is INCOMPLETE — a score is never
 * invented from partial inputs. The score is an interpretable proxy for
 * P(target reached before stop within horizon); it is not a probability.
 */
import { GOLDEN_FORMULA_V0, type GoldenFormulaConfig } from './config.js';
import { clampScore, roundScore } from './math.js';
import { FEATURE_COMPONENTS, type FeatureVector, type FormulaEvaluation, type Interpretation } from './types.js';

export function scoreGoldenFormula(
  features: FeatureVector,
  formula: GoldenFormulaConfig = GOLDEN_FORMULA_V0,
): FormulaEvaluation {
  const weightTotal = Object.values(formula.weights).reduce((sum, weight) => sum + weight, 0);
  if (Math.abs(weightTotal - 1) > 1e-9) {
    throw new Error(`Golden Formula weights must sum to 1 (got ${weightTotal})`);
  }

  const missing = FEATURE_COMPONENTS.filter(
    (name) => features.components[name].status === 'UNAVAILABLE',
  );
  const formulaParams = {
    weights: { ...formula.weights },
    thresholds: { ...formula.thresholds },
  };

  if (missing.length > 0) {
    return {
      status: 'INCOMPLETE',
      score: null,
      interpretation: null,
      missing,
      formulaVersion: formula.id,
      formulaParams,
    };
  }

  const raw = FEATURE_COMPONENTS.reduce(
    (sum, name) => sum + formula.weights[name] * (features.components[name].value as number),
    0,
  );
  const score = roundScore(clampScore(raw));
  const interpretation: Interpretation =
    score >= formula.thresholds.buyCandidate
      ? 'BUY_CANDIDATE'
      : score >= formula.thresholds.watch
        ? 'WATCH'
        : 'IGNORE';

  return {
    status: 'SCORED',
    score,
    interpretation,
    missing: [],
    formulaVersion: formula.id,
    formulaParams,
  };
}
