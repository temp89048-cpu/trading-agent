'use client';

import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { useOrderFlow } from './OrderFlow';
import { useMultiExchange } from './MultiExchange';
import { buildStrategyContext } from '@/lib/strategyContext';
import { runStrategyEnsembleGated, PLANNED_AGENTS } from '@/lib/strategyEnsemble';

export function StrategyEnsemblePanel() {
  const { watchlist } = useMarketData();
  const { getCandles } = useCandles();
  const { getOrderFlow } = useOrderFlow();
  const { getSnapshot } = useMultiExchange();

  if (watchlist.length === 0) {
    return <p className="text-[11px] text-txt2">No watchlist symbols to analyze.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      {watchlist.map((item) => {
        const primary = getCandles(item.symbol, '1h');
        const ctx = primary && primary.candles.length > 0 ? buildStrategyContext(item, primary.candles, getCandles, getOrderFlow(item.symbol)) : null;

        if (!ctx) {
          return (
            <div key={item.symbol} className="border-b border-line pb-2 last:border-0 last:pb-0">
              <p className="font-mono text-[11px] text-txt1 mb-1">{item.symbol}</p>
              <p className="text-[10px] font-mono text-txt2">Loading data…</p>
            </div>
          );
        }

        const result = runStrategyEnsembleGated(ctx, getSnapshot(item.symbol) ?? null);
        const color = result.consensus === 'BUY' ? 'text-green' : result.consensus === 'SELL' ? 'text-red' : 'text-txt2';
        const buyCount = result.signals.filter((s) => s.signal === 'BUY').length;
        const sellCount = result.signals.filter((s) => s.signal === 'SELL').length;
        const holdCount = result.signals.filter((s) => s.signal === 'HOLD').length;

        return (
          <div key={item.symbol} className="border-b border-line pb-2 last:border-0 last:pb-0">
            <p className="font-mono text-[11px] text-txt1 mb-1">{item.symbol}</p>
            <p className={`text-[11px] font-mono font-bold ${color}`}>
              {result.consensus}
              {result.consensus !== 'HOLD' && <span className="text-txt2 font-normal"> · {result.confidencePct.toFixed(0)}%</span>}
            </p>
            <p className="text-[9.5px] font-mono text-txt2">
              {buyCount} BUY · {sellCount} SELL · {holdCount} HOLD across 9 agents
            </p>
          </div>
        );
      })}
      <p className="text-[9.5px] text-txt2">
        9 rule-based agents (Trend, Momentum, Scalping, Swing, Mean Reversion, Breakout, Range, Grid, Arbitrage) vote
        independently. Consensus is confidence-weighted between BUY/SELL only. One input among many — not a trade
        instruction.
      </p>
      <div className="border-t border-line pt-2 flex flex-col gap-1">
        <p className="text-[9.5px] font-mono text-txt1">Execution still planned (they vote above using real data, but this app can&apos;t act on their specific strategy):</p>
        {PLANNED_AGENTS.map((p) => (
          <p key={p.agent} className="text-[9.5px] font-mono text-txt2" title={p.reason}>
            <span className="text-amber">{p.agent}</span> — Planned ({p.complexity} complexity, {p.plannedVersion})
          </p>
        ))}
      </div>
    </div>
  );
}
