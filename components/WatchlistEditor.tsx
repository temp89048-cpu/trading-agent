'use client';

import { useState } from 'react';
import { Icon } from './Icon';
import { useMarketData } from './MarketData';
import type { WatchItem } from '@/lib/types';

function sourceLabel(source: string) {
  if (source === 'ws-live') return { label: 'LIVE · WS', color: 'var(--green)' };
  if (source === 'poll-live') return { label: 'LIVE · POLL', color: 'var(--cyan)' };
  return { label: 'SIM', color: 'var(--txt-2)' };
}

export function WatchlistEditor({ onSelectSymbol }: { onSelectSymbol?: (symbol: string) => void }) {
  const { watchlist, setWatchlist, ticks, flash, quoteApiError } = useMarketData();
  const [adding, setAdding] = useState(false);
  const [draftSymbol, setDraftSymbol] = useState('');
  const [draftType, setDraftType] = useState<'crypto' | 'equity'>('crypto');

  function add() {
    const symbol = draftSymbol.trim().toUpperCase();
    if (!symbol || watchlist.some((w) => w.symbol === symbol)) return;
    const item: WatchItem =
      draftType === 'crypto'
        ? { symbol, type: 'crypto', binance: symbol.replace(/[^A-Z0-9]/gi, '').toLowerCase() }
        : { symbol, type: 'equity' };
    setWatchlist((prev) => [...prev, item]);
    setDraftSymbol('');
    setAdding(false);
  }

  function remove(symbol: string) {
    setWatchlist((prev) => prev.filter((w) => w.symbol !== symbol));
  }

  return (
    <div className="flex flex-col gap-0.5">
      {watchlist.map((w) => {
        const t = ticks[w.symbol];
        const f = flash[w.symbol];
        const changePct = t?.prevClose ? ((t.price - t.prevClose) / t.prevClose) * 100 : null;
        const src = sourceLabel(t?.source ?? 'sim-fallback');
        return (
          <div
            key={w.symbol}
            className={`group flex items-center justify-between px-1.5 py-1.5 rounded transition ${
              f === 'up' ? 'flash-up' : f === 'down' ? 'flash-down' : ''
            }`}
          >
            <div className="flex flex-col cursor-pointer" onClick={() => onSelectSymbol?.(w.symbol)}>
              <span className="font-mono text-xs text-txt1 hover:underline">{w.symbol}</span>
              <span className="font-mono text-[9px]" style={{ color: src.color }}>
                {src.label}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="flex flex-col items-end">
                <span className="font-mono text-xs text-txt0">
                  {t ? t.price.toLocaleString(undefined, { maximumFractionDigits: t.price < 10 ? 4 : 2 }) : '—'}
                </span>
                {changePct !== null && (
                  <span className="font-mono text-[10px]" style={{ color: changePct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                    {changePct >= 0 ? '+' : ''}
                    {changePct.toFixed(2)}%
                  </span>
                )}
              </div>
              <button
                onClick={() => remove(w.symbol)}
                className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:text-red text-txt2"
                title="Remove"
              >
                <Icon name="x" size={12} />
              </button>
            </div>
          </div>
        );
      })}

      {quoteApiError && <p className="text-[10px] mt-1 text-red">Equity quotes: {quoteApiError} — showing simulated fallback.</p>}

      {adding ? (
        <div className="flex flex-col gap-1.5 mt-2 p-2 rounded-md border border-line bg-bg2">
          <div className="flex gap-1.5">
            <button
              onClick={() => setDraftType('crypto')}
              className={`flex-1 py-1 rounded text-[10px] font-mono border ${draftType === 'crypto' ? 'border-amber text-amber' : 'border-line text-txt2'}`}
            >
              Crypto
            </button>
            <button
              onClick={() => setDraftType('equity')}
              className={`flex-1 py-1 rounded text-[10px] font-mono border ${draftType === 'equity' ? 'border-amber text-amber' : 'border-line text-txt2'}`}
            >
              Equity
            </button>
          </div>
          <input
            autoFocus
            value={draftSymbol}
            onChange={(e) => setDraftSymbol(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            placeholder={draftType === 'crypto' ? 'e.g. SOLUSDT' : 'e.g. AAPL'}
            className="w-full rounded px-2 py-1.5 text-xs font-mono"
          />
          <div className="flex gap-1.5">
            <button onClick={add} className="flex-1 py-1 rounded text-[10px] font-mono font-semibold bg-amber text-black">
              Add
            </button>
            <button onClick={() => setAdding(false)} className="flex-1 py-1 rounded text-[10px] font-mono text-txt2 hover:bg-bg3">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="mt-2 flex items-center justify-center gap-1.5 py-1.5 rounded-md text-[11px] font-mono border border-dashed border-line text-txt2 hover:text-txt0 hover:border-amberDim transition"
        >
          <Icon name="plus" size={12} /> Add symbol
        </button>
      )}
    </div>
  );
}
