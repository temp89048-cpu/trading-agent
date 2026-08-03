'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { WatchItem } from '@/lib/types';
import type { MultiExchangeSnapshot } from '@/lib/multiExchange';
import { useMarketData } from './MarketData';

type MultiExchangeValue = {
  getSnapshot: (symbol: string) => MultiExchangeSnapshot | undefined;
  getAllSnapshots: () => Record<string, MultiExchangeSnapshot | undefined>;
  refreshing: boolean;
};

const MultiExchangeContext = createContext<MultiExchangeValue | null>(null);

export function useMultiExchange(): MultiExchangeValue {
  const ctx = useContext(MultiExchangeContext);
  if (!ctx) throw new Error('useMultiExchange must be used within MultiExchangeProvider');
  return ctx;
}

// Prices across 5 venues don't need tick-rate polling — a spread that
// matters persists for more than a few seconds, and hammering 4 extra
// public REST hosts on every tick would be its own kind of irresponsible
// free-tier usage. Same 5-minute cadence as MarketIntel's derivatives
// refresh, since both are "check periodically, not continuously" data.
const REFRESH_MS = 5 * 60_000;

export function MultiExchangeProvider({ children }: { children: React.ReactNode }) {
  const { watchlist } = useMarketData();
  const [snapshots, setSnapshots] = useState<Record<string, MultiExchangeSnapshot>>({});
  const [refreshing, setRefreshing] = useState(false);
  const inFlightRef = useRef<Set<string>>(new Set());

  async function refreshOne(item: WatchItem) {
    if (inFlightRef.current.has(item.symbol)) return;
    inFlightRef.current.add(item.symbol);
    try {
      const binanceSymbol = item.binance ?? item.symbol.replace('/', '');
      const res = await fetch(`/api/multiexchange?symbol=${encodeURIComponent(item.symbol)}&binance=${encodeURIComponent(binanceSymbol)}`);
      const json = await res.json();
      if (json.quotes) setSnapshots((prev) => ({ ...prev, [item.symbol]: json }));
    } catch {
      // Same standard as candles/order-flow/market-intel: leave the
      // cache as-is on a failed refresh rather than clearing good data.
    } finally {
      inFlightRef.current.delete(item.symbol);
    }
  }

  useEffect(() => {
    async function refreshAll() {
      const cryptoItems = watchlist.filter((w) => w.type === 'crypto');
      if (cryptoItems.length === 0) return;
      setRefreshing(true);
      await Promise.all(cryptoItems.map(refreshOne));
      setRefreshing(false);
    }
    refreshAll();
    const iv = setInterval(refreshAll, REFRESH_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist.map((w) => w.symbol).join(',')]);

  const value: MultiExchangeValue = {
    getSnapshot: (symbol) => snapshots[symbol],
    getAllSnapshots: () => snapshots,
    refreshing,
  };

  return <MultiExchangeContext.Provider value={value}>{children}</MultiExchangeContext.Provider>;
}
