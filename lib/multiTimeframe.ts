import { ema, emaSeries, type Candle } from './indicators';
import type { WatchItem } from './types';

// The seven timeframes from the roadmap. Order matters for display —
// shortest to longest, so a scan reads like zooming out.
export const MTF_TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'] as const;
export type MtfTimeframe = (typeof MTF_TIMEFRAMES)[number];

export type Trend = 'bullish' | 'bearish' | 'neutral';

export type TimeframeTrend = {
  timeframe: MtfTimeframe;
  trend: Trend;
  // Short human-readable qualifier, e.g. "Pullback", "Momentum Returning" —
  // derived from the trajectory of price-vs-EMA20 over the last few bars,
  // not a single snapshot. See classify() below.
  detail: string;
};

// How many bars back to scan for a recent swing high/low and for an
// EMA20 crossing. Short enough to catch a real pullback/bounce, long
// enough not to fire on single-candle noise.
const LOOKBACK_WINDOW = 8; // bars scanned (excluding the current one)
const FLAT_THRESHOLD_PCT = 0.05; // EMA20 vs EMA50 spread below this = no real trend
const EXTENDED_THRESHOLD_PCT = 0.15; // price-vs-EMA20 spread above this = "extended", not just "holding"
const RETRACE_THRESHOLD_PCT = 0.12; // minimum pullback/bounce off a recent swing high/low to count as real, not noise

// Trend classification is two layers, both auditable back to plain
// numbers — no black-box scoring:
//   1) Direction: EMA20 vs EMA50 (the underlying trend).
//   2) State within that direction, from two checks over the last
//      LOOKBACK_WINDOW bars:
//        - Did price actually cross to/through EMA20 at some point in
//          the window, and is "now" clearly back on the trend's side of
//          it? -> "Momentum Returning" — this is a real, unambiguous
//          crossing event, not an artifact of anything else.
//        - Otherwise, compare "now" to the window's own raw price
//          high/low (not an EMA-relative spread) to see if we're
//          retracing off a recent extreme ("Pullback") or sitting at
//          one ("Momentum Extending"). Raw price swings are used here
//          instead of EMA-relative spread specifically because a fresh
//          EMA still "warming up" from its seed SMA has its own lag
//          that decays over the first ~1-2 EMA periods — comparing
//          spread-vs-window-spread on a young EMA falsely reads that
//          decay as a pullback. Raw price highs/lows don't have that
//          artifact. (This gets formalized properly with real swing-
//          high/low detection in the Market Structure Agent — this is
//          intentionally a lighter-weight version for now.)
function classify(closes: number[]): { trend: Trend; detail: string } | null {
  if (closes.length < 21 + LOOKBACK_WINDOW) return null; // need EMA20 to exist for the whole scan window, not just the latest bar
  const price = closes[closes.length - 1];
  const e20Series = emaSeries(closes, 20);
  const e20 = e20Series[e20Series.length - 1];
  const e50 = closes.length >= 50 ? ema(closes, 50) : null;
  if (e20 === null) return null;

  const nowIdx = closes.length - 1;
  const spreadNowPct = ((price - e20) / e20) * 100;
  const windowStart = Math.max(0, nowIdx - LOOKBACK_WINDOW);
  const windowCloses = closes.slice(windowStart, nowIdx); // excludes "now"

  // Did the EMA20-relative spread cross to/through zero at any point in
  // the window (i.e. price touched or crossed EMA20)?
  let crossedInWindow = false;
  for (let i = windowStart; i < nowIdx; i++) {
    const e = e20Series[i];
    if (e === null) continue;
    const s = ((closes[i] - e) / e) * 100;
    if (Math.sign(s) !== Math.sign(spreadNowPct) || s === 0) crossedInWindow = true;
  }

  const windowHigh = windowCloses.length > 0 ? Math.max(...windowCloses) : price;
  const windowLow = windowCloses.length > 0 ? Math.min(...windowCloses) : price;

  function trajectoryDetail(directionLabel: 'above' | 'below'): string {
    const sign = directionLabel === 'above' ? 1 : -1;
    const signedSpreadNow = sign * spreadNowPct;

    if (crossedInWindow && signedSpreadNow > 0) {
      return directionLabel === 'above' ? 'Momentum Returning' : 'Breakdown Resuming';
    }

    // Retracement off the window's own high (bullish) or bounce off its
    // low (bearish), as a % of that extreme — real price action, not an
    // EMA artifact.
    const retracePct = directionLabel === 'above' ? ((windowHigh - price) / windowHigh) * 100 : ((price - windowLow) / windowLow) * 100;

    if (retracePct > RETRACE_THRESHOLD_PCT && signedSpreadNow > 0) {
      return directionLabel === 'above' ? 'Pullback' : 'Relief Bounce';
    }
    if (signedSpreadNow > EXTENDED_THRESHOLD_PCT && retracePct <= RETRACE_THRESHOLD_PCT) {
      return `Momentum Extending ${directionLabel} EMA20`;
    }
    return `Holding ${directionLabel} EMA20`;
  }

  if (e50 === null) {
    // Not enough history for the 50-period leg — still say something
    // honest about the 20-period relationship instead of forcing a
    // full label that isn't actually supported yet.
    const trend: Trend = spreadNowPct > 0 ? 'bullish' : spreadNowPct < 0 ? 'bearish' : 'neutral';
    const base = trend === 'bullish' ? trajectoryDetail('above') : trend === 'bearish' ? trajectoryDetail('below') : 'Flat';
    return { trend, detail: `${base} — based on EMA20 only, insufficient history for EMA50 yet` };
  }

  const emaSpreadPct = ((e20 - e50) / e50) * 100;

  if (emaSpreadPct > FLAT_THRESHOLD_PCT) {
    return { trend: 'bullish', detail: trajectoryDetail('above') };
  }
  if (emaSpreadPct < -FLAT_THRESHOLD_PCT) {
    return { trend: 'bearish', detail: trajectoryDetail('below') };
  }
  return { trend: 'neutral', detail: 'Flat — EMA20/EMA50 converged, no clear trend' };
}

export function computeTimeframeTrend(timeframe: MtfTimeframe, candles: Candle[]): TimeframeTrend | null {
  const closes = candles.map((c) => c.c);
  const result = classify(closes);
  if (!result) return null;
  return { timeframe, trend: result.trend, detail: result.detail };
}

export type SymbolMtfSnapshot = {
  symbol: string;
  perTimeframe: TimeframeTrend[];
  // Simple majority rollup across whatever timeframes actually had
  // enough data — not a weighted model, just an honest count, plus a
  // qualitative assessment derived from that same count (never a
  // separately-invented number).
  overall: { trend: Trend; agreement: string; assessment: string } | null;
};

export type MtfLookup = (symbol: string, timeframe: string) => { candles: Candle[] } | undefined;

export function computeMtfSnapshot(item: WatchItem, lookup: MtfLookup): SymbolMtfSnapshot {
  const perTimeframe: TimeframeTrend[] = [];
  for (const tf of MTF_TIMEFRAMES) {
    const entry = lookup(item.symbol, tf);
    if (!entry || entry.candles.length === 0) continue;
    const t = computeTimeframeTrend(tf, entry.candles);
    if (t) perTimeframe.push(t);
  }

  if (perTimeframe.length === 0) {
    return { symbol: item.symbol, perTimeframe, overall: null };
  }

  const bullish = perTimeframe.filter((t) => t.trend === 'bullish').length;
  const bearish = perTimeframe.filter((t) => t.trend === 'bearish').length;
  const total = perTimeframe.length;
  let overallTrend: Trend = 'neutral';
  if (bullish > bearish) overallTrend = 'bullish';
  else if (bearish > bullish) overallTrend = 'bearish';
  const dominant = Math.max(bullish, bearish);
  const agreement = total > 0 ? `${dominant}/${total} timeframes agree` : 'no data';

  // "Momentum Returning"/"Momentum Extending"/"Breakdown Resuming" are the
  // states that actively confirm the direction continuing; "Pullback"/
  // "Relief Bounce"/"Holding" mean the direction holds but isn't
  // currently confirming with fresh momentum. The assessment reads that
  // mix, not just the raw count.
  const confirming = perTimeframe.filter(
    (t) => t.trend === overallTrend && /Momentum (Extending|Returning)|Breakdown Resuming/.test(t.detail),
  ).length;
  const ratio = total > 0 ? dominant / total : 0;

  let assessment: string;
  if (overallTrend === 'neutral' || dominant === 0) {
    assessment = 'No clear direction — timeframes are split or flat';
  } else if (ratio >= 0.75 && confirming > 0) {
    assessment = 'High probability continuation';
  } else if (ratio >= 0.6) {
    assessment = 'Likely continuation, but confirmation is mixed';
  } else if (ratio > 0.5) {
    assessment = 'Weak majority — treat direction as contested';
  } else {
    assessment = 'Mixed signals across timeframes — no reliable majority';
  }

  return { symbol: item.symbol, perTimeframe, overall: { trend: overallTrend, agreement, assessment } };
}

function trendWord(t: Trend): string {
  return t === 'bullish' ? 'Bullish' : t === 'bearish' ? 'Bearish' : 'Neutral';
}

// Same injection pattern as buildLiveMarketContext / buildIndicatorContext:
// a plain-text system message, honest about gaps, never inventing a
// trend for a timeframe with no candle history yet. Format mirrors the
// requested shape: "<TF> Trend: <Bullish/Bearish> / <state>" per
// timeframe, then "Overall: <assessment>".
export function buildMultiTimeframeContext(watchlist: WatchItem[], lookup: MtfLookup): string {
  if (watchlist.length === 0) {
    return 'MULTI-TIMEFRAME ANALYSIS: no watchlist symbols to analyze.';
  }

  const blocks: string[] = [];
  for (const item of watchlist) {
    const snapshot = computeMtfSnapshot(item, lookup);
    if (snapshot.perTimeframe.length === 0) {
      blocks.push(`${item.symbol}: no timeframes with enough history yet`);
      continue;
    }
    const lines = snapshot.perTimeframe.map((t) => `  ${t.timeframe} Trend: ${trendWord(t.trend)} / ${t.detail}`);
    const overallLine = snapshot.overall
      ? `  Overall: ${snapshot.overall.assessment} (${trendWord(snapshot.overall.trend)}, ${snapshot.overall.agreement})`
      : '  Overall: not enough data across timeframes yet';
    blocks.push(`${item.symbol}:\n${lines.join('\n')}\n${overallLine}`);
  }

  return `MULTI-TIMEFRAME ANALYSIS (computed from real OHLC history per timeframe — EMA20-vs-EMA50 for direction, price-vs-EMA20 trajectory over the last few bars for state — not the model's own read of the chart):\n${blocks.join('\n\n')}\n\nOnly timeframes listed for a symbol have been computed. If a timeframe is missing, say history is still loading rather than guessing its trend.`;
}
