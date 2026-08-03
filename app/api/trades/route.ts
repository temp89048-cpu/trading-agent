import { listTrades, addTrade } from '@/lib/tradeStore.server';
import type { NewTrade } from '@/lib/tradeStore.server';
import type { TradeTab, TradeSide } from '@/lib/types';

// Node runtime, not edge — this route uses the filesystem (see
// lib/tradeStore.server.ts for the persistence caveat).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Optional shared-secret auth: if TRADES_API_KEY is set in the
// environment, writes (POST/DELETE) require it. Reads (GET) stay open
// so the in-app UI doesn't need to carry a secret around in the
// browser. Unset by default, so local use needs zero setup — but if
// you expose this server beyond your own machine, set this.
function isAuthorized(req: Request): boolean {
  const required = process.env.TRADES_API_KEY;
  if (!required) return true;
  const header = req.headers.get('authorization') || '';
  return header === `Bearer ${required}`;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tabParam = searchParams.get('tab');
  const tab = tabParam === 'paper' || tabParam === 'real' ? (tabParam as TradeTab) : undefined;
  const trades = await listTrades(tab);
  return Response.json({ trades });
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return Response.json({ error: 'Unauthorized — missing or wrong Authorization header' }, { status: 401 });
  }

  let body: {
    tab?: string;
    symbol?: string;
    side?: string;
    qty?: number;
    price?: number;
    note?: string;
    pnl?: number;
    entryContext?: string;
    debateId?: string;
    originTag?: string;
    exchangeOrderId?: string;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { tab, symbol, side, qty, price, note, pnl, entryContext, debateId, originTag, exchangeOrderId } = body;

  if (tab !== 'paper' && tab !== 'real') {
    return Response.json({ error: 'tab must be "paper" or "real"' }, { status: 400 });
  }
  if (side !== 'buy' && side !== 'sell') {
    return Response.json({ error: 'side must be "buy" or "sell"' }, { status: 400 });
  }
  if (!symbol || typeof symbol !== 'string') {
    return Response.json({ error: 'symbol is required' }, { status: 400 });
  }
  if (typeof qty !== 'number' || !isFinite(qty) || qty <= 0) {
    return Response.json({ error: 'qty must be a positive number' }, { status: 400 });
  }
  if (typeof price !== 'number' || !isFinite(price) || price <= 0) {
    return Response.json({ error: 'price must be a positive number' }, { status: 400 });
  }

  const VALID_ORIGIN_TAGS = ['debate', 'chat-trade-action', 'agent-plan', 'user-command', 'manual-click'];

  const entry = await addTrade({
    tab: tab as TradeTab,
    symbol: symbol.toUpperCase(),
    side: side as TradeSide,
    qty,
    price,
    note,
    pnl: typeof pnl === 'number' && isFinite(pnl) ? pnl : undefined,
    entryContext: typeof entryContext === 'string' ? entryContext : undefined,
    debateId: typeof debateId === 'string' ? debateId : undefined,
    originTag: typeof originTag === 'string' && VALID_ORIGIN_TAGS.includes(originTag) ? (originTag as NewTrade['originTag']) : undefined,
    exchangeOrderId: typeof exchangeOrderId === 'string' ? exchangeOrderId : undefined,
  });

  return Response.json({ trade: entry }, { status: 201 });
}
