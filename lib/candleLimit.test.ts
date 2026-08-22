import { describe, expect, it } from 'vitest';

import { DEFAULT_LIMIT, MAX_LIMIT, MIN_LIMIT, resolveLimit } from './candleLimit';

describe('resolveLimit', () => {
  it('takes the default when the caller does not supply one', () => {
    for (const raw of [null, '', '   ']) {
      const r = resolveLimit(raw);
      expect(r.ok && r.limit, String(raw)).toBe(DEFAULT_LIMIT);
      expect(r.ok && r.note).toBeNull();
    }
  });

  it('passes an in-range value through unchanged and unannotated', () => {
    for (const n of [MIN_LIMIT, 100, 200, MAX_LIMIT]) {
      const r = resolveLimit(String(n));
      expect(r.ok && r.limit, String(n)).toBe(n);
      expect(r.ok && r.note, String(n)).toBeNull();
    }
  });

  it('raises a too-small value to the floor AND says it did', () => {
    // The silent half of the original bug: limit=3 returned 20 candles with
    // nothing indicating the caller had been overruled.
    const r = resolveLimit('3');
    expect(r.ok && r.limit).toBe(MIN_LIMIT);
    expect(r.ok && r.requested).toBe(3);
    expect(r.ok && r.note).toContain('raised from 3');
    expect(r.ok && r.note).toContain('lookback');
  });

  it('lowers a too-large value to the ceiling AND says it did', () => {
    const r = resolveLimit('9999');
    expect(r.ok && r.limit).toBe(MAX_LIMIT);
    expect(r.ok && r.requested).toBe(9999);
    expect(r.ok && r.note).toContain('reduced from 9999');
    // Points at the route that can actually serve deep history.
    expect(r.ok && r.note).toContain('/api/backtest');
  });

  it('rejects a non-numeric limit instead of forwarding NaN upstream', () => {
    // The crash half: parseInt('abc') is NaN, Math.min/max propagate it, and
    // `limit=NaN` reached Binance, which answered 400 — surfaced to the caller as
    // a 502 blaming Binance for a parameter this route never checked.
    const r = resolveLimit('abc');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('must be a whole number');
    expect(!r.ok && r.error).toContain('abc');
  });

  it('rejects trailing junk rather than silently taking the leading digits', () => {
    // parseInt('20abc') is 20. Accepting that guesses at what the caller meant.
    const r = resolveLimit('20abc');
    expect(r.ok).toBe(false);
  });

  it('rejects signs, decimals and whitespace-separated values', () => {
    for (const raw of ['-5', '+20', '2.5', '1e3', '20 30', '0x14']) {
      expect(resolveLimit(raw).ok, raw).toBe(false);
    }
  });

  it('accepts zero as a number but clamps it to the floor', () => {
    // '0' parses cleanly, so it is a clamp case, not a parse error.
    const r = resolveLimit('0');
    expect(r.ok && r.limit).toBe(MIN_LIMIT);
    expect(r.ok && r.note).toContain('raised from 0');
  });

  it('rejects a value too large to be a safe integer', () => {
    expect(resolveLimit('99999999999999999999').ok).toBe(false);
  });

  it('never returns NaN for any input', () => {
    // The property that actually mattered: nothing NaN-shaped can reach the URL.
    for (const raw of ['abc', '', '0', '-1', '2.5', '9999', null, '  50  ']) {
      const r = resolveLimit(raw);
      if (r.ok) expect(Number.isSafeInteger(r.limit), String(raw)).toBe(true);
    }
  });
});
