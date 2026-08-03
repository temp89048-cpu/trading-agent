// Equities (unlike crypto) don't have a free public WebSocket we can hit
// straight from the browser, and quote providers generally don't send
// CORS headers either, so this route fetches server-side and hands back
// plain JSON — same reasoning as /api/chat and /api/news.

export const runtime = 'nodejs';

type Quote = { symbol: string; price: number | null; prevClose: number | null };

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbolsParam = searchParams.get('symbols') || '';
  const symbols = [...new Set(symbolsParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];

  if (symbols.length === 0) {
    return Response.json({ quotes: [] });
  }

  try {
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(symbols.join(','))}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal quote fetch)' } });
    if (!res.ok) throw new Error(`upstream ${res.status}`);
    const json = await res.json();
    const results: any[] = json?.quoteResponse?.result ?? [];

    const bySymbol = new Map(results.map((r) => [String(r.symbol).toUpperCase(), r]));
    const quotes: Quote[] = symbols.map((s) => {
      const r = bySymbol.get(s);
      return {
        symbol: s,
        price: typeof r?.regularMarketPrice === 'number' ? r.regularMarketPrice : null,
        prevClose: typeof r?.regularMarketPreviousClose === 'number' ? r.regularMarketPreviousClose : null,
      };
    });

    return Response.json({ quotes });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return Response.json({ error: `Could not fetch quotes: ${message}` }, { status: 502 });
  }
}
