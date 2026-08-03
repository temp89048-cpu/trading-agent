import type { StrategyContext, StrategySignal } from '../strategyContext';

// Trend Following Agent: only takes a position when the confirmed
// market structure (HH/HL sequence from Commit 9) AND the multi-
// timeframe rollup (Commit 8) agree on direction — deliberately
// conservative, since a trend-following agent that fights its own
// inputs isn't following a trend, it's guessing.
export function runTrendFollowingAgent(ctx: StrategyContext): StrategySignal {
  const structureTrend = ctx.structure.currentTrend;
  const mtfTrend = ctx.mtf.overall?.trend ?? null;
  const aboveEma50 = ctx.ema50 !== null && ctx.price > ctx.ema50;
  const belowEma50 = ctx.ema50 !== null && ctx.price < ctx.ema50;

  if (structureTrend === 'bullish' && mtfTrend === 'bullish' && aboveEma50) {
    const agreementBoost = ctx.mtf.overall?.assessment === 'High probability continuation' ? 0.15 : 0;
    return {
      agent: 'Trend Following',
      signal: 'BUY',
      confidence: Math.min(0.9, 0.6 + agreementBoost),
      reason: `Structure confirmed bullish (HH/HL), MTF rollup bullish, price above EMA50 (${ctx.mtf.overall?.agreement ?? 'n/a'})`,
    };
  }
  if (structureTrend === 'bearish' && mtfTrend === 'bearish' && belowEma50) {
    const agreementBoost = ctx.mtf.overall?.assessment === 'High probability continuation' ? 0.15 : 0;
    return {
      agent: 'Trend Following',
      signal: 'SELL',
      confidence: Math.min(0.9, 0.6 + agreementBoost),
      reason: `Structure confirmed bearish (LL/LH), MTF rollup bearish, price below EMA50 (${ctx.mtf.overall?.agreement ?? 'n/a'})`,
    };
  }
  return {
    agent: 'Trend Following',
    signal: 'HOLD',
    confidence: 0.5,
    reason: 'Structure and multi-timeframe trend do not agree, or no confirmed structure yet — nothing to follow',
  };
}
