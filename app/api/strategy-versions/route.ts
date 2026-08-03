import { listStrategyVersions, addStrategyVersion } from '@/lib/strategyVersionStore.server';
import type { NewStrategyVersion } from '@/lib/strategyVersionStore.server';

// Strategy Versioning (Production Readiness Review #7) — append-only,
// see lib/strategyVersionStore.server.ts's header for exactly what's
// versioned and why (the Backtest Optimizer's TunableParams, not the
// hardcoded live Strategy Ensemble). Node runtime, file-backed, same
// shape as /api/trades and /api/decisions.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = searchParams.get('symbol') ?? undefined;
  const all = await listStrategyVersions(symbol);
  return Response.json({ versions: all });
}

export async function POST(req: Request) {
  let body: Partial<NewStrategyVersion>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.symbol || typeof body.symbol !== 'string') {
    return Response.json({ error: 'symbol is required' }, { status: 400 });
  }
  if (body.assetType !== 'crypto' && body.assetType !== 'equity') {
    return Response.json({ error: 'assetType must be crypto or equity' }, { status: 400 });
  }
  if (!body.params || typeof body.params !== 'object') {
    return Response.json({ error: 'params (TunableParams) is required' }, { status: 400 });
  }

  const record: NewStrategyVersion = {
    symbol: body.symbol,
    assetType: body.assetType,
    interval: typeof body.interval === 'string' ? body.interval : '1h',
    objective: (typeof body.objective === 'string' ? body.objective : 'profitFactor') as NewStrategyVersion['objective'],
    algorithm: typeof body.algorithm === 'string' ? body.algorithm : 'grid',
    params: body.params as NewStrategyVersion['params'],
    trainMetrics: body.trainMetrics ?? null,
    testMetrics: body.testMetrics ?? null,
    stabilityScore: typeof body.stabilityScore === 'number' ? body.stabilityScore : null,
    note: typeof body.note === 'string' ? body.note : undefined,
  };

  const saved = await addStrategyVersion(record);
  return Response.json({ version: saved }, { status: 201 });
}
