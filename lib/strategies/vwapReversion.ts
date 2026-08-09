import type { StrategyContext, StrategySignal } from '../strategyContext';

// VWAP strategy (spec Section 11.2).
//
// VWAP is already computed on every StrategyContext (lib/indicators.ts),
// it just had no agent reading it. Two distinct, well-known uses,
// selected by whether structure confirms a trend:
//
//   - Trending: VWAP acts as dynamic support/resistance. A pullback TO
//     VWAP in the direction of the trend is an entry.
//   - Ranging: a stretched excursion FROM VWAP is a mean-reversion entry
//     back toward it.
//
// Distinguishing those two cases is the whole point — using the
// reversion reading during a trend is how VWAP strategies lose money,
// which is exactly what the regime gate in lib/strategyProfiles.ts also
// guards against at the ensemble level.

const NEAR_VWAP_PCT = 0.4; // within this % of VWAP counts as "at" it
const STRETCHED_PCT = 1.5; // beyond this % from VWAP is a stretched excursion

export function runVwapAgent(ctx: StrategyContext): StrategySignal {
  if (ctx.vwapValue === null || ctx.vwapValue <= 0) {
    return {
      agent: 'VWAP',
      signal: 'HOLD',
      confidence: 0.5,
      reason: 'VWAP not computable from available candles — no read, rather than a guessed one.',
    };
  }

  const distancePct = ((ctx.price - ctx.vwapValue) / ctx.vwapValue) * 100;
  const absDistance = Math.abs(distancePct);
  const trend = ctx.structure.currentTrend;

  // --- Trending: pullback to VWAP in the trend direction.
  if (trend === 'bullish' || trend === 'bearish') {
    const pullbackToVwap = absDistance <= NEAR_VWAP_PCT;
    if (pullbackToVwap) {
      return {
        agent: 'VWAP',
        signal: trend === 'bullish' ? 'BUY' : 'SELL',
        confidence: 0.68,
        reason: `Price is at VWAP (${distancePct >= 0 ? '+' : ''}${distancePct.toFixed(2)}%) within a confirmed ${trend} structure — VWAP acting as dynamic ${trend === 'bullish' ? 'support' : 'resistance'}.`,
      };
    }
    // Deliberately does NOT fade a stretched move during a trend. In a
    // trend, "stretched from VWAP" is the normal state, and fading it is
    // the documented failure mode of this strategy.
    return {
      agent: 'VWAP',
      signal: 'HOLD',
      confidence: 0.5,
      reason: `Price is ${distancePct >= 0 ? '+' : ''}${distancePct.toFixed(2)}% from VWAP within a ${trend} structure — waiting for a pullback to VWAP rather than fading a trending move.`,
    };
  }

  // --- Ranging: revert a stretched excursion back toward VWAP.
  if (absDistance >= STRETCHED_PCT) {
    return {
      agent: 'VWAP',
      signal: distancePct > 0 ? 'SELL' : 'BUY',
      confidence: 0.62,
      reason: `No confirmed trend and price is ${distancePct >= 0 ? '+' : ''}${distancePct.toFixed(2)}% from VWAP (beyond the ${STRETCHED_PCT}% stretch threshold) — reversion toward VWAP.`,
    };
  }

  return {
    agent: 'VWAP',
    signal: 'HOLD',
    confidence: 0.5,
    reason: `Price is ${distancePct >= 0 ? '+' : ''}${distancePct.toFixed(2)}% from VWAP — neither a trend pullback nor a stretched excursion.`,
  };
}
