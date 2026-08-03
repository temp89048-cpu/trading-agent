'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { WatchItem } from '@/lib/types';
import type { NewsItem, FearGreedPoint, DerivativesSnapshot } from '@/lib/sentimentAgent';
import { checkCapability } from '@/lib/providerCapabilities';
import { useMarketData } from './MarketData';

type MarketIntelValue = {
  getNews: () => NewsItem[];
  getFearGreed: () => FearGreedPoint | undefined;
  getDerivatives: (symbol: string) => DerivativesSnapshot | undefined;
  aggregatorNote: string | null;
};

const MarketIntelContext = createContext<MarketIntelValue | null>(null);

export function useMarketIntel(): MarketIntelValue {
  const ctx = useContext(MarketIntelContext);
  if (!ctx) throw new Error('useMarketIntel must be used within MarketIntelProvider');
  return ctx;
}

// News + Fear & Greed don't move fast enough to justify hammering the
// free-tier aggregators or RSS hosts — 5 minutes matches the existing
// NewsPanel's own cadence. Derivatives (funding/OI/ratios) refresh on
// the same cycle; they're not tick-by-tick data either.
const REFRESH_MS = 5 * 60_000;

export function MarketIntelProvider({ children }: { children: React.ReactNode }) {
  const { watchlist } = useMarketData();
  const [news, setNews] = useState<NewsItem[]>([]);
  const [fearGreed, setFearGreed] = useState<FearGreedPoint | undefined>(undefined);
  const [derivatives, setDerivatives] = useState<Record<string, DerivativesSnapshot>>({});
  const [aggregatorNote, setAggregatorNote] = useState<string | null>(null);
  const inFlightRef = useRef<Set<string>>(new Set());

  async function refreshNews() {
    try {
      const res = await fetch('/api/news');
      const json = await res.json();
      if (json.items) setNews(json.items);
      if (json.aggregatorNote) setAggregatorNote(json.aggregatorNote);
    } catch {
      // Fail quietly here — NewsPanel already surfaces a fetch-error
      // state to the user; this cache just keeps whatever it last had.
    }
  }

  async function refreshDerivatives(item: WatchItem) {
    if (inFlightRef.current.has(item.symbol)) return;
    inFlightRef.current.add(item.symbol);
    try {
      const binanceSymbol = item.binance ?? item.symbol.replace('/', '');
      const res = await fetch(`/api/marketintel?binance=${encodeURIComponent(binanceSymbol)}`);
      const json = await res.json();
      if (json.fearGreed?.current) setFearGreed(json.fearGreed.current);
      if (json.derivatives) setDerivatives((prev) => ({ ...prev, [item.symbol]: json.derivatives }));
    } catch {
      // Same as candles/order-flow: leave the cache as-is on failure
      // rather than clearing good data because of one bad fetch.
    } finally {
      inFlightRef.current.delete(item.symbol);
    }
  }

  useEffect(() => {
    refreshNews();
    const iv = setInterval(refreshNews, REFRESH_MS);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    function refreshAll() {
      for (const item of watchlist) {
        // Only crypto has funding/OI data at all (see DATA CAPABILITIES)
        // — no point calling a Binance-only endpoint for an equity ticker.
        if (checkCapability(item, 'fundingRate').supported) refreshDerivatives(item);
      }
    }
    refreshAll();
    const iv = setInterval(refreshAll, REFRESH_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist.map((w) => w.symbol).join(',')]);

  const value: MarketIntelValue = {
    getNews: () => news,
    getFearGreed: () => fearGreed,
    getDerivatives: (symbol) => derivatives[symbol],
    aggregatorNote,
  };
  return <MarketIntelContext.Provider value={value}>{children}</MarketIntelContext.Provider>;
}
