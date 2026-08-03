// Feeds lib/multiExchange.ts. Server-side to avoid CORS on 4 more
// public exchange REST hosts, same reasoning as /api/candles and
// /api/orderflow. Crypto only — see lib/providerCapabilities.ts /
// lib/multiExchange.ts for why equities have no equivalent.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { aggregateMultiExchangePrices } from '@/lib/multiExchange';
import type { WatchItem } from '@/lib/types';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol');
  const binanceSymbol = searchParams.get('binance') ?? undefined;

  if (!symbol) {
    return Response.json({ error: 'symbol query param required (e.g. ?symbol=BTC/USDT).' }, { status: 400 });
  }

  const item: WatchItem = { symbol, type: 'crypto', binance: binanceSymbol };
  const result = await aggregateMultiExchangePrices(item);
  if ('error' in result) {
    return Response.json({ error: result.error }, { status: 400 });
  }
  return Response.json(result);
}
