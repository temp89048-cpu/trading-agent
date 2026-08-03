import type { CalibrationResult } from './calibration';
import type { StabilityScore } from '../backtest/stabilityScore';
import type { DebateRegimeTag } from './types';

// Design note: calibrateConfidence() already folds "strategy agreement"
// (via the moderator's weighted vote) and "historical agent accuracy"
// (via the confidence-bin empirical win rate) into one empirically-
// grounded number. The remaining factors the roadmap names — regime
// match, backtest stability, Monte Carlo survival, news risk, liquidity
// — are each optional context that this app may or may not have on hand
// at decision time (a Monte Carlo run requires having already backtested
// this exact strategy/symbol, for instance). Rather than averaging seven
// things of wildly different reliability and availability as if they
// were equal-weight peers, calibrated confidence is the BASE (it's the
// one number with real empirical backing), and everything else applies
// a bounded adjustment on top — each capped so no single soft signal can
// swing the number more than a modest, stated amount.

export type CompositeInputs = {
  calibration: CalibrationResult;
  regime: DebateRegimeTag;
  regimeMatchScore: number | null; // 0-1: how well the CURRENT top agents have performed in this exact regime historically; null = not enough regime-specific history yet
  backtestStability?: StabilityScore | null;
  monteCarloRiskOfRuinPct?: number | null;
  newsRiskLevel: 'low' | 'medium' | 'high';
  liquidityOk: boolean | null; // null = unavailable (e.g. equities, no order-flow feed)
  disagreementCount: number; // how many agents took the opposite directional stance
  totalAgents: number;
};

export type CompositeResult = {
  compositeConfidence: number; // 0-1, final, bounded
  riskLevel: 'Low' | 'Medium' | 'High';
  breakdown: { factor: string; detail: string; adjustmentPct: number }[];
};

const MAX_ADJUSTMENT = 0.12; // no single soft factor can move the calibrated base by more than this

export function computeCompositeConfidence(inputs: CompositeInputs): CompositeResult {
  const breakdown: CompositeResult['breakdown'] = [];
  let confidence = inputs.calibration.calibratedConfidence;
  breakdown.push({ factor: 'Calibrated base (agreement + historical accuracy)', detail: inputs.calibration.note, adjustmentPct: 0 });

  if (inputs.regimeMatchScore !== null) {
    const adj = (inputs.regimeMatchScore - 0.5) * 2 * MAX_ADJUSTMENT;
    confidence += adj;
    breakdown.push({ factor: 'Market regime match', detail: `Agents currently weighted have a ${(inputs.regimeMatchScore * 100).toFixed(0)}% historical win rate in the current ${inputs.regime ? `${inputs.regime.trend}/${inputs.regime.vol}` : 'unknown'} regime.`, adjustmentPct: adj * 100 });
  } else {
    breakdown.push({ factor: 'Market regime match', detail: 'Not enough regime-specific history yet — no adjustment applied.', adjustmentPct: 0 });
  }

  if (inputs.backtestStability && inputs.backtestStability.overallScore !== null) {
    const adj = ((inputs.backtestStability.overallScore - 50) / 50) * MAX_ADJUSTMENT;
    confidence += adj;
    breakdown.push({ factor: 'Backtest stability', detail: `Stability score ${inputs.backtestStability.overallScore.toFixed(0)}/100 (${inputs.backtestStability.recommendation}).`, adjustmentPct: adj * 100 });
  } else {
    breakdown.push({ factor: 'Backtest stability', detail: 'No backtest/optimizer stability check run for this strategy — no adjustment applied.', adjustmentPct: 0 });
  }

  if (typeof inputs.monteCarloRiskOfRuinPct === 'number') {
    // Risk-of-ruin only ever penalizes — a LOW risk of ruin doesn't
    // deserve a confidence bonus (that's what the calibrated base is
    // already for), but a HIGH one is a real red flag worth docking for.
    const penalty = inputs.monteCarloRiskOfRuinPct > 20 ? MAX_ADJUSTMENT : inputs.monteCarloRiskOfRuinPct > 10 ? MAX_ADJUSTMENT * 0.5 : 0;
    confidence -= penalty;
    breakdown.push({ factor: 'Monte Carlo survival', detail: `${inputs.monteCarloRiskOfRuinPct.toFixed(1)}% simulated risk of ruin.`, adjustmentPct: -penalty * 100 });
  } else {
    breakdown.push({ factor: 'Monte Carlo survival', detail: 'No Monte Carlo simulation run for this strategy — no adjustment applied.', adjustmentPct: 0 });
  }

  const newsPenalty = inputs.newsRiskLevel === 'high' ? MAX_ADJUSTMENT * 0.6 : inputs.newsRiskLevel === 'medium' ? MAX_ADJUSTMENT * 0.25 : 0;
  confidence -= newsPenalty;
  breakdown.push({ factor: 'News risk', detail: `News/sentiment risk assessed as ${inputs.newsRiskLevel}.`, adjustmentPct: -newsPenalty * 100 });

  if (inputs.liquidityOk === false) {
    confidence -= MAX_ADJUSTMENT * 0.4;
    breakdown.push({ factor: 'Liquidity', detail: 'Order flow shows thin/unfavorable liquidity.', adjustmentPct: -MAX_ADJUSTMENT * 0.4 * 100 });
  } else {
    breakdown.push({ factor: 'Liquidity', detail: inputs.liquidityOk === null ? 'Order flow data not available for this asset — no adjustment applied.' : 'Order flow liquidity looks adequate.', adjustmentPct: 0 });
  }

  const clamped = Math.min(0.98, Math.max(0.05, confidence)); // never claim near-certainty either direction

  // Risk level: driven by real, checkable factors — volatility regime,
  // how much the agents disagree, simulated risk of ruin, and news risk.
  const disagreementFraction = inputs.totalAgents > 0 ? inputs.disagreementCount / inputs.totalAgents : 0;
  const highVol = inputs.regime?.vol === 'high-vol';
  const highRuin = typeof inputs.monteCarloRiskOfRuinPct === 'number' && inputs.monteCarloRiskOfRuinPct > 15;
  let riskLevel: 'Low' | 'Medium' | 'High' = 'Low';
  if (highRuin || inputs.newsRiskLevel === 'high' || (highVol && disagreementFraction >= 0.3)) {
    riskLevel = 'High';
  } else if (highVol || disagreementFraction >= 0.2 || inputs.newsRiskLevel === 'medium') {
    riskLevel = 'Medium';
  }

  return { compositeConfidence: clamped, riskLevel, breakdown };
}

// A simple, clearly-labeled INDICATIVE position size — scaled by the
// composite confidence and derated by risk level. This is not a
// replacement for the Risk Manager's real fixed-fractional/volatility-
// based sizing (Commit 13) — that's still what actually executes — this
// is the "here's roughly the size this evidence supports" figure shown
// alongside the debate explanation, same spirit as the user's example
// ("Suggested Position: 1.5%").
export function suggestPositionPct(compositeConfidence: number, riskLevel: 'Low' | 'Medium' | 'High', basePct: number = 2): number {
  const riskMultiplier = riskLevel === 'High' ? 0.5 : riskLevel === 'Medium' ? 0.75 : 1;
  return Math.round(basePct * compositeConfidence * riskMultiplier * 100) / 100;
}
