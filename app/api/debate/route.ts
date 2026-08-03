import { listDebateRecords, saveDebateRecord, linkDebateToTrade, updateDebateOutcomeByTradeId } from '@/lib/debateStore.server';
import type { DebateRecord } from '@/lib/debate/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') ?? undefined;
  const records = await listDebateRecords(symbol);
  return Response.json({ records });
}

export async function POST(req: Request) {
  let body: Partial<DebateRecord>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }
  if (!body.id || !body.symbol || !body.opinions || !body.moderator) {
    return Response.json({ error: 'id, symbol, opinions, and moderator are required' }, { status: 400 });
  }
  const record: DebateRecord = {
    id: body.id,
    ts: body.ts ?? Date.now(),
    symbol: body.symbol,
    opinions: body.opinions,
    moderator: body.moderator,
    regime: body.regime ?? null,
    calibratedConfidence: body.calibratedConfidence ?? null,
    riskLevel: body.riskLevel ?? 'Medium',
    suggestedPositionPct: body.suggestedPositionPct ?? null,
    tradeId: body.tradeId ?? null,
    outcome: null,
    outcomePnlUsd: null,
  };
  const saved = await saveDebateRecord(record);
  return Response.json({ record: saved }, { status: 201 });
}

// PATCH covers two distinct, narrow updates — linking a debate to the
// trade the user actually placed, and later recording that trade's
// outcome. Both are deliberately the ONLY mutations this route allows;
// a debate record's opinions/moderator/etc. are never edited after the
// fact, since retroactively changing what was "predicted" would corrupt
// the calibration/reputation data that depends on it being untouched.
export async function PATCH(req: Request) {
  let body: { debateId?: string; tradeId?: string; outcome?: 'win' | 'loss'; outcomePnlUsd?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (body.debateId && body.tradeId && !body.outcome) {
    const updated = await linkDebateToTrade(body.debateId, body.tradeId);
    if (!updated) return Response.json({ error: 'Debate record not found' }, { status: 404 });
    return Response.json({ record: updated });
  }

  if (body.tradeId && body.outcome && typeof body.outcomePnlUsd === 'number') {
    const updated = await updateDebateOutcomeByTradeId(body.tradeId, body.outcome, body.outcomePnlUsd);
    if (!updated) return Response.json({ error: 'No debate record linked to that tradeId' }, { status: 404 });
    return Response.json({ record: updated });
  }

  return Response.json({ error: 'Provide either { debateId, tradeId } to link, or { tradeId, outcome, outcomePnlUsd } to record an outcome' }, { status: 400 });
}
