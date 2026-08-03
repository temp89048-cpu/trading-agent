import type { StrategyContext, StrategySignal } from '../strategyContext';

// Range Trading Agent: the deliberate opposite of Breakout — only
// active when there's genuinely no confirmed trend (Commit 9's
// structure hasn't confirmed bullish or bearish), on the theory that
// undirected price tends to oscillate within its recent value area
// (Commit 10) rather than trend. Fades the edges, doesn't chase them.
export function runRangeTradingAgent(ctx: StrategyContext): StrategySignal {
  const vp = ctx.volumeProfile;
  if (ctx.structure.currentTrend !== 'undefined') {
    return {
      agent: 'Range Trading',
      signal: 'HOLD',
      confidence: 0.5,
      reason: `Structure has confirmed a ${ctx.structure.currentTrend} trend — this agent only trades genuinely undirected/ranging conditions`,
    };
  }
  if (!vp) {
    return { agent: 'Range Trading', signal: 'HOLD', confidence: 0.5, reason: 'Volume profile not available yet' };
  }

  if (ctx.price <= vp.val) {
    return {
      agent: 'Range Trading',
      signal: 'BUY',
      confidence: 0.55,
      reason: `No confirmed trend, and price (${ctx.price.toFixed(2)}) is at/below the Value Area Low (${vp.val.toFixed(2)}) — fading the bottom of the recent range`,
    };
  }
  if (ctx.price >= vp.vah) {
    return {
      agent: 'Range Trading',
      signal: 'SELL',
      confidence: 0.55,
      reason: `No confirmed trend, and price (${ctx.price.toFixed(2)}) is at/above the Value Area High (${vp.vah.toFixed(2)}) — fading the top of the recent range`,
    };
  }
  return {
    agent: 'Range Trading',
    signal: 'HOLD',
    confidence: 0.5,
    reason: 'No confirmed trend, but price is inside the value area, not at an edge worth fading',
  };
}
