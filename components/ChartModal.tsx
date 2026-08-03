'use client';

import { useState } from 'react';
import { Icon } from './Icon';
import { LiveChart } from './LiveChart';
import type { WatchItem } from '@/lib/types';

function tvSymbolFor(w: WatchItem): string {
  if (w.type === 'crypto' && w.binance) return `BINANCE:${w.binance.toUpperCase()}`;
  return w.symbol.replace(/[^A-Z0-9.]/gi, '');
}

export function ChartModal({ item, onClose }: { item: WatchItem | null; onClose: () => void }) {
  const [view, setView] = useState<'quant' | 'tradingview'>('quant');
  if (!item) return null;
  const tvSymbol = tvSymbolFor(item);
  const src = `https://s.tradingview.com/widgetembed/?frameElementId=tvchart&symbol=${encodeURIComponent(
    tvSymbol,
  )}&interval=60&theme=dark&style=1&timezone=Etc%2FUTC&withdateranges=1&hide_side_toolbar=0&studies=%5B%5D&toolbarbg=141822`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(4,5,7,0.75)' }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl rounded-xl border shadow-2xl overflow-hidden rise border-line bg-bg1 card-shadow"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-line">
          <div className="flex items-center gap-2 font-mono text-sm font-semibold text-txt0">
            <Icon name="trend-up" size={16} className="text-amber" /> {item.symbol}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setView('quant')}
              className={`px-2.5 py-1 rounded text-[10px] font-mono transition ${view === 'quant' ? 'bg-bg3 text-amber' : 'text-txt2 hover:bg-bg2'}`}
            >
              QUANT Engine
            </button>
            <button
              onClick={() => setView('tradingview')}
              className={`px-2.5 py-1 rounded text-[10px] font-mono transition ${view === 'tradingview' ? 'bg-bg3 text-amber' : 'text-txt2 hover:bg-bg2'}`}
            >
              TradingView
            </button>
            <button onClick={onClose} className="p-1 rounded hover:bg-bg3 text-txt2 ml-1">
              <Icon name="x" size={18} />
            </button>
          </div>
        </div>

        {view === 'quant' ? (
          <div className="p-4">
            <LiveChart item={item} />
          </div>
        ) : (
          <div style={{ height: '70vh' }}>
            <iframe title={`chart-${item.symbol}`} src={src} style={{ width: '100%', height: '100%', border: 'none' }} />
          </div>
        )}

        <p className="px-4 py-2 text-[10px] font-mono border-t border-line text-txt2">
          {view === 'quant'
            ? 'Computed by this app from real OHLC history (see the price attribution in the panel above) — the same indicator engine used to give the AI real numbers instead of "I don\'t have indicator access."'
            : `Chart data and symbol resolution come directly from TradingView, not this app's proxy — equity symbol matching accuracy depends on their resolver (${tvSymbol}).`}
        </p>
      </div>
    </div>
  );
}
