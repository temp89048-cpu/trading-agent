import type { StrategyContext, StrategySignal } from '../strategyContext';

// Mean Reversion Agent: bets on price snapping back toward the mean
// after an extreme (price outside the Bollinger Band + RSI extreme).
// Deliberately refuses to fire AGAINST a confirmed strong trend in the
// same direction as the extreme (e.g. won't buy an oversold reading
// inside a confirmed downtrend — that's not a reversion setup, that's a
// trend continuing). This is the natural counterweight to Trend
// Following/Momentum in the ensemble vote.
export function runMeanReversionAgent(ctx: StrategyContext): StrategySignal {
  const { bb, rsiValue: r, price, structure } = ctx;
  if (!bb || r === null) {
    return { agent: 'Mean Reversion', signal: 'HOLD', confidence: 0.5, reason: 'Bollinger Bands or RSI not available yet' };
  }

  const oversold = price <= bb.lower && r < 30;
  const overbought = price >= bb.upper && r > 70;

  if (oversold && structure.currentTrend !== 'bearish') {
    return {
      agent: 'Mean Reversion',
      signal: 'BUY',
      confidence: 0.6,
      reason: `Price at/below lower Bollinger Band (${bb.lower.toFixed(2)}) with RSI ${r.toFixed(1)} oversold, and no confirmed bearish structure fighting it`,
    };
  }
  if (overbought && structure.currentTrend !== 'bullish') {
    return {
      agent: 'Mean Reversion',
      signal: 'SELL',
      confidence: 0.6,
      reason: `Price at/above upper Bollinger Band (${bb.upper.toFixed(2)}) with RSI ${r.toFixed(1)} overbought, and no confirmed bullish structure fighting it`,
    };
  }
  if (oversold || overbought) {
    return {
      agent: 'Mean Reversion',
      signal: 'HOLD',
      confidence: 0.5,
      reason: 'Price/RSI at an extreme, but a confirmed structure trend in the same direction makes this look like continuation, not reversion',
    };
  }
  return { agent: 'Mean Reversion', signal: 'HOLD', confidence: 0.5, reason: 'Price is within the bands, RSI not at an extreme — no reversion setup' };
}
