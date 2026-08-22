import { describe, expect, it } from 'vitest';

import { isCanvasSafe, withAlpha } from './color';

describe('withAlpha', () => {
  it('converts the exact colour that crashed the chart', () => {
    // `color-mix(in srgb, #16C784 45%, transparent)` is what CandlestickChart used
    // to build, and lightweight-charts' own parser rejects it. The equivalent
    // rgba() is what it accepts.
    expect(withAlpha('#16C784', 0.45)).toBe('rgba(22, 199, 132, 0.45)');
  });

  it('handles the three theme accent colours', () => {
    expect(withAlpha('#EA3943', 0.45)).toBe('rgba(234, 57, 67, 0.45)');
    expect(withAlpha('#3B82F6', 1)).toBe('rgba(59, 130, 246, 1)');
    expect(withAlpha('#F0B90B', 0)).toBe('rgba(240, 185, 11, 0)');
  });

  it('expands 3- and 4-digit hex', () => {
    expect(withAlpha('#fff', 0.5)).toBe('rgba(255, 255, 255, 0.5)');
    expect(withAlpha('#000', 1)).toBe('rgba(0, 0, 0, 1)');
    // The 4th digit is alpha, and it must MULTIPLY rather than be discarded.
    expect(withAlpha('#0008', 1)).toBe('rgba(0, 0, 0, 0.533)');
  });

  it('multiplies into an existing 8-digit hex alpha', () => {
    // Discarding the input's own alpha would make a deliberately-faint colour
    // fully opaque, which is a silent design change.
    expect(withAlpha('#16C78480', 0.5)).toBe('rgba(22, 199, 132, 0.251)');
  });

  it('accepts rgb() and rgba() input', () => {
    expect(withAlpha('rgb(22, 199, 132)', 0.45)).toBe('rgba(22, 199, 132, 0.45)');
    expect(withAlpha('rgba(22,199,132,0.8)', 0.5)).toBe('rgba(22, 199, 132, 0.4)');
    // Space/slash syntax, which getComputedStyle can return.
    expect(withAlpha('rgb(22 199 132 / 50%)', 1)).toBe('rgba(22, 199, 132, 0.5)');
  });

  it('clamps alpha rather than emitting a value outside 0..1', () => {
    expect(withAlpha('#16C784', 5)).toBe('rgba(22, 199, 132, 1)');
    expect(withAlpha('#16C784', -3)).toBe('rgba(22, 199, 132, 0)');
  });

  it('returns the input unchanged when it cannot be parsed', () => {
    // THE IMPORTANT PROPERTY: never emit a string the library will reject. An
    // opaque bar is a visual nit; an unparseable colour took the whole route down.
    for (const input of [
      'color-mix(in srgb, #16C784 45%, transparent)',
      'var(--positive)',
      'oklch(70% 0.1 150)',
      'transparent',
      'red',
      'not a colour',
      '',
    ]) {
      expect(withAlpha(input, 0.45), input).toBe(input);
    }
  });

  it('never returns a string containing NaN', () => {
    for (const input of ['#16C784', 'rgb(a, b, c)', '#zzz', 'rgba(1,2,3,x)', '#12345']) {
      expect(withAlpha(input, 0.45), input).not.toContain('NaN');
    }
  });
});

describe('isCanvasSafe', () => {
  it('rejects the CSS colour functions a canvas parser cannot resolve', () => {
    for (const bad of [
      'color-mix(in srgb, #fff 45%, transparent)',
      'var(--positive)',
      'oklch(70% 0.1 150)',
      'lab(50% 20 -30)',
      '',
    ]) {
      expect(isCanvasSafe(bad), bad).toBe(false);
    }
  });

  it('accepts literals the parser handles', () => {
    for (const ok of ['#16C784', '#fff', 'rgb(1,2,3)', 'rgba(1,2,3,0.5)', 'red', 'transparent']) {
      expect(isCanvasSafe(ok), ok).toBe(true);
    }
  });
});
