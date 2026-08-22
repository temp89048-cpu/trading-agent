'use client';

// ---------------------------------------------------------------------
// Code-split wrapper around `CandlestickChart`.
//
// `lightweight-charts` is ~40kB of the first-load bundle and only two of the 25
// routes draw a candle chart. Loading it eagerly made every route pay for it,
// including the ones that are pure tables.
//
// `ssr: false` because the chart calls `createChart` against a real DOM node and
// measures it with a ResizeObserver — neither exists during prerender, and a chart
// rendered server-side would be a blank canvas the client immediately replaces.
//
// The fallback reserves the SAME height as the chart. Without that the page reflows
// when the chunk lands, which on a data page is worse than a slightly later chart:
// the operator's eye is already on a number that jumps.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';

import type { Bar } from './CandlestickChart';

export type { Bar };

export const LazyCandlestickChart = dynamic(
  () => import('./CandlestickChart').then((m) => ({ default: m.CandlestickChart })),
  {
    ssr: false,
    loading: () => (
      <div
        className="flex items-center justify-center text-[11.5px] rounded"
        style={{ height: 280, background: 'var(--bg-surface-2)', color: 'var(--text-muted)' }}
      >
        Loading chart…
      </div>
    ),
  },
);
