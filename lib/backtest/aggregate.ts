import type { Candle } from '../indicators';
import type { MtfTimeframe } from '../multiTimeframe';

// Building 5m/15m/1h/4h from a single 1m download (or 1h from a single
// 15m download, etc.) gives perfect timestamp alignment by construction
// — no cross-provider clock skew, no gaps between two separately-fetched
// series, and one download instead of several. This is how real
// backtesting engines avoid the "MTF requires N fetches" problem
// entirely rather than just caching the N fetches (see mtfCache.server.ts
// for the caching layer, used when aggregation isn't possible because
// the base interval itself needed a live fetch anyway).

const TIMEFRAME_MINUTES: Record<MtfTimeframe, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10080,
};

// Which base timeframe would you need to fetch once to derive ALL of
// these targets by aggregation? Returns the finest (smallest) timeframe
// in the list, since every coarser one in the list is an integer
// multiple of it — aggregation only works cleanly for exact multiples.
export function pickAggregationBase(targets: MtfTimeframe[]): MtfTimeframe {
  return [...targets].sort((a, b) => TIMEFRAME_MINUTES[a] - TIMEFRAME_MINUTES[b])[0];
}

export function canAggregate(base: MtfTimeframe, target: MtfTimeframe): boolean {
  const baseMin = TIMEFRAME_MINUTES[base];
  const targetMin = TIMEFRAME_MINUTES[target];
  return targetMin >= baseMin && targetMin % baseMin === 0;
}

// Aggregates ascending-by-time base candles into the target timeframe.
// Bucketing is aligned to UTC epoch boundaries (bucket = floor(t /
// bucketMs) * bucketMs), matching how exchanges themselves align kline
// buckets — NOT aligned to the first candle's own timestamp, which
// would silently drift from what a live fetch of that timeframe would
// actually return.
export function aggregateCandles(base: Candle[], baseInterval: MtfTimeframe, targetInterval: MtfTimeframe): Candle[] {
  if (baseInterval === targetInterval) return base;
  if (!canAggregate(baseInterval, targetInterval)) {
    throw new Error(`Cannot aggregate ${baseInterval} candles into ${targetInterval} — target must be an integer multiple of the base interval.`);
  }
  const bucketMs = TIMEFRAME_MINUTES[targetInterval] * 60_000;

  const buckets = new Map<number, Candle[]>();
  for (const c of base) {
    const bucketStart = Math.floor(c.t / bucketMs) * bucketMs;
    const list = buckets.get(bucketStart);
    if (list) list.push(c);
    else buckets.set(bucketStart, [c]);
  }

  const out: Candle[] = [];
  const sortedBucketStarts = [...buckets.keys()].sort((a, b) => a - b);
  for (const bucketStart of sortedBucketStarts) {
    const group = buckets.get(bucketStart)!;
    // Only emit a bucket once it's had a chance to fully fill — a
    // partial final bucket (fewer base candles than the ratio implies)
    // would understate that period's true range/volume and, worse,
    // could look like "current" data mid-formation. Since this is used
    // for historical backtesting (never a live in-progress bar), drop
    // any bucket that doesn't have the full expected count.
    const expectedCount = bucketMs / (TIMEFRAME_MINUTES[baseInterval] * 60_000);
    if (group.length < expectedCount) continue;
    group.sort((a, b) => a.t - b.t);
    out.push({
      t: bucketStart,
      o: group[0].o,
      h: Math.max(...group.map((g) => g.h)),
      l: Math.min(...group.map((g) => g.l)),
      c: group[group.length - 1].c,
      v: group.reduce((s, g) => s + g.v, 0),
    });
  }
  return out;
}
