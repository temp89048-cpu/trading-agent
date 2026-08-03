// Two genuinely free, no-key data sources combined here:
//   - Fear & Greed Index (alternative.me) — market-wide, not per-symbol
//   - Binance Futures public endpoints — per-symbol derivatives data
// Crypto only, same reasoning as /api/orderflow: equities have no
// equivalent free derivatives data source (see DATA CAPABILITIES).

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type FearGreedPoint = { value: number; classification: string; timestamp: number };

async function fetchFearGreed(): Promise<FearGreedPoint[] | null> {
  try {
    const res = await fetch('https://api.alternative.me/fng/?limit=2');
    if (!res.ok) return null;
    const json = await res.json();
    const data = json?.data ?? [];
    return data.map((d: { value: string; value_classification: string; timestamp: string }) => ({
      value: parseInt(d.value, 10),
      classification: d.value_classification,
      timestamp: parseInt(d.timestamp, 10) * 1000,
    }));
  } catch {
    return null;
  }
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal marketintel fetch)' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const binanceSymbol = searchParams.get('binance'); // e.g. BTCUSDT — optional; Fear & Greed alone works without it

  const [fearGreed, premiumIndex, openInterest, topRatio, takerRatio] = await Promise.all([
    fetchFearGreed(),
    binanceSymbol ? fetchJson(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(binanceSymbol.toUpperCase())}`) : Promise.resolve(null),
    binanceSymbol ? fetchJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${encodeURIComponent(binanceSymbol.toUpperCase())}`) : Promise.resolve(null),
    binanceSymbol
      ? fetchJson(`https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${encodeURIComponent(binanceSymbol.toUpperCase())}&period=5m&limit=1`)
      : Promise.resolve(null),
    binanceSymbol
      ? fetchJson(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${encodeURIComponent(binanceSymbol.toUpperCase())}&period=5m&limit=1`)
      : Promise.resolve(null),
  ]);

  const premium = premiumIndex as { lastFundingRate?: string; markPrice?: string } | null;
  const oi = openInterest as { openInterest?: string } | null;
  const top = Array.isArray(topRatio) ? (topRatio[0] as { longShortRatio?: string; longAccount?: string; shortAccount?: string } | undefined) : undefined;
  const taker = Array.isArray(takerRatio) ? (takerRatio[0] as { buySellRatio?: string; buyVol?: string; sellVol?: string } | undefined) : undefined;

  return Response.json({
    fearGreed: fearGreed ? { current: fearGreed[0] ?? null, previous: fearGreed[1] ?? null } : null,
    derivatives: binanceSymbol
      ? {
          fundingRate: premium?.lastFundingRate ? parseFloat(premium.lastFundingRate) : null,
          markPrice: premium?.markPrice ? parseFloat(premium.markPrice) : null,
          openInterest: oi?.openInterest ? parseFloat(oi.openInterest) : null,
          topTraderLongShortRatio: top?.longShortRatio ? parseFloat(top.longShortRatio) : null,
          topTraderLongAccountPct: top?.longAccount ? parseFloat(top.longAccount) * 100 : null,
          takerBuySellRatio: taker?.buySellRatio ? parseFloat(taker.buySellRatio) : null,
        }
      : null,
  });
}
