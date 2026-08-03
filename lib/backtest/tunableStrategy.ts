import { ema } from '../indicators';
import type { StrategyContext, StrategySignal } from '../strategyContext';
import type { StopLossTakeProfit } from '../riskManager';

// Why a new strategy instead of grid-searching the existing 7 ensemble
// agents (lib/strategies/*.ts): those are deliberately hand-tuned
// pattern-matchers — fixed RSI 30/70, fixed EMA20/50, fixed MTF-
// agreement counts, chosen and documented for a reason in each file.
// Reparametrizing all seven would mean rewriting already-shipped
// Commit 12 logic, which is real surgery on working code for the sake
// of this one feature. Instead, this file defines ONE strategy built
// specifically to expose the knobs the roadmap actually asks the
// optimizer to search: EMA lengths, an RSI extremity threshold, an ATR
// stop multiplier, and a reward:risk ratio. It's a legitimate, common
// backtesting pattern in its own right (EMA-crossover + RSI filter),
// not a placeholder — just deliberately separate from the ensemble.

export type TunableParams = {
  emaFast: number;
  emaSlow: number;
  rsiThreshold: number; // distance from 50; oversold = 50 - threshold, overbought = 50 + threshold
  atrMultiplier: number; // stop distance = atrValue * atrMultiplier
  rewardRiskRatio: number; // take-profit distance = stop distance * this
};

export const DEFAULT_TUNABLE_PARAMS: TunableParams = {
  emaFast: 20,
  emaSlow: 50,
  rsiThreshold: 15, // oversold < 35, overbought > 65
  atrMultiplier: 1.5,
  rewardRiskRatio: 2,
};

export function runTunableStrategy(ctx: StrategyContext, params: TunableParams): StrategySignal {
  const closes = ctx.candles.map((c) => c.c);
  if (closes.length < params.emaSlow + 1) {
    return { agent: 'Tunable EMA/RSI', signal: 'HOLD', confidence: 0.5, reason: `Not enough candles yet for EMA(${params.emaSlow})` };
  }
  const fast = ema(closes, params.emaFast);
  const slow = ema(closes, params.emaSlow);
  const r = ctx.rsiValue;
  if (fast === null || slow === null || r === null) {
    return { agent: 'Tunable EMA/RSI', signal: 'HOLD', confidence: 0.5, reason: 'EMA or RSI not available yet' };
  }

  const overbought = 50 + params.rsiThreshold;
  const oversold = 50 - params.rsiThreshold;
  const trendUp = fast > slow;
  const trendDown = fast < slow;

  if (trendUp && r < overbought) {
    return {
      agent: 'Tunable EMA/RSI',
      signal: 'BUY',
      confidence: 0.65,
      reason: `EMA(${params.emaFast}) > EMA(${params.emaSlow}) and RSI ${r.toFixed(1)} not overbought (< ${overbought})`,
    };
  }
  if (trendDown && r > oversold) {
    return {
      agent: 'Tunable EMA/RSI',
      signal: 'SELL',
      confidence: 0.65,
      reason: `EMA(${params.emaFast}) < EMA(${params.emaSlow}) and RSI ${r.toFixed(1)} not oversold (> ${oversold})`,
    };
  }
  return {
    agent: 'Tunable EMA/RSI',
    signal: 'HOLD',
    confidence: 0.5,
    reason: trendUp || trendDown ? 'Trend direction set but RSI is at the opposing extreme — sitting out' : 'EMA fast/slow not clearly separated',
  };
}

// A dedicated SL/TP function using the SAME atrMultiplier/rewardRiskRatio
// knobs being optimized, rather than riskManager's fixed structural-stop
// logic — the optimizer needs the stop distance itself to respond to the
// param grid, or "ATR multiplier" and "TP:SL ratio" wouldn't actually do
// anything.
export function computeTunableStopLossTakeProfit(ctx: StrategyContext, side: 'buy' | 'sell', params: TunableParams): StopLossTakeProfit | null {
  if (ctx.atrValue === null || ctx.atrValue <= 0) return null;
  const stopDistance = ctx.atrValue * params.atrMultiplier;
  const stopLoss = side === 'buy' ? ctx.price - stopDistance : ctx.price + stopDistance;
  const takeProfit = side === 'buy' ? ctx.price + stopDistance * params.rewardRiskRatio : ctx.price - stopDistance * params.rewardRiskRatio;
  return { stopLoss, takeProfit, stopDistance, method: `tunable ATR stop (${params.atrMultiplier}x ATR, ${params.rewardRiskRatio}:1 reward:risk)` };
}
