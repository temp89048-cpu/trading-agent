// Feeds lib/eventDetection.ts's funding-spike and OI-delta detectors.
// Both need real HISTORY, not the current-snapshot derivatives data
// /api/marketintel already provides — these are two more free, no-key
// Binance Futures endpoints (same host already used since Commit 18),
// just the historical variants instead of the latest-value ones.
// Crypto only — futures concepts have no equities equivalent.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal eventdata fetch)' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const binanceSymbol = searchParams.get('binance');

  if (!binanceSymbol) {
    return Response.json(
      { error: 'Funding-rate/OI history requires a Binance symbol — crypto-only, futures data has no equities equivalent.' },
      { status: 400 },
    );
  }

  const sym = binanceSymbol.toUpperCase();
  const [fundingRaw, oiRaw] = await Promise.all([
    fetchJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(sym)}&limit=30`),
    fetchJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${encodeURIComponent(sym)}&period=5m&limit=30`),
  ]);

  const fundingHistory = Array.isArray(fundingRaw)
    ? (fundingRaw as { fundingRate: string; fundingTime: number }[])
        .map((f) => ({ rate: parseFloat(f.fundingRate), time: f.fundingTime }))
        .filter((f) => isFinite(f.rate))
    : [];

  const oiHistory = Array.isArray(oiRaw)
    ? (oiRaw as { sumOpenInterest: string; timestamp: number }[])
        .map((o) => ({ oi: parseFloat(o.sumOpenInterest), time: o.timestamp }))
        .filter((o) => isFinite(o.oi))
    : [];

  return Response.json({
    fundingHistory,
    oiHistory,
    // Honest partial-failure surfacing, same standard as the multi-
    // exchange snapshot: if one series came back empty, say so instead
    // of silently returning an empty array indistinguishable from "no
    // spike detected."
    fundingHistoryAvailable: fundingHistory.length > 0,
    oiHistoryAvailable: oiHistory.length > 0,
  });
}
