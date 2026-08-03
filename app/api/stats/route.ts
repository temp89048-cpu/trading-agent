// Server-side so it can read both file-backed stores directly
// (lib/tradeStore.server.ts, lib/reflectionStore.server.ts) without a
// round trip through two separate client fetches — same reasoning as
// every other server-only aggregation route in this app.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

import { listTrades } from '@/lib/tradeStore.server';
import { listReflections } from '@/lib/reflectionStore.server';
import { buildDashboardStats } from '@/lib/learningDashboard';
import type { TradeTab } from '@/lib/types';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tabParam = searchParams.get('tab');
  const tab = tabParam === 'paper' || tabParam === 'real' ? (tabParam as TradeTab) : undefined;

  const [trades, reflections] = await Promise.all([listTrades(tab), listReflections()]);
  const reflectedTradeIds = new Set(reflections.map((r) => r.tradeId));
  const stats = buildDashboardStats(trades, reflectedTradeIds);

  return Response.json({ stats, tab: tab ?? 'all' });
}
