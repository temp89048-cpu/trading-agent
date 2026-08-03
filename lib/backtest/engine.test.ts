import { describe, it, expect } from 'vitest';
import { upperBoundIndex, MTF_INTERVAL_MS } from './engine';
import type { Candle } from '../indicators';

// Regression test for a real lookahead-bias bug: makeMtfLookupAsOf used
// to include an MTF candle once its OPEN time had passed, even if the
// candle hadn't actually CLOSED yet — leaking up to a full bar's worth
// of future price action into the strategy. The fix requires
// t + durationMs <= asOfTs, not just t <= asOfTs. See lib/backtest/engine.ts.

function candle(t: number, c = 100): Candle {
  return { t, o: c, h: c, l: c, c, v: 1 };
}

describe('upperBoundIndex — MTF lookahead safety', () => {
  const hourMs = MTF_INTERVAL_MS['1h'];
  // Three consecutive 1h candles: 08:00-09:00, 09:00-10:00, 10:00-11:00.
  const candles = [candle(hourMs * 8), candle(hourMs * 9), candle(hourMs * 10)];

  it('excludes a still-forming candle even though its open time has already passed', () => {
    // At 09:15, the 09:00 candle has OPENED but won't close until 10:00.
    const asOfTs = hourMs * 9 + 15 * 60_000;
    const idx = upperBoundIndex(candles, asOfTs, hourMs);
    expect(idx).toBe(0); // only the 08:00 candle (which closed at 09:00) is real data
  });

  it('includes a candle exactly at the instant it closes', () => {
    const asOfTs = hourMs * 10; // the 09:00 candle's exact close time
    const idx = upperBoundIndex(candles, asOfTs, hourMs);
    expect(idx).toBe(1);
  });

  it('excludes everything before the first candle has even closed', () => {
    const asOfTs = hourMs * 8 + 30 * 60_000; // 08:30, mid-formation of the first candle
    expect(upperBoundIndex(candles, asOfTs, hourMs)).toBe(-1);
  });

  it('includes all candles once enough time has passed for all to close', () => {
    const asOfTs = hourMs * 12;
    expect(upperBoundIndex(candles, asOfTs, hourMs)).toBe(2);
  });
});
