import type { Tick, WatchItem } from './types';

const SOURCE_LABEL: Record<string, string> = {
  'ws-live': 'live Binance websocket',
  'poll-live': 'live polled quote',
  'sim-fallback': 'simulated fallback — proxy not reachable, NOT a real price',
};

// This is the actual fix for "the AI doesn't pull the live price": before
// this existed, the chat request never included any market data at all,
// so the model was just guessing. This builds a system message with the
// real current ticks and tells the model to use those numbers verbatim.
export function buildLiveMarketContext(watchlist: WatchItem[], ticks: Record<string, Tick>): string {
  const now = new Date();
  const dateTimeLine = `CURRENT DATE/TIME: ${now.toLocaleString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })} (this is the real current moment — you have no way to know what happens after this message; never narrate a wait, a delay, or a "later" price check as if it already occurred).`;

  if (watchlist.length === 0) {
    return `${dateTimeLine}\n\nLIVE MARKET DATA: no symbols on the watchlist right now — add symbols to the watchlist to give the assistant live prices to reference.`;
  }
  const lines = watchlist.map((w) => {
    const t = ticks[w.symbol];
    if (!t) return `${w.symbol}: no price received yet`;
    const ageSec = Math.round((Date.now() - t.ts) / 1000);
    const changePct = t.prevClose ? (((t.price - t.prevClose) / t.prevClose) * 100).toFixed(2) : null;
    const srcLabel = SOURCE_LABEL[t.source] ?? t.source;
    return `${w.symbol}: ${t.price}${changePct !== null ? ` (${Number(changePct) >= 0 ? '+' : ''}${changePct}% since prev close)` : ''} — ${srcLabel}, ${ageSec}s ago`;
  });
  return `${dateTimeLine}\n\nLIVE MARKET DATA (from this app's watchlist feed, current as of now):\n${lines.join('\n')}\n\nUse these exact figures when the user asks about the current/live price of a symbol on this list. If a symbol they ask about is not on this list, say you don't have a live feed for it and suggest adding it to the watchlist — do not guess a price.`;
}
