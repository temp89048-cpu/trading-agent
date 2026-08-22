// Feeds lib/indicators.ts with real historical OHLC data. Same reasoning
// as /api/quote and /api/news: fetched server-side to avoid CORS and to
// keep a single, auditable place that talks to these upstreams.
//
// Fetch logic itself now lives in lib/candleSource.server.ts (Commit 16),
// shared with /api/backtest, which needs the same upstreams but a lot
// more history. This route's behavior is unchanged — same params, same
// response shape, same 500-bar cap for live chart/indicator use.

import { resolveLimit } from '@/lib/candleLimit';
import { BINANCE_INTERVALS, fetchBinanceCandles, fetchYahooCandles, type Candle } from '@/lib/candleSource.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol');
  const type = searchParams.get('type'); // 'crypto' | 'equity'
  const interval = searchParams.get('interval') || '1h';

  if (!symbol || !type) {
    return Response.json({ error: 'symbol and type are required' }, { status: 400 });
  }

  // Parsed and validated BEFORE any upstream call. The inline
  // `Math.min(500, Math.max(20, parseInt(...)))` this replaces let `limit=abc`
  // through as NaN, which reached Binance as `limit=NaN` and came back as a 502
  // blaming the exchange for a parameter this route never checked. It also clamped
  // silently, so `limit=3` returned 20 bars with no indication. See lib/candleLimit.ts.
  const parsed = resolveLimit(searchParams.get('limit'));
  if (!parsed.ok) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }
  const limit = parsed.limit;

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
    return Response.json({
      symbol,
      interval,
      candles,
      limit,
      // Present only when the caller was overruled, so a client can surface it
      // rather than charting a different number of bars than it asked for.
      ...(parsed.note ? { requestedLimit: parsed.requested, limitNote: parsed.note } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return Response.json({ error: `Could not fetch candles: ${message}` }, { status: 502 });
  }
}
