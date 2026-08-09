import type { StrategyContext, StrategySignal } from '../strategyContext';

// Smart Money Concepts / ICT (spec Section 11.2).
//
// The spec lists ICT and SMC as separate entries, but their tradable
// primitives overlap almost entirely (BOS, CHoCH, order blocks, fair
// value gaps, liquidity sweeps, premium/discount). Implementing them as
// two agents casting two votes off the same underlying reads would
// double-count one perspective in the ensemble — so this is ONE agent
// covering both, and the profile says so.
//
// Everything here is read from signals the app already computes:
// structure events (lib/marketStructure.ts) and liquidity sweeps
// (lib/liquidity.ts). No new indicator math, and no invented concepts —
// order blocks and FVGs are deliberately NOT approximated, because doing
// so from 1h candles alone would produce plausible-looking levels that
// aren't the thing traders mean by those terms.
//
// The core SMC sequence this looks for:
//   liquidity sweep (stops taken) -> BOS/CHoCH confirming direction
// That ordering matters. A sweep alone is noise; a break alone is late.
// The sweep-then-break sequence is the actual setup.

const SWEEP_LOOKBACK_BARS = 20; // how recent a sweep must be to still be relevant to a break

export function runSmartMoneyAgent(ctx: StrategyContext): StrategySignal {
  const events = ctx.structure.events;
  const sweeps = ctx.liquidity.sweeps;
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;

  if (!lastEvent) {
    return {
      agent: 'Smart Money (SMC/ICT)',
      signal: 'HOLD',
      confidence: 0.5,
      reason: 'No confirmed BOS or CHoCH yet — nothing to structure a setup around.',
    };
  }

  // Was there a liquidity sweep shortly before this break? Sweeps carry
  // a candle index; compare against the break's own swing index so
  // "recent" means recent relative to the break, not to now.
  const recentSweep = sweeps.find(
    (s) => s.index <= lastEvent.brokenSwingIndex + SWEEP_LOOKBACK_BARS && s.index >= lastEvent.brokenSwingIndex - SWEEP_LOOKBACK_BARS,
  );

  const bullish = lastEvent.direction === 'bullish';
  const inDiscount = isInDiscountZone(ctx, bullish);

  // Full sequence: sweep + break + favourable zone.
  if (recentSweep && inDiscount) {
    return {
      agent: 'Smart Money (SMC/ICT)',
      signal: bullish ? 'BUY' : 'SELL',
      confidence: 0.75,
      reason: `${lastEvent.type} ${lastEvent.direction} at ${lastEvent.brokenLevel.toFixed(2)} preceded by a liquidity sweep, with price in the ${bullish ? 'discount' : 'premium'} zone — the full sweep-then-break sequence.`,
    };
  }

  // Break with a sweep but price already extended past the good entry
  // zone: the setup was real, the entry is late.
  if (recentSweep) {
    return {
      agent: 'Smart Money (SMC/ICT)',
      signal: bullish ? 'BUY' : 'SELL',
      confidence: 0.6,
      reason: `${lastEvent.type} ${lastEvent.direction} preceded by a liquidity sweep, but price is no longer in the favourable ${bullish ? 'discount' : 'premium'} zone — valid structure, late entry.`,
    };
  }

  // A CHoCH without a preceding sweep is the weakest form — it may be a
  // genuine character change or just a failed continuation.
  return {
    agent: 'Smart Money (SMC/ICT)',
    signal: 'HOLD',
    confidence: 0.5,
    reason: `${lastEvent.type} ${lastEvent.direction} present, but no recent liquidity sweep to confirm it — a break without stops being taken first is the weak form of this setup.`,
  };
}

// Premium/discount: where price sits within the recent structural range.
// Below the midpoint is "discount" (favourable for longs), above is
// "premium" (favourable for shorts). Uses the last confirmed swing high
// and low — the same levels the risk manager derives stops from, so
// there's one definition of the range in the codebase.
function isInDiscountZone(ctx: StrategyContext, forLong: boolean): boolean {
  const high = ctx.structure.lastSwingHigh?.price;
  const low = ctx.structure.lastSwingLow?.price;
  if (high === undefined || low === undefined || high <= low) return false;
  const mid = (high + low) / 2;
  return forLong ? ctx.price <= mid : ctx.price >= mid;
}
