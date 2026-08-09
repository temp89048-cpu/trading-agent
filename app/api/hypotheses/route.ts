import { listHypotheses, getHypothesisByTradeId, saveHypothesis, updateHypothesisStatus, type HypothesisRecord, type HypothesisStatus } from '@/lib/hypothesisStore.server';

// Node runtime, not edge — filesystem-backed, same as /api/reflections.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const VALID_STATUSES: HypothesisStatus[] = ['proposed', 'dismissed', 'validated', 'rejected', 'applied'];

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tradeId = searchParams.get('tradeId');
  if (tradeId) {
    const record = await getHypothesisByTradeId(tradeId);
    return Response.json({ hypothesis: record });
  }
  const all = await listHypotheses();
  return Response.json({ hypotheses: all });
}

export async function POST(req: Request) {
  let body: Partial<HypothesisRecord>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { id, tradeId, symbol, claim, suggestedTest } = body;
  if (!id || typeof id !== 'string') return Response.json({ error: 'id is required' }, { status: 400 });
  if (!tradeId || typeof tradeId !== 'string') return Response.json({ error: 'tradeId is required' }, { status: 400 });
  if (!symbol || typeof symbol !== 'string') return Response.json({ error: 'symbol is required' }, { status: 400 });
  if (!claim || typeof claim !== 'string') return Response.json({ error: 'claim is required' }, { status: 400 });
  if (!suggestedTest || typeof suggestedTest !== 'string') return Response.json({ error: 'suggestedTest is required' }, { status: 400 });

  const record: HypothesisRecord = {
    id,
    tradeId,
    ts: Date.now(),
    symbol,
    claim,
    suggestedTest,
    status: 'proposed',
    reviewNote: null,
    updatedAt: Date.now(),
  };

  const saved = await saveHypothesis(record);
  return Response.json({ hypothesis: saved }, { status: 201 });
}

// Human review actions only — mark dismissed/validated/rejected/applied
// with an optional note. Nothing in this codebase calls PATCH with
// 'applied' except a person clicking the Apply button in
// components/HypothesisPanel.tsx after already changing the relevant
// config themselves; this endpoint does not touch any config store.
export async function PATCH(req: Request) {
  let body: { id?: string; status?: string; reviewNote?: string | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  const { id, status, reviewNote } = body;
  if (!id || typeof id !== 'string') return Response.json({ error: 'id is required' }, { status: 400 });
  if (!status || !VALID_STATUSES.includes(status as HypothesisStatus)) {
    return Response.json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` }, { status: 400 });
  }
  const updated = await updateHypothesisStatus(id, status as HypothesisStatus, typeof reviewNote === 'string' ? reviewNote : null);
  if (!updated) return Response.json({ error: 'hypothesis not found' }, { status: 404 });
  return Response.json({ hypothesis: updated });
}
