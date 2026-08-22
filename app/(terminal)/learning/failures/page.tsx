'use client';

// ---------------------------------------------------------------------
// /learning/failures — losing trades, grouped.
//
// THE CLUSTERING IS CLIENT-SIDE AND SAID TO BE. No backend component clusters
// failures; the reference's groups ("DOGEUSDT · Breakout · High Volatility") span
// asset, strategy and regime, and trade records carry only the asset. So grouping
// is by symbol and side only, and the missing dimensions are named rather than
// invented.
// ---------------------------------------------------------------------

import { useMemo } from 'react';

import { Card, Num, NotAvailable, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { groupBy, realised, type Trade } from '@/lib/api/portfolio';
import { useSameOrigin } from '@/lib/api/useSameOrigin';

export default function FailuresPage() {
  const trades = useSameOrigin<{ trades?: Trade[] }>('/api/trades', { intervalMs: 60_000 });
  const reflections = useSameOrigin<{ reflections?: Record<string, unknown>[] }>('/api/reflections', { intervalMs: 60_000 });

  const losses = useMemo(
    () => (trades.data?.trades ?? []).filter((t) => typeof t.pnl === 'number' && (t.pnl as number) < 0),
    [trades.data],
  );

  const clusters = useMemo(() => {
    const groups = groupBy(losses, (t) => `${t.symbol ?? '—'} · ${t.side ?? '—'}`);
    return [...groups.entries()]
      .map(([label, list]) => {
        const r = realised(list);
        return { label, count: list.length, total: r.total, avg: list.length ? r.total / list.length : 0 };
      })
      .sort((a, b) => a.total - b.total);
  }, [losses]);

  const refl = reflections.data?.reflections ?? [];

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Failure Analysis</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Losing trades" value={<Num value={losses.length} digits={0} />} />
        <StatCard label="Total loss" value={<Num value={losses.length ? realised(losses).total : null} prefix="$" colored />} />
        <StatCard label="Clusters" value={<Num value={clusters.length} digits={0} />} sub="by symbol + side" />
        <StatCard label="Reflections" value={<Num value={refl.length} digits={0} />} />
      </div>

      <Card>
        <SectionTitle>Loss clusters</SectionTitle>
        {clusters.length === 0 ? (
          <NotAvailable
            what="Loss clusters"
            reason="no trade carries a negative pnl. That is not the same as no losses — it may mean no trade carries a pnl at all."
            compact
          />
        ) : (
          <TermTable
            columns={[
              { key: 'g', label: 'Group' }, { key: 'c', label: 'Count', num: true },
              { key: 't', label: 'Total', num: true }, { key: 'a', label: 'Avg', num: true },
            ]}
          >
            {clusters.map((c) => (
              <tr key={c.label}>
                <td className="text-[11.5px]">{c.label}</td>
                <td className="num mono">{c.count}</td>
                <td className="num"><Num value={c.total} colored /></td>
                <td className="num"><Num value={c.avg} colored /></td>
              </tr>
            ))}
          </TermTable>
        )}
        <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          Grouped in the browser by <strong>symbol and side only</strong>. Strategy and regime
          are not on a trade record, so the reference&apos;s three-way grouping cannot be
          reproduced — inventing those dimensions would label each cluster with a strategy the
          trade may not have used.
        </div>
      </Card>

      <Card>
        <SectionTitle>Reflections</SectionTitle>
        <TermTable
          columns={[{ key: 's', label: 'Symbol' }, { key: 'l', label: 'Lesson' }]}
          empty="No reflections recorded. One is generated per closed trade."
        >
          {refl.slice(0, 25).map((r, i) => (
            <tr key={String(r.id ?? i)}>
              <td className="mono text-[11.5px]">{String(r.symbol ?? '—')}</td>
              <td className="text-[11px] whitespace-normal max-w-[620px]" style={{ color: 'var(--text-secondary)' }}>
                {String(r.lesson ?? r.summary ?? r.content ?? '—').slice(0, 400)}
              </td>
            </tr>
          ))}
        </TermTable>
      </Card>
    </div>
  );
}
