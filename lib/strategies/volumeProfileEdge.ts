import type { StrategyContext, StrategySignal } from '../strategyContext';

// Volume Profile strategy (spec Section 11.2).
//
// lib/volumeProfile.ts already computes POC, value-area high/low, and
// high/low volume nodes for every symbol — nothing read it as a trading
// signal until now.
//
// The two standard readings:
//   - Value-area edge rejection: price at VAH/VAL in a range tends to
//     revert toward the POC (the price the market agreed on most).
//   - Low-volume-node traversal: price moves FAST through thin nodes,
//     because there's little resting interest to slow it. Entering as
//     price enters a low-volume node, in the direction of travel, is the
//     continuation reading.
//
// Deliberately conservative on the second one: a low-volume node tells
// you movement will be fast, not which direction — so it only votes when
// structure already supplies the direction.

const AT_LEVEL_PCT = 0.3; // within this % of a level counts as "at" it

export function runVolumeProfileAgent(ctx: StrategyContext): StrategySignal {
  const vp = ctx.volumeProfile;
  if (!vp) {
    return {
      agent: 'Volume Profile',
      signal: 'HOLD',
      confidence: 0.5,
      reason: 'No volume profile computed for this symbol yet.',
    };
  }

  const nearPct = (level: number) => (Math.abs(ctx.price - level) / level) * 100;
  const trend = ctx.structure.currentTrend;

  // --- Value-area edge rejection toward the POC. Only in the absence of
  // a confirmed trend — in a trend, a value-area edge is more often
  // broken than respected.
  if (trend === 'undefined') {
    if (nearPct(vp.vah) <= AT_LEVEL_PCT && ctx.price > vp.poc) {
      return {
        agent: 'Volume Profile',
        signal: 'SELL',
        confidence: 0.65,
        reason: `Price at value-area high (${vp.vah.toFixed(2)}) with no confirmed trend — reversion toward POC ${vp.poc.toFixed(2)} is the standard read.`,
      };
    }
    if (nearPct(vp.val) <= AT_LEVEL_PCT && ctx.price < vp.poc) {
      return {
        agent: 'Volume Profile',
        signal: 'BUY',
        confidence: 0.65,
        reason: `Price at value-area low (${vp.val.toFixed(2)}) with no confirmed trend — reversion toward POC ${vp.poc.toFixed(2)} is the standard read.`,
      };
    }
  }

  // --- Low-volume node traversal, direction supplied by structure.
  const inLowVolumeNode = vp.lowVolumeNodes.some((n) => nearPct(n.price) <= AT_LEVEL_PCT);
  if (inLowVolumeNode && (trend === 'bullish' || trend === 'bearish')) {
    return {
      agent: 'Volume Profile',
      signal: trend === 'bullish' ? 'BUY' : 'SELL',
      confidence: 0.62,
      reason: `Price is entering a low-volume node with a confirmed ${trend} structure — thin resting interest means moves through this area tend to be fast, and structure supplies the direction.`,
    };
  }

  if (inLowVolumeNode) {
    return {
      agent: 'Volume Profile',
      signal: 'HOLD',
      confidence: 0.5,
      reason: 'Price is in a low-volume node, but with no confirmed structure there is no directional basis — a thin node predicts speed, not direction.',
    };
  }

  return {
    agent: 'Volume Profile',
    signal: 'HOLD',
    confidence: 0.5,
    reason: `Price (${ctx.price.toFixed(2)}) is inside the value area, away from its edges and from any low-volume node — no volume-profile edge here.`,
  };
}
