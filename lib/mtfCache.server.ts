import type { Candle } from './indicators';

// In-memory, per-server-instance cache (module-level Map — resets on
// redeploy/restart, same lifetime class as everything else that isn't
// explicitly file-backed in this app). This is deliberately NOT
// file-backed: candle history is large, changes constantly, and is
// trivially re-fetchable — unlike trades/reflections/memory, there's
// nothing here worth surviving a restart for.
//
// Used as the fallback path when lib/backtest/aggregate.ts can't derive
// a timeframe from one already-fetched base series (e.g. the base
// interval itself needed a fresh network call, or the caller only wants
// one specific higher timeframe and fetching+aggregating a much finer
// base would mean pulling far more data than necessary).

type CacheEntry = { candles: Candle[]; fetchedAt: number; sourceNote: string };

const CACHE_TTL_MS = 5 * 60_000; // 5 minutes — long enough to make a backtest+optimize session on the same symbol fast, short enough that live re-runs still see fresh data
const cache = new Map<string, CacheEntry>();

function cacheKey(providerId: string, symbol: string, interval: string, totalBars: number): string {
  return `${providerId}:${symbol.toUpperCase()}:${interval}:${totalBars}`;
}

export function getCached(providerId: string, symbol: string, interval: string, totalBars: number): CacheEntry | null {
  const key = cacheKey(providerId, symbol, interval, totalBars);
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return entry;
}

export function setCached(providerId: string, symbol: string, interval: string, totalBars: number, candles: Candle[], sourceNote: string): void {
  const key = cacheKey(providerId, symbol, interval, totalBars);
  cache.set(key, { candles, fetchedAt: Date.now(), sourceNote });
}

export function cacheStats(): { entries: number; oldestAgeMs: number | null } {
  if (cache.size === 0) return { entries: 0, oldestAgeMs: null };
  const now = Date.now();
  let oldest = 0;
  for (const entry of cache.values()) oldest = Math.max(oldest, now - entry.fetchedAt);
  return { entries: cache.size, oldestAgeMs: oldest };
}

export function clearCache(): void {
  cache.clear();
}
