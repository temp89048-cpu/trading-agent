import { listAutonomousCycles, appendAutonomousCycle, type AutonomousCycleRecord } from '@/lib/autonomousCycleStore.server';

// Node runtime, not edge — filesystem-backed, same as /api/reflections,
// /api/hypotheses, /api/collaboration.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const all = await listAutonomousCycles();
  return Response.json({ cycles: all });
}

export async function POST(req: Request) {
  let body: Partial<AutonomousCycleRecord>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { id, outcome, considered, decisionSummary } = body;
  if (!id || typeof id !== 'string') return Response.json({ error: 'id is required' }, { status: 400 });
  if (outcome !== 'traded' && outcome !== 'no-trade' && outcome !== 'error') {
    return Response.json({ error: 'outcome must be traded, no-trade, or error' }, { status: 400 });
  }
  if (typeof decisionSummary !== 'string' || !decisionSummary) {
    return Response.json({ error: 'decisionSummary is required — an unexplained autonomous cycle is not recordable' }, { status: 400 });
  }

  const record: AutonomousCycleRecord = {
    id,
    ts: Date.now(),
    outcome,
    considered: Array.isArray(considered) ? considered : [],
    actedSymbol: typeof body.actedSymbol === 'string' ? body.actedSymbol : null,
    actedSide: body.actedSide === 'buy' || body.actedSide === 'sell' ? body.actedSide : null,
    actedMarginUsd: typeof body.actedMarginUsd === 'number' ? body.actedMarginUsd : null,
    actedLeverage: typeof body.actedLeverage === 'number' ? body.actedLeverage : null,
    agentTaskId: typeof body.agentTaskId === 'string' ? body.agentTaskId : null,
    decisionSummary,
    missionId: typeof body.missionId === 'string' ? body.missionId : null,
    missionProgressPct: typeof body.missionProgressPct === 'number' ? body.missionProgressPct : null,
  };

  const saved = await appendAutonomousCycle(record);
  return Response.json({ cycle: saved }, { status: 201 });
}
