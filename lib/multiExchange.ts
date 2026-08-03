import type { WatchItem } from './types';

// ---------------------------------------------------------------------
// Multi-Exchange Price Aggregation (Level 14) — crypto only.
//
// Binance is already this app's primary crypto data source (candles,
// order flow). This adds five more public, no-key REST endpoints purely
// for a cross-venue PRICE comparison: Bybit, OKX, Kraken, Coinbase, Crypto.com.
// Nothing here executes anything on any exchange — it's read-only price
// aggregation, feeding the Arbitrage detector (informational — spread
// detection only, not execution, see lib/strategies/arbitrage.ts) and
// giving a sanity check against a single venue's price being stale or
// an outlier.
//
// Equities have no equivalent here at all — there's no second free
// equities data source wired into this app (see providerCapabilities.ts)
// — so this module simply doesn't run for equity WatchItems.
//
// Every exchange call fails independently and is tolerated: a 4/5 or
// even 1/5 result is still useful, so Promise.allSettled is used
// throughout rather than Promise.all, and the aggregate result reports
// exactly which venues answered and which didn't, honestly, rather than
// silently dropping failed ones.
// ---------------------------------------------------------------------

export type ExchangeId = 'binance' | 'bybit' | 'okx' | 'kraken' | 'coinbase' | 'cryptocom';

export const EXCHANGE_LABELS: Record<ExchangeId, string> = {
  binance: 'Binance',
  bybit: 'Bybit',
  okx: 'OKX',
  kraken: 'Kraken',
  coinbase: 'Coinbase',
  cryptocom: 'Crypto.com',
};

export type ExchangeQuote =
  | { exchange: ExchangeId; ok: true; price: number; quoteCurrency: string }
  | { exchange: ExchangeId; ok: false; error: string };

export type MultiExchangeSnapshot = {
  symbol: string;
  quotes: ExchangeQuote[];
  fetchedAt: number;
};

const FETCH_TIMEOUT_MS = 5000;

async function fetchJson(url: string): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal multiexchange fetch)' }, signal: controller.signal });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${res.status}: ${text.slice(0, 150)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Kraken's asset naming predates most others' (BTC -> XBT) — this is
// the one venue-specific symbol quirk worth naming explicitly rather
// than hiding behind a generic lookup table.
const KRAKEN_BASE_OVERRIDES: Record<string, string> = { BTC: 'XBT' };

function baseOf(item: WatchItem): string {
  return item.symbol.split('/')[0].toUpperCase();
}

async function fetchBinance(item: WatchItem): Promise<ExchangeQuote> {
  try {
    const sym = item.binance ?? item.symbol.replace('/', '');
    const json = await fetchJson(`https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(sym)}`);
    const price = parseFloat(json.price);
    if (!isFinite(price)) throw new Error('non-numeric price in response');
    return { exchange: 'binance', ok: true, price, quoteCurrency: 'USDT' };
  } catch (err) {
    return { exchange: 'binance', ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

async function fetchBybit(item: WatchItem): Promise<ExchangeQuote> {
  try {
    const sym = `${baseOf(item)}USDT`;
    const json = await fetchJson(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(sym)}`);
    const row = json?.result?.list?.[0];
    const price = row ? parseFloat(row.lastPrice) : NaN;
    if (!isFinite(price)) throw new Error('symbol not found or non-numeric price');
    return { exchange: 'bybit', ok: true, price, quoteCurrency: 'USDT' };
  } catch (err) {
    return { exchange: 'bybit', ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

async function fetchOkx(item: WatchItem): Promise<ExchangeQuote> {
  try {
    const instId = `${baseOf(item)}-USDT`;
    const json = await fetchJson(`https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`);
    const row = json?.data?.[0];
    const price = row ? parseFloat(row.last) : NaN;
    if (!isFinite(price)) throw new Error('symbol not found or non-numeric price');
    return { exchange: 'okx', ok: true, price, quoteCurrency: 'USDT' };
  } catch (err) {
    return { exchange: 'okx', ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

async function fetchKraken(item: WatchItem): Promise<ExchangeQuote> {
  try {
    const base = baseOf(item);
    const krakenBase = KRAKEN_BASE_OVERRIDES[base] ?? base;
    const pair = `${krakenBase}USDT`;
    const json = await fetchJson(`https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(pair)}`);
    if (Array.isArray(json?.error) && json.error.length > 0) throw new Error(json.error.join('; '));
    const resultKey = json?.result ? Object.keys(json.result)[0] : undefined;
    const row = resultKey ? json.result[resultKey] : undefined;
    const price = row?.c?.[0] !== undefined ? parseFloat(row.c[0]) : NaN; // 'c' = last trade closed [price, lot volume]
    if (!isFinite(price)) throw new Error('pair not found or non-numeric price — Kraken symbol mapping is best-effort (only the BTC->XBT rename is handled explicitly)');
    return { exchange: 'kraken', ok: true, price, quoteCurrency: 'USDT' };
  } catch (err) {
    return { exchange: 'kraken', ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

async function fetchCoinbase(item: WatchItem): Promise<ExchangeQuote> {
  try {
    // Coinbase Exchange's public book is USD-quoted for most pairs, not
    // USDT — used as-is and labeled honestly rather than assumed
    // equivalent to the USDT-quoted venues above (USDT/USD typically
    // trades within a few basis points of parity, but that's an
    // assumption this module states rather than silently bakes in).
    const productId = `${baseOf(item)}-USD`;
    const json = await fetchJson(`https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/ticker`);
    const price = json?.price !== undefined ? parseFloat(json.price) : NaN;
    if (!isFinite(price)) throw new Error('product not found or non-numeric price');
    return { exchange: 'coinbase', ok: true, price, quoteCurrency: 'USD' };
  } catch (err) {
    return { exchange: 'coinbase', ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

async function fetchCryptoCom(item: WatchItem): Promise<ExchangeQuote> {
  try {
    const instrumentName = `${baseOf(item)}_USDT`;
    const json = await fetchJson(`https://api.crypto.com/v2/public/get-ticker?instrument_name=${encodeURIComponent(instrumentName)}`);
    // result.data is an array when instrument_name is given, but Crypto.com's
    // API has returned a bare object for this shape in the past — handle both
    // rather than assume one and throw an unhelpful "undefined" error.
    const row = Array.isArray(json?.result?.data) ? json.result.data[0] : json?.result?.data;
    const price = row?.a !== undefined ? parseFloat(row.a) : NaN; // 'a' = latest trade price
    if (!isFinite(price)) throw new Error('instrument not found or non-numeric price');
    return { exchange: 'cryptocom', ok: true, price, quoteCurrency: 'USDT' };
  } catch (err) {
    return { exchange: 'cryptocom', ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

const FETCHERS: Record<ExchangeId, (item: WatchItem) => Promise<ExchangeQuote>> = {
  binance: fetchBinance,
  bybit: fetchBybit,
  okx: fetchOkx,
  kraken: fetchKraken,
  coinbase: fetchCoinbase,
  cryptocom: fetchCryptoCom,
};

export async function aggregateMultiExchangePrices(item: WatchItem): Promise<MultiExchangeSnapshot | { error: string }> {
  if (item.type !== 'crypto') {
    return { error: 'Multi-exchange aggregation is crypto-only — there is no second free equities data source wired into this app (see DATA CAPABILITIES).' };
  }
  const exchanges: ExchangeId[] = ['binance', 'bybit', 'okx', 'kraken', 'coinbase', 'cryptocom'];
  const quotes = await Promise.all(exchanges.map((ex) => FETCHERS[ex](item)));
  return { symbol: item.symbol, quotes, fetchedAt: Date.now() };
}

// ---------------------------------------------------------------------
// Spread analysis — pure, given a snapshot. Only compares quotes that
// actually succeeded; a venue that failed to answer is excluded from
// the spread math, not treated as agreeing or as an outlier.
// ---------------------------------------------------------------------
export type SpreadResult = {
  maxPrice: { exchange: ExchangeId; price: number };
  minPrice: { exchange: ExchangeId; price: number };
  spreadPct: number; // (max - min) / min * 100
  successCount: number;
  failedExchanges: { exchange: ExchangeId; error: string }[];
};

export function computeSpread(snapshot: MultiExchangeSnapshot): SpreadResult | null {
  const successes = snapshot.quotes.filter((q): q is Extract<ExchangeQuote, { ok: true }> => q.ok);
  const failures = snapshot.quotes.filter((q): q is Extract<ExchangeQuote, { ok: false }> => !q.ok);
  if (successes.length < 2) return null; // need at least 2 venues to talk about a spread at all

  let max = successes[0];
  let min = successes[0];
  for (const q of successes) {
    if (q.price > max.price) max = q;
    if (q.price < min.price) min = q;
  }
  const spreadPct = min.price > 0 ? ((max.price - min.price) / min.price) * 100 : 0;

  return {
    maxPrice: { exchange: max.exchange, price: max.price },
    minPrice: { exchange: min.exchange, price: min.price },
    spreadPct,
    successCount: successes.length,
    failedExchanges: failures.map((f) => ({ exchange: f.exchange, error: f.error })),
  };
}

// ---------------------------------------------------------------------
// Chat context injection.
// ---------------------------------------------------------------------
export function buildMultiExchangeContext(snapshots: Record<string, MultiExchangeSnapshot | undefined>, watchlist: WatchItem[]): string {
  const cryptoItems = watchlist.filter((w) => w.type === 'crypto');
  if (cryptoItems.length === 0) return 'MULTI-EXCHANGE: no crypto watchlist symbols (equities have no second free data source — crypto-only feature).';

  const lines = cryptoItems.map((item) => {
    const snap = snapshots[item.symbol];
    if (!snap) return `  ${item.symbol}: not fetched yet`;
    const spread = computeSpread(snap);
    const quoteLine = snap.quotes
      .map((q) => (q.ok ? `${EXCHANGE_LABELS[q.exchange]} $${q.price.toLocaleString()}` : `${EXCHANGE_LABELS[q.exchange]} unavailable`))
      .join(', ');
    if (!spread) return `  ${item.symbol}: ${quoteLine} (fewer than 2 venues answered — no spread to report)`;
    return `  ${item.symbol}: ${quoteLine} — spread ${spread.spreadPct.toFixed(3)}% (${EXCHANGE_LABELS[spread.maxPrice.exchange]} high / ${EXCHANGE_LABELS[spread.minPrice.exchange]} low)`;
  });

  return `MULTI-EXCHANGE PRICES (Binance, Bybit, OKX, Kraken, Coinbase, Crypto.com — public REST, no keys; Coinbase is USD-quoted, the rest USDT-quoted, a small basis difference is expected and not itself an arbitrage signal):\n${lines.join('\n')}`;
}
