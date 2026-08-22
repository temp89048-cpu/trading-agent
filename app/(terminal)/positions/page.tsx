'use client';

// ---------------------------------------------------------------------
// /positions — open positions with a detail panel and per-row actions.
//
// Unrealised P&L is `null` for any position that cannot be marked, never 0. A
// position with no live price has an UNKNOWN result, and rendering 0 would say it
// is exactly flat.
//
// THE "Close" ACTION IS NOT WIRED, AND SAYS SO. Closing routes through the TAR
// pipeline (`components/Supervisor.tsx`'s reviewAndExecute is the single execution
// path for AI-originated trades, and a manual close is its own path) and there is
// no read-only HTTP route that performs one. The reference's `confirmAction()` was
// an `alert()` with a `// TODO: wire to real mutation endpoint`; a button that
// looked live and did nothing would be worse.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';

import { LiveAgentInspectorModal } from '@/components/modals/LiveAgentInspectorModal';
import { TradeJourney } from '@/components/viz/TradeJourney';
import { Badge } from '@/components/ui/Badge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { exposureBySymbol, type PortfolioResponse, unrealised } from '@/lib/api/portfolio';
import { useBackend, useLivePrices } from '@/lib/realtime/useRealtime';
import { buildJourney } from '@/lib/viz/journey';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const PositionsOperator = dynamic(
  () => import('@/components/operator/PositionsOperator').then((m) => ({ default: m.PositionsOperator })),
  { ssr: false },
);

export default function PositionsPage() {
  const portfolio = useBackend<PortfolioResponse>(BACKEND_PATHS.portfolio, { intervalMs: 10_000 });
  const exchange = useBackend<{ liveTradingEnabled?: boolean }>(BACKEND_PATHS.exchangeStatus, { intervalMs: 30_000 });
  const monitored = useBackend<{ positions: Record<string, unknown>[]; count: number; stopMeaning?: string }>(
    BACKEND_PATHS.graphPositions,
    { intervalMs: 15_000 },
  );
  const prices = useLivePrices();

  const [detail, setDetail] = useState<string | null>(null);
  const [journeyFor, setJourneyFor] = useState<string | null>(null);
  const [inspect, setInspect] = useState<string | null>(null);

  const live = exchange.data?.liveTradingEnabled === true;
  const book = live ? portfolio.data?.real : portfolio.data?.paper;
  const rows = book?.positions ?? [];
  const exposure = useMemo(() => exposureBySymbol(book, prices), [book, prices]);

  const unmarked = rows.filter((p) => unrealised(p, prices) === null).length;
  const totalUnreal = rows.reduce((s, p) => s + (unrealised(p, prices) ?? 0), 0);

  const selected = rows.find((p) => p.symbol === detail) ?? null;
  const monitoredFor = (sym: string) =>
    (monitored.data?.positions ?? []).find((m) => (m as { symbol?: string }).symbol === sym) as
      | Record<string, unknown>
      | undefined;

  if (portfolio.state === 'unreachable') {
    return (
      <div className="max-w-[820px]">
        <h1 className="text-[17px] font-semibold mb-3">Positions</h1>
        <NotAvailable what="The portfolio" reason="/api/dashboard/portfolio did not respond." />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold">Positions</h1>
        <Badge state={live ? 'CRITICAL' : 'INFO'} label={live ? 'Real book' : 'Paper book'} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Open" value={<Num value={rows.length} digits={0} />} />
        <StatCard
          label="Unrealised P&L"
          value={unmarked === rows.length && rows.length > 0
            ? <span style={{ color: 'var(--text-muted)' }}>—</span>
            : <Num value={rows.length ? totalUnreal : null} prefix="$" colored signed />}
          sub={unmarked > 0 ? `${unmarked} position(s) could not be marked` : undefined}
          color={unmarked > 0 ? 'var(--warning)' : undefined}
        />
        <StatCard label="Monitored" value={<Num value={monitored.data?.count ?? null} digits={0} />} sub="by the position worker" />
        <StatCard label="Symbols" value={<Num value={new Set(rows.map((p) => p.symbol)).size} digits={0} />} />
      </div>

      <Card>
        <SectionTitle>Open positions</SectionTitle>
        <TermTable
          columns={[
            { key: 's', label: 'Symbol' },
            { key: 'q', label: 'Qty', num: true },
            { key: 'c', label: 'Avg cost', num: true },
            { key: 'm', label: 'Mark', num: true },
            { key: 'u', label: 'Unrealised', num: true },
            { key: 'x', label: 'Exposure', num: true },
            { key: 'st', label: 'Stop' },
            { key: 'a', label: '' },
          ]}
          empty="No open positions."
        >
          {rows.map((p) => {
            const sym = String(p.symbol ?? '—');
            const mark = prices[sym];
            const u = unrealised(p, prices);
            const ex = exposure.find((e) => e.symbol === sym);
            const mon = monitoredFor(sym);
            const stop = mon?.stop_loss ?? mon?.stopLoss;
            return (
              <tr key={sym} className="cursor-pointer" onClick={() => setDetail(sym)}>
                <td className="mono text-[11.5px]">{sym}</td>
                <td className="num"><Num value={typeof p.qty === 'number' ? p.qty : null} digits={6} /></td>
                <td className="num"><Num value={typeof p.avgCost === 'number' ? p.avgCost : null} /></td>
                <td className="num">
                  {typeof mark === 'number' ? <Num value={mark} /> : <span style={{ color: 'var(--text-muted)' }}>no price</span>}
                </td>
                <td className="num">
                  {u === null ? <span style={{ color: 'var(--text-muted)' }}>—</span> : <Num value={u} colored signed />}
                </td>
                <td className="num">
                  {ex?.share === null || ex?.share === undefined
                    ? <span style={{ color: 'var(--text-muted)' }}>—</span>
                    : <Num value={ex.share} digits={1} suffix="%" />}
                </td>
                <td>
                  {typeof stop === 'number'
                    ? <span className="mono text-[11px]">{stop}</span>
                    : <Badge state="UNAVAILABLE" label="not tracked" />}
                </td>
                <td>
                  <span className="flex gap-1.5" onClick={(e) => e.stopPropagation()}>
                    <button type="button" className="btn-live" onClick={() => setInspect(sym)}>
                      <span className="live-dot" aria-hidden /> Live
                    </button>
                    <button type="button" className="chip" onClick={() => setJourneyFor(sym)}>◎ How</button>
                  </span>
                </td>
              </tr>
            );
          })}
        </TermTable>

        <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          <strong>No Close button.</strong> Closing a position goes through the execution
          pipeline, and no read-only HTTP route performs one. A button that looked live and
          did nothing would be worse than its absence — use the operator controls in the
          legacy terminal until a close route exists.
          {monitored.data?.stopMeaning ? ` ${monitored.data.stopMeaning}` : ''}
        </div>
      </Card>

      {selected ? (
        <Card>
          <SectionTitle action={<button type="button" className="chip" onClick={() => setDetail(null)}>Close</button>}>
            {String(selected.symbol)} — detail
          </SectionTitle>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Qty" value={<Num value={typeof selected.qty === 'number' ? selected.qty : null} digits={6} />} />
            <StatCard label="Avg cost" value={<Num value={typeof selected.avgCost === 'number' ? selected.avgCost : null} />} />
            <StatCard label="Mark" value={<Num value={prices[String(selected.symbol)] ?? null} />} />
            <StatCard label="Unrealised" value={<Num value={unrealised(selected, prices)} colored signed />} />
          </div>
        </Card>
      ) : null}

      {journeyFor ? (
        <Card>
          <SectionTitle action={<button type="button" className="chip" onClick={() => setJourneyFor(null)}>Close</button>}>
            How this position was opened — {journeyFor}
          </SectionTitle>
          <TradeJourney
            steps={buildJourney({
              symbol: journeyFor,
              price: prices[journeyFor] ?? null,
              // Nothing links an open position back to the decision that opened it:
              // positions carry no decision id. So the middle of the journey is
              // honestly unknown rather than reconstructed from a guess.
              outcome: { status: 'OPEN' },
            })}
          />
          <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
            Most steps are unknown because a position record carries no decision id, so it
            cannot be joined to the run that opened it. Adding one would be a backend change.
          </div>
        </Card>
      ) : null}

      <LiveAgentInspectorModal symbol={inspect} onClose={() => setInspect(null)} />
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <PositionsOperator />
    </div>
  );
}
