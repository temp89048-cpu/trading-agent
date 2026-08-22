'use client';

// ---------------------------------------------------------------------
// Theme-aware candlestick + volume chart.
//
// The reference's `candles()` draws 40 fake bars from `Math.random()`. This uses
// `lightweight-charts` — already a dependency, and already used correctly at v5
// by `components/LiveChart.tsx`.
//
// WHY A NEW COMPONENT RATHER THAN REUSING `LiveChart`
//
// `LiveChart` is genuinely good but coupled two ways that block reuse here:
//
//   * it takes a `WatchItem` and pulls its own data from `useCandles()`, so it
//     cannot chart a backtest result, an equity curve, or a symbol chosen on
//     `/markets` from a different source;
//   * its colours are hardcoded hex (`#141822`, `#3ecf7a`), so it cannot follow
//     the three themes.
//
// So this one is prop-driven and theme-aware. `LiveChart` stays untouched for the
// legacy routes; its indicator overlays are worth lifting into here later rather
// than reimplementing now.
//
// RE-CREATING THE CHART ON THEME CHANGE IS DELIBERATE. lightweight-charts can
// `applyOptions` a new palette, but the series colours would need updating
// individually and any future series added here would be easy to miss. A theme
// switch is a rare, user-initiated event, so paying a full rebuild buys
// correctness that cannot silently rot.
// ---------------------------------------------------------------------

import { useEffect, useMemo, useRef } from 'react';
import {
  CandlestickSeries,
  HistogramSeries,
  createChart,
  type IChartApi,
  type Time,
} from 'lightweight-charts';

import { sanitiseBars } from '@/lib/viz/bars';
// lightweight-charts parses colours with its OWN parser, which does not know
// `color-mix()`. Passing one threw "Failed to parse color" from inside the
// price-axis render and took the route down. See lib/viz/color.ts.
import { withAlpha } from '@/lib/viz/color';

import { useThemeColors } from './useThemeColors';

export type Bar = {
  /** Epoch MILLISECONDS. Converted internally — lightweight-charts wants
   *  seconds, and passing ms silently plots everything in the year 56000. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
};

function toTime(ms: number): Time {
  return Math.floor(ms / 1000) as Time;
}

export function CandlestickChart({
  bars,
  height = 320,
  showVolume = true,
  emptyMessage = 'No candles available for this symbol and timeframe.',
}: {
  bars: Bar[];
  height?: number;
  showVolume?: boolean;
  /** Shown instead of an empty chart frame. An empty frame reads as "the market
   *  is flat"; a message says the data is missing, which is the true statement. */
  emptyMessage?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const colors = useThemeColors();

  // NEVER hand raw props to setData. lightweight-charts ASSERTS on its input: a
  // single NaN timestamp throws from inside setData, React treats it as an
  // unhandled error, and the whole route goes white. That happened for real —
  // `/markets` read `c.openTime` off a payload whose field is `c.t`. The field
  // names are fixed, but a read-only chart must not be able to crash its host, so
  // the input is filtered and ordered first and a chart with nothing drawable says
  // so. See lib/viz/bars.ts.
  const safe = useMemo(() => sanitiseBars(bars), [bars]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || safe.bars.length === 0) return;

    const chart = createChart(el, {
      layout: {
        background: { color: colors.surface },
        textColor: colors.textSecondary,
        fontFamily: 'IBM Plex Mono, JetBrains Mono, monospace',
        fontSize: 10,
      },
      grid: { vertLines: { color: colors.border }, horzLines: { color: colors.border } },
      rightPriceScale: { borderColor: colors.border },
      timeScale: { borderColor: colors.border, timeVisible: true, secondsVisible: false },
      crosshair: { vertLine: { color: colors.borderStrong }, horzLine: { color: colors.borderStrong } },
      width: el.clientWidth,
      height,
    });
    chartRef.current = chart;

    const candles = chart.addSeries(CandlestickSeries, {
      upColor: colors.positive,
      downColor: colors.negative,
      wickUpColor: colors.positive,
      wickDownColor: colors.negative,
      borderVisible: false,
    });
    candles.setData(
      safe.bars.map((b) => ({ time: toTime(b.t), open: b.o, high: b.h, low: b.l, close: b.c })),
    );

    // Volume only when the bars actually carry it. Drawing a flat zero histogram
    // for candles with no volume field would show "no volume traded", which is a
    // claim about the market rather than about the data.
    const hasVolume = showVolume && safe.bars.some((b) => typeof b.v === 'number');
    if (hasVolume) {
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
      volume.setData(
        safe.bars
          .filter((b) => typeof b.v === 'number')
          .map((b) => ({
            time: toTime(b.t),
            value: b.v as number,
            // rgba(), not color-mix(): this string is consumed by a canvas
            // library, not by CSS.
            color: withAlpha(b.c >= b.o ? colors.positive : colors.negative, 0.45),
          })),
      );
    }

    chart.timeScale().fitContent();

    // ResizeObserver rather than a window listener: the sidebar collapsing or a
    // grid reflowing changes this element's width without any window resize, and
    // a chart left at its old width overflows its card.
    const ro = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, [safe, height, showVolume, colors]);

  if (safe.bars.length === 0) {
    return (
      <div
        className="card-2 rounded flex items-center justify-center text-[12px] px-4 text-center"
        style={{ height, color: 'var(--text-muted)' }}
      >
        {/* Distinguish "the API returned nothing" from "everything it returned was
            unusable" — the operator's next step is different for each, and a single
            "no candles" message for both sends them to check the network when the
            real fault is in this code. */}
        {bars.length === 0 ? emptyMessage : safe.reason}
      </div>
    );
  }

  return (
    <>
      <div ref={containerRef} style={{ height }} />
      {safe.reason ? (
        // Stated, not swallowed. A chart quietly missing candles looks complete and
        // is a false picture of the market.
        <div className="text-[10.5px] mt-1.5 leading-relaxed" style={{ color: 'var(--warning)' }}>
          {safe.reason}
        </div>
      ) : null}
    </>
  );
}
