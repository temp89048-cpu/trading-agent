import { rsi, macd, bollingerBands, atr, ema, type Candle } from './indicators';
import type { WatchItem } from './types';

export type IndicatorSnapshot = {
  rsi14: number | null;
  macd: ReturnType<typeof macd>;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  bollinger: ReturnType<typeof bollingerBands>;
  atr14: number | null;
};

export function computeIndicatorSnapshot(candles: Candle[]): IndicatorSnapshot | null {
  if (candles.length < 20) return null; // not enough history for anything meaningful
  const closes = candles.map((c) => c.c);
  return {
    rsi14: rsi(closes, 14),
    macd: macd(closes, 12, 26, 9),
    ema20: ema(closes, 20),
    ema50: closes.length >= 50 ? ema(closes, 50) : null,
    ema200: closes.length >= 200 ? ema(closes, 200) : null,
    bollinger: bollingerBands(closes, 20, 2),
    atr14: atr(candles, 14),
  };
}

function formatSnapshot(snapshot: IndicatorSnapshot): string {
  const parts: string[] = [];
  if (snapshot.rsi14 !== null) parts.push(`RSI(14)=${snapshot.rsi14.toFixed(1)}`);
  if (snapshot.macd) parts.push(`MACD=${snapshot.macd.macd.toFixed(3)}/signal=${snapshot.macd.signal.toFixed(3)}/hist=${snapshot.macd.histogram.toFixed(3)}`);
  if (snapshot.ema20 !== null) parts.push(`EMA20=${snapshot.ema20.toFixed(2)}`);
  if (snapshot.ema50 !== null) parts.push(`EMA50=${snapshot.ema50.toFixed(2)}`);
  if (snapshot.ema200 !== null) parts.push(`EMA200=${snapshot.ema200.toFixed(2)}`);
  if (snapshot.bollinger) parts.push(`BB(20,2)=${snapshot.bollinger.upper.toFixed(2)}/${snapshot.bollinger.middle.toFixed(2)}/${snapshot.bollinger.lower.toFixed(2)} (upper/mid/lower)`);
  if (snapshot.atr14 !== null) parts.push(`ATR(14)=${snapshot.atr14.toFixed(3)}`);
  return parts.join(', ');
}

export type SnapshotLookup = (symbol: string, interval: string) => { candles: Candle[] } | undefined;

// Builds the system message telling the model what's ACTUALLY computed
// and available, per watchlist symbol per timeframe — and just as
// importantly, tells it plainly when nothing is available, so it keeps
// being honest about gaps instead of inventing numbers for symbols/
// timeframes this app hasn't fetched data for.
export function buildIndicatorContext(watchlist: WatchItem[], timeframes: string[], lookup: SnapshotLookup): string {
  if (watchlist.length === 0) {
    return 'TECHNICAL INDICATORS: no watchlist symbols to compute indicators for.';
  }

  const lines: string[] = [];
  for (const item of watchlist) {
    for (const tf of timeframes) {
      const entry = lookup(item.symbol, tf);
      if (!entry || entry.candles.length === 0) continue;
      const snapshot = computeIndicatorSnapshot(entry.candles);
      if (!snapshot) continue;
      lines.push(`${item.symbol} [${tf}]: ${formatSnapshot(snapshot)}`);
    }
  }

  if (lines.length === 0) {
    return 'TECHNICAL INDICATORS: none computed yet (still fetching real OHLC history) — do not invent indicator values; say they are not available yet if asked.';
  }

  return `TECHNICAL INDICATORS (computed by this app from real OHLC candle history — these are real, not estimates; use them directly instead of saying you lack indicator access):\n${lines.join('\n')}\n\nOnly the symbols/timeframes listed above have computed indicators. For anything else, say you don't have it rather than inventing a plausible-looking number.`;
}
