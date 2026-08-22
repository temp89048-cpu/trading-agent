// ---------------------------------------------------------------------
// Alpha blending for colours handed to a CANVAS library.
//
// THE BUG THIS FIXES
//
// `CandlestickChart` coloured its volume bars with
// `color-mix(in srgb, #16C784 45%, transparent)`. That is valid CSS and renders
// fine in the DOM — which is why `Badge` and the rest of the design system use it
// freely. But `lightweight-charts` does NOT use the browser to parse colours; it
// ships its own parser, which understands hex, `rgb()`, `rgba()`, `hsl()` and
// named colours and nothing else. So it threw
//
//     Error: Failed to parse color: color-mix(in srgb, #16C784 45%, transparent)
//
// from inside `setData` -> price-axis rendering, which React surfaced as an
// unhandled runtime error and the whole route went white.
//
// THE RULE: CSS colour functions are for the DOM. Anything crossing into a canvas
// or WebGL library has to be resolved to a literal the library's own parser
// accepts. `withAlpha` is that boundary.
//
// IT NEVER RETURNS AN UNPARSEABLE STRING. If the input cannot be understood, the
// input is returned unchanged — an opaque bar is a small visual regression; a
// string the library rejects takes the page down.
// ---------------------------------------------------------------------

const HEX_SHORT = /^#([0-9a-f])([0-9a-f])([0-9a-f])([0-9a-f])?$/i;
const HEX_LONG = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i;
const RGB_FUNC = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/]\s*([\d.%]+)\s*)?\)$/i;

/** Parsed `r,g,b` in 0..255 and `a` in 0..1, or null when unrecognised. */
function parse(color: string): { r: number; g: number; b: number; a: number } | null {
  const c = color.trim();

  const short = HEX_SHORT.exec(c);
  if (short) {
    return {
      r: parseInt(short[1] + short[1], 16),
      g: parseInt(short[2] + short[2], 16),
      b: parseInt(short[3] + short[3], 16),
      a: short[4] === undefined ? 1 : parseInt(short[4] + short[4], 16) / 255,
    };
  }

  const long = HEX_LONG.exec(c);
  if (long) {
    return {
      r: parseInt(long[1], 16),
      g: parseInt(long[2], 16),
      b: parseInt(long[3], 16),
      a: long[4] === undefined ? 1 : parseInt(long[4], 16) / 255,
    };
  }

  const rgb = RGB_FUNC.exec(c);
  if (rgb) {
    const alphaRaw = rgb[4];
    const a =
      alphaRaw === undefined
        ? 1
        : alphaRaw.endsWith('%')
          ? Number(alphaRaw.slice(0, -1)) / 100
          : Number(alphaRaw);
    const parsed = {
      r: Number(rgb[1]),
      g: Number(rgb[2]),
      b: Number(rgb[3]),
      a: Number.isFinite(a) ? a : 1,
    };
    // Guard against `rgb(nan, ...)` producing an rgba() the library also rejects.
    if (![parsed.r, parsed.g, parsed.b].every(Number.isFinite)) return null;
    return parsed;
  }

  // `color-mix(...)`, `var(--x)`, `oklch(...)`, a named colour — all unrecognised
  // here. Named colours are fine for the library as-is, and the rest cannot be
  // resolved without the DOM, so the caller gets its input back.
  return null;
}

const clamp255 = (n: number) => Math.max(0, Math.min(255, Math.round(n)));

/**
 * `color` at `alpha` opacity, as an `rgba()` literal a canvas library can parse.
 *
 * Multiplies into any alpha the input already carries, so `withAlpha('#0008', 0.5)`
 * is half of an already-half-transparent colour rather than silently discarding
 * the original.
 *
 * Returns `color` unchanged when it cannot be parsed — see the header on why that
 * is the right failure mode.
 */
export function withAlpha(color: string, alpha: number): string {
  if (!color) return color;
  const parsed = parse(color);
  if (!parsed) return color;

  const a = Math.max(0, Math.min(1, alpha)) * parsed.a;
  // Trim trailing zeros so the common cases read as `rgba(22, 199, 132, 0.45)`.
  const rounded = Math.round(a * 1000) / 1000;
  return `rgba(${clamp255(parsed.r)}, ${clamp255(parsed.g)}, ${clamp255(parsed.b)}, ${rounded})`;
}

/** True when a canvas library's own parser can be expected to handle `color`. */
export function isCanvasSafe(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (!c) return false;
  // The functional CSS forms a canvas library will not resolve.
  return !/^(color-mix|var|oklch|oklab|lab|lch|color)\s*\(/.test(c);
}
