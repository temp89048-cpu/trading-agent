'use client';

import { useEffect, useState } from 'react';
import { useMarketData } from './MarketData';
import { usePortfolio } from './Portfolio';
import { useCandles } from './Candles';
import { captureContextSnapshot } from '@/lib/reflectionAgent';

export function PaperTradePanel() {
  const { watchlist, ticks } = useMarketData();
  const { portfolio, buyPaper, sellPaper } = usePortfolio();
  const { getCandles } = useCandles();
  const [symbol, setSymbol] = useState(watchlist[0]?.symbol ?? '');
  const [qty, setQty] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!watchlist.find((w) => w.symbol === symbol) && watchlist[0]) setSymbol(watchlist[0].symbol);
  }, [watchlist, symbol]);

  const price = ticks[symbol]?.price ?? null;
  const positions = portfolio.paper.positions;
  const marketValue = positions.reduce((sum, p) => sum + p.qty * (ticks[p.symbol]?.price ?? p.avgCost), 0);
  const totalValue = portfolio.paper.cash + marketValue;

  function trade(side: 'buy' | 'sell') {
    const q = parseFloat(qty);
    if (!q || q <= 0 || !price) return;
    // Manual panel has no leverage input, so pass undefined = 1x (full
    // notional locked as margin) rather than guessing a multiplier.
    const ok = side === 'buy' ? buyPaper(symbol, q, price, undefined, captureContextSnapshot(symbol, getCandles), undefined, 'manual-click') : sellPaper(symbol, q, price);
    setNotice(ok ? null : side === 'buy' ? 'Not enough cash for that.' : "You don't hold that much.");
    if (ok) setQty('');
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-txt2">Cash</span>
        <span className="text-txt0">${portfolio.paper.cash.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
      </div>
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-txt2">Total value</span>
        <span className="text-txt0">${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
      </div>

      {positions.length > 0 && (
        <div className="flex flex-col gap-1.5 pt-1 border-t border-line">
          {positions.map((p) => {
            const live = ticks[p.symbol]?.price;
            const value = p.qty * (live ?? p.avgCost);
            const pnl = live ? (live - p.avgCost) * p.qty : 0;
            const pnlPct = live ? ((live - p.avgCost) / p.avgCost) * 100 : 0;
            return (
              <div key={p.symbol} className="flex items-center justify-between text-[11px] font-mono">
                <span className="text-txt1">
                  {p.symbol} · {p.qty}
                </span>
                <div className="text-right">
                  <div className="text-txt0">${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                  {live && (
                    <div style={{ color: pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {pnl >= 0 ? '+' : ''}
                      {pnlPct.toFixed(2)}%
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex flex-col gap-1.5 pt-2 border-t border-line">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-full rounded px-2 py-1.5 text-xs font-mono">
          {watchlist.map((w) => (
            <option key={w.symbol} value={w.symbol}>
              {w.symbol}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-1.5">
          <input
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            placeholder="qty"
            className="flex-1 rounded px-2 py-1.5 text-xs font-mono"
          />
          <span className="text-[10px] font-mono text-txt2">
            @ {price ? price.toLocaleString(undefined, { maximumFractionDigits: 2 }) : '—'}
          </span>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={() => trade('buy')}
            disabled={!price}
            className="flex-1 py-1.5 rounded text-[11px] font-mono font-semibold disabled:opacity-40"
            style={{ background: 'var(--green)', color: '#04150c' }}
          >
            Buy
          </button>
          <button
            onClick={() => trade('sell')}
            disabled={!price}
            className="flex-1 py-1.5 rounded text-[11px] font-mono font-semibold disabled:opacity-40"
            style={{ background: 'var(--red)', color: '#1a0505' }}
          >
            Sell
          </button>
        </div>
        {notice && <p className="text-[10px] text-red">{notice}</p>}
      </div>
    </div>
  );
}
