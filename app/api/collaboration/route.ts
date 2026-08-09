import { listCollaborationRecords, appendCollaborationRecord, type CollaborationRecord } from '@/lib/collaborationStore.server';

// Node runtime, not edge — filesystem-backed, same as /api/reflections
// and /api/hypotheses.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const all = await listCollaborationRecords();
  return Response.json({ records: all });
}

export async function POST(req: Request) {
  let body: Partial<CollaborationRecord>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { id, symbol, side, ownConfidencePct, triggerReason, provider, model, opinion, error } = body;
  if (!id || typeof id !== 'string') return Response.json({ error: 'id is required' }, { status: 400 });
  if (!symbol || typeof symbol !== 'string') return Response.json({ error: 'symbol is required' }, { status: 400 });
  if (side !== 'buy' && side !== 'sell') return Response.json({ error: 'side must be buy or sell' }, { status: 400 });

  const record: CollaborationRecord = {
    id,
    ts: Date.now(),
    symbol,
    side,
    ownConfidencePct: typeof ownConfidencePct === 'number' ? ownConfidencePct : 0,
    triggerReason: typeof triggerReason === 'string' ? triggerReason : '',
    provider: typeof provider === 'string' ? provider : '',
    model: typeof model === 'string' ? model : '',
    opinion: opinion && typeof opinion === 'object' ? opinion : null,
    error: typeof error === 'string' ? error : null,
  };

  const saved = await appendCollaborationRecord(record);
  return Response.json({ record: saved }, { status: 201 });
}
