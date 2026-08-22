'use client';

// ---------------------------------------------------------------------
// /orders — was BLOCKED, now backed by `/api/catalog/orders`.
//
// It is NOT an exchange order book, and the page says so at the top rather than
// implying one. This backend has no order store: it has a trade log of completed
// fills, so every row is FILLED and there is no resting-order lifecycle to show.
// Slippage, latency and order type are null because nothing records them.
// ---------------------------------------------------------------------

import { useState } from 'react';

import { Badge } from '@/components/ui/Badge';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { BACKEND_PATHS } from '@/lib/backendConfig';
import { useBackend } from '@/lib/realtime/useRealtime';

type Order = {
  originTag?: string | null;
  exchangeOrderId?: string | null;
  filledQty?: number | null;
  id?: string; ts?: number; symbol?: string; side?: string; qty?: number; price?: number;
  pnl?: number | null; status?: string; tab?: string;
  slippageBps?: number | null; latencyMs?: number | null; orderType?: string | null;
};

export default function OrdersPage() {
  const [tab, setTab] = useState<'all' | 'paper' | 'real'>('all');
  const orders = useBackend<{
    orders: Order[]; count: number; totalStored: number; isDerived: boolean;
    reasonUnavailable: string | null; meaning: string; notRecorded: Record<string, string>;
    // WHICH BOOK answered. `postgres:trades` is the backend agent's fills;
    // `json:.data/trades.json` is the browser's manual trades. They are different
    // actors, so the page must name the one it is showing rather than presenting
    // either under a heading that implies the other.
    source?: string; qualityMeasured?: number;
  }>(`${BACKEND_PATHS.catalogOrders}${tab === 'all' ? '' : `?tab=${tab}`}`, { intervalMs: 20_000, deps: [tab] });

  const rows = orders.data?.orders ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold">Orders</h1>
        <Badge state="WARN" label="Derived from fills" />
      </div>

      <div className="text-[11.5px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
        {orders.data?.meaning ??
          'This backend has no order store. Rows below are completed fills from the trade log, not an exchange order book.'}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          label="Fills"
          value={<Num value={orders.data?.totalStored ?? null} digits={0} />}
          sub={
            orders.data?.source === 'postgres:trades'
              ? "the agent's book"
              : orders.data?.source
                ? 'FALLBACK: the browser\u2019s manual trades'
                : undefined
          }
          color={orders.data?.source && orders.data.source !== 'postgres:trades' ? 'var(--warning)' : undefined}
        />
        <StatCard label="Shown" value={<Num value={orders.data?.count ?? null} digits={0} />} />
        <StatCard label="Resting orders" value={<span style={{ color: 'var(--text-muted)' }}>n/a</span>} sub="no order state exists" mono={false} />
        <StatCard label="Slippage / latency" value={<span style={{ color: 'var(--text-muted)' }}>—</span>} sub="not recorded" mono={false} />
      </div>

      <Card>
        <SectionTitle
          action={
            <span className="flex gap-1.5">
              {(['all', 'paper', 'real'] as const).map((t) => (
                <button key={t} type="button" className={`chip${tab === t ? ' on' : ''}`} onClick={() => setTab(t)}>{t}</button>
              ))}
            </span>
          }
        >
          Fill records
        </SectionTitle>
        <TermTable
          columns={[
            { key: 't', label: 'When' }, { key: 'id', label: 'ID' }, { key: 's', label: 'Symbol' },
            { key: 'd', label: 'Side' }, { key: 'q', label: 'Qty', num: true },
            { key: 'p', label: 'Price', num: true }, { key: 'l', label: 'P&L', num: true },
            { key: 'sl', label: 'Slippage', num: true }, { key: 'la', label: 'Latency', num: true },
            { key: 'st', label: 'Status' },
          ]}
          empty={
            orders.state === 'unreachable'
              ? 'The catalog endpoint did not respond.'
              : (orders.data?.reasonUnavailable ?? 'No fills logged.')
          }
        >
          {rows.map((o, i) => (
            <tr key={o.id ?? i}>
              <td className="mono text-[11px]">{o.ts ? new Date(o.ts).toLocaleString() : '—'}</td>
              <td className="mono text-[10.5px]" style={{ color: 'var(--text-muted)' }}>{o.id?.slice(0, 10) ?? '—'}</td>
              <td className="mono text-[11.5px]">{o.symbol ?? '—'}</td>
              <td><span className="mono text-[11.5px]" style={{ color: o.side === 'buy' ? 'var(--positive)' : 'var(--negative)' }}>{o.side?.toUpperCase() ?? '—'}</span></td>
              <td className="num"><Num value={o.qty ?? null} digits={6} /></td>
              <td className="num"><Num value={o.price ?? null} /></td>
              <td className="num">{typeof o.pnl === 'number' ? <Num value={o.pnl} colored signed /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
              {/* null, never 0 — a slippage of zero is a perfect fill. */}
              <td className="num" style={{ color: 'var(--text-muted)' }}>—</td>
              <td className="num" style={{ color: 'var(--text-muted)' }}>—</td>
              <td><Badge state="FILLED" /></td>
            </tr>
          ))}
        </TermTable>
      </Card>

      <NotAvailable
        what="Order status, slippage and latency"
        reason={
          'no order store exists, so there is no PENDING/OPEN/CANCELLED lifecycle to report — ' +
          'every row is a completed fill. Slippage and latency are not captured on a trade ' +
          'record; they are null rather than zero, because zero would read as a perfect fill.'
        }
      />
    </div>
  );
}
