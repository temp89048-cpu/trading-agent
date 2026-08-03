// ---------------------------------------------------------------------
// Dynamic slippage
// ---------------------------------------------------------------------
// Fixed-bps slippage (still the default, still available) treats a
// thin, volatile micro-cap exactly like a deep, calm major pair. This
// model instead scales slippage by three real, cheaply-computed
// factors: relative order size vs. the bar's own volume (bigger clip of
// the bar's liquidity = more slippage), realized volatility via ATR as
// a fraction of price (choppier conditions = wider effective spread),
// and a floor so it never reports LESS slippage than the fixed baseline
// would for a perfectly calm, deep market — this is meant to be more
// realistic, not more optimistic.
//
// This is a real, checkable model, not a black box: every input is a
// number already flowing through the engine (bar volume, ATR, order
// notional), and the formula is small enough to audit at a glance.

export type DynamicSlippageInputs = {
  orderNotionalUsd: number;
  barVolumeBaseUnits: number; // candle.v — base-asset volume for that bar
  barPrice: number; // used to convert bar volume into notional terms
  atrValue: number | null; // absolute ATR, same units as price
  baselineSlippageBps: number; // floor — the fixed-bps behavior, never went below this
};

const MAX_VOLUME_IMPACT_BPS = 40; // cap: even a very large order vs. a very thin bar won't be modeled as an absurd blowup
const MAX_VOLATILITY_IMPACT_BPS = 30;

export function computeDynamicSlippageBps(inputs: DynamicSlippageInputs): { totalBps: number; breakdown: { base: number; sizeImpact: number; volatilityImpact: number } } {
  const barVolumeNotional = inputs.barVolumeBaseUnits * inputs.barPrice;
  const sizeRatio = barVolumeNotional > 0 ? inputs.orderNotionalUsd / barVolumeNotional : 1; // 1 = "this order is the entire bar's volume", a deliberately conservative fallback when volume is unknown/zero
  const sizeImpact = Math.min(MAX_VOLUME_IMPACT_BPS, sizeRatio * 200); // an order that's 5% of the bar's volume adds ~10bps; scales linearly from there

  const volatilityRatio = inputs.atrValue !== null && inputs.barPrice > 0 ? inputs.atrValue / inputs.barPrice : 0;
  const volatilityImpact = Math.min(MAX_VOLATILITY_IMPACT_BPS, volatilityRatio * 1000); // a 1%-of-price ATR adds ~10bps

  const totalBps = inputs.baselineSlippageBps + sizeImpact + volatilityImpact;
  return { totalBps, breakdown: { base: inputs.baselineSlippageBps, sizeImpact, volatilityImpact } };
}

// ---------------------------------------------------------------------
// Execution modes
// ---------------------------------------------------------------------
// When a single OHLC bar's range spans BOTH the stop-loss and take-
// profit levels, there is no way to know from OHLC alone which was
// actually touched first — that's only recoverable from tick data. The
// three modes below are named, explicit assumptions about how to
// resolve that ambiguity, so a user can see how sensitive their results
// are to this specific unknown rather than the engine silently picking
// one convention forever.
export type ExecutionMode = 'conservative' | 'optimistic' | 'random' | 'tick';

export type AmbiguousBarResolution = 'stop-loss' | 'take-profit';

// A tiny seeded PRNG (mulberry32) so "random" mode is reproducible given
// the same seed — a Monte Carlo-style random mode that couldn't be
// re-run identically would make results impossible to sanity-check.
export function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function resolveAmbiguousBar(mode: ExecutionMode, rng: () => number): AmbiguousBarResolution {
  switch (mode) {
    case 'conservative':
      return 'stop-loss'; // worst case for the trader — the existing, still-default behavior
    case 'optimistic':
      return 'take-profit'; // best case for the trader
    case 'random':
      return rng() < 0.5 ? 'stop-loss' : 'take-profit';
    case 'tick':
      // No tick-level data source is configured anywhere in this app
      // (Commit 11 documented the same honest gap for live order flow).
      // Rather than silently falling back to a different mode, this
      // says so and the caller (engine.ts) falls back to 'conservative'
      // with that reason surfaced in the backtest's warnings.
      return 'stop-loss';
  }
}

export function tickModeAvailable(): boolean {
  return false; // no tick-level historical data provider configured — see stubs.ts precedent
}
