'use client';

import { useState } from 'react';
import { Icon } from './Icon';
import { useMarketData } from './MarketData';
import { usePortfolio } from './Portfolio';
import { useCandles } from './Candles';
import { captureContextSnapshot } from '@/lib/reflectionAgent';

export function RealPortfolioPanel() {
  const { ticks } = useMarketData();
  const { portfolio, addRealPosition, removeRealPosition } = usePortfolio();
  const { getCandles } = useCandles();
  const [draft, setDraft] = useState({ symbol: '', qty: '', avgCost: '' });
  const [closing, setClosing] = useState<string | null>(null);
  const [exitPriceDraft, setExitPriceDraft] = useState('');

  const positions = portfolio.real.positions;
  const totalValue = positions.reduce((sum, p) => sum + p.qty * (ticks[p.symbol]?.price ?? p.avgCost), 0);

  function add() {
    const symbol = draft.symbol.trim().toUpperCase();
    const qty = parseFloat(draft.qty);
    const avgCost = parseFloat(draft.avgCost);
    if (!symbol || !qty || !avgCost) return;
    addRealPosition(symbol, qty, avgCost, captureContextSnapshot(symbol, getCandles));
    setDraft({ symbol: '', qty: '', avgCost: '' });
  }

  function startClose(symbol: string) {
    const live = ticks[symbol]?.price;
    setExitPriceDraft(live ? live.toString() : '');
    setClosing(symbol);
  }

  function confirmClose() {
    if (!closing) return;
    const price = parseFloat(exitPriceDraft);
    removeRealPosition(closing, isFinite(price) && price > 0 ? price : undefined);
    setClosing(null);
    setExitPriceDraft('');
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between text-xs font-mono">
        <span className="text-txt2">Total value</span>
        <span className="text-txt0 font-semibold">${totalValue.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        {positions.length === 0 && <p className="text-[11px] text-txt2">No positions in the ledger yet.</p>}
        {positions.map((p) => {
          const live = ticks[p.symbol]?.price;
          const value = p.qty * (live ?? p.avgCost);
          const pnlPct = live ? ((live - p.avgCost) / p.avgCost) * 100 : 0;
          const isClosing = closing === p.symbol;
          return (
            <div key={p.symbol} className="rounded-md border border-line bg-bg2 px-2.5 py-2">
              <div className="group flex items-center justify-between text-[11px] font-mono">
                <span className="text-txt1">
                  {p.symbol} · {p.qty} @ {p.avgCost}
                </span>
                <div className="flex items-center gap-2">
                  <div className="text-right">
                    <div className="text-txt0">${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                    {live && (
                      <div style={{ color: pnlPct >= 0 ? 'var(--green)' : 'var(--red)' }}>
                        {pnlPct >= 0 ? '+' : ''}
                        {pnlPct.toFixed(2)}%
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => (isClosing ? setClosing(null) : startClose(p.symbol))}
                    className="opacity-0 group-hover:opacity-100 transition p-0.5 rounded hover:text-red text-txt2"
                    title="Close position"
                  >
                    <Icon name="x" size={12} />
                  </button>
                </div>
              </div>
              {isClosing && (
                <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-line">
                  <span className="text-[10px] font-mono text-txt2 shrink-0">Exit price</span>
                  <input
                    value={exitPriceDraft}
                    onChange={(e) => setExitPriceDraft(e.target.value)}
                    placeholder={live ? live.toString() : p.avgCost.toString()}
                    className="flex-1 rounded px-2 py-1 text-xs font-mono"
                  />
                  <button onClick={confirmClose} className="px-2 py-1 rounded text-[10px] font-mono font-semibold bg-red text-black shrink-0">
                    Close
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="flex flex-col gap-1.5 pt-2 border-t border-line">
        <input
          value={draft.symbol}
          onChange={(e) => setDraft((d) => ({ ...d, symbol: e.target.value }))}
          placeholder="Symbol (e.g. NVDA)"
          className="w-full rounded px-2 py-1.5 text-xs font-mono"
        />
        <div className="flex gap-1.5">
          <input
            value={draft.qty}
            onChange={(e) => setDraft((d) => ({ ...d, qty: e.target.value }))}
            placeholder="qty"
            className="flex-1 rounded px-2 py-1.5 text-xs font-mono"
          />
          <input
            value={draft.avgCost}
            onChange={(e) => setDraft((d) => ({ ...d, avgCost: e.target.value }))}
            placeholder="avg cost"
            className="flex-1 rounded px-2 py-1.5 text-xs font-mono"
          />
        </div>
        <button onClick={add} className="py-1.5 rounded text-[11px] font-mono font-semibold bg-amber text-black hover:opacity-90 transition">
          Add to ledger
        </button>
      </div>
    </div>
  );
}
