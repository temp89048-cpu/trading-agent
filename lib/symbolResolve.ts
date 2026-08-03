import type { WatchItem } from './types';

// "SOL" -> "SOL/USDT" if that pair is on the watchlist (the only place
// this app actually has a live price to check against). Left untouched
// if it already has a slash, or nothing matches.
export function resolveSymbol(rawSymbol: string, watchlist: WatchItem[]): string {
  const upper = rawSymbol.toUpperCase();
  if (upper.includes('/')) return upper;
  const match = watchlist.find((w) => w.symbol.split('/')[0] === upper);
  return match?.symbol ?? upper;
}
