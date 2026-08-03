// Feeds lib/indicators.ts with real historical OHLC data. Same reasoning
// as /api/quote and /api/news: fetched server-side to avoid CORS and to
// keep a single, auditable place that talks to these upstreams.
//
// Fetch logic itself now lives in lib/candleSource.server.ts (Commit 16),
// shared with /api/backtest, which needs the same upstreams but a lot
// more history. This route's behavior is unchanged — same params, same
// response shape, same 500-bar cap for live chart/indicator use.

import { BINANCE_INTERVALS, fetchBinanceCandles, fetchYahooCandles, type Candle } from '@/lib/candleSource.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol');
  const type = searchParams.get('type'); // 'crypto' | 'equity'
  const interval = searchParams.get('interval') || '1h';
  const limit = Math.min(500, Math.max(20, parseInt(searchParams.get('limit') || '200', 10)));

  if (!symbol || !type) {
    return Response.json({ error: 'symbol and type are required' }, { status: 400 });
  }

  try {
    let candles: Candle[];
    if (type === 'crypto') {
      if (!BINANCE_INTERVALS.has(interval)) {
        return Response.json({ error: `Unsupported interval for crypto: ${interval}` }, { status: 400 });
      }
      candles = await fetchBinanceCandles(symbol, interval, limit);
    } else if (type === 'equity') {
      candles = await fetchYahooCandles(symbol, interval);
      candles = candles.slice(-limit);
    } else {
      return Response.json({ error: 'type must be "crypto" or "equity"' }, { status: 400 });
    }
    return Response.json({ symbol, interval, candles });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return Response.json({ error: `Could not fetch candles: ${message}` }, { status: 502 });
  }
}
