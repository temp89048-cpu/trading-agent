import { createHmac } from 'crypto';
import { toExchangeSymbol, type ExchangeCredentials, type ExchangeAccountSnapshot, type PlaceOrderParams, type OrderResult, type OrderStatusResult, type CancelOrderResult } from './types';

// ---------------------------------------------------------------------
// Binance SPOT trading — signed REST calls. Server-only (uses Node's
// `crypto` for HMAC-SHA256 request signing) — never import this from a
// 'use client' component. See types.ts for the scope note (spot only,
// no futures/margin) and the LOT_SIZE precision caveat.
//
// API reference this was written against (verify against current docs —
// exchange APIs change; this file was NOT tested against a live Binance
// endpoint, since this sandbox has no route to api.binance.com, same
// limitation noted elsewhere in this codebase for candle/quote fetching):
//   https://binance-docs.github.io/apidocs/spot/en/
// ---------------------------------------------------------------------

const MAINNET_BASE = 'https://api.binance.com';
const TESTNET_BASE = 'https://testnet.binance.vision';
const RECV_WINDOW_MS = 5000;

function baseUrl(creds: ExchangeCredentials): string {
  return creds.testnet ? TESTNET_BASE : MAINNET_BASE;
}

// Exported for testing (lib/exchangeClients/binance.test.ts) — pure HMAC
// math, no network, safe to exercise directly with test-only secrets.
export function sign(secret: string, queryString: string): string {
  return createHmac('sha256', secret).update(queryString).digest('hex');
}

async function signedRequest(
  creds: ExchangeCredentials,
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  params: Record<string, string | number>,
): Promise<{ ok: true; json: any } | { ok: false; error: string; raw?: unknown }> {
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) query.set(k, String(v));
  query.set('timestamp', String(Date.now()));
  query.set('recvWindow', String(RECV_WINDOW_MS));

  const signature = sign(creds.apiSecret, query.toString());
  query.set('signature', signature);

  const url = `${baseUrl(creds)}${path}?${query.toString()}`;
  try {
    const res = await fetch(url, {
      method,
      headers: { 'X-MBX-APIKEY': creds.apiKey },
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      // Binance error responses are {code, msg} — surface msg directly,
      // never swallow a rejected order silently.
      return { ok: false, error: json?.msg ? `Binance ${res.status}: ${json.msg}` : `Binance HTTP ${res.status}`, raw: json };
    }
    return { ok: true, json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Binance request failed' };
  }
}

export async function getAccountSnapshot(creds: ExchangeCredentials): Promise<{ ok: true; snapshot: ExchangeAccountSnapshot } | { ok: false; error: string }> {
  const result = await signedRequest(creds, 'GET', '/api/v3/account', {});
  if (!result.ok) return result;
  const balances = Array.isArray(result.json?.balances)
    ? result.json.balances
        .map((b: any) => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }))
        .filter((b: any) => b.free > 0 || b.locked > 0)
    : [];
  return { ok: true, snapshot: { balances, raw: result.json } };
}

export async function placeMarketOrder(creds: ExchangeCredentials, params: PlaceOrderParams): Promise<OrderResult> {
  const symbol = toExchangeSymbol(params.symbol);
  // Quantity precision: sent as-is, rounded to a conservative 6 decimal
  // places. This does NOT query the symbol's real LOT_SIZE step size
  // (would require a separate exchangeInfo call + per-symbol caching) —
  // if this symbol's step size disagrees, Binance rejects the order with
  // a clear "LOT_SIZE" error surfaced below, rather than silently
  // resizing to something the caller didn't ask for.
  const qty = Number(params.qty.toFixed(6));
  const result = await signedRequest(creds, 'POST', '/api/v3/order', {
    symbol,
    side: params.side.toUpperCase(),
    type: 'MARKET',
    quantity: qty,
    // Idempotency: Binance rejects a second order reusing the same
    // newClientOrderId with -2010 "Duplicate order sent", which is
    // exactly the protection a retry needs. Omitted entirely when the
    // caller didn't supply one, so Binance falls back to generating its
    // own (previous behavior) rather than us inventing a key that
    // wouldn't be stable across retries anyway.
    ...(params.clientOrderId ? { newClientOrderId: params.clientOrderId } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error, raw: result.raw };
  const json = result.json;
  const fills: any[] = Array.isArray(json.fills) ? json.fills : [];
  const filledQty = fills.length > 0 ? fills.reduce((s, f) => s + parseFloat(f.qty), 0) : (typeof json.executedQty === 'string' ? parseFloat(json.executedQty) : null);
  const avgFillPrice =
    fills.length > 0
      ? fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0) / fills.reduce((s, f) => s + parseFloat(f.qty), 0)
      : null;
  return {
    ok: true,
    exchangeOrderId: String(json.orderId),
    status: json.status ?? 'UNKNOWN',
    filledQty,
    avgFillPrice,
    raw: json,
  };
}

export async function getOrderStatus(creds: ExchangeCredentials, symbol: string, exchangeOrderId: string): Promise<OrderStatusResult> {
  const result = await signedRequest(creds, 'GET', '/api/v3/order', { symbol: toExchangeSymbol(symbol), orderId: exchangeOrderId });
  if (!result.ok) return result;
  const json = result.json;
  return {
    ok: true,
    status: json.status ?? 'UNKNOWN',
    filledQty: typeof json.executedQty === 'string' ? parseFloat(json.executedQty) : null,
    avgFillPrice: null, // /api/v3/order doesn't report avg fill price directly — use myTrades for that if ever needed
    raw: json,
  };
}

export async function cancelOrder(creds: ExchangeCredentials, symbol: string, exchangeOrderId: string): Promise<CancelOrderResult> {
  const result = await signedRequest(creds, 'DELETE', '/api/v3/order', { symbol: toExchangeSymbol(symbol), orderId: exchangeOrderId });
  if (!result.ok) return result;
  return { ok: true, raw: result.json };
}
