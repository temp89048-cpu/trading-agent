import type { OptimizerResult } from './optimizer';
import type { MonteCarloResult } from './monteCarlo';
import type { TunableParams } from './tunableStrategy';

// A single number ("Profit: £12,430") tells you nothing about whether
// that profit is trustworthy. This combines three INDEPENDENT signals
// already computed elsewhere in this app into one composite read:
//   1. Walk-forward consistency — do the winning params + their
//      out-of-sample performance agree across folds, or scatter?
//   2. Parameter sensitivity — how tight is the robust range (from the
//      optimizer) relative to the grid searched?
//   3. Monte Carlo robustness — does resampling the actual trades
//      suggest the historical path was typical, or a lucky outlier?
//
// This is explicitly a HEURISTIC composite (documented as such in the
// output, not just in this comment) — it's meant to flag "look closer
// here" or "this looks solid," not to replace judgment with one number
// masquerading as ground truth. Any of its three inputs being
// unavailable (e.g. Monte Carlo not run) degrades the score honestly
// rather than assuming a passing grade for the missing piece.

export type StabilityInputs = {
  optimizer?: OptimizerResult;
  monteCarlo?: MonteCarloResult;
};

export type StabilityBand = 'Low' | 'Medium' | 'High' | 'Excellent';
export type Recommendation = 'Deploy' | 'Deploy with caution' | 'Do not deploy' | 'Insufficient data';

export type StabilityScore = {
  overallScore: number | null; // 0-100, null if nothing usable was supplied
  walkForwardBand: StabilityBand | 'Unavailable';
  parameterSensitivityBand: StabilityBand | 'Unavailable';
  monteCarloBand: StabilityBand | 'Unavailable';
  recommendation: Recommendation;
  reasons: string[];
  isHeuristic: true; // present in the type itself so a consumer can't accidentally forget this isn't a statistically validated single metric
};

function scoreWalkForward(optimizer?: OptimizerResult): { score: number | null; band: StabilityBand | 'Unavailable'; reason: string } {
  if (!optimizer) return { score: null, band: 'Unavailable', reason: 'No optimizer run supplied.' };
  const withResults = optimizer.folds.filter((f) => f.testMetrics !== null);
  if (withResults.length < 2) {
    return { score: 20, band: 'Low', reason: `Only ${withResults.length} fold(s) produced an out-of-sample result — can't assess consistency from fewer than 2.` };
  }
  const objective = optimizer.objective;
  const testScores = withResults.map((f) => f.testMetrics![objective]).filter((v): v is number => typeof v === 'number' && isFinite(v));
  if (testScores.length < 2) return { score: 20, band: 'Low', reason: 'Out-of-sample objective values were not comparable across folds.' };

  const positiveFraction = testScores.filter((v) => v > 0).length / testScores.length;
  const mean = testScores.reduce((a, b) => a + b, 0) / testScores.length;
  const variance = testScores.reduce((a, b) => a + (b - mean) ** 2, 0) / testScores.length;
  const cv = mean !== 0 ? Math.sqrt(variance) / Math.abs(mean) : Infinity; // coefficient of variation — lower = more consistent across folds

  // Blend: half credit for "did most folds even stay positive out of
  // sample," half credit for "how consistent is the magnitude."
  const consistencyScore = Math.max(0, 100 - Math.min(100, cv * 50));
  const score = positiveFraction * 50 + consistencyScore * 0.5;
  const band: StabilityBand = score >= 80 ? 'Excellent' : score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low';
  return { score, band, reason: `${(positiveFraction * 100).toFixed(0)}% of folds stayed positive out-of-sample; coefficient of variation ${cv === Infinity ? 'n/a' : cv.toFixed(2)}.` };
}

function scoreParameterSensitivity(optimizer?: OptimizerResult): { score: number | null; band: StabilityBand | 'Unavailable'; reason: string } {
  if (!optimizer || !optimizer.robustRanges) {
    return { score: null, band: 'Unavailable', reason: 'No robust parameter range available (fewer than 2 folds found a winner).' };
  }
  const keys: (keyof TunableParams)[] = ['emaFast', 'emaSlow', 'rsiThreshold', 'atrMultiplier', 'rewardRiskRatio'];
  const spreads: number[] = [];
  for (const key of keys) {
    const r = optimizer.robustRanges[key];
    if (!r || r.max === 0) continue;
    spreads.push((r.max - r.min) / r.max); // normalized spread, 0 = every fold picked the exact same value
  }
  if (spreads.length === 0) return { score: null, band: 'Unavailable', reason: 'No comparable parameter spreads.' };
  const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;
  const score = Math.max(0, 100 - avgSpread * 150);
  const band: StabilityBand = score >= 80 ? 'Excellent' : score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low';
  return { score, band, reason: `Average normalized spread of winning parameters across folds: ${(avgSpread * 100).toFixed(0)}% (0% = every fold agreed exactly).` };
}

function scoreMonteCarlo(mc?: MonteCarloResult): { score: number | null; band: StabilityBand | 'Unavailable'; reason: string } {
  if (!mc) return { score: null, band: 'Unavailable', reason: 'No Monte Carlo simulation supplied.' };
  // Reward: low risk of ruin, and a tight-ish gap between p5 and p95
  // outcomes relative to the median (a strategy whose simulated outcomes
  // range from "ruin" to "10x" on the same trade statistics is not
  // "stable" even if its point-estimate return looked good).
  const ruinPenalty = Math.min(100, mc.riskOfRuinPct * 2);
  const spread = mc.finalEquityPct.p95 - mc.finalEquityPct.p5;
  const medianMagnitude = Math.max(Math.abs(mc.finalEquityPct.p50), 10);
  const spreadRatio = spread / medianMagnitude;
  const spreadPenalty = Math.min(60, spreadRatio * 10);
  const score = Math.max(0, 100 - ruinPenalty - spreadPenalty);
  const band: StabilityBand = score >= 80 ? 'Excellent' : score >= 60 ? 'High' : score >= 35 ? 'Medium' : 'Low';
  return { score, band, reason: `${mc.riskOfRuinPct.toFixed(1)}% risk of ruin across ${mc.simulations} resamples; p5-p95 outcome spread ${spread.toFixed(0)} points around a ${mc.finalEquityPct.p50.toFixed(0)}% median.` };
}

export function computeStabilityScore(inputs: StabilityInputs): StabilityScore {
  const wf = scoreWalkForward(inputs.optimizer);
  const ps = scoreParameterSensitivity(inputs.optimizer);
  const mc = scoreMonteCarlo(inputs.monteCarlo);

  const available = [wf, ps, mc].filter((x) => x.score !== null) as { score: number }[];
  const overallScore = available.length > 0 ? available.reduce((s, x) => s + x.score, 0) / available.length : null;

  let recommendation: Recommendation;
  if (overallScore === null) {
    recommendation = 'Insufficient data';
  } else if (mc.score !== null && mc.score < 30) {
    recommendation = 'Do not deploy'; // a real risk-of-ruin signal overrides an otherwise decent-looking score
  } else if (overallScore >= 65) {
    recommendation = 'Deploy';
  } else if (overallScore >= 40) {
    recommendation = 'Deploy with caution';
  } else {
    recommendation = 'Do not deploy';
  }

  return {
    overallScore,
    walkForwardBand: wf.band,
    parameterSensitivityBand: ps.band,
    monteCarloBand: mc.band,
    recommendation,
    reasons: [wf.reason, ps.reason, mc.reason],
    isHeuristic: true,
  };
}
