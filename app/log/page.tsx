'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import { usePortfolio } from '@/components/Portfolio';
import type { TradeTab } from '@/lib/types';

type FilterTab = 'all' | TradeTab;

export default function LogPage() {
  const { tradeLog, deleteTradeLogEntry } = usePortfolio();
  const router = useRouter();
  const [filter, setFilter] = useState<FilterTab>('all');

  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get('tab');
    if (param === 'paper' || param === 'real') setFilter(param);
  }, []);

  const rows = useMemo(() => {
    const filtered = filter === 'all' ? tradeLog : tradeLog.filter((t) => t.tab === filter);
    return [...filtered].sort((a, b) => b.ts - a.ts);
  }, [tradeLog, filter]);

  return (
    <div className="min-h-screen bg-bg0 text-txt0">
      <header className="flex items-center gap-3 px-4 h-14 border-b border-line bg-bg1 sticky top-0 z-10">
        <button onClick={() => router.push('/')} className="p-1.5 rounded-md hover:bg-bg3 transition text-txt1" title="Back to terminal">
          <Icon name="x" size={18} />
        </button>
        <span className="font-mono text-sm font-semibold">Trade Log</span>
        <div className="flex-1" />
        <div className="flex gap-1 text-[11px] font-mono">
          {(['all', 'paper', 'real'] as FilterTab[]).map((t) => (
            <button key={t} onClick={() => setFilter(t)} className={`tabbtn ${filter === t ? 'bg-bg3 text-amber' : 'text-txt2'}`}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-6">
        {rows.length === 0 ? (
          <p className="text-sm text-txt2">No trades logged yet.</p>
        ) : (
          <div className="flex flex-col divide-y divide-line border border-line rounded-lg overflow-hidden">
            <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-2 text-[10px] font-mono uppercase tracking-wider text-txt2 bg-bg1">
              <span>Symbol / Time</span>
              <span>Tab</span>
              <span>Qty</span>
              <span>Price</span>
              <span></span>
            </div>
            {rows.map((t) => (
              <div key={t.id} className="group grid grid-cols-[1fr_auto_auto_auto_auto] gap-3 px-4 py-3 items-center hover:bg-bg2 transition bg-bg1">
                <Link href={`/log/${t.id}`} className="min-w-0">
                  <div className="flex items-center gap-2 font-mono text-sm">
                    <span style={{ color: t.side === 'buy' ? 'var(--green)' : 'var(--red)' }}>{t.side.toUpperCase()}</span>
                    <span className="truncate">{t.symbol}</span>
                  </div>
                  <p className="text-[10.5px] text-txt2">
                    {new Date(t.ts).toLocaleString()}
                    {t.note ? ` · ${t.note}` : ''}
                  </p>
                </Link>
                <span className="text-[11px] font-mono uppercase text-txt2">{t.tab}</span>
                <span className="text-[13px] font-mono text-txt0">{t.qty % 1 === 0 ? t.qty : t.qty.toFixed(4)}</span>
                <div className="text-[13px] font-mono text-right">
                  <div className="text-txt0">{t.price.toFixed(2)}</div>
                  {typeof t.pnl === 'number' && (
                    <div className="text-[10px]" style={{ color: t.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {t.pnl >= 0 ? '+' : ''}
                      {t.pnl.toFixed(2)}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => {
                    if (confirm(`Delete this ${t.side} ${t.symbol} log entry? This can't be undone.`)) deleteTradeLogEntry(t.id);
                  }}
                  className="opacity-0 group-hover:opacity-100 transition p-1.5 rounded hover:bg-bg3 hover:text-red text-txt2"
                  title="Delete entry"
                >
                  <Icon name="trash" size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
