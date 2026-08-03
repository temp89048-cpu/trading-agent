'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { Candle } from '@/lib/indicators';
import type { WatchItem } from '@/lib/types';
import { useMarketData } from './MarketData';

type CacheEntry = { candles: Candle[]; fetchedAt: number; loading: boolean; error?: string };

type CandlesValue = {
  getCandles: (symbol: string, interval: string) => CacheEntry | undefined;
  ensureCandles: (item: WatchItem, interval: string, limit?: number) => void;
};

const CandlesContext = createContext<CandlesValue | null>(null);

export function useCandles(): CandlesValue {
  const ctx = useContext(CandlesContext);
  if (!ctx) throw new Error('useCandles must be used within CandlesProvider');
  return ctx;
}

function key(symbol: string, interval: string): string {
  return `${symbol}|${interval}`;
}

// These are the timeframes automatically kept fresh in the background
// for every watchlist symbol, so chat requests never have to wait on a
// fetch — the chart component can additionally request any other
// interval on demand via ensureCandles.
const DEFAULT_TIMEFRAMES = ['1h', '4h'];
const REFRESH_MS = 60_000;
const STALE_MS = 55_000; // slightly under REFRESH_MS so ensureCandles doesn't skip a fetch the background loop is about to do anyway

// Multi-Timeframe Analyzer (Commit 8) needs 1m/5m/15m/1h/4h/1d/1w per
// symbol. 1h/4h are already covered by DEFAULT_TIMEFRAMES above; this
// adds the rest. Refreshed on a much slower cadence than the 60s loop
// above — a daily or weekly bar's trend doesn't change minute to
// minute, and there's no reason to hammer Binance/Yahoo for bars that
// are mostly still forming. 1m/5m/15m do benefit from staying fresher,
// so they're included here too rather than left fully static.
const MTF_ONLY_TIMEFRAMES = ['1m', '5m', '15m', '1d', '1w'];
const MTF_REFRESH_MS = 5 * 60_000;

export function CandlesProvider({ children }: { children: React.ReactNode }) {
  const { watchlist } = useMarketData();
  const [cache, setCache] = useState<Record<string, CacheEntry>>({});
  const cacheRef = useRef(cache);
  cacheRef.current = cache;
  const inFlightRef = useRef<Set<string>>(new Set());

  async function fetchAndCache(item: WatchItem, interval: string, limit = 200) {
    const k = key(item.symbol, interval);
    if (inFlightRef.current.has(k)) return;
    inFlightRef.current.add(k);
    setCache((prev) => ({ ...prev, [k]: { ...(prev[k] ?? { candles: [], fetchedAt: 0 }), loading: true } }));
    try {
      const apiSymbol = item.type === 'crypto' ? item.binance ?? item.symbol.replace('/', '') : item.symbol;
      const res = await fetch(`/api/candles?symbol=${encodeURIComponent(apiSymbol)}&type=${item.type}&interval=${interval}&limit=${limit}`);
      const json = await res.json();
      if (json.error) throw new Error(json.error);
      setCache((prev) => ({ ...prev, [k]: { candles: json.candles ?? [], fetchedAt: Date.now(), loading: false } }));
    } catch (err) {
      setCache((prev) => ({
        ...prev,
        [k]: { candles: prev[k]?.candles ?? [], fetchedAt: prev[k]?.fetchedAt ?? 0, loading: false, error: err instanceof Error ? err.message : 'fetch failed' },
      }));
    } finally {
      inFlightRef.current.delete(k);
    }
  }

  function ensureCandles(item: WatchItem, interval: string, limit = 200) {
    const k = key(item.symbol, interval);
    const entry = cacheRef.current[k];
    if (entry && Date.now() - entry.fetchedAt < STALE_MS && !entry.error) return;
    fetchAndCache(item, interval, limit);
  }

  function getCandles(symbol: string, interval: string): CacheEntry | undefined {
    return cache[key(symbol, interval)];
  }

  // Background refresh for every watchlist symbol's default timeframes —
  // this is what lets a chat message include real indicator values
  // immediately, without making the user wait on a fetch mid-conversation.
  useEffect(() => {
    function refreshAll() {
      for (const item of watchlist) {
        for (const tf of DEFAULT_TIMEFRAMES) {
          ensureCandles(item, tf);
        }
      }
    }
    refreshAll();
    const iv = setInterval(refreshAll, REFRESH_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist.map((w) => w.symbol).join(',')]);

  // Slower-cadence background refresh for the remaining Multi-Timeframe
  // Analyzer intervals (see MTF_ONLY_TIMEFRAMES above). Kept as a
  // separate effect/interval so a chart or indicator panel wanting
  // fast 1h/4h isn't held back by this, and this loop isn't sped up by
  // touching the fast one.
  useEffect(() => {
    function refreshMtf() {
      for (const item of watchlist) {
        for (const tf of MTF_ONLY_TIMEFRAMES) {
          ensureCandles(item, tf);
        }
      }
    }
    refreshMtf();
    const iv = setInterval(refreshMtf, MTF_REFRESH_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchlist.map((w) => w.symbol).join(',')]);

  const value: CandlesValue = { getCandles, ensureCandles };
  return <CandlesContext.Provider value={value}>{children}</CandlesContext.Provider>;
}
