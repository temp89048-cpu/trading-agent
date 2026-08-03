import type { StrategyContext, StrategySignal } from '../strategyContext';

// Breakout Agent: wants two things to line up, not just one wick — a
// recent BOS (Commit 9: price closed past a real swing level continuing
// the trend) AND price now trading outside the volume-profile Value
// Area (Commit 10: outside the range most volume actually traded in).
// Either alone is weaker evidence; a structural break that's also
// clearing the "fair value" range is the real breakout signature.
const RECENT_EVENT_WINDOW = 5; // only count a BOS as "recent" if it's within the last few candles

export function runBreakoutAgent(ctx: StrategyContext): StrategySignal {
  const lastIdx = ctx.candles.length - 1;
  const recentBos = ctx.structure.events.filter((e) => e.type === 'BOS' && lastIdx - e.index <= RECENT_EVENT_WINDOW);
  const lastBos = recentBos[recentBos.length - 1];
  const vp = ctx.volumeProfile;

  if (!lastBos || !vp) {
    return { agent: 'Breakout', signal: 'HOLD', confidence: 0.5, reason: 'No recent Break of Structure, or volume profile not available yet' };
  }

  if (lastBos.direction === 'bullish' && ctx.price > vp.vah) {
    return {
      agent: 'Breakout',
      signal: 'BUY',
      confidence: 0.7,
      reason: `Recent bullish BOS at ${lastBos.brokenLevel.toFixed(2)} AND price (${ctx.price.toFixed(2)}) is now trading above the Value Area High (${vp.vah.toFixed(2)}) — structural break confirmed outside the prior fair-value range`,
    };
  }
  if (lastBos.direction === 'bearish' && ctx.price < vp.val) {
    return {
      agent: 'Breakout',
      signal: 'SELL',
      confidence: 0.7,
      reason: `Recent bearish BOS at ${lastBos.brokenLevel.toFixed(2)} AND price (${ctx.price.toFixed(2)}) is now trading below the Value Area Low (${vp.val.toFixed(2)})`,
    };
  }
  return {
    agent: 'Breakout',
    signal: 'HOLD',
    confidence: 0.5,
    reason: 'A recent BOS exists but price has not also cleared the volume-profile value area — not confirmed enough to call a breakout yet',
  };
}
