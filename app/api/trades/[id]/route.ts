import { getTrade, deleteTrade } from '@/lib/tradeStore.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function isAuthorized(req: Request): boolean {
  const required = process.env.TRADES_API_KEY;
  if (!required) return true;
  const header = req.headers.get('authorization') || '';
  return header === `Bearer ${required}`;
}

export async function GET(_req: Request, { params }: { params: { id: string } }) {
  const trade = await getTrade(params.id);
  if (!trade) return Response.json({ error: 'Trade not found' }, { status: 404 });
  return Response.json({ trade });
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  if (!isAuthorized(req)) {
    return Response.json({ error: 'Unauthorized — missing or wrong Authorization header' }, { status: 401 });
  }
  const removed = await deleteTrade(params.id);
  if (!removed) return Response.json({ error: 'Trade not found' }, { status: 404 });
  return Response.json({ deleted: true });
}
