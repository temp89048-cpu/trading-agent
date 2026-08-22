// ---------------------------------------------------------------------
// Bar sanitising for the candlestick chart.
//
// WHY THIS EXISTS
//
// `lightweight-charts` asserts on its input: one bar with a NaN timestamp throws
// `Assertion failed: data must be asc ordered by time, index=1, time=NaN` from
// inside `setData`, which React surfaces as an unhandled runtime error and the
// whole route goes white. That happened for real: `/markets` and `/home` read
// `c.openTime` off a payload whose field is `c.t` (two endpoints, two shapes), so
// every value was `undefined` and every time was NaN.
//
// The field-name bug is fixed at the call sites, but "a bad bar takes down the
// page" is the failure worth removing. A chart is a read-only view of market
// data; it has no business being able to crash the route that hosts it. So the
// input is filtered and ordered here first, and a chart with nothing left to draw
// says so instead of throwing.
//
// IT REPORTS WHAT IT DROPPED. Silently discarding bars would leave a chart that
// looks complete while missing candles — a false picture of the market, which is
// exactly what CLAUDE.md's "never fabricate market data" is about. `dropped` and
// `reason` exist so the caller can show it.
//
// Pure, so it is tested without a DOM.
// ---------------------------------------------------------------------

export type RawBar = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
};

export type SanitisedBars = {
  /** Finite, ascending, one bar per timestamp. Safe to hand to setData. */
  bars: RawBar[];
  /** How many input bars were discarded. */
  dropped: number;
  /** Human-readable cause, or null when nothing was dropped. */
  reason: string | null;
};

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** A bar every OHLC field of which is a finite number, with a finite timestamp. */
function usable(b: RawBar | null | undefined): b is RawBar {
  return (
    !!b &&
    finite(b.t) &&
    finite(b.o) &&
    finite(b.h) &&
    finite(b.l) &&
    finite(b.c) &&
    // A zero or negative epoch is not a market timestamp; it is a default that
    // leaked through. Charting it puts a candle in 1970 and squashes the rest.
    b.t > 0
  );
}

export function sanitiseBars(input: readonly (RawBar | null | undefined)[]): SanitisedBars {
  const total = input.length;
  const kept = input.filter(usable);

  // Sort before deduping so "keep the last for a timestamp" is well-defined, and
  // because setData requires ascending order regardless of what the API returned.
  const sorted = [...kept].sort((a, b) => a.t - b.t);

  // Duplicate timestamps also trip the assertion (it requires strictly
  // ascending). The later bar wins: on a live feed that is the more recent
  // revision of the same candle.
  const deduped: RawBar[] = [];
  for (const bar of sorted) {
    if (deduped.length > 0 && deduped[deduped.length - 1].t === bar.t) {
      deduped[deduped.length - 1] = bar;
      continue;
    }
    deduped.push(bar);
  }

  const dropped = total - deduped.length;
  if (dropped === 0) return { bars: deduped, dropped: 0, reason: null };

  const malformed = total - kept.length;
  const duplicates = kept.length - deduped.length;
  const parts: string[] = [];
  if (malformed > 0) {
    parts.push(
      `${malformed} had a missing or non-numeric field (usually a field-name ` +
        `mismatch between the API's shape and this page's)`,
    );
  }
  if (duplicates > 0) parts.push(`${duplicates} repeated a timestamp already present`);

  return {
    bars: deduped,
    dropped,
    reason: `${dropped} of ${total} candles were not drawn: ${parts.join('; ')}.`,
  };
}
