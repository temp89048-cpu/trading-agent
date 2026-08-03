import type { Candle } from '../indicators';
import { ema, atr } from '../indicators';
import type { BacktestTrade } from './engine';

// Classifies each bar into a trend regime (bull/bear/sideways) and a
// volatility regime (high/low), reusing the same ema()/atr() functions
// already used everywhere else in this app — no new indicator math
// invented for this. A trade is then tagged with whichever regime was
// in effect at its ENTRY bar, and performance is broken out per regime
// bucket, so "this strategy is profitable" can be qualified with
// "...mostly during trending, low-volatility conditions" instead of
// treated as one context-free number.

export type TrendRegime = 'bull' | 'bear' | 'sideways';
export type VolRegime = 'high-vol' | 'low-vol';
export type Regime = { trend: TrendRegime; vol: VolRegime };

const TREND_EMA_FAST = 20;
const TREND_EMA_SLOW = 50;
const SIDEWAYS_BAND_PCT = 0.3; // if fast/slow EMAs are within this % of each other, call it sideways rather than a weak trend
const VOL_LOOKBACK = 100; // bars used to build the ATR-percentile distribution that "high" vs "low" is judged against

export function classifyRegimes(candles: Candle[]): (Regime | null)[] {
  const closes = candles.map((c) => c.c);
  const fastSeries: (number | null)[] = [];
  const slowSeries: (number | null)[] = [];
  // Reuse ema() per-index by feeding growing prefixes would be O(n^2);
  // instead compute both EMA series once with the same recurrence ema()
  // itself uses, just exposed as a running series here.
  const fastMult = 2 / (TREND_EMA_FAST + 1);
  const slowMult = 2 / (TREND_EMA_SLOW + 1);
  let fastVal: number | null = null;
  let slowVal: number | null = null;
  const atrSeries: (number | null)[] = [];

  for (let i = 0; i < candles.length; i++) {
    fastVal = fastVal === null ? (i >= TREND_EMA_FAST - 1 ? closes.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1) : null) : closes[i] * fastMult + fastVal * (1 - fastMult);
    slowVal = slowVal === null ? (i >= TREND_EMA_SLOW - 1 ? closes.slice(0, i + 1).reduce((a, b) => a + b, 0) / (i + 1) : null) : closes[i] * slowMult + slowVal * (1 - slowMult);
    fastSeries.push(fastVal);
    slowSeries.push(slowVal);
    const atrHere = atr(candles.slice(Math.max(0, i - 14), i + 1), 14);
    atrSeries.push(atrHere);
  }

  return candles.map((c, i) => {
    const fast = fastSeries[i];
    const slow = slowSeries[i];
    if (fast === null || slow === null) return null;

    const diffPct = (Math.abs(fast - slow) / slow) * 100;
    const trend: TrendRegime = diffPct < SIDEWAYS_BAND_PCT ? 'sideways' : fast > slow ? 'bull' : 'bear';

    const windowStart = Math.max(0, i - VOL_LOOKBACK);
    const atrWindow = atrSeries.slice(windowStart, i + 1).filter((v): v is number => v !== null);
    const currentAtr = atrSeries[i];
    let vol: VolRegime = 'low-vol';
    if (currentAtr !== null && atrWindow.length >= 20) {
      const sorted = [...atrWindow].sort((a, b) => a - b);
      const rank = sorted.findIndex((v) => v >= currentAtr) / sorted.length;
      vol = rank >= 0.5 ? 'high-vol' : 'low-vol'; // above/below the trailing median ATR
    }

    return { trend, vol };
  });
}

export type RegimeBreakdown = {
  key: string; // e.g. "bull/high-vol"
  tradeCount: number;
  winRate: number | null;
  totalPnlUsd: number;
  avgPnlPct: number | null;
};

// Tags each trade by the regime in effect at its ENTRY timestamp (not
// exit — the regime that existed when the decision was made is the one
// worth evaluating the decision against) and aggregates performance per
// bucket.
export function computeRegimeBreakdown(candles: Candle[], trades: BacktestTrade[]): { breakdown: RegimeBreakdown[]; warnings: string[] } {
  const warnings: string[] = [];
  if (trades.length === 0) return { breakdown: [], warnings: ['No trades to break down by regime.'] };

  const regimes = classifyRegimes(candles);
  const timestamps = candles.map((c) => c.t);

  function regimeAt(ts: number): Regime | null {
    // Find the last candle with t <= ts (entry always lands on/after a bar close in this engine).
    let lo = 0;
    let hi = timestamps.length - 1;
    let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timestamps[mid] <= ts) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return idx >= 0 ? regimes[idx] : null;
  }

  const buckets = new Map<string, BacktestTrade[]>();
  let untagged = 0;
  for (const trade of trades) {
    const regime = regimeAt(trade.entryTs);
    if (!regime) {
      untagged++;
      continue;
    }
    const key = `${regime.trend}/${regime.vol}`;
    const list = buckets.get(key) ?? [];
    list.push(trade);
    buckets.set(key, list);
  }
  if (untagged > 0) warnings.push(`${untagged} trade(s) couldn't be tagged with a regime (not enough candle history before entry to classify) and are excluded from the breakdown.`);

  const breakdown: RegimeBreakdown[] = [];
  for (const [key, list] of buckets) {
    const wins = list.filter((t) => t.pnlUsd > 0).length;
    breakdown.push({
      key,
      tradeCount: list.length,
      winRate: list.length > 0 ? wins / list.length : null,
      totalPnlUsd: list.reduce((s, t) => s + t.pnlUsd, 0),
      avgPnlPct: list.length > 0 ? list.reduce((s, t) => s + t.pnlPct, 0) / list.length : null,
    });
  }
  breakdown.sort((a, b) => b.tradeCount - a.tradeCount);

  return { breakdown, warnings };
}
