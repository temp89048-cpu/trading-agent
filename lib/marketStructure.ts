import type { Candle } from './indicators';
import type { WatchItem } from './types';

// ---------------------------------------------------------------------
// Swing point detection
// ---------------------------------------------------------------------
// A "swing high" is a bar whose high is strictly greater than the highs
// of `strength` bars on both sides of it (a local extremum, aka a
// fractal). A "swing low" is the mirror using lows. This is the
// standard, auditable definition used across most market-structure
// tooling — no smoothing, no black-box scoring, just "is this bar a
// local peak/trough over a window."
//
// strength=2 means a 5-bar fractal (2 left + the bar + 2 right) — tight
// enough to catch real turns without firing on every 2-candle wiggle.

export type SwingPointType = 'high' | 'low';
// null = the very first swing of that type in the series — nothing to
// compare it against yet, so it isn't labeled HH/LH/HL/LL.
export type SwingLabel = 'HH' | 'LH' | 'HL' | 'LL' | null;

export type SwingPoint = {
  index: number; // candle index this swing point sits at
  time: number; // candle timestamp (ms)
  price: number; // the high or low value that defines this swing
  type: SwingPointType;
  label: SwingLabel;
};

export const DEFAULT_STRENGTH = 2;

export function findRawSwingPoints(candles: Candle[], strength: number): SwingPoint[] {
  const points: SwingPoint[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const bar = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= strength; k++) {
      if (candles[i - k].h >= bar.h || candles[i + k].h >= bar.h) isHigh = false;
      if (candles[i - k].l <= bar.l || candles[i + k].l <= bar.l) isLow = false;
    }
    // A single bar can't be a strict local max of highs AND local min of
    // lows at the same window (that would mean every neighbor is both
    // higher-high and lower-low than it, a contradiction for strength>0),
    // so no dedup needed here — but keep the checks independent in case
    // strength is ever 0.
    if (isHigh) points.push({ index: i, time: bar.t, price: bar.h, type: 'high', label: null });
    if (isLow) points.push({ index: i, time: bar.t, price: bar.l, type: 'low', label: null });
  }
  return points;
}

// Labels each swing point relative to the previous swing point of the
// *same* type (highs compared to the last high, lows to the last low —
// comparing a high to a low would be meaningless).
function labelSwingPoints(points: SwingPoint[]): SwingPoint[] {
  let lastHigh: SwingPoint | null = null;
  let lastLow: SwingPoint | null = null;
  return points.map((p) => {
    if (p.type === 'high') {
      const label: SwingLabel = lastHigh === null ? null : p.price > lastHigh.price ? 'HH' : 'LH';
      lastHigh = p;
      return { ...p, label };
    } else {
      const label: SwingLabel = lastLow === null ? null : p.price > lastLow.price ? 'HL' : 'LL';
      lastLow = p;
      return { ...p, label };
    }
  });
}

// ---------------------------------------------------------------------
// Break of Structure (BOS) / Change of Character (CHoCH)
// ---------------------------------------------------------------------
// Standard definitions:
//   - In a bullish structure (confirmed by an HH followed by an HL),
//     a close ABOVE the most recent swing high = BOS: the uptrend
//     continuing to make new structure.
//   - A close BELOW the most recent swing low while structure is
//     bullish = CHoCH: the first break that suggests the uptrend's
//     structure is failing — a possible reversal starting.
//   - Mirror image for bearish structure (confirmed by an LL followed
//     by an LH): a close below the most recent swing low = BOS
//     (continuation down); a close above the most recent swing high =
//     CHoCH (possible reversal up).
//   - Before a trend is confirmed either way, breaks aren't logged —
//     there's no established structure yet to break.

export type StructureEventType = 'BOS' | 'CHoCH';
export type StructureEvent = {
  index: number; // candle index where the break closed beyond the level
  time: number;
  type: StructureEventType;
  direction: 'bullish' | 'bearish'; // the structure direction this break confirms/establishes
  brokenLevel: number; // the swing price that was broken
  brokenSwingIndex: number; // index of the swing point that defined that level
};

export type StructureSnapshot = {
  swings: SwingPoint[];
  events: StructureEvent[];
  currentTrend: 'bullish' | 'bearish' | 'undefined';
  lastSwingHigh: SwingPoint | null;
  lastSwingLow: SwingPoint | null;
};

export function computeMarketStructure(candles: Candle[], strength: number = DEFAULT_STRENGTH): StructureSnapshot {
  const minBars = strength * 2 + 3;
  if (candles.length < minBars) {
    return { swings: [], events: [], currentTrend: 'undefined', lastSwingHigh: null, lastSwingLow: null };
  }

  const swings = labelSwingPoints(findRawSwingPoints(candles, strength));

  // Walk swings chronologically to find the point a bullish or bearish
  // structure is first *confirmed* (HH then HL, or LL then LH) — before
  // that, currentTrend stays 'undefined' and no breaks are logged.
  let currentTrend: 'bullish' | 'bearish' | 'undefined' = 'undefined';
  let lastSwingHigh: SwingPoint | null = null;
  let lastSwingLow: SwingPoint | null = null;
  let pendingHH = false; // saw an HH, waiting to see if an HL confirms bullish structure
  let pendingLL = false; // saw an LL, waiting to see if an LH confirms bearish structure
  const events: StructureEvent[] = [];

  // Levels currently "live" for BOS/CHoCH purposes — the most recent
  // swing high/low at the time we last checked, so a break is measured
  // against structure as it stood before this bar, not after (a swing
  // point can't be confirmed as a fractal until `strength` bars after
  // it forms anyway, so this is naturally lagged and can't look ahead).
  let watchedHigh: SwingPoint | null = null;
  let watchedLow: SwingPoint | null = null;

  let swingCursor = 0;
  for (let i = 0; i < candles.length; i++) {
    // Bring in any swing points that have become confirmed as of this bar.
    while (swingCursor < swings.length && swings[swingCursor].index <= i) {
      const sp = swings[swingCursor];
      if (sp.type === 'high') {
        if (sp.label === 'HH') pendingHH = true;
        if (sp.label === 'LH' && currentTrend === 'bearish') pendingLL = false; // stays bearish, LH alone doesn't break it further here
        lastSwingHigh = sp;
        watchedHigh = sp;
      } else {
        if (sp.label === 'LL') pendingLL = true;
        if (sp.label === 'HL' && pendingHH) {
          currentTrend = 'bullish';
          pendingHH = false;
        }
        lastSwingLow = sp;
        watchedLow = sp;
      }
      // Bearish confirmation mirrors bullish: LL then LH.
      if (sp.type === 'high' && sp.label === 'LH' && pendingLL) {
        currentTrend = 'bearish';
        pendingLL = false;
      }
      swingCursor++;
    }

    const close = candles[i].c;

    if (currentTrend === 'bullish' && watchedLow) {
      if (close < watchedLow.price) {
        events.push({ index: i, time: candles[i].t, type: 'CHoCH', direction: 'bearish', brokenLevel: watchedLow.price, brokenSwingIndex: watchedLow.index });
        currentTrend = 'bearish';
        pendingLL = false;
        pendingHH = false;
        watchedLow = null; // require a fresh swing low before the next bearish break can log
      } else if (watchedHigh && close > watchedHigh.price) {
        events.push({ index: i, time: candles[i].t, type: 'BOS', direction: 'bullish', brokenLevel: watchedHigh.price, brokenSwingIndex: watchedHigh.index });
        watchedHigh = null; // require a fresh swing high before the next continuation break can log
      }
    } else if (currentTrend === 'bearish' && watchedHigh) {
      if (close > watchedHigh.price) {
        events.push({ index: i, time: candles[i].t, type: 'CHoCH', direction: 'bullish', brokenLevel: watchedHigh.price, brokenSwingIndex: watchedHigh.index });
        currentTrend = 'bullish';
        pendingHH = false;
        pendingLL = false;
        watchedHigh = null;
      } else if (watchedLow && close < watchedLow.price) {
        events.push({ index: i, time: candles[i].t, type: 'BOS', direction: 'bearish', brokenLevel: watchedLow.price, brokenSwingIndex: watchedLow.index });
        watchedLow = null;
      }
    }
  }

  return { swings, events, currentTrend, lastSwingHigh, lastSwingLow };
}

// ---------------------------------------------------------------------
// Chat context injection — same pattern as buildMultiTimeframeContext.
// ---------------------------------------------------------------------
export type StructureLookup = (symbol: string, timeframe: string) => { candles: Candle[] } | undefined;

// Structure is checked on these timeframes by default — 15m for
// near-term structure, 1h/4h for the higher-timeframe picture. All
// three are already kept warm by CandlesProvider from Commit 8, so this
// needs no new fetching.
const STRUCTURE_TIMEFRAMES = ['15m', '1h', '4h'];

function describeTrend(t: 'bullish' | 'bearish' | 'undefined'): string {
  return t === 'bullish' ? 'Bullish (HH/HL)' : t === 'bearish' ? 'Bearish (LL/LH)' : 'No confirmed structure yet';
}

export function buildStructureContext(watchlist: WatchItem[], lookup: StructureLookup): string {
  if (watchlist.length === 0) {
    return 'MARKET STRUCTURE: no watchlist symbols to analyze.';
  }

  const blocks: string[] = [];
  for (const item of watchlist) {
    const lines: string[] = [];
    for (const tf of STRUCTURE_TIMEFRAMES) {
      const entry = lookup(item.symbol, tf);
      if (!entry || entry.candles.length === 0) {
        lines.push(`  ${tf}: no candle history yet`);
        continue;
      }
      const snap = computeMarketStructure(entry.candles);
      if (snap.swings.length === 0) {
        lines.push(`  ${tf}: not enough bars yet for swing detection`);
        continue;
      }
      const recentEvents = snap.events.slice(-2);
      const eventStr =
        recentEvents.length > 0
          ? ` — recent: ${recentEvents.map((e) => `${e.type} @ ${e.brokenLevel.toFixed(2)} (now ${e.direction})`).join(', ')}`
          : '';
      const hhLabel = snap.lastSwingHigh ? `last swing high ${snap.lastSwingHigh.price.toFixed(2)} (${snap.lastSwingHigh.label ?? 'first'})` : 'no swing high yet';
      const llLabel = snap.lastSwingLow ? `last swing low ${snap.lastSwingLow.price.toFixed(2)} (${snap.lastSwingLow.label ?? 'first'})` : 'no swing low yet';
      lines.push(`  ${tf}: ${describeTrend(snap.currentTrend)} — ${hhLabel}, ${llLabel}${eventStr}`);
    }
    blocks.push(`${item.symbol}:\n${lines.join('\n')}`);
  }

  return `MARKET STRUCTURE (real swing high/low detection + BOS/CHoCH from actual OHLC history — not the model's read of the chart):\n${blocks.join(
    '\n\n',
  )}\n\nBOS = Break of Structure (trend continuing to make new structure). CHoCH = Change of Character (structure just broke the opposite way — treat as an early reversal warning, not a confirmed reversal). If a timeframe shows "no confirmed structure yet," say so rather than guessing a trend.`;
}
