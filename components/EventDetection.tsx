'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { WatchItem } from '@/lib/types';
import { detectMarketEvents, type MarketEvent, type FundingRatePoint, type OiPoint } from '@/lib/eventDetection';
import { useMarketData } from './MarketData';
import { useCandles } from './Candles';

type EventDetectionValue = {
  getEvents: (symbol: string) => MarketEvent[];
  getAllEvents: () => Record<string, MarketEvent[]>;
  refreshing: boolean;
};

const EventDetectionContext = createContext<EventDetectionValue | null>(null);

export function useEventDetection(): EventDetectionValue {
  const ctx = useContext(EventDetectionContext);
  if (!ctx) throw new Error('useEventDetection must be used within EventDetectionProvider');
  return ctx;
}

// Same reasoning as MarketIntel/MultiExchange: these are "check
// periodically" signals, not tick-rate ones. A funding settlement only
// happens every ~8h and OI history only updates every 5m on Binance's
// own endpoint, so polling faster than that buys nothing.
const REFRESH_MS = 5 * 60_000;

export function EventDetectionProvider({ children }: { children: React.ReactNode }) {
  const { watchlist } = useMarketData();
  const { getCandles } = useCandles();
  const [history, setHistory] = useState<Record<string, { fundingHistory: FundingRatePoint[]; oiHistory: OiPoint[] }>>({});
  const [refreshing, setRefreshing] = useState(false);
  const inFlightRef = useRef<Set<string>>(new Set());

  async function refreshOne(item: WatchItem) {
    if (inFlightRef.current.has(item.symbol)) return;
    inFlightRef.current.add(item.symbol);
    try {
      const binanceSymbol = item.binance ?? item.symbol.replace('/', '');
      const res = await fetch(`/api/eventdata?binance=${encodeURIComponent(binanceSymbol)}`);
      const json = await res.json();
      setHistory((prev) => ({ ...prev, [item.symbol]: { fundingHistory: json.fundingHistory ?? [], oiHistory: json.oiHistory ?? [] } }));
    } catch {
      // Leave the cache as-is on a failed refresh, same standard as
      // every other polling hook in this app.
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

  function computeEvents(item: WatchItem): MarketEvent[] {
    const primary = getCandles(item.symbol, '1h');
    if (!primary || primary.candles.length === 0) return [];
    const h = history[item.symbol];

    // Best-effort price-change-over-the-OI-window read, using whatever
    // 5m candles are already cached by the multi-timeframe analyzer
    // (Commit 8) — if they're not loaded yet, this honestly reads as
    // "unknown direction" inside detectOiDelta rather than guessing.
    let priceChangePctOverOiWindow: number | null = null;
    if (h?.oiHistory && h.oiHistory.length >= 2) {
      const fiveMin = getCandles(item.symbol, '5m');
      if (fiveMin && fiveMin.candles.length >= 2) {
        const first = fiveMin.candles[0].c;
        const last = fiveMin.candles[fiveMin.candles.length - 1].c;
        if (first > 0) priceChangePctOverOiWindow = ((last - first) / first) * 100;
      }
    }

    return detectMarketEvents({
      symbol: item.symbol,
      assetType: item.type,
      candles: primary.candles,
      fundingHistory: h?.fundingHistory,
      oiHistory: h?.oiHistory,
      priceChangePctOverOiWindow,
    });
  }

  const value: EventDetectionValue = {
    getEvents: (symbol) => {
      const item = watchlist.find((w) => w.symbol === symbol);
      return item ? computeEvents(item) : [];
    },
    getAllEvents: () => {
      const out: Record<string, MarketEvent[]> = {};
      for (const item of watchlist) out[item.symbol] = computeEvents(item);
      return out;
    },
    refreshing,
  };

  return <EventDetectionContext.Provider value={value}>{children}</EventDetectionContext.Provider>;
}
