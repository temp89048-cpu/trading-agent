import { describe, expect, it } from 'vitest';

import { sanitiseBars, type RawBar } from './bars';

const bar = (t: number, close = 100): RawBar => ({ t, o: close, h: close + 1, l: close - 1, c: close });

describe('sanitiseBars', () => {
  it('passes clean ascending bars through untouched', () => {
    const input = [bar(1_000), bar(2_000), bar(3_000)];
    const out = sanitiseBars(input);
    expect(out.bars).toHaveLength(3);
    expect(out.dropped).toBe(0);
    expect(out.reason).toBeNull();
  });

  it('drops the NaN-timestamp bar that crashed the route', () => {
    // The exact shape of the real bug: reading `c.openTime` off a payload whose
    // field is `c.t` gives undefined for every field, and Math.floor(undefined/1000)
    // is NaN. One of these reaching setData threw
    // "Assertion failed: data must be asc ordered by time ... time=NaN"
    // and took the whole page down.
    const wrongShape = { t: undefined, o: undefined, h: undefined, l: undefined, c: undefined } as unknown as RawBar;
    const out = sanitiseBars([bar(1_000), wrongShape, bar(2_000)]);
    expect(out.bars.map((b) => b.t)).toEqual([1_000, 2_000]);
    expect(out.dropped).toBe(1);
    expect(out.reason).toContain('1 of 3 candles were not drawn');
    expect(out.reason).toContain('field-name mismatch');
  });

  it('drops Infinity, NaN and a non-numeric close', () => {
    const out = sanitiseBars([
      bar(1_000),
      { t: 2_000, o: 1, h: Infinity, l: 1, c: 1 },
      { t: 3_000, o: 1, h: 1, l: 1, c: NaN },
      { t: 4_000, o: 1, h: 1, l: 1, c: '105' as unknown as number },
    ]);
    expect(out.bars.map((b) => b.t)).toEqual([1_000]);
    expect(out.dropped).toBe(3);
  });

  it('drops a zero or negative epoch rather than charting a 1970 candle', () => {
    // A default that leaked through, not a market timestamp. Drawing it squashes
    // every real candle into the right-hand edge.
    const out = sanitiseBars([bar(0), bar(-5), bar(1_000)]);
    expect(out.bars.map((b) => b.t)).toEqual([1_000]);
    expect(out.dropped).toBe(2);
  });

  it('sorts descending input ascending, because setData requires it', () => {
    const out = sanitiseBars([bar(3_000), bar(1_000), bar(2_000)]);
    expect(out.bars.map((b) => b.t)).toEqual([1_000, 2_000, 3_000]);
    // Reordering is not data loss.
    expect(out.dropped).toBe(0);
    expect(out.reason).toBeNull();
  });

  it('collapses a repeated timestamp, keeping the later revision', () => {
    // The assertion demands strictly ascending, so an equal timestamp throws too.
    const out = sanitiseBars([bar(1_000, 100), bar(1_000, 105), bar(2_000, 110)]);
    expect(out.bars).toHaveLength(2);
    expect(out.bars[0].c).toBe(105);
    expect(out.reason).toContain('repeated a timestamp');
  });

  it('reports both causes when both occur', () => {
    const out = sanitiseBars([
      bar(1_000),
      bar(1_000),
      { t: NaN, o: 1, h: 1, l: 1, c: 1 },
    ]);
    expect(out.reason).toContain('non-numeric field');
    expect(out.reason).toContain('repeated a timestamp');
  });

  it('returns an empty result for an empty input without claiming a drop', () => {
    const out = sanitiseBars([]);
    expect(out.bars).toEqual([]);
    expect(out.dropped).toBe(0);
    expect(out.reason).toBeNull();
  });

  it('returns zero bars — not a throw — when everything is malformed', () => {
    // The whole point: the chart must be able to say "nothing drawable" instead
    // of taking the route down.
    const out = sanitiseBars([{ t: NaN, o: NaN, h: NaN, l: NaN, c: NaN }]);
    expect(out.bars).toEqual([]);
    expect(out.dropped).toBe(1);
    expect(out.reason).not.toBeNull();
  });

  it('does not mutate its input', () => {
    const input = [bar(3_000), bar(1_000)];
    sanitiseBars(input);
    expect(input.map((b) => b.t)).toEqual([3_000, 1_000]);
  });
});
