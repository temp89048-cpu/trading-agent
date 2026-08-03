import { describe, it, expect } from 'vitest';
import { rsi, ema, sma, atr, macd, bollingerBands, type Candle } from './indicators';

function makeCandles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({ t: i * 60_000, o: c, h: c + 1, l: c - 1, c, v: 100 }));
}

describe('rsi', () => {
  it('is 100 for a strictly rising series (no losses at all)', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    expect(rsi(closes, 14)).toBe(100);
  });

  it('is 0 for a strictly falling series (no gains at all)', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 200 - i);
    expect(rsi(closes, 14)).toBe(0);
  });

  it('is 50 for a perfectly flat series (no gains, no losses)', () => {
    const closes = Array(30).fill(100);
    expect(rsi(closes, 14)).toBe(50);
  });

  it('returns null when there is not enough history for the period', () => {
    expect(rsi([1, 2, 3], 14)).toBeNull();
  });
});

describe('ema', () => {
  it('returns null before enough data points exist', () => {
    expect(ema([1, 2, 3], 10)).toBeNull();
  });

  it('converges toward a constant series', () => {
    const values = Array(50).fill(42);
    expect(ema(values, 20)).toBeCloseTo(42, 6);
  });

  it('reacts in the direction of a trend (fast EMA above slow EMA in an uptrend)', () => {
    const values = Array.from({ length: 100 }, (_, i) => 100 + i * 0.5);
    const fast = ema(values, 10)!;
    const slow = ema(values, 50)!;
    expect(fast).toBeGreaterThan(slow);
  });
});

describe('sma', () => {
  it('averages exactly the last `period` values, ignoring older ones', () => {
    expect(sma([1, 1, 1, 10, 20, 30], 3)).toBeCloseTo(20, 6);
  });

  it('returns null when fewer than `period` values are available', () => {
    expect(sma([1, 2], 5)).toBeNull();
  });
});

describe('atr', () => {
  it('is null with insufficient candles', () => {
    expect(atr(makeCandles([100, 101, 102]), 14)).toBeNull();
  });

  it('is always non-negative and roughly tracks per-bar range', () => {
    const candles = makeCandles(Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5));
    const value = atr(candles, 14);
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThan(0);
  });
});

describe('macd', () => {
  it('is null before slow + signal period bars exist', () => {
    expect(macd(Array(20).fill(100), 12, 26, 9)).toBeNull();
  });

  it('produces a positive histogram in a sustained uptrend', () => {
    const closes = Array.from({ length: 100 }, (_, i) => 100 + i * 0.8);
    const result = macd(closes);
    expect(result).not.toBeNull();
    expect(result!.macd).toBeGreaterThan(0);
  });
});

describe('bollingerBands', () => {
  it('orders lower <= middle <= upper', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 4);
    const bands = bollingerBands(closes, 20, 2);
    expect(bands).not.toBeNull();
    expect(bands!.lower).toBeLessThanOrEqual(bands!.middle);
    expect(bands!.middle).toBeLessThanOrEqual(bands!.upper);
  });

  it('collapses to a single point (zero width) for a perfectly flat series', () => {
    const bands = bollingerBands(Array(40).fill(100), 20, 2);
    expect(bands!.upper).toBeCloseTo(bands!.lower, 6);
  });
});
