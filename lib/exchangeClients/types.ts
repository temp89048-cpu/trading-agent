// ---------------------------------------------------------------------
// Real Exchange Trading — shared types.
//
// SCOPE, stated plainly: SPOT trading only, on Binance and Bybit. Not
// futures/margin — this app's "leverage" field has always been notional-
// only for paper trades (see lib/riskManager.ts, lib/agentEngine.ts), and
// building real margin/liquidation mechanics (isolated vs cross, funding
// rates, position mode) is a materially larger and riskier undertaking
// than spot order placement. A real futures build should be its own
// deliberate piece of work, not folded into this one.
//
// This is a genuinely different risk category from everything else in
// this app: these functions place REAL orders with REAL funds. Every
// function here is a thin, honest wrapper around one documented exchange
// endpoint — no retry-and-hope logic, no silent fallback on a failed
// order. See binance.ts/bybit.ts for the endpoints implemented and their
// known limitations (in particular: no LOT_SIZE/PRICE_FILTER precision
// validation against live exchangeInfo — a qty that violates a symbol's
// step size will be rejected BY THE EXCHANGE with a clear error, not
// silently rounded to something wrong).
// ---------------------------------------------------------------------

export type TradingExchangeId = 'binance' | 'bybit';

export type ExchangeCredentials = {
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
};

export type ExchangeBalance = {
  asset: string;
  free: number;
  locked: number;
};

export type ExchangeAccountSnapshot = {
  balances: ExchangeBalance[];
  raw?: unknown; // full provider response, for debugging — never logged server-side, only returned to the caller that already holds the credentials
};

export type PlaceOrderParams = {
  symbol: string; // app's internal "BTC/USDT" form — converted to the exchange's native form internally
  side: 'buy' | 'sell';
  qty: number; // base-asset quantity (e.g. BTC amount), not USD notional
  // IDEMPOTENCY KEY (spec Section 19: "a retried order must never result
  // in a duplicate fill"). Sent to the exchange as its own
  // caller-supplied unique order id — newClientOrderId on Binance,
  // orderLinkId on Bybit — both of which the exchange REJECTS duplicates
  // of. Must be deterministic for one logical trade intent; build it with
  // lib/executionQuality.ts's buildClientOrderId(), never with a random
  // or timestamped value, since a retry has to reproduce it exactly.
  //
  // Optional only for backward compatibility with existing callers. Any
  // path that can retry MUST supply one.
  clientOrderId?: string;
};

export type OrderResult =
  | {
      ok: true;
      exchangeOrderId: string;
      status: string; // exchange's own status string (e.g. 'FILLED', 'Filled') — not normalized further, see each client's comment
      filledQty: number | null; // null if the exchange response didn't report it back synchronously
      avgFillPrice: number | null;
      raw: unknown;
    }
  | { ok: false; error: string; raw?: unknown };

export type OrderStatusResult =
  | { ok: true; status: string; filledQty: number | null; avgFillPrice: number | null; raw: unknown }
  | { ok: false; error: string; raw?: unknown };

export type CancelOrderResult = { ok: true; raw: unknown } | { ok: false; error: string; raw?: unknown };

// Every symbol in this app is stored as "BTC/USDT" (WatchItem.symbol).
// Both Binance and Bybit spot APIs want the concatenated form ("BTCUSDT")
// with no separator — same conversion lib/multiExchange.ts already does
// for read-only price aggregation.
export function toExchangeSymbol(appSymbol: string): string {
  return appSymbol.replace('/', '').toUpperCase();
}
