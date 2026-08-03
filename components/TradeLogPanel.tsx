'use client';

import Link from 'next/link';
import { usePortfolio } from './Portfolio';
import { Icon } from './Icon';

const SIDEBAR_PREVIEW_COUNT = 5;

export function TradeLogPanel({ tab }: { tab: 'paper' | 'real' }) {
  const { tradeLog, deleteTradeLogEntry } = usePortfolio();
  const rows = tradeLog.filter((t) => t.tab === tab).sort((a, b) => b.ts - a.ts);

  if (rows.length === 0) {
    return <p className="text-[11px] text-txt2">No {tab} trades logged yet — buy/sell (or add/remove a ledger row) to see it here.</p>;
  }

  const preview = rows.slice(0, SIDEBAR_PREVIEW_COUNT);

  return (
    <div className="flex flex-col gap-1.5">
      {preview.map((t) => (
        <div key={t.id} className="group flex items-center justify-between text-[11px] font-mono rounded px-1 -mx-1 py-0.5 hover:bg-bg3 transition">
          <Link href={`/log/${t.id}`} className="flex flex-col min-w-0 flex-1">
            <span style={{ color: t.side === 'buy' ? 'var(--green)' : 'var(--red)' }}>
              {t.side.toUpperCase()} {t.symbol}
            </span>
            <span className="text-[9.5px] text-txt2 truncate">
              {new Date(t.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              {t.note ? ` · ${t.note}` : ''}
            </span>
          </Link>
          <div className="flex items-center gap-1.5 shrink-0">
            <div className="text-right text-txt0">
              <div>{t.qty % 1 === 0 ? t.qty : t.qty.toFixed(4)} @ {t.price.toFixed(2)}</div>
              {typeof t.pnl === 'number' && (
                <div style={{ color: t.pnl >= 0 ? 'var(--green)' : 'var(--red)' }} className="text-[9.5px]">
                  {t.pnl >= 0 ? '+' : ''}
                  {t.pnl.toFixed(2)}
                </div>
              )}
            </div>
            <button
              onClick={() => {
                if (confirm(`Delete this ${t.side} ${t.symbol} log entry? This can't be undone.`)) deleteTradeLogEntry(t.id);
              }}
              className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:text-red text-txt2"
              title="Delete entry"
            >
              <Icon name="trash" size={11} />
            </button>
          </div>
        </div>
      ))}

      <Link
        href={`/log?tab=${tab}`}
        className="flex items-center justify-center gap-1 mt-1 pt-2 border-t border-line text-[10px] font-mono text-txt2 hover:text-amber transition"
      >
        View all {rows.length} {tab} trades <Icon name="chevron-down" size={11} className="-rotate-90" />
      </Link>
    </div>
  );
}
