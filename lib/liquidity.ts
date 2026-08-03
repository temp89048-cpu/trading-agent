import type { Candle } from './indicators';
import type { WatchItem } from './types';
import { findRawSwingPoints, DEFAULT_STRENGTH, type SwingPoint, type SwingPointType } from './marketStructure';

// ---------------------------------------------------------------------
// Liquidity zones: clusters of swing highs (or lows) that sit close
// enough together in price that the market treats them as one level —
// each one is a pool of resting stop-losses/orders. "Equal highs" above
// price is where short-sellers' stops and breakout-buyers' orders
// cluster; "equal lows" below is the mirror for longs.
// ---------------------------------------------------------------------

export type LiquidityZoneType = 'equal_highs' | 'equal_lows';

export type LiquidityZone = {
  type: LiquidityZoneType;
  level: number; // average price of the clustered swings
  touches: number; // how many swing points contributed to this zone
  size: 'large' | 'standard'; // 'large' = enough independent touches that this reads as a real resting-order pool, not just two coincidental wicks
  firstIndex: number;
  lastIndex: number;
};

// How close (as a % of price) two swing highs (or two swing lows) need
// to be to count as "equal" rather than two distinct levels. Real charts
// rarely print two wicks at the exact same tick, so this needs to be a
// tolerance band, not an exact match.
const EQUAL_TOLERANCE_PCT = 0.15;
// Minimum number of swing points clustered together to call it a real
// liquidity zone — two lone swings 0.1% apart could be coincidence, but
// enough of a signal is still worth flagging at touches>=2.
const MIN_TOUCHES = 2;
// A zone with this many touches or more is a genuinely large pool — the
// same level got respected/rejected repeatedly, meaning a lot of orders
// have likely stacked up there, not just two coincidental wicks.
const LARGE_POOL_MIN_TOUCHES = 3;

function clusterSwings(points: SwingPoint[], type: SwingPointType): LiquidityZone[] {
  const same = points.filter((p) => p.type === type).sort((a, b) => a.price - b.price);
  const zones: LiquidityZone[] = [];
  let cluster: SwingPoint[] = [];

  function flush() {
    if (cluster.length >= MIN_TOUCHES) {
      const level = cluster.reduce((s, p) => s + p.price, 0) / cluster.length;
      zones.push({
        type: type === 'high' ? 'equal_highs' : 'equal_lows',
        level,
        touches: cluster.length,
        size: cluster.length >= LARGE_POOL_MIN_TOUCHES ? 'large' : 'standard',
        firstIndex: Math.min(...cluster.map((p) => p.index)),
        lastIndex: Math.max(...cluster.map((p) => p.index)),
      });
    }
    cluster = [];
  }

  for (const p of same) {
    if (cluster.length === 0) {
      cluster.push(p);
      continue;
    }
    const clusterAvg = cluster.reduce((s, c) => s + c.price, 0) / cluster.length;
    const withinTolerance = Math.abs(p.price - clusterAvg) / clusterAvg <= EQUAL_TOLERANCE_PCT / 100;
    if (withinTolerance) {
      cluster.push(p);
    } else {
      flush();
      cluster.push(p);
    }
  }
  flush();

  return zones.sort((a, b) => b.lastIndex - a.lastIndex); // most recently touched first
}

// ---------------------------------------------------------------------
// Liquidity sweeps / stop hunts: a candle whose WICK pierces through a
// liquidity zone (grabbing the resting orders there) but whose CLOSE
// reverses back to the other side of it — the classic "stop hunt" or
// "liquidity grab" pattern. Uses raw wick-vs-close, nothing inferred.
// ---------------------------------------------------------------------

export type LiquiditySweepEvent = {
  index: number;
  time: number;
  zone: LiquidityZone;
  wickPrice: number; // how far the wick reached beyond the zone
};

function detectSweeps(candles: Candle[], zones: LiquidityZone[]): LiquiditySweepEvent[] {
  const events: LiquiditySweepEvent[] = [];
  for (const zone of zones) {
    // Only look at candles after the zone's last contributing swing —
    // a sweep has to happen after the liquidity pool actually formed.
    for (let i = zone.lastIndex + 1; i < candles.length; i++) {
      const bar = candles[i];
      if (zone.type === 'equal_highs' && bar.h > zone.level && bar.c < zone.level) {
        events.push({ index: i, time: bar.t, zone, wickPrice: bar.h });
        break; // one sweep logged per zone is enough signal — once swept, that pool is spent
      }
      if (zone.type === 'equal_lows' && bar.l < zone.level && bar.c > zone.level) {
        events.push({ index: i, time: bar.t, zone, wickPrice: bar.l });
        break;
      }
    }
  }
  return events.sort((a, b) => b.index - a.index);
}

export type LiquiditySnapshot = {
  zones: LiquidityZone[];
  sweeps: LiquiditySweepEvent[];
};

export function computeLiquidity(candles: Candle[], strength: number = DEFAULT_STRENGTH): LiquiditySnapshot {
  if (candles.length < strength * 2 + 3) return { zones: [], sweeps: [] };
  const swings = findRawSwingPoints(candles, strength);
  const zones = [...clusterSwings(swings, 'high'), ...clusterSwings(swings, 'low')];
  const sweeps = detectSweeps(candles, zones);
  return { zones, sweeps };
}

// ---------------------------------------------------------------------
// Chat context injection — same pattern as multiTimeframe/marketStructure.
// ---------------------------------------------------------------------
export type LiquidityLookup = (symbol: string, timeframe: string) => { candles: Candle[] } | undefined;
const LIQUIDITY_TIMEFRAMES = ['15m', '1h', '4h'];

export function buildLiquidityContext(watchlist: WatchItem[], lookup: LiquidityLookup): string {
  if (watchlist.length === 0) return 'LIQUIDITY ANALYSIS: no watchlist symbols to analyze.';

  const blocks: string[] = [];
  for (const item of watchlist) {
    const lines: string[] = [];
    for (const tf of LIQUIDITY_TIMEFRAMES) {
      const entry = lookup(item.symbol, tf);
      if (!entry || entry.candles.length === 0) {
        lines.push(`  ${tf}: no candle history yet`);
        continue;
      }
      const snap = computeLiquidity(entry.candles);
      if (snap.zones.length === 0) {
        lines.push(`  ${tf}: no equal-high/low clusters detected yet`);
        continue;
      }
      // Only surface the most recent couple of zones per side — older,
      // untouched pools further from price are less actionable, and a
      // long list is just noise to the model.
      const highs = snap.zones.filter((z) => z.type === 'equal_highs').slice(0, 2);
      const lows = snap.zones.filter((z) => z.type === 'equal_lows').slice(0, 2);
      const largePools = snap.zones.filter((z) => z.size === 'large');
      const recentSweep = snap.sweeps[0];
      const parts: string[] = [];
      if (highs.length > 0) {
        parts.push(`liquidity above at ${highs.map((h) => `${h.level.toFixed(2)} (${h.touches}x${h.size === 'large' ? ', LARGE POOL' : ''})`).join(', ')}`);
      }
      if (lows.length > 0) {
        parts.push(`liquidity below at ${lows.map((l) => `${l.level.toFixed(2)} (${l.touches}x${l.size === 'large' ? ', LARGE POOL' : ''})`).join(', ')}`);
      }
      if (largePools.length > 0) {
        parts.push(
          `large pools (3+ touches, more resting orders than a typical equal-high/low pair): ${largePools
            .map((z) => `${z.level.toFixed(2)} (${z.touches}x ${z.type === 'equal_highs' ? 'above' : 'below'})`)
            .join(', ')}`,
        );
      }
      if (recentSweep) {
        parts.push(
          `most recent sweep: ${recentSweep.zone.type === 'equal_highs' ? 'upside' : 'downside'} liquidity grabbed at ${recentSweep.zone.level.toFixed(2)} then reversed`,
        );
      }
      lines.push(`  ${tf}: ${parts.join('; ')}`);
    }
    blocks.push(`${item.symbol}:\n${lines.join('\n')}`);
  }

  return `LIQUIDITY ANALYSIS (equal-high/low clusters from real swing points + wick-vs-close sweep detection — not inferred):\n${blocks.join(
    '\n\n',
  )}\n\nThese are zones where stops/orders likely cluster, not guaranteed reversal points. "LARGE POOL" (3+ touches) means the level was respected/rejected repeatedly — more resting size than a standard 2-touch pair. A "sweep" means price wicked through the level and closed back — treat it as one input among several, not a standalone signal.`;
}
