import * as binance from '@/lib/exchangeClients/binance.server';
import * as bybit from '@/lib/exchangeClients/bybit.server';
import type { ExchangeCredentials, ExchangeAccountSnapshot, PlaceOrderParams, OrderResult, OrderStatusResult, CancelOrderResult, TradingExchangeId } from '@/lib/exchangeClients/types';

// ---------------------------------------------------------------------
// Real Exchange Trading — the one server-side entry point for every
// signed Binance/Bybit call. Same trust model as this app's existing
// /api/chat route for LLM provider keys: the client holds the API
// key/secret (see components/ExchangeAccounts.tsx, localStorage) and
// sends it here per request; this route signs and forwards the actual
// exchange call server-side (needed for HMAC signing with Node's
// `crypto`, and to avoid the browser talking directly to an exchange's
// signed endpoints). Nothing here logs or persists the secret — it's
// used in-memory for exactly one outbound request, then discarded when
// this handler returns.
//
// IMPORTANT for self-hosting: this means the API secret crosses the
// network from browser to this Next.js server on every call, same as
// the LLM key already does. Fine for localhost; if you ever deploy this
// somewhere other than your own machine, that channel needs to be
// HTTPS, and the exposure model is materially different from a purely
// client-side app. Read this before deploying, not after.
// ---------------------------------------------------------------------

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ExchangeAction = 'balance' | 'placeOrder' | 'orderStatus' | 'cancelOrder';

type RequestBody = {
  exchange: TradingExchangeId;
  apiKey: string;
  apiSecret: string;
  testnet: boolean;
  action: ExchangeAction;
  params?: {
    symbol?: string;
    side?: 'buy' | 'sell';
    qty?: number;
    exchangeOrderId?: string;
    clientOrderId?: string; // idempotency key — see lib/executionQuality.ts
  };
};

// The dispatcher only ever calls these four functions — deliberately
// narrower than `typeof binance`/`typeof bybit` (which now also export
// `sign`, with a different signature per exchange purely for unit
// testing — see each file's test). This interface is what actually
// needs to be uniform across exchanges.
type ExchangeClient = {
  getAccountSnapshot(creds: ExchangeCredentials): Promise<{ ok: true; snapshot: ExchangeAccountSnapshot } | { ok: false; error: string }>;
  placeMarketOrder(creds: ExchangeCredentials, params: PlaceOrderParams): Promise<OrderResult>;
  getOrderStatus(creds: ExchangeCredentials, symbol: string, exchangeOrderId: string): Promise<OrderStatusResult>;
  cancelOrder(creds: ExchangeCredentials, symbol: string, exchangeOrderId: string): Promise<CancelOrderResult>;
};

const CLIENTS: Record<TradingExchangeId, ExchangeClient> = { binance, bybit };

export async function POST(req: Request) {
  let body: Partial<RequestBody>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.exchange !== 'binance' && body.exchange !== 'bybit') {
    return Response.json({ ok: false, error: 'exchange must be "binance" or "bybit"' }, { status: 400 });
  }
  if (!body.apiKey || !body.apiSecret) {
    return Response.json({ ok: false, error: 'apiKey and apiSecret are required' }, { status: 400 });
  }
  if (!body.action || !['balance', 'placeOrder', 'orderStatus', 'cancelOrder'].includes(body.action)) {
    return Response.json({ ok: false, error: 'action must be one of balance, placeOrder, orderStatus, cancelOrder' }, { status: 400 });
  }

  const creds: ExchangeCredentials = { apiKey: body.apiKey, apiSecret: body.apiSecret, testnet: body.testnet === true };
  const client = CLIENTS[body.exchange];

  try {
    if (body.action === 'balance') {
      const result = await client.getAccountSnapshot(creds);
      return Response.json(result);
    }

    if (body.action === 'placeOrder') {
      const p = body.params;
      if (!p?.symbol || (p.side !== 'buy' && p.side !== 'sell') || typeof p.qty !== 'number' || p.qty <= 0) {
        return Response.json({ ok: false, error: 'placeOrder needs params: { symbol, side: "buy"|"sell", qty > 0 }' }, { status: 400 });
      }
      const orderParams: PlaceOrderParams = {
        symbol: p.symbol,
        side: p.side,
        qty: p.qty,
        // Passed straight through — this is the idempotency key the
        // exchange uses to reject a duplicate retry.
        ...(typeof p.clientOrderId === 'string' && p.clientOrderId ? { clientOrderId: p.clientOrderId } : {}),
      };
      const result = await client.placeMarketOrder(creds, orderParams);
      return Response.json(result);
    }

    if (body.action === 'orderStatus') {
      const p = body.params;
      if (!p?.symbol || !p.exchangeOrderId) {
        return Response.json({ ok: false, error: 'orderStatus needs params: { symbol, exchangeOrderId }' }, { status: 400 });
      }
      const result = await client.getOrderStatus(creds, p.symbol, p.exchangeOrderId);
      return Response.json(result);
    }

    // cancelOrder
    const p = body.params;
    if (!p?.symbol || !p.exchangeOrderId) {
      return Response.json({ ok: false, error: 'cancelOrder needs params: { symbol, exchangeOrderId }' }, { status: 400 });
    }
    const result = await client.cancelOrder(creds, p.symbol, p.exchangeOrderId);
    return Response.json(result);
  } catch (err) {
    // Deliberately generic — never let a raw error object that might
    // embed request details near the credentials leak back verbatim.
    return Response.json({ ok: false, error: err instanceof Error ? err.message : 'Exchange request failed unexpectedly' }, { status: 500 });
  }
}
