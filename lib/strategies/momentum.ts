import type { StrategyContext, StrategySignal } from '../strategyContext';

// Momentum Agent: distinct from Trend Following — this one specifically
// wants MACD histogram direction confirmed by multiple timeframes
// showing active "Momentum Extending" or "Momentum Returning" states
// (from Commit 8's classifier), not just "the trend is up." A trend can
// be intact while momentum stalls (Commit 8's "Holding" state); this
// agent sits out when that happens.
export function runMomentumAgent(ctx: StrategyContext): StrategySignal {
  const hist = ctx.macdValue?.histogram ?? null;
  if (hist === null) {
    return { agent: 'Momentum', signal: 'HOLD', confidence: 0.5, reason: 'MACD not available yet' };
  }

  const bullishMomentumCount = ctx.mtf.perTimeframe.filter(
    (t) => t.trend === 'bullish' && /Momentum (Extending|Returning)/.test(t.detail),
  ).length;
  const bearishMomentumCount = ctx.mtf.perTimeframe.filter(
    (t) => t.trend === 'bearish' && /Momentum Extending|Breakdown Resuming/.test(t.detail),
  ).length;

  if (hist > 0 && bullishMomentumCount >= 2) {
    return {
      agent: 'Momentum',
      signal: 'BUY',
      confidence: Math.min(0.85, 0.55 + bullishMomentumCount * 0.1),
      reason: `MACD histogram positive (${hist.toFixed(4)}) with ${bullishMomentumCount} timeframes showing active bullish momentum`,
    };
  }
  if (hist < 0 && bearishMomentumCount >= 2) {
    return {
      agent: 'Momentum',
      signal: 'SELL',
      confidence: Math.min(0.85, 0.55 + bearishMomentumCount * 0.1),
      reason: `MACD histogram negative (${hist.toFixed(4)}) with ${bearishMomentumCount} timeframes showing active bearish momentum`,
    };
  }
  return {
    agent: 'Momentum',
    signal: 'HOLD',
    confidence: 0.5,
    reason: 'MACD direction not confirmed by enough timeframes showing active momentum (vs. just holding)',
  };
}
