'use client';

// ---------------------------------------------------------------------
// /dashboard — the command centre.
//
// THIS ROUTE REPLACED A WORKING PAGE, so `app/dashboard/page.tsx` was deleted in
// the same change that created this file. Next.js rejects two routes on one path,
// and the brief forbids shipping a placeholder over a functioning screen — so this
// is the one route that could not be staged behind a placeholder first.
//
// Equity is DERIVED (cash + marked positions) and labelled partial when a position
// could not be marked. Today's P&L is not shown at all: the backend computes no
// daily mark, and choosing a session boundary here would be inventing the number.
// ---------------------------------------------------------------------

import { useMemo, useState } from 'react';

import { MarketCard, type MarketCardData } from '@/components/cards/MarketCard';
import { PolymarketCard, type PolymarketCardData } from '@/components/cards/PolymarketCard';
import { LiveAgentInspectorModal } from '@/components/modals/LiveAgentInspectorModal';
import { FlowDiagram } from '@/components/viz/FlowDiagram';
import { Badge } from '@/components/ui/Badge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import type { NodeContract } from '@/lib/api/graphs';
import { equity, type PortfolioResponse, realised, type Trade } from '@/lib/api/portfolio';
import { useSameOrigin } from '@/lib/api/useSameOrigin';
import {
  useBackend,
  useCurrentNode,
  useEventFeed,
  useGraphNodes,
  useLivePrices,
  useRealtimeConnected,
} from '@/lib/realtime/useRealtime';
import { mergeNodeStates } from '@/lib/viz/flow';

const GRAPH2_FLOW = [
  'market_analysis',
  'regime_classification',
  'strategy_scoring',
  'opportunity_detection',
  'debate',
  'supervisor',
  'risk_gateway',
];

export default function DashboardPage() {
  const portfolio = useBackend<PortfolioResponse>(BACKEND_PATHS.portfolio, { intervalMs: 15_000 });
  const exchange = useBackend<{ liveTradingEnabled?: boolean }>(BACKEND_PATHS.exchangeStatus, {
    intervalMs: 30_000,
  });
  const nodesApi = useBackend<{ nodes: NodeContract[] }>(BACKEND_PATHS.graphNodes, {
    intervalMs: 60_000,
  });
  const snapshots = useBackend<{ snapshots: Record<string, unknown>[] }>(
    BACKEND_PATHS.polymarketSnapshots,
    { intervalMs: 60_000 },
  );
  const pricesApi = useBackend<{ prices?: Record<string, number>; count?: number; note?: string }>(
    BACKEND_PATHS.marketPrices,
    { intervalMs: 15_000 },
  );
  const trades = useSameOrigin<{ trades?: Trade[] }>('/api/trades', { intervalMs: 30_000 });

  const livePrices = useLivePrices();
  const liveNodes = useGraphNodes();
  const currentNode = useCurrentNode();
  const connected = useRealtimeConnected();
  const events = useEventFeed({ limit: 12 });

  const [inspect, setInspect] = useState<string | null>(null);

  // Live stream first, HTTP cache as a fallback. The stream is fresher; the cache
  // is what exists before the first tick arrives.
  const prices = useMemo(
    () => ({ ...(pricesApi.data?.prices ?? {}), ...livePrices }),
    [pricesApi.data, livePrices],
  );

  const live = exchange.data?.liveTradingEnabled === true;
  const book = live ? portfolio.data?.real : portfolio.data?.paper;
  const eq = equity(book, prices);
  const tradeRows = trades.data?.trades ?? [];
  const pnl = realised(tradeRows);

  const flowNodes = useMemo(
    () =>
      mergeNodeStates(
        GRAPH2_FLOW.map((n) => ({
          name: n,
          mayCallLlm: nodesApi.data?.nodes.find((c) => c.name === n)?.mayCallLlm,
        })),
        liveNodes,
      ),
    [liveNodes, nodesApi.data],
  );

  const marketRows: MarketCardData[] = useMemo(
    () =>
      Object.entries(prices)
        .slice(0, 6)
        .map(([symbol, price]) => ({ symbol, price, changePct: null, history: [] })),
    [prices],
  );

  const pmRows: PolymarketCardData[] = useMemo(() => {
    const rows = snapshots.data?.snapshots ?? [];
    return rows.flatMap((r) => {
      const dir = r.directional as Record<string, unknown> | null;
      if (!dir) return [];
      return [{
        question: String(dir.event ?? `${r.symbol} price range`),
        category: String(r.symbol ?? ''),
        yes: null,
        role: 'directional' as const,
        confidence: typeof dir.confidence === 'number' ? dir.confidence : null,
        confirmed: true,
        observation: typeof dir.observation === 'string' ? dir.observation : null,
      }];
    });
  }, [snapshots.data]);

  const notApplicable = (snapshots.data?.snapshots ?? []).filter(
    (r) => (r as Record<string, unknown>).applicable === false,
  ).length;

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold">Dashboard</h1>
        <Badge state={live ? 'CRITICAL' : 'INFO'} label={live ? 'Real money' : 'Paper'} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label={live ? 'Equity (real)' : 'Equity (paper)'}
          value={<Num value={eq.value} prefix="$" />}
          sub={
            eq.value === null
              ? 'no cash figure returned'
              : eq.complete
                ? 'cash + marked positions'
                : `partial — ${eq.unmarked} position(s) could not be marked`
          }
          color={eq.complete ? undefined : 'var(--warning)'}
        />
        <StatCard
          label="Realised P&L"
          value={<Num value={pnl.counted ? pnl.total : null} prefix="$" colored signed />}
          sub={
            pnl.counted
              ? `${pnl.counted} trade(s)${pnl.withoutPnl ? ` · ${pnl.withoutPnl} without a pnl` : ''}`
              : 'no trade carries a pnl'
          }
        />
        <StatCard
          label="Win rate"
          value={
            pnl.winRatePct === null ? (
              <span style={{ color: 'var(--text-muted)' }}>—</span>
            ) : (
              <Num value={pnl.winRatePct} digits={1} suffix="%" />
            )
          }
          sub={pnl.counted ? `${pnl.wins}W / ${pnl.losses}L` : 'not measurable yet'}
        />
        <StatCard
          label="Open positions"
          value={<Num value={portfolio.state === 'ok' ? (book?.positions?.length ?? 0) : null} digits={0} />}
        />
      </div>

      {/* Today's P&L is deliberately absent — see the header note. */}
      <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
        Today&apos;s P&amp;L is not shown: the backend computes no daily mark, and picking a
        session boundary here would be inventing the number. Realised P&amp;L above is
        all-time over trades that carry one.
      </div>

      {/* ---- Markets ---- */}
      <Card>
        <SectionTitle>Markets</SectionTitle>
        {marketRows.length === 0 ? (
          <NotAvailable
            what="Live prices"
            reason={
              pricesApi.data?.note ??
              'the price cache is empty. The backend feeds it from the exchange websocket; with no route to the exchange it stays empty.'
            }
            compact
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {marketRows.map((m) => (
              <MarketCard key={m.symbol} data={m} onSelect={setInspect} />
            ))}
          </div>
        )}
      </Card>

      {/* ---- Agent status ---- */}
      <Card>
        <SectionTitle
          action={
            <div className="flex items-center gap-2">
              <Badge state={connected ? 'HEALTHY' : 'DOWN'} label={connected ? 'Stream live' : 'Stream offline'} />
              <button type="button" className="btn-live" onClick={() => setInspect('BTC/USDT')}>
                <span className="live-dot" aria-hidden /> Watch Live
              </button>
            </div>
          }
        >
          Agent status — decision pipeline
        </SectionTitle>
        <FlowDiagram nodes={flowNodes} currentNode={currentNode} />
      </Card>

      {/* ---- Recent events ---- */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card>
          <SectionTitle>Recent events</SectionTitle>
          <TermTable
            columns={[
              { key: 't', label: 'Time' },
              { key: 'e', label: 'Event' },
              { key: 's', label: 'Symbol' },
            ]}
            empty={
              connected
                ? 'Connected, nothing published yet.'
                : 'The event stream is offline.'
            }
          >
            {events.map((e, i) => (
              <tr key={i}>
                <td className="mono text-[11px]" style={{ color: 'var(--text-muted)' }}>
                  {typeof e.timestamp === 'string' ? e.timestamp.slice(11, 19) : '—'}
                </td>
                <td className="mono text-[11px]">{String(e.event_type)}</td>
                <td className="mono text-[11.5px]">{typeof e.symbol === 'string' ? e.symbol : '—'}</td>
              </tr>
            ))}
          </TermTable>
        </Card>

        <Card>
          <SectionTitle>Polymarket pulse</SectionTitle>
          {pmRows.length === 0 ? (
            <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
              {notApplicable > 0
                ? `No confirmed mapping for ${notApplicable} watched symbol(s), so the feed contributes nothing — and costs the panel nothing either.`
                : 'No prediction-market reading available.'}
            </div>
          ) : (
            <div className="space-y-2">
              {pmRows.map((r, i) => (
                <PolymarketCard key={i} data={r} compact />
              ))}
            </div>
          )}
        </Card>
      </div>

      <LiveAgentInspectorModal symbol={inspect} onClose={() => setInspect(null)} />
    </div>
  );
}
