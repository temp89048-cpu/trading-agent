import { runMonteCarlo, type MonteCarloMode } from '@/lib/backtest/monteCarlo';
import type { BacktestTrade } from '@/lib/backtest/engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Takes the trade list from an already-completed backtest (the client
// already has it from POST /api/backtest — no need to re-run the
// backtest here) and resamples it. Pure computation, no external fetch,
// but kept as a route rather than done client-side so heavier
// simulation counts (thousands of resamples) don't block the UI thread.

export async function POST(req: Request) {
  let body: {
    trades?: BacktestTrade[];
    initialCapitalUsd?: number;
    simulations?: number;
    mode?: MonteCarloMode;
    ruinThresholdPct?: number;
    seed?: number;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { trades, initialCapitalUsd, simulations, mode, ruinThresholdPct, seed } = body;
  if (!trades || !Array.isArray(trades)) return Response.json({ error: 'trades array is required' }, { status: 400 });
  if (!initialCapitalUsd || initialCapitalUsd <= 0) return Response.json({ error: 'initialCapitalUsd must be a positive number' }, { status: 400 });

  const result = runMonteCarlo({ trades, initialCapitalUsd, simulations, mode, ruinThresholdPct, seed });
  if ('error' in result) return Response.json({ error: result.error }, { status: 422 });

  return Response.json({ result });
}
