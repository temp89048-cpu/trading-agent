// Shared by /api/candles (live chart/indicator data) and /api/backtest
// (historical replay, which needs a lot more bars than a live chart
// ever does). Same upstreams as before this file existed — this is a
// behavior-preserving extraction, not a new data source.

export type Candle = { t: number; o: number; h: number; l: number; c: number; v: number };

export const BINANCE_INTERVALS = new Set(['1m', '5m', '15m', '1h', '4h', '1d', '1w']);

const BINANCE_INTERVAL_MS: Record<string, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

// Yahoo's intraday granularity is more restricted than Binance's, so
// map our interval names to what Yahoo actually supports, and to a
// sane history range for that granularity (Yahoo rejects requests for
// too much history at fine granularity). This IS the honest ceiling on
// equity backtest depth mentioned in Commit 16's roadmap note — there's
// no deeper history to page through for equities the way there is for
// Binance.
export const YAHOO_INTERVAL_MAP: Record<string, { interval: string; range: string }> = {
  '1m': { interval: '1m', range: '5d' },
  '5m': { interval: '5m', range: '1mo' },
  '15m': { interval: '15m', range: '1mo' },
  '1h': { interval: '60m', range: '3mo' },
  '4h': { interval: '60m', range: '3mo' },
  '1d': { interval: '1d', range: '1y' },
  '1w': { interval: '1wk', range: '5y' },
};

export async function fetchBinanceCandles(binanceSymbol: string, interval: string, limit: number): Promise<Candle[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol.toUpperCase())}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal candles fetch)' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Binance klines ${res.status}: ${text.slice(0, 200)}`);
  }
  const rows: any[] = await res.json();
  return rows.map((r) => ({ t: r[0], o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
}

// Binance caps a single klines call at 1000 bars. For backtesting we
// often want more than that, so this walks backward in time using the
// `endTime` param, stitching pages together — real pagination, not a
// bigger single request pretending the cap doesn't exist.
const BINANCE_MAX_PER_CALL = 1000;
const MAX_BINANCE_PAGES = 10; // hard ceiling: 10 * 1000 = 10,000 bars max per backtest fetch, keeps this bounded

export async function fetchBinanceCandlesDeep(binanceSymbol: string, interval: string, totalBars: number): Promise<Candle[]> {
  const intervalMs = BINANCE_INTERVAL_MS[interval];
  if (!intervalMs) throw new Error(`Unsupported interval for crypto: ${interval}`);

  const target = Math.min(totalBars, BINANCE_MAX_PER_CALL * MAX_BINANCE_PAGES);
  let endTime: number | undefined = undefined;
  const pages: Candle[][] = [];
  let collected = 0;
  let pageCount = 0;

  while (collected < target && pageCount < MAX_BINANCE_PAGES) {
    const pageLimit = Math.min(BINANCE_MAX_PER_CALL, target - collected);
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(binanceSymbol.toUpperCase())}&interval=${interval}&limit=${pageLimit}${endTime ? `&endTime=${endTime}` : ''}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal candles fetch)' } });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Binance klines ${res.status}: ${text.slice(0, 200)}`);
    }
    const rows: any[] = await res.json();
    if (rows.length === 0) break; // no more history available upstream
    const page: Candle[] = rows.map((r) => ({ t: r[0], o: parseFloat(r[1]), h: parseFloat(r[2]), l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[5]) }));
    pages.unshift(page);
    collected += page.length;
    endTime = page[0].t - 1; // next page ends right before this page's first candle
    pageCount += 1;
    if (rows.length < pageLimit) break; // upstream ran out of history before hitting our target
  }

  // De-dupe on the (rare) chance of an overlap at a page boundary, then sort ascending.
  const seen = new Set<number>();
  const merged: Candle[] = [];
  for (const page of pages) {
    for (const c of page) {
      if (seen.has(c.t)) continue;
      seen.add(c.t);
      merged.push(c);
    }
  }
  merged.sort((a, b) => a.t - b.t);
  return merged;
}

export async function fetchYahooCandles(equitySymbol: string, interval: string): Promise<Candle[]> {
  const mapped = YAHOO_INTERVAL_MAP[interval];
  if (!mapped) throw new Error(`Unsupported interval for equities: ${interval}`);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(equitySymbol)}?interval=${mapped.interval}&range=${mapped.range}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal candles fetch)' } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Yahoo chart ${res.status}: ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result) throw new Error('Yahoo chart returned no result');
  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const candles: Candle[] = [];
  for (let i = 0; i < timestamps.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i];
    if ([o, h, l, c].some((x) => x === null || x === undefined)) continue;
    candles.push({ t: timestamps[i] * 1000, o, h, l, c, v: v ?? 0 });
  }
  return candles;
}

// One entry point for "give me as much history as you honestly have,
// up to N bars" — used by the backtest route. type/interval validation
// mirrors /api/candles exactly so error messages stay consistent.
export async function fetchDeepHistory(symbol: string, type: 'crypto' | 'equity', interval: string, totalBars: number): Promise<{ candles: Candle[]; sourceNote: string }> {
  if (type === 'crypto') {
    if (!BINANCE_INTERVALS.has(interval)) throw new Error(`Unsupported interval for crypto: ${interval}`);
    const candles = await fetchBinanceCandlesDeep(symbol, interval, totalBars);
    const sourceNote = candles.length < totalBars
      ? `Binance returned ${candles.length} bars (fewer than the ${totalBars} requested — that's all the history available at this granularity).`
      : `Binance, ${candles.length} bars.`;
    return { candles, sourceNote };
  }
  if (type === 'equity') {
    const all = await fetchYahooCandles(symbol, interval);
    const candles = all.slice(-totalBars);
    const sourceNote = all.length < totalBars
      ? `Yahoo returned ${all.length} bars total at this granularity (fewer than the ${totalBars} requested) — equities have a shorter available history at fine granularity than crypto. See Commit 16's documented limit.`
      : `Yahoo, ${candles.length} of ${all.length} available bars used.`;
    return { candles, sourceNote };
  }
  throw new Error('type must be "crypto" or "equity"');
}
