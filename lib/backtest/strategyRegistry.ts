import type { StrategyContext, StrategySignal } from '../strategyContext';
import { runTrendFollowingAgent } from '../strategies/trendFollowing';
import { runMomentumAgent } from '../strategies/momentum';
import { runScalpingAgent } from '../strategies/scalping';
import { runSwingTradingAgent } from '../strategies/swingTrading';
import { runMeanReversionAgent } from '../strategies/meanReversion';
import { runBreakoutAgent } from '../strategies/breakout';
import { runRangeTradingAgent } from '../strategies/rangeTrading';
import { runStrategyEnsemble } from '../strategyEnsemble';
import { runTunableStrategy, DEFAULT_TUNABLE_PARAMS } from './tunableStrategy';

// runStrategyEnsemble returns an EnsembleResult (per-agent breakdown +
// consensus), not a single StrategySignal — this adapts it to the same
// shape every other strategy produces, so the backtest engine (which
// only knows how to call `(ctx) => StrategySignal`) can run the whole
// ensemble's consensus exactly as the live app votes it, bar by bar.
function runEnsembleAsSignal(ctx: StrategyContext): StrategySignal {
  const result = runStrategyEnsemble(ctx);
  return {
    agent: 'Strategy Ensemble',
    signal: result.consensus,
    confidence: result.confidencePct / 100,
    reason: `Confidence-weighted vote across 7 agents (BUY ${result.buyWeight.toFixed(2)} / SELL ${result.sellWeight.toFixed(2)} / HOLD ${result.holdWeight.toFixed(2)})`,
  };
}

export const STRATEGY_REGISTRY: Record<string, { label: string; fn: (ctx: StrategyContext) => StrategySignal; usesMtf: boolean }> = {
  trendFollowing: { label: 'Trend Following', fn: runTrendFollowingAgent, usesMtf: true },
  momentum: { label: 'Momentum', fn: runMomentumAgent, usesMtf: true },
  scalping: { label: 'Scalping', fn: runScalpingAgent, usesMtf: false },
  swingTrading: { label: 'Swing Trading', fn: runSwingTradingAgent, usesMtf: false },
  meanReversion: { label: 'Mean Reversion', fn: runMeanReversionAgent, usesMtf: false },
  breakout: { label: 'Breakout', fn: runBreakoutAgent, usesMtf: false },
  rangeTrading: { label: 'Range Trading', fn: runRangeTradingAgent, usesMtf: false },
  ensemble: { label: 'Strategy Ensemble (all 7)', fn: runEnsembleAsSignal, usesMtf: true },
  tunable: { label: 'Tunable EMA/RSI (for optimizer)', fn: (ctx) => runTunableStrategy(ctx, DEFAULT_TUNABLE_PARAMS), usesMtf: false },
};

export type StrategyName = keyof typeof STRATEGY_REGISTRY;
export const STRATEGY_NAMES = Object.keys(STRATEGY_REGISTRY) as StrategyName[];
