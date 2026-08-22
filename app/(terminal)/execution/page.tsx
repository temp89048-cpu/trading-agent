'use client';

// ---------------------------------------------------------------------
// /execution — the pipeline plus recent fills.
//
// The reference's 7-stage `execFlow` is a mock list. `ExecCycleStepper` renders the
// REAL six stages instead (Trigger -> Analyse -> Decide -> Validate -> Submit ->
// Fill); see `lib/viz/flow.ts` for why keeping the mock labels would have described
// a system that does not exist.
//
// Latency, slippage and fill-ratio stats are NOT shown. They are not recorded on a
// trade or in the audit trail — `/api/catalog/orders` returns them as null and says
// so. Three stat cards reading "—" would be noise; the absence is stated once.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { TradeHistoryTable } from '@/components/TradeHistoryTable';
import { OperatorSection } from '@/components/operator/OperatorSection';
import { Badge } from '@/components/ui/Badge';
import { ExecCycleStepper } from '@/components/viz/ExecCycleStepper';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { useBackend, useCurrentNode, useEventFeed } from '@/lib/realtime/useRealtime';
import { stageForNode } from '@/lib/viz/flow';

// Code-split. The operator panels sit below this page's real-data content, so
// nothing above the fold waits on them, and their dependency graph (providers,
// charts, the LLM chat path) is large relative to a page of tables. `ssr: false`
// because they read localStorage and measure DOM nodes.
const ExecutionOperator = dynamic(
  () => import('@/components/operator/ExecutionOperator').then((m) => ({ default: m.ExecutionOperator })),
  { ssr: false },
);

type Order = {
  id?: string; ts?: number; symbol?: string; side?: string; qty?: number; price?: number;
  pnl?: number | null; status?: string; tab?: string;
  slippageBps?: number | null; latencyMs?: number | null;
  // `agent-plan`, `debate`, `chat-trade-action`, `manual-click`... — WHO originated
  // this fill. On an Execution page that is the most useful column there is: it
  // separates what the agent did from what a human clicked.
  originTag?: string | null;
  exchangeOrderId?: string | null;
};

export default function ExecutionPage() {
  const orders = useBackend<{
    orders: Order[]; count: number; totalStored: number; meaning: string;
    notRecorded: Record<string, string>;
    // See the /orders page: names which of the two books answered.
    source?: string; qualityMeasured?: number;
  }>(
    BACKEND_PATHS.catalogOrders,
    { intervalMs: 20_000 },
  );
  const exchange = useBackend<{ liveTradingEnabled?: boolean; ordersRoutedTo?: string }>(
    BACKEND_PATHS.exchangeStatus,
    { intervalMs: 30_000 },
  );
  const currentNode = useCurrentNode();
  const execEvents = useEventFeed({
    types: ['EXECUTION_PLAN_READY', 'TAR_SUBMITTED', 'TAR_APPROVED', 'TAR_REJECTED', 'ORDER_FILLED'],
    limit: 25,
  });

  const rows = orders.data?.orders ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold">Execution</h1>
        {exchange.data?.ordersRoutedTo ? (
          <span className="text-[11.5px] mono" style={{ color: 'var(--text-secondary)' }}>
            routed to: {exchange.data.ordersRoutedTo}
          </span>
        ) : null}
      </div>

      <Card>
        <SectionTitle>Pipeline</SectionTitle>
        <div className="overflow-x-auto">
          <ExecCycleStepper activeKey={stageForNode(currentNode)} />
        </div>
      </Card>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Fills logged" value={<Num value={orders.data?.totalStored ?? null} digits={0} />} />
        <StatCard label="Mode" value={<Badge state={exchange.data?.liveTradingEnabled ? 'CRITICAL' : 'INFO'} label={exchange.data?.liveTradingEnabled ? 'Real' : 'Simulated'} />} mono={false} />
        <StatCard label="Pipeline events" value={<Num value={execEvents.length} digits={0} />} sub="on the live stream" />
        <StatCard label="Latency / slippage" value={<span style={{ color: 'var(--text-muted)' }}>—</span>} sub="not recorded" mono={false} />
      </div>

      <Card>
        <SectionTitle>Recent fills</SectionTitle>
        <TermTable
          columns={[
            { key: 't', label: 'When' }, { key: 's', label: 'Symbol' }, { key: 'd', label: 'Side' },
            { key: 'q', label: 'Qty', num: true }, { key: 'p', label: 'Price', num: true },
            { key: 'l', label: 'P&L', num: true }, { key: 'st', label: 'Status' },
          ]}
          empty={orders.state === 'unreachable' ? 'The catalog endpoint did not respond.' : 'No fills logged.'}
        >
          {rows.map((o, i) => (
            <tr key={o.id ?? i}>
              <td className="mono text-[11px]">{o.ts ? new Date(o.ts).toLocaleString() : '—'}</td>
              <td className="mono text-[11.5px]">{o.symbol ?? '—'}</td>
              <td><span className="mono text-[11.5px]" style={{ color: o.side === 'buy' ? 'var(--positive)' : 'var(--negative)' }}>{o.side?.toUpperCase() ?? '—'}</span></td>
              <td className="num"><Num value={o.qty ?? null} digits={6} /></td>
              <td className="num"><Num value={o.price ?? null} /></td>
              <td className="num">{typeof o.pnl === 'number' ? <Num value={o.pnl} colored signed /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
              <td><Badge state="FILLED" /></td>
            </tr>
          ))}
        </TermTable>
        {orders.data?.meaning ? (
          <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>{orders.data.meaning}</div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>Pipeline events</SectionTitle>
        <TermTable
          columns={[{ key: 't', label: 'Time' }, { key: 'e', label: 'Event' }, { key: 's', label: 'Symbol' }, { key: 'd', label: 'Detail' }]}
          empty="No execution events on the stream."
        >
          {execEvents.map((e, i) => (
            <tr key={i}>
              <td className="mono text-[11px]" style={{ color: 'var(--text-muted)' }}>{typeof e.timestamp === 'string' ? e.timestamp.slice(11, 19) : '—'}</td>
              <td className="mono text-[11px]">{String(e.event_type)}</td>
              <td className="mono text-[11.5px]">{typeof e.symbol === 'string' ? e.symbol : '—'}</td>
              <td className="text-[11px] whitespace-normal" style={{ color: 'var(--text-secondary)' }}>
                {typeof e.detail === 'string' ? e.detail : typeof e.reason === 'string' ? e.reason : '—'}
              </td>
            </tr>
          ))}
        </TermTable>
      </Card>

      <NotAvailable
        what="Latency, slippage and fill ratio"
        reason={
          'none of the three is recorded. Trade records carry no timing or slippage field, and ' +
          'the audit trail stores decisions rather than order round-trips. Showing them as 0 ' +
          'would report perfect execution — a mistake this project has already made once, when ' +
          'slippage hardcoded to 0.0 gave every trade a flawless score.'
        }
      />
      {/* ---- Operator controls: real panels from the old sidebar ---- */}
      <ExecutionOperator />

      <OperatorSection
        title="Fills seen on the event stream"
        note="A DIFFERENT source from the orders table above: this is what the backend published as it executed, while that table is derived from .data/trades.json. They can legitimately disagree, and which one is wrong is worth knowing."
      >
        <TradeHistoryTable />
      </OperatorSection>
    </div>
  );
}
