import { getWatchlist, saveWatchlist } from '@/lib/watchlistStore.server';
import type { WatchItem } from '@/lib/types';

// The watchlist, server-backed. Same contract as /api/portfolio: `source: 'none'`
// means there is no database and the client should keep its localStorage copy —
// it does NOT mean the watchlist is empty.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const items = await getWatchlist();
  if (items === null) {
    return Response.json({
      watchlist: null,
      source: 'none',
      note: 'No DATABASE_URL configured. The browser should keep its own list.',
    });
  }
  return Response.json({ watchlist: items, source: 'postgres' });
}

export async function PUT(req: Request) {
  let body: { watchlist?: WatchItem[] };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!Array.isArray(body.watchlist)) {
    return Response.json({ error: 'Body must be { watchlist: WatchItem[] }' }, { status: 400 });
  }
  const ok = await saveWatchlist(body.watchlist);
  if (!ok) {
    return Response.json(
      { saved: false, source: 'none', note: 'No DATABASE_URL configured; nothing was stored.' },
      { status: 503 },
    );
  }
  return Response.json({ saved: true, source: 'postgres', count: body.watchlist.length });
}
