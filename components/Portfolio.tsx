'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { loadLS, saveLS, LS_KEYS } from '@/lib/storage';
import { DEFAULT_PORTFOLIO } from '@/lib/types';
import type { PortfolioState, Position, TradeLogEntry, TradeSide, TradeTab } from '@/lib/types';

type PortfolioValue = {
  portfolio: PortfolioState;
  tradeLog: TradeLogEntry[];
  tradeLogLoaded: boolean;
  buyPaper: (symbol: string, qty: number, price: number, leverage?: number, entryContext?: string, debateId?: string, originTag?: TradeLogEntry['originTag']) => boolean;
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

  // THE PORTFOLIO IS NOW SERVER-BACKED, with localStorage kept as the fallback.
  //
  // It used to be client-local on the reasoning that "there's no need for another
  // application to reach in and change your open positions directly". True, but it
  // also meant clearing site data or opening the app on another machine lost the
  // entire book — and the equity every risk check measures against with it.
  //
  // localStorage is written FIRST and synchronously on every change, which keeps
  // `getPortfolioSnapshot()` able to see a trade made earlier in the same
  // synchronous batch. The server write is fire-and-forget on top of that; making
  // the mutators await it would break that guarantee.
  useEffect(() => {
    // Read the local copy immediately so the first render has a book, then let the
    // server correct it if it has one.
    const local = loadLS<PortfolioState>(LS_KEYS.portfolio, DEFAULT_PORTFOLIO);
    portfolioRef.current = local;
    setPortfolio(local);
    setHydrated(true);
    refreshTradeLog();

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/portfolio');
        const json = (await res.json()) as { portfolio: PortfolioState | null; source?: string };
        // `null` means NO DATABASE, not an empty book. Overwriting the local copy
        // with an empty one here would wipe a portfolio because a database was
        // absent — a data loss that looks like a successful read.
        if (cancelled || !json.portfolio) return;
        portfolioRef.current = json.portfolio;
        setPortfolio(json.portfolio);
        saveLS(LS_KEYS.portfolio, json.portfolio);
      } catch {
        // Offline or no route — the local copy already loaded above stands.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveLS(LS_KEYS.portfolio, portfolio);
    // Mirror to the server. A failure is logged rather than surfaced: the local
    // copy is already correct, so a dropped sync degrades durability, not
    // correctness, and blocking a trade on it would be worse.
    fetch('/api/portfolio', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolio }),
    }).catch(() => {});
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

  function buyPaper(symbol: string, qty: number, price: number, leverage?: number, entryContext?: string, debateId?: string, originTag?: TradeLogEntry['originTag']): boolean {
    if (!qty || qty <= 0 || !price) return false;
    const prev = portfolioRef.current;
    const notional = qty * price;
    const marginRequired = leverage && leverage > 0 ? notional / leverage : notional;
    if (marginRequired > prev.paper.cash) return false;
    const positions = [...prev.paper.positions];
    const idx = positions.findIndex((p) => p.symbol === symbol);
    if (idx >= 0) {
      const ex = positions[idx];
      const newQty = ex.qty + qty;
      const newAvg = (ex.qty * ex.avgCost + notional) / newQty;
      const newMargin = (ex.marginLocked ?? (ex.qty * ex.avgCost)) + marginRequired;
      positions[idx] = { ...ex, qty: newQty, avgCost: newAvg, marginLocked: newMargin };
    } else {
      positions.push({ symbol, qty, avgCost: price, marginLocked: marginRequired });
    }
    const next = { ...prev, paper: { cash: prev.paper.cash - marginRequired, positions } };
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
    const remainingQty = ex.qty - qty;
    const proportionClosed = qty / ex.qty;
    const marginReleased = (ex.marginLocked ?? (ex.qty * ex.avgCost)) * proportionClosed;
    
    const positions =
      remainingQty > 0.0000001
        ? prev.paper.positions.map((p, i) => (i === idx ? { ...p, qty: remainingQty, marginLocked: (p.marginLocked ?? (p.qty * p.avgCost)) - marginReleased } : p))
        : prev.paper.positions.filter((_, i) => i !== idx);
    const next = { ...prev, paper: { cash: prev.paper.cash + marginReleased + realizedPnl, positions } };
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
