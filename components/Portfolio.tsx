'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { loadLS, saveLS, LS_KEYS } from '@/lib/storage';
import { DEFAULT_PORTFOLIO } from '@/lib/types';
import type { PortfolioState, Position, TradeLogEntry, TradeSide, TradeTab } from '@/lib/types';

type PortfolioValue = {
  portfolio: PortfolioState;
  tradeLog: TradeLogEntry[];
  tradeLogLoaded: boolean;
  buyPaper: (symbol: string, qty: number, price: number, entryContext?: string, debateId?: string, originTag?: TradeLogEntry['originTag']) => boolean;
  sellPaper: (symbol: string, qty: number, price: number) => boolean;
  addRealPosition: (symbol: string, qty: number, avgCost: number, entryContext?: string, debateId?: string, originTag?: TradeLogEntry['originTag'], exchangeOrderId?: string) => void;
  removeRealPosition: (symbol: string, exitPrice?: number, exchangeOrderId?: string) => void;
  deleteTradeLogEntry: (id: string) => Promise<void>;
  restorePortfolio: (p: PortfolioState) => void;
  restoreTradeLog: (log: TradeLogEntry[]) => void;
  // Synchronous "as of right now" read, including any buy/sell already
  // executed earlier in the SAME synchronous call stack (e.g. several
  // agent tasks opening/closing within one tick). `portfolio` (the React
  // state value above) only updates on next render, so a risk check that
  // reads it mid-batch would see stale exposure/positions and could
  // approve several trades against the same pre-batch headroom. See
  // components/Agent.tsx's tasksRef for the same pattern applied to tasks.
  getPortfolioSnapshot: () => PortfolioState;
};

const PortfolioContext = createContext<PortfolioValue | null>(null);

export function usePortfolio(): PortfolioValue {
  const ctx = useContext(PortfolioContext);
  if (!ctx) throw new Error('usePortfolio must be used within PortfolioProvider');
  return ctx;
}

export function PortfolioProvider({ children }: { children: React.ReactNode }) {
  const [portfolio, setPortfolio] = useState<PortfolioState>(DEFAULT_PORTFOLIO);
  const [tradeLog, setTradeLog] = useState<TradeLogEntry[]>([]);
  const [tradeLogLoaded, setTradeLogLoaded] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Authoritative synchronous truth — every mutator below reads and
  // writes this ref directly (never a setState functional updater, whose
  // callback only runs when React processes the queue, not immediately),
  // then calls setPortfolio(next) with the resulting plain value purely
  // to trigger a re-render. This is what lets getPortfolioSnapshot() see
  // every trade already executed earlier in the same synchronous batch.
  const portfolioRef = useRef<PortfolioState>(portfolio);
  function getPortfolioSnapshot(): PortfolioState {
    return portfolioRef.current;
  }

  // Portfolio (current holdings/cash) stays a simple client-local value —
  // there's no need for another application to reach in and change your
  // open positions directly. The trade LOG (append-only history of what
  // happened) is the thing you asked to reach from another application,
  // so that's server-backed via /api/trades — see lib/tradeStore.server.ts.
  useEffect(() => {
    const loaded = loadLS<PortfolioState>(LS_KEYS.portfolio, DEFAULT_PORTFOLIO);
    portfolioRef.current = loaded;
    setPortfolio(loaded);
    setHydrated(true);
    refreshTradeLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (hydrated) saveLS(LS_KEYS.portfolio, portfolio);
  }, [portfolio, hydrated]);

  async function refreshTradeLog() {
    try {
      const res = await fetch('/api/trades');
      const json = await res.json();
      if (Array.isArray(json.trades)) setTradeLog(json.trades);
    } catch {
      // server not reachable — keep whatever's already in state
    } finally {
      setTradeLogLoaded(true);
    }
  }

  async function logTrade(tab: TradeTab, symbol: string, side: TradeSide, qty: number, price: number, note?: string, pnl?: number, entryContext?: string, debateId?: string, originTag?: TradeLogEntry['originTag'], exchangeOrderId?: string) {
    // Optimistic local append so the UI feels instant, then reconcile
    // with the server's assigned id/timestamp once the POST resolves.
    const optimistic: TradeLogEntry = { id: `pending-${Date.now()}`, ts: Date.now(), tab, symbol, side, qty, price, note, pnl, entryContext, debateId, originTag, exchangeOrderId };
    setTradeLog((prev) => [optimistic, ...prev]);
    try {
      const res = await fetch('/api/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tab, symbol, side, qty, price, note, pnl, entryContext, debateId, originTag, exchangeOrderId }),
      });
      const json = await res.json();
      if (json.trade) {
        setTradeLog((prev) => prev.map((t) => (t.id === optimistic.id ? json.trade : t)));
        if (side === 'buy' && debateId) {
          // Fire-and-forget link — this only wires the debate record's
          // tradeId for later outcome tracking; it never blocks or can
          // fail the trade itself.
          fetch('/api/debate', {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ debateId, tradeId: json.trade.id }),
          }).catch(() => {});
        }
      }
    } catch {
      // Left as the optimistic entry — better than silently losing the
      // fact that a trade happened. It just won't have a server id yet.
    }
  }

  async function deleteTradeLogEntry(id: string) {
    setTradeLog((prev) => prev.filter((t) => t.id !== id)); // optimistic
    try {
      await fetch(`/api/trades/${id}`, { method: 'DELETE' });
    } catch {
      // if this fails, the next refreshTradeLog() call will bring it back
      // (server is the source of truth), which is the honest outcome —
      // silently pretending a delete worked when it didn't is worse.
    }
  }

  function buyPaper(symbol: string, qty: number, price: number, entryContext?: string, debateId?: string, originTag?: TradeLogEntry['originTag']): boolean {
    if (!qty || qty <= 0 || !price) return false;
    const prev = portfolioRef.current;
    const cost = qty * price;
    if (cost > prev.paper.cash) return false;
    const positions = [...prev.paper.positions];
    const idx = positions.findIndex((p) => p.symbol === symbol);
    if (idx >= 0) {
      const ex = positions[idx];
      const newQty = ex.qty + qty;
      const newAvg = (ex.qty * ex.avgCost + cost) / newQty;
      positions[idx] = { ...ex, qty: newQty, avgCost: newAvg };
    } else {
      positions.push({ symbol, qty, avgCost: price });
    }
    const next = { ...prev, paper: { cash: prev.paper.cash - cost, positions } };
    portfolioRef.current = next;
    setPortfolio(next);
    logTrade('paper', symbol, 'buy', qty, price, undefined, undefined, entryContext, debateId, originTag);
    return true;
  }

  function sellPaper(symbol: string, qty: number, price: number): boolean {
    if (!qty || qty <= 0 || !price) return false;
    const prev = portfolioRef.current;
    const idx = prev.paper.positions.findIndex((p) => p.symbol === symbol);
    if (idx < 0 || prev.paper.positions[idx].qty < qty) return false;
    const ex = prev.paper.positions[idx];
    const realizedPnl = (price - ex.avgCost) * qty;
    const remaining = ex.qty - qty;
    const positions =
      remaining > 0.0000001
        ? prev.paper.positions.map((p, i) => (i === idx ? { ...p, qty: remaining } : p))
        : prev.paper.positions.filter((_, i) => i !== idx);
    const next = { ...prev, paper: { cash: prev.paper.cash + qty * price, positions } };
    portfolioRef.current = next;
    setPortfolio(next);
    logTrade('paper', symbol, 'sell', qty, price, undefined, realizedPnl);
    return true;
  }

  function addRealPosition(symbol: string, qty: number, avgCost: number, entryContext?: string, debateId?: string, originTag?: TradeLogEntry['originTag'], exchangeOrderId?: string) {
    if (!symbol || !qty || !avgCost) return;
    const prev = portfolioRef.current;
    const next = { ...prev, real: { positions: [...prev.real.positions, { symbol, qty, avgCost }] } };
    portfolioRef.current = next;
    setPortfolio(next);
    logTrade('real', symbol, 'buy', qty, avgCost, exchangeOrderId ? `filled by real order ${exchangeOrderId}` : 'ledger entry added', undefined, entryContext, debateId, originTag, exchangeOrderId);
  }

  // Closing a real position now takes (or defaults to, via the caller
  // passing a live tick) an exit price, so realized P&L is a real number
  // instead of always computing to zero.
  function removeRealPosition(symbol: string, exitPrice?: number, exchangeOrderId?: string) {
    const prev = portfolioRef.current;
    const existing = prev.real.positions.find((p) => p.symbol === symbol);
    const next = { ...prev, real: { positions: prev.real.positions.filter((p) => p.symbol !== symbol) } };
    portfolioRef.current = next;
    setPortfolio(next);
    if (existing) {
      const price = exitPrice ?? existing.avgCost;
      const pnl = (price - existing.avgCost) * existing.qty;
      logTrade('real', symbol, 'sell', existing.qty, price, exchangeOrderId ? `filled by real order ${exchangeOrderId}` : 'ledger entry removed', pnl, undefined, undefined, undefined, exchangeOrderId);
    }
  }

  function restorePortfolio(p: PortfolioState) {
    portfolioRef.current = p;
    setPortfolio(p);
  }

  // Restoring a trade-log backup re-POSTs each entry to the server store
  // (skipping ones whose id already exists there) so an imported backup
  // and the server-backed log stay consistent, rather than only living
  // in local state and disappearing on next refresh.
  async function restoreTradeLog(log: TradeLogEntry[]) {
    setTradeLog(log);
    try {
      const res = await fetch('/api/trades');
      const json = await res.json();
      const existingIds = new Set<string>((json.trades ?? []).map((t: TradeLogEntry) => t.id));
      for (const entry of log) {
        if (existingIds.has(entry.id)) continue;
        await fetch('/api/trades', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tab: entry.tab, symbol: entry.symbol, side: entry.side, qty: entry.qty, price: entry.price, note: entry.note, pnl: entry.pnl, entryContext: entry.entryContext, debateId: entry.debateId }),
        }).catch(() => {});
      }
      refreshTradeLog();
    } catch {
      // server unreachable — local state above still reflects the import
    }
  }

  const value: PortfolioValue = {
    portfolio, tradeLog, tradeLogLoaded, buyPaper, sellPaper, addRealPosition, removeRealPosition,
    deleteTradeLogEntry, restorePortfolio, restoreTradeLog, getPortfolioSnapshot,
  };
  return <PortfolioContext.Provider value={value}>{children}</PortfolioContext.Provider>;
}

export function positionValue(p: Position, price: number | undefined): number {
  return p.qty * (price ?? p.avgCost);
}
