import { appendPvSample, listPvHistory, type PvSample } from '@/lib/pvHistoryStore.server';
import type { TradeTab } from '@/lib/types';

// Portfolio-value samples. `complete: false` marks a total computed while some
// position had no price — a PARTIAL figure. It is returned as recorded rather than
// smoothed over, because plotting a partial total beside complete ones draws a
// cliff that looks like a loss and never happened.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tabParam = searchParams.get('tab');
  const tab = tabParam === 'paper' || tabParam === 'real' ? (tabParam as TradeTab) : undefined;

  const samples = await listPvHistory(tab);
  if (samples === null) {
    return Response.json({
      samples: null,
      source: 'none',
      note: 'No DATABASE_URL configured. The browser should keep its own history.',
    });
  }
  return Response.json({
    samples,
    source: 'postgres',
    count: samples.length,
    partial: samples.filter((s) => !s.complete).length,
  });
}

export async function POST(req: Request) {
  let body: Partial<PvSample>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { tab, ts, totalValue } = body;
  if (
    (tab !== 'paper' && tab !== 'real') ||
    typeof ts !== 'number' ||
    !Number.isFinite(ts) ||
    typeof totalValue !== 'number' ||
    !Number.isFinite(totalValue)
  ) {
    return Response.json(
      { error: 'Body must be { tab: "paper"|"real", ts: number, totalValue: number, ... }' },
      { status: 400 },
    );
  }

  const ok = await appendPvSample({
    tab,
    ts,
    totalValue,
    cash: typeof body.cash === 'number' ? body.cash : null,
    positionsValue: typeof body.positionsValue === 'number' ? body.positionsValue : null,
    // Defaults to INCOMPLETE when the caller does not say. An unmarked sample
    // asserting completeness it never verified is the failure this flag exists
    // to prevent.
    complete: body.complete === true,
  });

  if (!ok) {
    return Response.json({ saved: false, source: 'none' }, { status: 503 });
  }
  return Response.json({ saved: true, source: 'postgres' });
}
