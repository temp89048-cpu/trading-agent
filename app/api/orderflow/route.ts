// Feeds lib/orderFlow.ts. Same reasoning as /api/candles: fetched
// server-side to avoid CORS, single auditable place that talks to
// Binance's public REST endpoints. Crypto only — see
// lib/providerCapabilities.ts for why equities can't do this at all
// with Yahoo as the data source.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DepthLevel = [string, string]; // [price, quantity] as strings, per Binance's response shape

type AggTrade = {
  p: string; // price
  q: string; // quantity
  T: number; // trade time
  m: boolean; // true = the buyer was the maker, i.e. the SELLER was the aggressor
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const binanceSymbol = searchParams.get('binance');

  if (!binanceSymbol) {
    return Response.json(
      { error: 'Order flow data requires a Binance symbol — this endpoint is crypto-only. Equities have no order book/trade tape data source wired up (see the capability matrix).' },
      { status: 400 },
    );
  }

  const symbol = binanceSymbol.toUpperCase();
  const depthUrl = `https://api.binance.com/api/v3/depth?symbol=${encodeURIComponent(symbol)}&limit=50`;
  const tradesUrl = `https://api.binance.com/api/v3/aggTrades?symbol=${encodeURIComponent(symbol)}&limit=200`;

  try {
    const [depthRes, tradesRes] = await Promise.all([
      fetch(depthUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal orderflow fetch)' } }),
      fetch(tradesUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal orderflow fetch)' } }),
    ]);

    if (!depthRes.ok) {
      const text = await depthRes.text().catch(() => '');
      throw new Error(`Binance depth ${depthRes.status}: ${text.slice(0, 200)}`);
    }
    if (!tradesRes.ok) {
      const text = await tradesRes.text().catch(() => '');
      throw new Error(`Binance aggTrades ${tradesRes.status}: ${text.slice(0, 200)}`);
    }

    const depthJson: { bids: DepthLevel[]; asks: DepthLevel[] } = await depthRes.json();
    const tradesJson: AggTrade[] = await tradesRes.json();

    return Response.json({
      bids: depthJson.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
      asks: depthJson.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
      trades: tradesJson.map((t) => ({ price: parseFloat(t.p), qty: parseFloat(t.q), time: t.T, buyerIsMaker: t.m })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    // Fail gracefully, same standard as /api/candles — a clean error
    // response, not a crash, since real Binance access can't be
    // verified from this sandbox at build time.
    return Response.json({ error: message }, { status: 502 });
  }
}
