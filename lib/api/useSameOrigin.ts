'use client';

// ---------------------------------------------------------------------
// Fetch from THIS app's route handlers.
//
// Deliberately separate from `useBackend`, which prefixes `BACKEND_BASE`. The two
// must not be confused: `/api/trades`, `/api/decisions` and `/api/news` are Next.js
// routes served by this origin, and `/api/health` and `/api/trades` are ALSO real
// FastAPI paths — so pointing a Next path at the Python host returns a 404 that
// looks like missing data.
//
// That exact mistake is why `lib/backendConfig.ts` exists, and it is worth two
// hooks rather than one with a flag.
// ---------------------------------------------------------------------

import { useCallback, useEffect, useState } from 'react';

export type FetchState = 'loading' | 'ok' | 'unreachable';

export function useSameOrigin<T>(
  path: string | null,
  { intervalMs }: { intervalMs?: number } = {},
) {
  const [data, setData] = useState<T | null>(null);
  const [state, setState] = useState<FetchState>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!path) return;
    try {
      const res = await fetch(path);
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
  }, [path]);

  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void load();
    };
    run();
    if (!intervalMs) {
      return () => {
        cancelled = true;
      };
    }
    const id = setInterval(run, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [load, intervalMs]);

  return { data, state, error, reload: load };
}
