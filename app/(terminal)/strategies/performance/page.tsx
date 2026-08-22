'use client';

// ---------------------------------------------------------------------
// /strategies/performance — equity curve, drawdown, per-asset P&L.
//
// PER-REGIME AND PER-TIMEFRAME BREAKDOWNS ARE OMITTED. Both need the regime (or
// timeframe) stamped on each trade record, and trades carry neither. Grouping by a
// field that does not exist would put every trade in one bucket labelled with a
// regime it may not have been opened in.
//
// The equity curve is REALISED only — cumulative pnl over trades that carry one,
// starting at zero. It is not account equity, and the axis label says so.
// ---------------------------------------------------------------------

import { useMemo } from 'react';

import { Sparkline } from '@/components/ui/Sparkline';
import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { equityCurve, groupBy, maxDrawdownPct, realised, type Trade } from '@/lib/api/portfolio';
import { useSameOrigin } from '@/lib/api/useSameOrigin';

export default function PerformancePage() {
  const trades = useSameOrigin<{ trades?: Trade[] }>('/api/trades', { intervalMs: 60_000 });
  const rows = trades.data?.trades ?? [];

  const curve = useMemo(() => equityCurve(rows), [rows]);
  const drawdown = useMemo(() => maxDrawdownPct(curve), [curve]);
  const pnl = realised(rows);

  const bySymbol = useMemo(() => {
    const groups = groupBy(rows, (t) => t.symbol ?? '—');
    return [...groups.entries()]
      .map(([symbol, list]) => ({ symbol, ...realised(list), trades: list.length }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Strategy Performance</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Realised P&L" value={<Num value={pnl.counted ? pnl.total : null} prefix="$" colored signed />} sub={pnl.withoutPnl ? `${pnl.withoutPnl} excluded` : undefined} />
        <StatCard label="Win rate" value={pnl.winRatePct === null ? <span style={{ color: 'var(--text-muted)' }}>—</span> : <Num value={pnl.winRatePct} digits={1} suffix="%" />} />
        <StatCard label="Max drawdown" value={drawdown === null ? <span style={{ color: 'var(--text-muted)' }}>—</span> : <Num value={drawdown} digits={2} suffix="%" />} sub={drawdown === null ? 'needs 2+ trades' : 'of realised curve'} />
        <StatCard label="Curve points" value={<Num value={curve.length} digits={0} />} />
      </div>

      <Card>
        <SectionTitle>Realised equity curve</SectionTitle>
        {curve.length < 2 ? (
          <NotAvailable
            what="Equity curve"
            reason="fewer than two trades carry a pnl, so there is no curve to draw. A flat line from one point would imply a measured period of no change."
            compact
          />
        ) : (
          <>
            <Sparkline values={curve.map((p) => p.v)} width={720} height={120} minPoints={2} />
            <div className="text-[10.5px] mt-2" style={{ color: 'var(--text-muted)' }}>
              Cumulative realised P&amp;L from zero, oldest trade first — <strong>not</strong>{' '}
              account equity. Unrealised movement on open positions is not included.
            </div>
          </>
        )}
      </Card>

      <Card>
        <SectionTitle>P&amp;L by asset</SectionTitle>
        <TermTable
          columns={[
            { key: 's', label: 'Symbol' }, { key: 't', label: 'Trades', num: true },
            { key: 'p', label: 'Realised', num: true }, { key: 'w', label: 'Win rate', num: true },
          ]}
          empty="No trades logged."
        >
          {bySymbol.map((r) => (
            <tr key={r.symbol}>
              <td className="mono text-[11.5px]">{r.symbol}</td>
              <td className="num mono">{r.trades}</td>
              <td className="num">{r.counted ? <Num value={r.total} colored signed /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
              <td className="num">{r.winRatePct === null ? <span style={{ color: 'var(--text-muted)' }}>—</span> : <Num value={r.winRatePct} digits={1} suffix="%" />}</td>
            </tr>
          ))}
        </TermTable>
      </Card>

      <NotAvailable
        what="P&L by regime and by timeframe"
        reason={
          'both need the regime (or timeframe) stamped on each trade record, and trades carry ' +
          'neither. Grouping by a field that does not exist would put every trade in one bucket ' +
          'labelled with a regime it may not have been opened in. Adding the field to the trade ' +
          'record would unblock both charts.'
        }
      />
    </div>
  );
}
