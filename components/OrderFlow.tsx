'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { WatchItem } from '@/lib/types';
import type { RawOrderFlowData } from '@/lib/orderFlow';
import { checkCapability } from '@/lib/providerCapabilities';
import { useMarketData } from './MarketData';

type CacheEntry = { data: RawOrderFlowData; fetchedAt: number; loading: boolean; error?: string };

type OrderFlowValue = {
  getOrderFlow: (symbol: string) => RawOrderFlowData | undefined;
};

const OrderFlowContext = createContext<OrderFlowValue | null>(null);

export function useOrderFlow(): OrderFlowValue {
  const ctx = useContext(OrderFlowContext);
  if (!ctx) throw new Error('useOrderFlow must be used within OrderFlowProvider');
  return ctx;
}

// Order flow moves fast — resting book depth and the recent trade tape
// are only meaningful within a short window, unlike a daily candle. 20s
// is frequent enough to stay useful without hammering Binance's public
// endpoints (these are cheap REST calls, not a websocket firehose).
const REFRESH_MS = 20_000;

export function OrderFlowProvider({ children }: { children: React.ReactNode }) {
  const { watchlist } = useMarketData();
  const [cache, setCache] = useState<Record<string, CacheEntry>>({});
  const inFlightRef = useRef<Set<string>>(new Set());

  async function fetchAndCache(item: WatchItem) {
    if (inFlightRef.current.has(item.symbol)) return;
    inFlightRef.current.add(item.symbol);
    try {
      const binanceSymbol = item.binance ?? item.symbol.replace('/', '');
      const res = await fetch(`/api/orderflow?binance=${encodeURIComponent(binanceSymbol)}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setCache((prev) => ({ ...prev, [item.symbol]: { data: json, fetchedAt: Date.now(), loading: false } }));
    } catch (err) {
      setCache((prev) => ({
        ...prev,
        [item.symbol]: {
          data: prev[item.symbol]?.data ?? { bids: [], asks: [], trades: [] },
          fetchedAt: prev[item.symbol]?.fetchedAt ?? 0,
          loading: false,
          error: err instanceof Error ? err.message : 'fetch failed',
        },
      }));
    } finally {
      inFlightRef.current.delete(item.symbol);
    }
  }

  function getOrderFlow(symbol: string): RawOrderFlowData | undefined {
    return cache[symbol]?.data;
  }

  // Only fetch for symbols the Provider Manager says actually support
  // order flow data — no point polling Binance's endpoints for an
  // equity symbol that will never have one, and no risk of accidentally
  // sending an equity ticker to a crypto-only endpoint.
  useEffect(() => {
    function refreshAll() {
      for (const item of watchlist) {
        if (checkCapability(item, 'orderBook').supported) fetchAndCache(item);
      }
    }
    refreshAll();
    const iv = setInterval(refreshAll, REFRESH_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist.map((w) => w.symbol).join(',')]);

  const value: OrderFlowValue = { getOrderFlow };
  return <OrderFlowContext.Provider value={value}>{children}</OrderFlowContext.Provider>;
}
