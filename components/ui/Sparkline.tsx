'use client';

// ---------------------------------------------------------------------
// A sparkline from REAL points.
//
// The reference's `sparkline(seed)` generates 24 values from `Math.sin` plus
// `Math.random()`. That is a decorative squiggle that changes on every render and
// says nothing about the market — and because it is random it also differs between
// server and client, which is a hydration mismatch.
//
// This takes actual values. With too few to draw a line it renders a flat rule and
// a caption rather than inventing a shape, because a fabricated trend line next to
// a real price is worse than no line at all: it is read as information.
// ---------------------------------------------------------------------

export function Sparkline({
  values,
  width = 90,
  height = 28,
  color,
  minPoints = 3,
}: {
  /** Oldest to newest. */
  values: (number | null | undefined)[];
  width?: number;
  height?: number;
  /** Defaults to positive/negative based on first-to-last direction. */
  color?: string;
  minPoints?: number;
}) {
  const clean = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

  if (clean.length < minPoints) {
    return (
      <svg width={width} height={height} aria-label="not enough history">
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="var(--border-strong)"
          strokeWidth="1"
          strokeDasharray="2 3"
        />
      </svg>
    );
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const span = max - min;
  const step = width / (clean.length - 1);

  // A flat series has span 0. Dividing by it gives NaN and the path silently
  // disappears, so it is drawn as the flat line it is.
  const y = (v: number) => (span === 0 ? height / 2 : height - ((v - min) / span) * height);

  const d = clean.map((v, i) => `${i === 0 ? 'M' : 'L'} ${i * step},${y(v)}`).join(' ');
  const stroke =
    color ?? (clean[clean.length - 1] >= clean[0] ? 'var(--positive)' : 'var(--negative)');

  return (
    <svg width={width} height={height} className="overflow-visible" aria-hidden>
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.6" />
    </svg>
  );
}
