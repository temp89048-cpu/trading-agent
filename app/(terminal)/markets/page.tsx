'use client';

// ---------------------------------------------------------------------
// /markets — asset selector, chart, indicators, agent read.
//
// THE ASSET LIST IS DATA-DRIVEN. Neither the reference's ETH/SOL/DOGE nor the
// backend's BTC/ETH is hardcoded: symbols come from `/api/market/prices` and the
// live tick stream, so the page is correct today and stays correct if the backend
// is retargeted.
//
// FUNDING AND OPEN INTEREST ARE BTC-ONLY and labelled as such.
// `sentiment_agent.fetch_macro_data` queries BTCUSDT specifically, so showing those
// two figures under SOL would attribute a BTC number to SOL. `MarketCard` takes
// `macroSymbol` for exactly this.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { useEffect, useMemo, useState } from 'react';

import { MarketCard, type MarketCardData } from '@/components/cards/MarketCard';
import { LiveAgentInspectorModal } from '@/components/modals/LiveAgentInspectorModal';
import { LazyCandlestickChart as CandlestickChart, type Bar } from '@/components/ui/LazyCandlestickChart';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { useSameOrigin } from '@/lib/api/useSameOrigin';
import { useBackend, useLastDecision, useLivePrices } from '@/lib/realtime/useRealtime';
import type { WatchItem } from '@/lib/types';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const MarketsOperator = dynamic(
  () => import('@/components/operator/MarketsOperator').then((m) => ({ default: m.MarketsOperator })),
  { ssr: false },
);

// Code-split: ChartModal renders `LiveChart`, which pulls in lightweight-charts a
// second time. It is behind a click, so nothing about the initial page needs it —
// eager-importing it put ~58kB on the first load of a route whose default view is
// a card grid. `ssr: false` because the chart measures a real DOM node.
const ChartModal = dynamic(() => import('@/components/ChartModal').then((m) => ({ default: m.ChartModal })), {
  ssr: false,
});

const TIMEFRAMES = ['15m', '1h', '4h', '1d'] as const;
// `/api/candles` (the NEXT route, lib/candleSource.server.ts) returns
// `{ t, o, h, l, c, v }` — already the `Bar` shape. It is NOT the backend's
// `{ openTime, open, high, ... }`; that shape belongs to
// `backend/services/market_data.fetch_klines`, and reading it here produced
// `undefined` for every field. `toTime(undefined)` is NaN, which tripped
// lightweight-charts' own ordering assertion and took the whole route down with an
// unhandled runtime error. Two endpoints, two shapes, one guessed wrong.
type Candle = Bar;

/** `BTC/USDT` -> `BTCUSDT`, which is what the candles route expects. */
const toBinance = (s: string) => s.replace('/', '').replace(':USDT', '');

export default function MarketsPage() {
  const pricesApi = useBackend<{ prices?: Record<string, number>; note?: string }>(
    BACKEND_PATHS.marketPrices, { intervalMs: 15_000 },
  );
  const livePrices = useLivePrices();
  const prices = useMemo(() => ({ ...(pricesApi.data?.prices ?? {}), ...livePrices }), [pricesApi.data, livePrices]);
  const symbols = useMemo(() => Object.keys(prices).sort(), [prices]);

  const [symbol, setSymbol] = useState<string | null>(null);
  const [tf, setTf] = useState<(typeof TIMEFRAMES)[number]>('1h');
  const [inspect, setInspect] = useState<string | null>(null);
  // ChartModal takes a WatchItem, not a symbol string. It offers the TradingView
  // embed the in-page chart cannot — kept because it was reachable from the old
  // sidebar and nothing else in the new design replaces it.
  const [chartItem, setChartItem] = useState<WatchItem | null>(null);

  // Pick the first available symbol once one appears, rather than defaulting to a
  // hardcoded one that may not be watched.
  useEffect(() => {
    if (!symbol && symbols.length > 0) setSymbol(symbols[0]);
  }, [symbol, symbols]);

  const candles = useSameOrigin<{ candles?: Candle[] }>(
    symbol ? `/api/candles?symbol=${toBinance(symbol)}&type=crypto&interval=${tf}&limit=200` : null,
  );
  const analysis = useBackend<Record<string, unknown>>(
    symbol ? `/api/market/analysis/${encodeURIComponent(symbol)}` : null,
  );
  const regime = useBackend<{ regime?: string; classified?: boolean; candlesUsed?: number }>(
    symbol ? `/api/market/regime/${encodeURIComponent(symbol.replace('/', '-'))}` : null,
  );
  const decision = useLastDecision(symbol);

  const bars: Bar[] = useMemo(
    () => candles.data?.candles ?? [],
    [candles.data],
  );

  const cards: MarketCardData[] = symbols.map((s) => ({
    symbol: s,
    price: prices[s] ?? null,
    changePct: null,
    history: [],
    // Attributed to BTC, because that is the only symbol the macro fetch queries.
    macroSymbol: 'BTC/USDT',
  }));

  if (symbols.length === 0) {
    return (
      <div className="max-w-[820px] space-y-3">
        <h1 className="text-[17px] font-semibold">Live Markets</h1>
        <NotAvailable
          what="Watched symbols"
          reason={pricesApi.data?.note ?? 'the price cache is empty and no tick has arrived on the stream. The symbol list is derived from real data rather than hardcoded, so with no data there is nothing to list.'}
        />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Live Markets</h1>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {cards.map((c) => (
          <MarketCard key={c.symbol} data={c} onSelect={setSymbol} selected={c.symbol === symbol} />
        ))}
      </div>

      <Card>
        <SectionTitle
          action={
            <span className="flex gap-1.5">
              {TIMEFRAMES.map((t) => (
                <button key={t} type="button" className={`chip${tf === t ? ' on' : ''}`} onClick={() => setTf(t)}>{t}</button>
              ))}
              {symbol ? (
                <>
                  <button
                    type="button"
                    className="chip"
                    onClick={() => setChartItem({ symbol, type: 'crypto' } as WatchItem)}
                  >
                    Expand
                  </button>
                  <button type="button" className="btn-live" onClick={() => setInspect(symbol)}>
                    <span className="live-dot" aria-hidden /> Live
                  </button>
                </>
              ) : null}
            </span>
          }
        >
          {symbol ?? '—'} · {tf}
        </SectionTitle>
        <CandlestickChart
          bars={bars}
          height={340}
          emptyMessage="No candles returned. /api/candles proxies the exchange directly; with no route to it there is no history to draw."
        />
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <SectionTitle>Regime</SectionTitle>
          {regime.state === 'unreachable' ? (
            <NotAvailable what="Regime" reason="the backend did not respond" compact />
          ) : regime.data?.classified === false || !regime.data?.regime ? (
            <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              Not classified — usually too few candles. {typeof regime.data?.candlesUsed === 'number' ? `${regime.data.candlesUsed} used.` : ''}
            </div>
          ) : (
            <>
              <div className="mono text-[16px] font-semibold">{regime.data.regime}</div>
              <div className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                from {regime.data.candlesUsed ?? '—'} candles
              </div>
            </>
          )}
        </Card>

        <Card>
          <SectionTitle>Agent read</SectionTitle>
          {decision ? (
            <>
              <div className="mono text-[14px] font-semibold">{decision.action}</div>
              <div className="text-[11.5px] mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{decision.detail}</div>
              <div className="text-[10.5px] mt-1" style={{ color: 'var(--text-muted)' }}>
                {new Date(decision.at).toLocaleString()}
              </div>
            </>
          ) : (
            <div className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>
              No decision on the stream for {symbol ?? 'this symbol'} yet. Not a HOLD — simply
              nothing recorded.
            </div>
          )}
        </Card>
      </div>

      <Card>
        <SectionTitle>Technical analysis</SectionTitle>
        {analysis.state === 'unreachable' || !analysis.data ? (
          <NotAvailable what="Indicator values" reason="/api/market/analysis did not return data for this symbol" compact />
        ) : (
          <TermTable columns={[{ key: 'k', label: 'Field' }, { key: 'v', label: 'Value', num: true }]}>
            {Object.entries(analysis.data)
              .filter(([, v]) => typeof v === 'number' || typeof v === 'string')
              .map(([k, v]) => (
                <tr key={k}>
                  <td className="mono text-[11.5px]" style={{ color: 'var(--text-secondary)' }}>{k}</td>
                  <td className="num mono text-[11.5px]">{typeof v === 'number' ? <Num value={v} digits={4} /> : String(v)}</td>
                </tr>
              ))}
          </TermTable>
        )}
      </Card>

      <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        <strong>Funding and open interest are not shown per asset.</strong> The backend fetches
        both for BTCUSDT only, so attributing them to another symbol would be a wrong number
        rather than a rounding.
      </div>

      <ChartModal item={chartItem} onClose={() => setChartItem(null)} />
      <LiveAgentInspectorModal symbol={inspect} onClose={() => setInspect(null)} />
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <MarketsOperator onSelectSymbol={setSymbol} />
    </div>
  );
}
