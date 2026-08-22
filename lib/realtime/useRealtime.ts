'use client';

// ---------------------------------------------------------------------
// Hooks over the routed store. A component selects a slice; it does not scan
// the event buffer, and it does not open a socket.
// ---------------------------------------------------------------------

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type RealtimeState,
  realtimeSnapshot,
  subscribeRealtime,
} from './store';

/** Subscribe to a selected slice. Re-renders only when the selection changes.
 *
 *  `isEqual` defaults to reference equality, which is why `route()` in the store
 *  returns the SAME slice object when an event did not touch it — that is what
 *  makes a price tick not re-render the flow diagram. A selector returning a
 *  fresh object each call (`s => ({...})`) defeats it, so selectors here return
 *  slices or primitives.
 */
export function useRealtimeSelector<T>(
  selector: (s: RealtimeState) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const [value, setValue] = useState<T>(() => selector(realtimeSnapshot()));

  // Refs so the effect below never needs `selector` in its dependency list —
  // an inline arrow selector is a new function every render, which would
  // resubscribe on every render and, with the store's reference counting,
  // churn the socket.
  const selectorRef = useRef(selector);
  const isEqualRef = useRef(isEqual);
  selectorRef.current = selector;
  isEqualRef.current = isEqual;

  useEffect(() => {
    return subscribeRealtime((s) => {
      const next = selectorRef.current(s);
      setValue((prev) => (isEqualRef.current(prev, next) ? prev : next));
    });
  }, []);

  return value;
}

export function useRealtimeConnected(): boolean {
  return useRealtimeSelector((s) => s.connected);
}

export function useGraphNodes() {
  return useRealtimeSelector((s) => s.nodes);
}

export function useCurrentNode(): string | null {
  return useRealtimeSelector((s) => s.currentNode);
}

export function useLivePrice(symbol: string | null | undefined): number | null {
  return useRealtimeSelector((s) => (symbol ? (s.prices[symbol] ?? null) : null));
}

export function useLivePrices() {
  return useRealtimeSelector((s) => s.prices);
}

/** Triggers, newest first, optionally filtered by symbol.
 *
 *  `useMemo` on the slice rather than a selector that filters: a filtering
 *  selector allocates a new array per event and would defeat the equality
 *  check in `useRealtimeSelector`. */
export function useTriggers(symbol?: string) {
  const all = useRealtimeSelector((s) => s.triggers);
  return useMemo(() => {
    const rows = symbol ? all.filter((t) => t.symbol === symbol) : all;
    return [...rows].reverse();
  }, [all, symbol]);
}

/** The raw event tail, newest first. For the timeline and log views.
 *
 *  `types` filters by `event_type`; `limit` caps what is rendered, which matters
 *  because the timeline is one of the two views the perf pass virtualizes. */
export function useEventFeed({
  types,
  symbol,
  limit = 200,
}: { types?: string[]; symbol?: string; limit?: number } = {}) {
  const events = useRealtimeSelector((s) => s.events);
  const typeKey = types?.join(',') ?? '';

  return useMemo(() => {
    const wanted = typeKey ? new Set(typeKey.split(',')) : null;
    const out = [];
    for (let i = events.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const e = events[i];
      if (wanted && !wanted.has(String(e.event_type))) continue;
      if (symbol && e.symbol !== symbol) continue;
      out.push(e);
    }
    return out;
  }, [events, typeKey, symbol, limit]);
}

export function useLastDecision(symbol: string | null | undefined) {
  return useRealtimeSelector((s) => (symbol ? (s.lastDecision[symbol] ?? null) : null));
}

/** Seconds since the last event, recomputed on a timer.
 *
 *  Kept separate from the store because "how stale is this" changes with the
 *  clock, not with an event — routing a tick just to update an age would make
 *  every component re-render once a second. */
export function useStreamAge(): number | null {
  const lastEventAt = useRealtimeSelector((s) => s.lastEventAt);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, []);

  return lastEventAt === null ? null : Math.max(0, Math.round((now - lastEventAt) / 1000));
}

/** Fetch JSON from the FastAPI backend with an honest error state.
 *
 *  Every page needs this and every page needs the same three-way result:
 *  loading / data / unreachable. A hook that returned `null` for both "loading"
 *  and "failed" would let a page render an empty panel that looks like "no data"
 *  when the backend is simply not running — which is the single most common way
 *  a dashboard misleads its operator. */
export function useBackend<T>(
  path: string | null,
  { intervalMs, deps = [] }: { intervalMs?: number; deps?: unknown[] } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'unreachable'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const { backendUrl } = await import('../backendConfig');
      const res = await fetch(backendUrl(path));
      if (!res.ok) {
        setState('unreachable');
        setError(`HTTP ${res.status}`);
        return;
      }
      setData((await res.json()) as T);
      setState('ok');
      setError(null);
    } catch (e) {
      setState('unreachable');
      setError(e instanceof Error ? e.message : 'fetch failed');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void load();
    };
    run();
    if (!intervalMs) return () => {
      cancelled = true;
    };
    const id = setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [load, intervalMs]);

  return { data, state, error, reload: load };
}
