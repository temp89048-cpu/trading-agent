import type { Candle } from './indicators';
import type { WatchItem } from './types';

// ---------------------------------------------------------------------
// Volume Profile: bucket the traded price range into bins and sum
// volume per bin to find the Point of Control (the price with the most
// traded volume) and the Value Area (the tightest price range
// containing ~70% of total volume, expanding outward from the POC).
//
// Honest simplification: real volume profile tools distribute a
// candle's volume across every price tick it traded at, using
// intrabar tick data. OHLCV candles don't carry that — only open/high/
// low/close/volume for the whole bar — so each candle's volume here is
// assigned to the bin containing its typical price ((h+l+c)/3), not
// spread across its full range. This is a standard, well-understood
// approximation, but it's coarser than a real tick-level profile,
// especially on candles with wide ranges. Flagged in the context string
// below rather than presented as more precise than it is.
// ---------------------------------------------------------------------

const DEFAULT_BINS = 24;
const VALUE_AREA_PCT = 0.7;
// A bucket counts as a High-Volume Node if it's a local peak (more
// volume than both neighbors) AND holds at least this multiple of the
// average bucket volume — a real concentration, not just "slightly more
// than its neighbor." Low-Volume Node is the mirror: a local trough at
// or below this fraction of average — price tends to move fast through
// these since little traded there.
const HVN_MULTIPLIER = 1.5;
const LVN_MULTIPLIER = 0.5;

export type VolumeBucket = {
  priceLow: number;
  priceHigh: number;
  volume: number;
};

export type VolumeNode = {
  price: number; // midpoint of the bucket
  volume: number;
  type: 'hvn' | 'lvn';
};

export type VolumeProfile = {
  buckets: VolumeBucket[];
  poc: number; // price at the center of the highest-volume bucket
  vah: number; // top of the value area
  val: number; // bottom of the value area
  totalVolume: number;
  highVolumeNodes: VolumeNode[]; // local volume peaks, strongest first (POC is always the top one)
  lowVolumeNodes: VolumeNode[]; // local volume troughs, thinnest first
};

// Local-extrema scan over the price-ordered bucket array — a bucket is
// a node only if it's a genuine peak/trough against BOTH neighbors, not
// just a snapshot comparison, so a single noisy bucket next to an even
// noisier one doesn't get flagged.
function findVolumeNodes(buckets: VolumeBucket[], totalVolume: number): { hvn: VolumeNode[]; lvn: VolumeNode[] } {
  const mean = totalVolume / buckets.length;
  const hvn: VolumeNode[] = [];
  const lvn: VolumeNode[] = [];

  for (let i = 0; i < buckets.length; i++) {
    const b = buckets[i];
    const prev = i > 0 ? buckets[i - 1].volume : null;
    const next = i < buckets.length - 1 ? buckets[i + 1].volume : null;
    const price = (b.priceLow + b.priceHigh) / 2;

    const higherThanBothNeighbors = (prev === null || b.volume > prev) && (next === null || b.volume > next);
    if (higherThanBothNeighbors && b.volume >= mean * HVN_MULTIPLIER) {
      hvn.push({ price, volume: b.volume, type: 'hvn' });
    }

    const lowerThanBothNeighbors = (prev === null || b.volume < prev) && (next === null || b.volume < next);
    if (lowerThanBothNeighbors && b.volume <= mean * LVN_MULTIPLIER) {
      lvn.push({ price, volume: b.volume, type: 'lvn' });
    }
  }

  hvn.sort((a, b) => b.volume - a.volume); // strongest concentration first
  lvn.sort((a, b) => a.volume - b.volume); // thinnest (most likely to move fast through) first
  return { hvn, lvn };
}

export function computeVolumeProfile(candles: Candle[], bins: number = DEFAULT_BINS): VolumeProfile | null {
  if (candles.length === 0) return null;

  const minPrice = Math.min(...candles.map((c) => c.l));
  const maxPrice = Math.max(...candles.map((c) => c.h));
  if (maxPrice <= minPrice) return null; // degenerate/flat data — nothing to profile

  const binSize = (maxPrice - minPrice) / bins;
  const buckets: VolumeBucket[] = Array.from({ length: bins }, (_, i) => ({
    priceLow: minPrice + i * binSize,
    priceHigh: minPrice + (i + 1) * binSize,
    volume: 0,
  }));

  for (const c of candles) {
    const typicalPrice = (c.h + c.l + c.c) / 3;
    let idx = Math.floor((typicalPrice - minPrice) / binSize);
    if (idx >= bins) idx = bins - 1;
    if (idx < 0) idx = 0;
    buckets[idx].volume += c.v;
  }

  const totalVolume = buckets.reduce((s, b) => s + b.volume, 0);
  if (totalVolume === 0) return null;

  let pocIdx = 0;
  for (let i = 1; i < buckets.length; i++) {
    if (buckets[i].volume > buckets[pocIdx].volume) pocIdx = i;
  }
  const poc = (buckets[pocIdx].priceLow + buckets[pocIdx].priceHigh) / 2;

  // Expand the value area outward from the POC bucket, one bucket at a
  // time, always adding whichever neighbor (above or below the current
  // range) has more volume — standard value-area construction.
  let loIdx = pocIdx;
  let hiIdx = pocIdx;
  let accumulated = buckets[pocIdx].volume;
  while (accumulated / totalVolume < VALUE_AREA_PCT && (loIdx > 0 || hiIdx < buckets.length - 1)) {
    const belowVol = loIdx > 0 ? buckets[loIdx - 1].volume : -1;
    const aboveVol = hiIdx < buckets.length - 1 ? buckets[hiIdx + 1].volume : -1;
    if (aboveVol >= belowVol) {
      hiIdx++;
      accumulated += buckets[hiIdx].volume;
    } else {
      loIdx--;
      accumulated += buckets[loIdx].volume;
    }
  }

  const { hvn, lvn } = findVolumeNodes(buckets, totalVolume);

  return {
    buckets,
    poc,
    vah: buckets[hiIdx].priceHigh,
    val: buckets[loIdx].priceLow,
    totalVolume,
    highVolumeNodes: hvn,
    lowVolumeNodes: lvn,
  };
}

// ---------------------------------------------------------------------
// Chat context injection — same pattern as the other Level-1 agents.
// ---------------------------------------------------------------------
export type VolumeProfileLookup = (symbol: string, timeframe: string) => { candles: Candle[] } | undefined;
// Volume profile is most meaningful over a defined session/range — 1h
// candles over the recent history already cached give a reasonable
// "recent trading range" profile without needing a new data fetch.
const VOLUME_PROFILE_TIMEFRAME = '1h';

export function buildVolumeProfileContext(watchlist: WatchItem[], lookup: VolumeProfileLookup): string {
  if (watchlist.length === 0) return 'VOLUME PROFILE: no watchlist symbols to analyze.';

  const lines: string[] = [];
  for (const item of watchlist) {
    const entry = lookup(item.symbol, VOLUME_PROFILE_TIMEFRAME);
    if (!entry || entry.candles.length === 0) {
      lines.push(`${item.symbol}: no candle history yet`);
      continue;
    }
    const profile = computeVolumeProfile(entry.candles);
    if (!profile) {
      lines.push(`${item.symbol}: not enough volume data yet`);
      continue;
    }
    const parts = [`POC ${profile.poc.toFixed(2)}`, `Value Area ${profile.val.toFixed(2)}–${profile.vah.toFixed(2)}`];
    const otherHvns = profile.highVolumeNodes.filter((n) => Math.abs(n.price - profile.poc) > 1e-9).slice(0, 2);
    if (otherHvns.length > 0) parts.push(`other high-volume nodes: ${otherHvns.map((n) => n.price.toFixed(2)).join(', ')}`);
    const lvns = profile.lowVolumeNodes.slice(0, 2);
    if (lvns.length > 0) parts.push(`low-volume nodes (price likely to move fast through): ${lvns.map((n) => n.price.toFixed(2)).join(', ')}`);
    lines.push(`${item.symbol}: ${parts.join(', ')} (over the last ${entry.candles.length} 1h bars)`);
  }

  return `VOLUME PROFILE (POC = heaviest-traded price, Value Area = range holding ~70% of volume, High/Low-Volume Nodes = local peaks/troughs in the volume histogram — all computed from real candle volume, approximated per-candle at typical price since tick-level data isn't available):\n${lines.join(
    '\n',
  )}\n\nPrice trading back into a low-volume node tends to move faster through it; high-volume nodes (including but not limited to the POC) tend to see more two-way, rangebound action and can act as support/resistance on a retest.`;
}
