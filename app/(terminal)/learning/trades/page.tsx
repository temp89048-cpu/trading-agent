'use client';

// ---------------------------------------------------------------------
// /learning/trades — per-trade analysis.
//
// Joins the trade log to reflections by symbol, because that is the only key both
// carry. The join is reported as approximate: a symbol with several trades and one
// reflection cannot be matched exactly, and pretending otherwise would attach one
// trade's lesson to another.
// ---------------------------------------------------------------------

import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';

import { OperatorSection } from '@/components/operator/OperatorSection';
import { Card, Num, SectionTitle, StatCard, TermTable } from '@/components/ui/primitives';
import { realised, type Trade } from '@/lib/api/portfolio';
import { useSameOrigin } from '@/lib/api/useSameOrigin';

// Code-split: HypothesisPanel is shown only after a row is selected, and it pulls
// in the hypothesis provider and the LLM path. Eager-importing it doubled this
// route's first load for a panel most visits never open.
const HypothesisPanel = dynamic(
  () => import('@/components/HypothesisPanel').then((m) => ({ default: m.HypothesisPanel })),
  { ssr: false, loading: () => <p className="text-[11.5px]" style={{ color: 'var(--text-muted)' }}>Loading…</p> },
);

export default function TradeAnalysisPage() {
  const trades = useSameOrigin<{ trades?: Trade[] }>('/api/trades', { intervalMs: 60_000 });
  const reflections = useSameOrigin<{ reflections?: Record<string, unknown>[] }>('/api/reflections', { intervalMs: 60_000 });

  const rows = useMemo(() => [...(trades.data?.trades ?? [])].sort((a, b) => b.ts - a.ts), [trades.data]);
  const bySymbol = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of reflections.data?.reflections ?? []) {
      const sym = String(r.symbol ?? '');
      const lesson = String(r.lesson ?? r.summary ?? r.content ?? '');
      if (sym && lesson && !map.has(sym)) map.set(sym, lesson);
    }
    return map;
  }, [reflections.data]);

  const pnl = realised(rows);
  // HypothesisPanel is per-trade — it takes the trade id and shows that trade's
  // lesson, the hypothesis derived from it, and the Apply button. Selecting a row is
  // the only way to give it one.
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <h1 className="text-[17px] font-semibold">Trade Analysis</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Trades" value={<Num value={rows.length} digits={0} />} />
        <StatCard label="With a pnl" value={<Num value={pnl.counted} digits={0} />} sub={pnl.withoutPnl ? `${pnl.withoutPnl} without` : undefined} />
        <StatCard label="Wins" value={<Num value={pnl.wins} digits={0} />} color="var(--positive)" />
        <StatCard label="Losses" value={<Num value={pnl.losses} digits={0} />} color="var(--negative)" />
      </div>

      <Card>
        <SectionTitle>Per-trade</SectionTitle>
        <TermTable
          columns={[
            { key: 't', label: 'When' }, { key: 's', label: 'Symbol' }, { key: 'd', label: 'Side' },
            { key: 'p', label: 'Price', num: true }, { key: 'l', label: 'P&L', num: true },
            { key: 'r', label: 'Lesson (by symbol)' },
          ]}
          empty="No trades logged."
        >
          {rows.map((t) => (
            <tr
              key={t.id}
              className="cursor-pointer"
              onClick={() => setSelectedId(t.id)}
              style={t.id === selectedId ? { background: 'var(--bg-surface-2)' } : undefined}
            >
              <td className="mono text-[11px]">{new Date(t.ts).toLocaleString()}</td>
              <td className="mono text-[11.5px]">{t.symbol}</td>
              <td><span className="mono text-[11.5px]" style={{ color: t.side === 'buy' ? 'var(--positive)' : 'var(--negative)' }}>{t.side?.toUpperCase()}</span></td>
              <td className="num"><Num value={t.price} /></td>
              <td className="num">{typeof t.pnl === 'number' ? <Num value={t.pnl} colored signed /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</td>
              <td className="text-[11px] whitespace-normal max-w-[420px]" style={{ color: 'var(--text-muted)' }}>
                {bySymbol.get(t.symbol)?.slice(0, 200) ?? '—'}
              </td>
            </tr>
          ))}
        </TermTable>
        <div className="text-[10.5px] mt-2 leading-relaxed" style={{ color: 'var(--text-muted)' }}>
          The lesson column is joined by <strong>symbol only</strong> — the sole key both a
          trade and a reflection carry. Where a symbol has several trades they all show the
          same lesson, which is why the column is labelled &quot;by symbol&quot; rather than
          presented as this trade&apos;s own reflection.
        </div>
      </Card>
      {selectedId ? (
        <OperatorSection
          title="Lesson, hypothesis and Apply"
          note="A hypothesis reaching production requires this explicit click. Nothing in the reflection or hypothesis path can write to risk config or strategy selection on its own — Loss then AI-rewrites-strategy then live is deliberately impossible."
          action={
            <button type="button" className="chip" onClick={() => setSelectedId(null)}>
              Close
            </button>
          }
        >
          <HypothesisPanel tradeId={selectedId} />
        </OperatorSection>
      ) : (
        <div className="text-[10.5px]" style={{ color: 'var(--text-muted)' }}>
          Select a trade above to see its reflection, the hypothesis derived from it, and the
          Apply control.
        </div>
      )}
    </div>
  );
}
