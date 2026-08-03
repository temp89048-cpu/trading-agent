import type { StrategyContext, StrategySignal } from '../strategyContext';

// Scalping Agent: looks ONLY at 1m/5m — deliberately ignores the higher-
// timeframe picture, which is the point of a scalping agent (it's
// allowed to disagree with Trend/Swing, since it's trying to catch a
// small, fast move, not the same move they are). Avoids entries when
// short-term RSI is already at an extreme in the trade's direction —
// chasing an already-stretched 1m/5m move is exactly what tends to get
// scalpers caught in a snap-back.
export function runScalpingAgent(ctx: StrategyContext): StrategySignal {
  const oneMin = ctx.mtf.perTimeframe.find((t) => t.timeframe === '1m');
  const fiveMin = ctx.mtf.perTimeframe.find((t) => t.timeframe === '5m');
  const r = ctx.rsiValue;

  if (!oneMin || !fiveMin || r === null) {
    return { agent: 'Scalping', signal: 'HOLD', confidence: 0.5, reason: '1m/5m data or RSI not available yet' };
  }

  if (oneMin.trend === 'bullish' && fiveMin.trend === 'bullish' && r < 70) {
    return {
      agent: 'Scalping',
      signal: 'BUY',
      confidence: 0.55,
      reason: `1m and 5m both bullish (${oneMin.detail} / ${fiveMin.detail}), RSI ${r.toFixed(1)} not overbought yet`,
    };
  }
  if (oneMin.trend === 'bearish' && fiveMin.trend === 'bearish' && r > 30) {
    return {
      agent: 'Scalping',
      signal: 'SELL',
      confidence: 0.55,
      reason: `1m and 5m both bearish (${oneMin.detail} / ${fiveMin.detail}), RSI ${r.toFixed(1)} not oversold yet`,
    };
  }
  return {
    agent: 'Scalping',
    signal: 'HOLD',
    confidence: 0.5,
    reason: '1m/5m disagree, or RSI already at an extreme in that direction — not chasing it',
  };
}
