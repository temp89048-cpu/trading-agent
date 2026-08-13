'use client';

import { useEffect, useState } from 'react';
import { useAgentWebSocket } from '@/lib/useAgentWebSocket';

type Trade = {
  id: string;
  ts: number;
  tab: string;
  symbol: string;
  side: string;
  qty: number;
  price: number;
  pnl?: number;
};

export function TradeHistoryTable() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const { events } = useAgentWebSocket();
  const [isLoading, setIsLoading] = useState(true);

  const fetchTrades = async () => {
    try {
      const res = await fetch('http://127.0.0.1:8000/api/trades?limit=20');
      const data = await res.json();
      if (data.status === 'success') {
        setTrades(data.trades);
      }
    } catch (err) {
      console.error('Failed to fetch trades', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTrades();
  }, []);

  // When an ORDER_FILLED event happens over WS, refresh the table
  useEffect(() => {
    const hasNewOrder = events.some(e => e.event_type === 'ORDER_FILLED' && (Date.now() - new Date(e.timestamp).getTime() < 2000));
    if (hasNewOrder) {
      fetchTrades();
    }
  }, [events]);

  return (
    <div className="glass-panel rounded-xl flex flex-col h-full min-h-[300px] overflow-hidden">
      <div className="px-4 py-3 border-b border-white/5 bg-bg1/40 flex justify-between items-center">
        <div className="font-semibold tracking-wide text-sm">Execution History</div>
      </div>
      
      <div className="flex-1 overflow-auto p-4 custom-scrollbar">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-txt2/50 italic text-xs">
            Loading trades...
          </div>
        ) : trades.length === 0 ? (
          <div className="flex items-center justify-center h-full text-txt2/50 italic text-xs">
            No trades executed yet.
          </div>
        ) : (
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="text-[10px] text-txt2 uppercase tracking-wider border-b border-white/5">
                <th className="pb-2 font-medium">Time</th>
                <th className="pb-2 font-medium">Symbol</th>
                <th className="pb-2 font-medium">Side</th>
                <th className="pb-2 font-medium text-right">Price</th>
                <th className="pb-2 font-medium text-right">Size</th>
                <th className="pb-2 font-medium text-right">PnL</th>
              </tr>
            </thead>
            <tbody className="text-xs">
              {trades.map(trade => (
                <tr key={trade.id} className="border-b border-white/5 last:border-0 hover:bg-white/[0.02] transition-colors">
                  <td className="py-2.5 text-txt1">
                    {new Date(trade.ts).toLocaleTimeString([], { hour12: false })}
                  </td>
                  <td className="py-2.5 font-mono text-txt0">{trade.symbol}</td>
                  <td className="py-2.5 font-bold">
                    <span className={trade.side.toLowerCase() === 'buy' ? 'text-green' : 'text-red'}>
                      {trade.side.toUpperCase()}
                    </span>
                  </td>
                  <td className="py-2.5 text-right font-mono">{trade.price.toFixed(2)}</td>
                  <td className="py-2.5 text-right font-mono text-txt1">{trade.qty}</td>
                  <td className={`py-2.5 text-right font-mono ${trade.pnl ? (trade.pnl > 0 ? 'text-green' : 'text-red') : 'text-txt2'}`}>
                    {trade.pnl ? (trade.pnl > 0 ? '+' : '') + trade.pnl.toFixed(2) : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
