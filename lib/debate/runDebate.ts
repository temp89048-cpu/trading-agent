import type { Candle } from '../indicators';
import type { StrategyContext } from '../strategyContext';
import type { SentimentResult } from '../sentimentAgent';
import type { StabilityScore } from '../backtest/stabilityScore';
import { runAllDebateAgents } from './agents';
import { moderate, type ModeratorDecision } from './moderator';
import { computeAgentReputation, reputationToWeights } from './reputation';
import { currentRegime, computeRegimePerformance, regimeAwareWeights } from './regimeAwareness';
import { calibrateConfidence, type CalibrationResult } from './calibration';
import { computeCompositeConfidence, suggestPositionPct, type CompositeResult } from './confidenceComposite';
import type { AgentOpinion, DebateRecord, DebateRegimeTag } from './types';

export type FullDebateResult = {
  opinions: AgentOpinion[];
  moderator: ModeratorDecision;
  regime: DebateRegimeTag;
  calibration: CalibrationResult;
  composite: CompositeResult;
  suggestedPositionPct: number;
};

export function runFullDebate(params: {
  ctx: StrategyContext;
  sentiment: SentimentResult | null;
  historicalRecords: DebateRecord[];
  liveCandles: Candle[];
  backtestStability?: StabilityScore | null;
  monteCarloRiskOfRuinPct?: number | null;
  liquidityOk?: boolean | null;
}): FullDebateResult {
  const opinions = runAllDebateAgents(params.ctx, params.sentiment);

  const overallReputation = computeAgentReputation(params.historicalRecords);
  const overallWeights = reputationToWeights(overallReputation);

  const regime = currentRegime(params.liveCandles);
  const regimePerf = computeRegimePerformance(params.historicalRecords, regime);
  const weights = regimeAwareWeights(regimePerf, overallWeights);

  const moderatorDecision = moderate(opinions, weights);

  const calibration = calibrateConfidence(moderatorDecision.rawConfidence, params.historicalRecords);

  const agreeingAgents = opinions.filter((o) => o.recommendation === moderatorDecision.recommendation).map((o) => o.agent);
  const regimeAccuracies = agreeingAgents.map((a) => regimePerf[a]?.accuracy).filter((a): a is number => a !== null && a !== undefined);
  const regimeMatchScore = regimeAccuracies.length > 0 ? regimeAccuracies.reduce((s, a) => s + a, 0) / regimeAccuracies.length : null;

  const newsOpinion = opinions.find((o) => o.agent === 'news');
  const newsRiskLevel: 'low' | 'medium' | 'high' =
    newsOpinion && newsOpinion.recommendation !== moderatorDecision.recommendation && newsOpinion.confidence >= 0.65
      ? 'high'
      : newsOpinion && newsOpinion.recommendation !== moderatorDecision.recommendation
        ? 'medium'
        : 'low';

  const liquidityOk = params.liquidityOk ?? (params.ctx.orderFlow?.pressure ? params.ctx.orderFlow.pressure.pressure !== (moderatorDecision.recommendation === 'BUY' ? 'sell-heavy' : 'buy-heavy') : null);

  const opposite = moderatorDecision.recommendation === 'BUY' ? 'SELL' : moderatorDecision.recommendation === 'SELL' ? 'BUY' : null;
  const disagreementCount = opposite ? opinions.filter((o) => o.recommendation === opposite).length : 0;

  const composite = computeCompositeConfidence({
    calibration,
    regime,
    regimeMatchScore,
    backtestStability: params.backtestStability,
    monteCarloRiskOfRuinPct: params.monteCarloRiskOfRuinPct,
    newsRiskLevel,
    liquidityOk,
    disagreementCount,
    totalAgents: opinions.length,
  });

  return {
    opinions,
    moderator: moderatorDecision,
    regime,
    calibration,
    composite,
    suggestedPositionPct: suggestPositionPct(composite.compositeConfidence, composite.riskLevel),
  };
}
