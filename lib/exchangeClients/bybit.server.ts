import { createHmac } from 'crypto';
import { toExchangeSymbol, type ExchangeCredentials, type ExchangeAccountSnapshot, type PlaceOrderParams, type OrderResult, type OrderStatusResult, type CancelOrderResult } from './types';

// ---------------------------------------------------------------------
// Bybit SPOT trading (V5 Unified Account API) — signed REST calls.
// Server-only (Node's `crypto`) — never import from a 'use client'
// component. See types.ts for scope (spot only, no futures/margin) and
// the LOT_SIZE-equivalent precision caveat.
//
// API reference this was written against (verify against current docs —
// NOT tested against a live Bybit endpoint, this sandbox has no route to
// api.bybit.com):
//   https://bybit-exchange.github.io/docs/v5/intro
// ---------------------------------------------------------------------

const MAINNET_BASE = 'https://api.bybit.com';
const TESTNET_BASE = 'https://api-testnet.bybit.com';
const RECV_WINDOW_MS = 5000;

function baseUrl(creds: ExchangeCredentials): string {
  return creds.testnet ? TESTNET_BASE : MAINNET_BASE;
}

// Bybit V5's signature covers timestamp + apiKey + recvWindow + payload,
// where payload is the raw query string for GET or the exact JSON body
// string for POST — must match byte-for-byte what's actually sent.
// Exported for testing (lib/exchangeClients/bybit.test.ts) — pure HMAC
// math, no network, safe to exercise directly with test-only secrets.
export function sign(secret: string, timestamp: string, apiKey: string, recvWindow: string, payload: string): string {
  return createHmac('sha256', secret).update(timestamp + apiKey + recvWindow + payload).digest('hex');
}

async function signedGet(creds: ExchangeCredentials, path: string, params: Record<string, string>): Promise<{ ok: true; json: any } | { ok: false; error: string; raw?: unknown }> {
  const query = new URLSearchParams(params).toString();
  const timestamp = String(Date.now());
  const recvWindow = String(RECV_WINDOW_MS);
  const signature = sign(creds.apiSecret, timestamp, creds.apiKey, recvWindow, query);
  const url = `${baseUrl(creds)}${path}${query ? `?${query}` : ''}`;
  return bybitFetch(url, 'GET', undefined, creds, timestamp, recvWindow, signature);
}

async function signedPost(creds: ExchangeCredentials, path: string, body: Record<string, unknown>): Promise<{ ok: true; json: any } | { ok: false; error: string; raw?: unknown }> {
  const bodyStr = JSON.stringify(body);
  const timestamp = String(Date.now());
  const recvWindow = String(RECV_WINDOW_MS);
  const signature = sign(creds.apiSecret, timestamp, creds.apiKey, recvWindow, bodyStr);
  const url = `${baseUrl(creds)}${path}`;
  return bybitFetch(url, 'POST', bodyStr, creds, timestamp, recvWindow, signature);
}

async function bybitFetch(
  url: string,
  method: 'GET' | 'POST',
  body: string | undefined,
  creds: ExchangeCredentials,
  timestamp: string,
  recvWindow: string,
  signature: string,
): Promise<{ ok: true; json: any } | { ok: false; error: string; raw?: unknown }> {
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'X-BAPI-API-KEY': creds.apiKey,
        'X-BAPI-TIMESTAMP': timestamp,
        'X-BAPI-RECV-WINDOW': recvWindow,
        'X-BAPI-SIGN': signature,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body,
    });
    const json = await res.json().catch(() => null);
    // Bybit returns HTTP 200 even for application-level errors — the
    // real success/failure signal is retCode (0 = success). A grossly
    // malformed/nonexistent key can also be rejected by Bybit's edge
    // (CloudFront) BEFORE it ever reaches the application layer — that
    // response has an EMPTY body (json parses to null) but a real reason
    // in the HTTP status line itself (e.g. "401 API key is invalid."),
    // which res.statusText captures — falling back to a bare "HTTP 401"
    // would silently drop that information.
    if (!res.ok || (json && typeof json.retCode === 'number' && json.retCode !== 0)) {
      const msg = json?.retMsg ? `Bybit: ${json.retMsg} (retCode ${json.retCode})` : `Bybit HTTP ${res.status}${res.statusText ? `: ${res.statusText}` : ''}`;
      return { ok: false, error: msg, raw: json };
    }
    return { ok: true, json };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Bybit request failed' };
  }
}

export async function getAccountSnapshot(creds: ExchangeCredentials): Promise<{ ok: true; snapshot: ExchangeAccountSnapshot } | { ok: false; error: string }> {
  const result = await signedGet(creds, '/v5/account/wallet-balance', { accountType: 'UNIFIED' });
  if (!result.ok) return result;
  const coins = result.json?.result?.list?.[0]?.coin ?? [];
  const balances = Array.isArray(coins)
    ? coins
        .map((c: any) => ({ asset: c.coin, free: parseFloat(c.walletBalance) - parseFloat(c.locked || '0'), locked: parseFloat(c.locked || '0') }))
        .filter((b: any) => b.free > 0 || b.locked > 0)
    : [];
  return { ok: true, snapshot: { balances, raw: result.json } };
}

export async function placeMarketOrder(creds: ExchangeCredentials, params: PlaceOrderParams): Promise<OrderResult> {
  const symbol = toExchangeSymbol(params.symbol);
  // Same precision caveat as binance.server.ts's placeMarketOrder — see
  // that file's comment. Bybit rejects with a clear error on a step-size
  // mismatch rather than this silently resizing the order.
  const qty = params.qty.toFixed(6);
  const result = await signedPost(creds, '/v5/order/create', {
    category: 'spot',
    symbol,
    side: params.side === 'buy' ? 'Buy' : 'Sell',
    orderType: 'Market',
    qty,
    // Idempotency: Bybit V5 rejects a duplicate orderLinkId, which is
    // what makes a retry safe. Omitted when the caller didn't supply one
    // (previous behavior) rather than inventing an unstable key.
    ...(params.clientOrderId ? { orderLinkId: params.clientOrderId } : {}),
  });
  if (!result.ok) return { ok: false, error: result.error, raw: result.raw };
  const orderId = result.json?.result?.orderId;
  if (!orderId) return { ok: false, error: 'Bybit accepted the request but returned no orderId', raw: result.json };
  // Bybit's order/create response doesn't include fill data synchronously
  // for a market order — the caller (Supervisor) should follow up with
  // getOrderStatus to get the actual fill price/qty before ledgering it.
  return { ok: true, exchangeOrderId: String(orderId), status: 'Submitted', filledQty: null, avgFillPrice: null, raw: result.json };
}

export async function getOrderStatus(creds: ExchangeCredentials, symbol: string, exchangeOrderId: string): Promise<OrderStatusResult> {
  const result = await signedGet(creds, '/v5/order/realtime', { category: 'spot', symbol: toExchangeSymbol(symbol), orderId: exchangeOrderId });
  if (!result.ok) return result;
  const order = result.json?.result?.list?.[0];
  if (!order) return { ok: false, error: 'Order not found in Bybit response', raw: result.json };
  return {
    ok: true,
    status: order.orderStatus ?? 'Unknown',
    filledQty: order.cumExecQty !== undefined ? parseFloat(order.cumExecQty) : null,
    avgFillPrice: order.avgPrice ? parseFloat(order.avgPrice) : null,
    raw: result.json,
  };
}

export async function cancelOrder(creds: ExchangeCredentials, symbol: string, exchangeOrderId: string): Promise<CancelOrderResult> {
  const result = await signedPost(creds, '/v5/order/cancel', { category: 'spot', symbol: toExchangeSymbol(symbol), orderId: exchangeOrderId });
  if (!result.ok) return result;
  return { ok: true, raw: result.json };
}
