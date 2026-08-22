'use client';

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { loadLS, saveLS, LS_KEYS } from '@/lib/storage';
import { DEFAULT_WATCHLIST } from '@/lib/constants';
import type { Tick, WatchItem } from '@/lib/types';

type FlashDir = 'up' | 'down' | null;

type MarketDataValue = {
  watchlist: WatchItem[];
  setWatchlist: (updater: WatchItem[] | ((w: WatchItem[]) => WatchItem[])) => void;
  ticks: Record<string, Tick>;
  flash: Record<string, FlashDir>;
  quoteApiError: string | null;
};

const MarketDataContext = createContext<MarketDataValue | null>(null);

export function useMarketData(): MarketDataValue {
  const ctx = useContext(MarketDataContext);
  if (!ctx) throw new Error('useMarketData must be used within MarketDataProvider');
  return ctx;
}

const EQUITY_POLL_MS = 8000;
const FLASH_MS = 700;

export function MarketDataProvider({ children }: { children: React.ReactNode }) {
  const [watchlist, setWatchlistState] = useState<WatchItem[]>(DEFAULT_WATCHLIST);
  const [ticks, setTicks] = useState<Record<string, Tick>>({});
  const [flash, setFlash] = useState<Record<string, FlashDir>>({});
  const [quoteApiError, setQuoteApiError] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  const flashTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const simTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Local copy first so the first render has a list; the server corrects it if
    // it has one. A `null` watchlist from the server means NO DATABASE, not an
    // empty list — replacing the local list with [] there would silently clear it.
    setWatchlistState(loadLS<WatchItem[]>(LS_KEYS.watchlist, DEFAULT_WATCHLIST));
    fetch('/api/watchlist')
      .then((res) => res.json())
      .then((json: { watchlist: WatchItem[] | null }) => {
        if (Array.isArray(json.watchlist) && json.watchlist.length > 0) {
          setWatchlistState(json.watchlist);
          saveLS(LS_KEYS.watchlist, json.watchlist);
        }
      })
      .catch(() => {});
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    saveLS(LS_KEYS.watchlist, watchlist);
    // Mirrored to Postgres so the list is not confined to this browser. Logged,
    // not surfaced, on failure: the local copy is already authoritative here.
    fetch('/api/watchlist', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ watchlist }),
    }).catch(() => {});
  }, [watchlist, hydrated]);

  function setWatchlist(updater: WatchItem[] | ((w: WatchItem[]) => WatchItem[])) {
    setWatchlistState((prev) => (typeof updater === 'function' ? (updater as (w: WatchItem[]) => WatchItem[])(prev) : updater));
  }

  function applyTick(symbol: string, price: number, prevClose: number | null, source: Tick['source']) {
    setTicks((prev) => {
      const before = prev[symbol];
      if (before && before.price !== price) {
        const dir: FlashDir = price > before.price ? 'up' : 'down';
        setFlash((f) => ({ ...f, [symbol]: dir }));
        clearTimeout(flashTimers.current[symbol]);
        flashTimers.current[symbol] = setTimeout(() => {
          setFlash((f) => ({ ...f, [symbol]: null }));
        }, FLASH_MS);
      }
      return { ...prev, [symbol]: { price, prevClose, ts: Date.now(), source } };
    });
  }

  const cryptoItems = useMemo(() => watchlist.filter((w) => w.type === 'crypto' && w.binance), [watchlist]);
  const equityItems = useMemo(() => watchlist.filter((w) => w.type === 'equity'), [watchlist]);

  // --- Crypto: single combined Binance WebSocket stream, reconnects with backoff ---
  useEffect(() => {
    if (!hydrated || cryptoItems.length === 0) return;
    let ws: WebSocket | null = null;
    let closedByUs = false;
    let attempt = 0;

    const bySlug = new Map(cryptoItems.map((w) => [w.binance!.toLowerCase(), w.symbol]));
    const streams = [...bySlug.keys()].map((s) => `${s}@ticker`).join('/');
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    function connect() {
      ws = new WebSocket(url);
      ws.onopen = () => {
        attempt = 0;
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          const d = msg?.data;
          if (!d?.s) return;
          const symbol = bySlug.get(String(d.s).toLowerCase());
          if (!symbol) return;
          const price = parseFloat(d.c);
          const openPrice = parseFloat(d.o);
          if (!Number.isFinite(price)) return;
          applyTick(symbol, price, Number.isFinite(openPrice) ? openPrice : null, 'ws-live');
        } catch {
          // ignore malformed frame
        }
      };
      ws.onclose = () => {
        if (closedByUs) return;
        attempt++;
        const backoff = Math.min(15000, 1000 * 2 ** attempt);
        setTimeout(connect, backoff);
      };
      ws.onerror = () => {
        ws?.close();
      };
    }
    connect();

    return () => {
      closedByUs = true;
      ws?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, cryptoItems.map((c) => c.binance).join(',')]);

  // --- Equities: poll the server-side quote route ---
  useEffect(() => {
    if (!hydrated || equityItems.length === 0) return;
    let cancelled = false;

    async function poll() {
      try {
        const symbols = equityItems.map((e) => e.symbol).join(',');
        const res = await fetch(`/api/quote?symbols=${encodeURIComponent(symbols)}`);
        const json = await res.json();
        if (cancelled) return;
        if (json.error) throw new Error(json.error);
        setQuoteApiError(null);
        for (const q of json.quotes ?? []) {
          if (typeof q.price === 'number') applyTick(q.symbol, q.price, q.prevClose ?? null, 'poll-live');
        }
      } catch (err) {
        if (!cancelled) setQuoteApiError(err instanceof Error ? err.message : 'quote fetch failed');
      }
    }
    poll();
    const iv = setInterval(poll, EQUITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, equityItems.map((e) => e.symbol).join(',')]);

  // --- Honest simulated fallback: only for symbols with NO real tick at all
  // after 10s (equity poll failed and it's not a crypto symbol either), so
  // the UI doesn't sit blank — clearly labeled 'sim-fallback' everywhere,
  // including to the model in buildLiveMarketContext.
  useEffect(() => {
    if (!hydrated) return;
    simTimer.current && clearInterval(simTimer.current);
    simTimer.current = setInterval(() => {
      setTicks((prev) => {
        const next = { ...prev };
        let changed = false;
        for (const w of watchlist) {
          const t = prev[w.symbol];
          const stale = !t || Date.now() - t.ts > 12000;
          if (stale && (w.type !== 'equity' || quoteApiError)) {
            const base = t?.price ?? (w.type === 'crypto' ? 50000 : 100);
            const walk = base * (1 + (Math.random() - 0.5) * 0.002);
            next[w.symbol] = { price: walk, prevClose: t?.prevClose ?? base, ts: Date.now(), source: 'sim-fallback' };
            changed = true;
          }
        }
        return changed ? next : prev;
      });
    }, 4000);
    return () => {
      simTimer.current && clearInterval(simTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated, watchlist, quoteApiError]);

  const value: MarketDataValue = { watchlist, setWatchlist, ticks, flash, quoteApiError };
  return <MarketDataContext.Provider value={value}>{children}</MarketDataContext.Provider>;
}
