import type { StrategyContext, StrategySignal } from '../strategyContext';
import { atr } from '../indicators';

// Volatility Trading (spec Section 11.2).
//
// IMPORTANT SCOPE NOTE, because the name invites a wrong assumption:
// real volatility trading means taking positions on volatility ITSELF
// (options, VIX products, straddles). This app trades spot direction
// only, so it cannot do that — see PLANNED_STRATEGIES in
// lib/strategyProfiles.ts for the honest version of that gap.
//
// What this agent actually does is the directional cousin that spot CAN
// express: volatility-regime-aware positioning. Volatility is mean-
// reverting and clusters — contraction precedes expansion. So:
//
//   - Contraction (squeeze): expansion is likely, but direction is
//     unknown. Abstain rather than guess, and say why — this is the
//     honest answer, and the Breakout agent is the one positioned to act
//     when the expansion actually resolves.
//   - Expansion already underway with structure agreeing: participate in
//     the direction the expansion has chosen.
//   - Extreme expansion: stand down. Entering into a volatility spike is
//     how stops get run before the move resolves.

const CONTRACTION_RATIO = 0.7; // recent ATR below this fraction of baseline = squeeze
const EXPANSION_RATIO = 1.4; // above this = expanding
const EXTREME_RATIO = 2.2; // above this = too violent to enter into
const RECENT_BARS = 10;
const BASELINE_BARS = 40;

export function runVolatilityAgent(ctx: StrategyContext): StrategySignal {
  const recent = atr(ctx.candles.slice(-RECENT_BARS - 14), 14);
  const baseline = atr(ctx.candles.slice(-BASELINE_BARS - 14), 14);

  if (recent === null || baseline === null || baseline <= 0) {
    return {
      agent: 'Volatility',
      signal: 'HOLD',
      confidence: 0.5,
      reason: 'Not enough candle history to compare current volatility against its own baseline.',
    };
  }

  const ratio = recent / baseline;
  const trend = ctx.structure.currentTrend;
  const pct = (ratio * 100).toFixed(0);

  if (ratio >= EXTREME_RATIO) {
    return {
      agent: 'Volatility',
      signal: 'HOLD',
      confidence: 0.5,
      reason: `Volatility is at ${pct}% of baseline — an extreme expansion. Standing down: entering into a spike tends to get stopped out before the move resolves, regardless of direction.`,
    };
  }

  if (ratio >= EXPANSION_RATIO) {
    if (trend === 'bullish' || trend === 'bearish') {
      return {
        agent: 'Volatility',
        signal: trend === 'bullish' ? 'BUY' : 'SELL',
        confidence: 0.66,
        reason: `Volatility expanding (${pct}% of baseline) with a confirmed ${trend} structure — participating in the direction the expansion has already chosen.`,
      };
    }
    return {
      agent: 'Volatility',
      signal: 'HOLD',
      confidence: 0.5,
      reason: `Volatility expanding (${pct}% of baseline) but no confirmed structure — expansion without direction is not tradable here.`,
    };
  }

  if (ratio <= CONTRACTION_RATIO) {
    return {
      agent: 'Volatility',
      signal: 'HOLD',
      confidence: 0.5,
      reason: `Volatility contracting (${pct}% of baseline) — a squeeze. Expansion is likely but its DIRECTION is unknown, so abstaining rather than guessing; the Breakout agent is positioned to act when it resolves.`,
    };
  }

  return {
    agent: 'Volatility',
    signal: 'HOLD',
    confidence: 0.5,
    reason: `Volatility is normal (${pct}% of baseline) — no volatility-regime edge either way.`,
  };
}
