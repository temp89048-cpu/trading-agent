import { runOptimizer, type ParamGrid, type OptimizerObjective } from '@/lib/backtest/optimizer';
import { MTF_TIMEFRAMES, type MtfTimeframe } from '@/lib/multiTimeframe';
import type { SizingMethod } from '@/lib/backtest/engine';
import type { SearchAlgorithmName } from '@/lib/backtest/searchAlgorithms';
import { fetchPrimaryAndMtf } from '@/lib/backtest/historyService.server';
import { parseCandlesCsv } from '@/lib/candleProviders/csvImport';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Grid/random/genetic/bayesian search all run entirely server-side in
// one request — fetching history once and running potentially hundreds
// of backtests here is far better than the client doing one HTTP round
// trip per param combo.

export async function POST(req: Request) {
  let body: {
    symbol?: string;
    type?: 'crypto' | 'equity';
    interval?: string;
    barCount?: number;
    customCandlesCsv?: string;
    grid?: ParamGrid;
    folds?: number;
    trainRatio?: number;
    objective?: OptimizerObjective;
    minTradesForViability?: number;
    algorithm?: SearchAlgorithmName;
    evaluationBudget?: number;
    initialCapitalUsd?: number;
    riskPct?: number;
    sizingMethod?: SizingMethod;
    feeBps?: number;
    slippageBps?: number;
    confidenceThreshold?: number;
    rollingWindowBars?: number;
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { symbol, type, grid, folds, trainRatio, objective, minTradesForViability, algorithm, evaluationBudget, customCandlesCsv, ...engineOverrides } = body;
  const interval = (body.interval || '1h') as MtfTimeframe;
  const barCount = Math.min(10000, Math.max(300, body.barCount ?? 1500));

  if (!symbol || !type) return Response.json({ error: 'symbol and type are required' }, { status: 400 });
  if (!MTF_TIMEFRAMES.includes(interval)) return Response.json({ error: `Unsupported interval: ${interval}` }, { status: 400 });
  if (!grid) return Response.json({ error: 'grid is required (emaFast/emaSlow/rsiThreshold/atrMultiplier/rewardRiskRatio arrays)' }, { status: 400 });

  try {
    let primaryCandles;
    let sourceNote: string;

    if (customCandlesCsv) {
      const parsed = parseCandlesCsv(customCandlesCsv);
      if ('error' in parsed) return Response.json({ error: `CSV import failed: ${parsed.error}` }, { status: 400 });
      primaryCandles = parsed.candles;
      sourceNote = `Custom CSV upload, ${primaryCandles.length} bars.`;
    } else {
      const history = await fetchPrimaryAndMtf(symbol, type, interval, barCount, []);
      if ('error' in history) return Response.json({ error: history.error }, { status: 502 });
      primaryCandles = history.primaryCandles;
      sourceNote = history.sourceNote;
    }

    const result = runOptimizer({
      symbol,
      type,
      primaryInterval: interval,
      primaryCandles,
      grid,
      folds,
      trainRatio,
      objective,
      minTradesForViability,
      algorithm,
      evaluationBudget,
      engine: engineOverrides,
    });

    if ('error' in result) return Response.json({ error: result.error }, { status: 422 });

    return Response.json({ result, meta: { symbol, type, interval, dataSource: sourceNote, barCount: primaryCandles.length } });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return Response.json({ error: `Optimizer run failed: ${message}` }, { status: 502 });
  }
}
