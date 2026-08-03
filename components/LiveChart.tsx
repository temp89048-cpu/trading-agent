'use client';

import { useEffect, useRef, useState } from 'react';
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers, type IChartApi, type Time, type SeriesMarker } from 'lightweight-charts';
import { useCandles } from './Candles';
import { rsi, ema, macd, bollingerBands, type Candle } from '@/lib/indicators';
import { computeMarketStructure } from '@/lib/marketStructure';
import type { WatchItem } from '@/lib/types';

const TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;

function toChartTime(ms: number): Time {
  return Math.floor(ms / 1000) as Time;
}

// Builds a rolling series (one value per candle once there's enough
// history) instead of just the latest reading, since the chart needs to
// draw a line across time, not a single point.
function rollingSeries(candles: Candle[], compute: (closes: number[]) => number | null): { time: Time; value: number }[] {
  const closes = candles.map((c) => c.c);
  const out: { time: Time; value: number }[] = [];
  for (let i = 0; i < candles.length; i++) {
    const v = compute(closes.slice(0, i + 1));
    if (v !== null) out.push({ time: toChartTime(candles[i].t), value: v });
  }
  return out;
}

export function LiveChart({ item }: { item: WatchItem }) {
  const { getCandles, ensureCandles } = useCandles();
  const [interval, setIntervalStr] = useState<(typeof TIMEFRAMES)[number]>('1h');
  const [showStructure, setShowStructure] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    ensureCandles(item, interval, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.symbol, interval]);

  const entry = getCandles(item.symbol, interval);
  const candles = entry?.candles ?? [];

  useEffect(() => {
    if (!containerRef.current || candles.length === 0) return;

    const chart = createChart(containerRef.current, {
      layout: { background: { color: '#141822' }, textColor: '#93a0b4', fontFamily: 'JetBrains Mono, monospace', fontSize: 11 },
      grid: { vertLines: { color: '#232a38' }, horzLines: { color: '#232a38' } },
      width: containerRef.current.clientWidth,
      height: 420,
      timeScale: { timeVisible: true, secondsVisible: false },
    });
    chartRef.current = chart;

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#3ecf7a', downColor: '#ef5a5a', borderVisible: false, wickUpColor: '#3ecf7a', wickDownColor: '#ef5a5a',
    });
    candleSeries.setData(candles.map((c) => ({ time: toChartTime(c.t), open: c.o, high: c.h, low: c.l, close: c.c })));

    // Market Structure overlay (Commit 9): swing high/low labels plus
    // BOS/CHoCH break markers, computed from this same candle data —
    // same engine that feeds the chat context, so what's drawn here
    // matches what the model is told.
    let markersApi: ReturnType<typeof createSeriesMarkers<Time>> | null = null;
    if (showStructure) {
      const snap = computeMarketStructure(candles);
      const markers: SeriesMarker<Time>[] = [];
      for (const sp of snap.swings) {
        if (sp.label === null) continue; // first swing of its type carries no comparison yet — nothing useful to show
        const bullishLabel = sp.label === 'HH' || sp.label === 'HL';
        markers.push({
          time: toChartTime(sp.time),
          position: sp.type === 'high' ? 'aboveBar' : 'belowBar',
          color: bullishLabel ? '#3ecf7a' : '#ef5a5a',
          shape: sp.type === 'high' ? 'arrowDown' : 'arrowUp',
          text: sp.label,
          size: 0.7,
        });
      }
      for (const ev of snap.events) {
        markers.push({
          time: toChartTime(ev.time),
          position: ev.direction === 'bullish' ? 'belowBar' : 'aboveBar',
          color: ev.type === 'CHoCH' ? '#f5a623' : ev.direction === 'bullish' ? '#3ecf7a' : '#ef5a5a',
          shape: 'circle',
          text: ev.type,
        });
      }
      markers.sort((a, b) => (a.time as number) - (b.time as number));
      markersApi = createSeriesMarkers(candleSeries, markers);
    }

    const ema20Series = chart.addSeries(LineSeries, { color: '#f5a623', lineWidth: 1, title: 'EMA20' });
    ema20Series.setData(rollingSeries(candles, (closes) => ema(closes, 20)));

    const ema50Series = chart.addSeries(LineSeries, { color: '#3fd9d9', lineWidth: 1, title: 'EMA50' });
    ema50Series.setData(rollingSeries(candles, (closes) => ema(closes, 50)));

    const bbUpper = chart.addSeries(LineSeries, { color: 'rgba(147,160,180,0.5)', lineWidth: 1, title: 'BB upper' });
    bbUpper.setData(rollingSeries(candles, (closes) => bollingerBands(closes, 20, 2)?.upper ?? null));
    const bbLower = chart.addSeries(LineSeries, { color: 'rgba(147,160,180,0.5)', lineWidth: 1, title: 'BB lower' });
    bbLower.setData(rollingSeries(candles, (closes) => bollingerBands(closes, 20, 2)?.lower ?? null));

    // RSI in its own pane below the price chart
    const rsiSeries = chart.addSeries(LineSeries, { color: '#f5a623', lineWidth: 1, title: 'RSI(14)' }, 1);
    rsiSeries.setData(rollingSeries(candles, (closes) => rsi(closes, 14)));

    // MACD histogram in a third pane
    const macdHist = chart.addSeries(HistogramSeries, { color: '#3ecf7a', title: 'MACD hist' }, 2);
    const histData: { time: Time; value: number; color: string }[] = [];
    const closes = candles.map((c) => c.c);
    for (let i = 0; i < candles.length; i++) {
      const m = macd(closes.slice(0, i + 1), 12, 26, 9);
      if (m) histData.push({ time: toChartTime(candles[i].t), value: m.histogram, color: m.histogram >= 0 ? '#3ecf7a' : '#ef5a5a' });
    }
    macdHist.setData(histData);

    chart.timeScale().fitContent();

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current) chart.applyOptions({ width: containerRef.current.clientWidth });
    });
    resizeObserver.observe(containerRef.current);

    return () => {
      resizeObserver.disconnect();
      markersApi?.detach();
      chart.remove();
      chartRef.current = null;
    };
  }, [candles, showStructure]);

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1">
        {TIMEFRAMES.map((tf) => (
          <button
            key={tf}
            onClick={() => setIntervalStr(tf)}
            className={`px-2 py-1 rounded text-[10px] font-mono transition ${interval === tf ? 'bg-bg3 text-amber' : 'text-txt2 hover:bg-bg2'}`}
          >
            {tf}
          </button>
        ))}
        {entry?.loading && <span className="text-[10px] font-mono text-txt2 ml-2">loading…</span>}
        {entry?.error && <span className="text-[10px] font-mono text-red ml-2">{entry.error}</span>}
        <button
          onClick={() => setShowStructure((v) => !v)}
          className={`px-2 py-1 rounded text-[10px] font-mono transition ml-auto ${showStructure ? 'bg-bg3 text-amber' : 'text-txt2 hover:bg-bg2'}`}
        >
          Structure
        </button>
      </div>
      <div ref={containerRef} className="w-full rounded-md overflow-hidden border border-line" style={{ minHeight: 420 }}>
        {candles.length === 0 && !entry?.loading && (
          <div className="h-[420px] flex items-center justify-center text-xs font-mono text-txt2">
            {entry?.error ? 'Could not load candle data.' : 'Loading candles…'}
          </div>
        )}
      </div>
      <p className="text-[10px] font-mono text-txt2">
        EMA20 (amber) · EMA50 (cyan) · Bollinger(20,2) bands · RSI(14) below · MACD(12,26,9) histogram at bottom — all
        computed by this app from real OHLC history, not TradingView&apos;s engine. Structure overlay: green/red
        arrows = HH/HL vs LH/LL swing labels, circles = BOS (continuation) or CHoCH (amber, possible reversal).
      </p>
    </div>
  );
}
