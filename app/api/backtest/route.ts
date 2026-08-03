import { runBacktest, type SizingMethod } from '@/lib/backtest/engine';
import { STRATEGY_REGISTRY, type StrategyName } from '@/lib/backtest/strategyRegistry';
import { runTunableStrategy, computeTunableStopLossTakeProfit, type TunableParams } from '@/lib/backtest/tunableStrategy';
import { MTF_TIMEFRAMES, type MtfTimeframe } from '@/lib/multiTimeframe';
import { fetchPrimaryAndMtf } from '@/lib/backtest/historyService.server';
import { parseCandlesCsv } from '@/lib/candleProviders/csvImport';
import { computeRegimeBreakdown } from '@/lib/backtest/regime';
import type { Candle } from '@/lib/indicators';
import type { ExecutionMode } from '@/lib/backtest/executionModel';
import type { VipLevel } from '@/lib/backtest/feeModel';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Timeframes strictly longer than the primary are what a real trader
// means by "MTF confirmation" — a shorter timeframe than what you're
// trading on isn't a meaningful trend confirmation, so those are the
// only extra timeframes fetched when includeMtf is requested.
function longerTimeframes(primary: MtfTimeframe): MtfTimeframe[] {
  const idx = MTF_TIMEFRAMES.indexOf(primary);
  return MTF_TIMEFRAMES.slice(idx + 1);
}

export async function POST(req: Request) {
  let body: {
    symbol?: string;
    type?: 'crypto' | 'equity';
    interval?: string;
    strategyName?: string;
    barCount?: number;
    includeMtf?: boolean;
    includeRegimeBreakdown?: boolean;
    customCandlesCsv?: string; // if supplied, skips the live/provider fetch entirely and backtests this CSV instead (see lib/candleProviders/csvImport.ts — Parquet not supported, documented gap)
    initialCapitalUsd?: number;
    riskPct?: number;
    sizingMethod?: SizingMethod;
    rewardRiskRatio?: number;
    feeBps?: number;
    slippageBps?: number;
    confidenceThreshold?: number;
    rollingWindowBars?: number;
    executionMode?: ExecutionMode;
    executionSeed?: number;
    useDynamicSlippage?: boolean;
    feeModel?: 'fixed' | 'exchange';
    vipLevel?: VipLevel;
    isMaker?: boolean;
    tunableParams?: TunableParams; // when strategyName === 'tunable', use these specific params instead of the registry default — this is how an Optimizer run's found parameters get plugged into a real single backtest
  };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { symbol, type, includeMtf, includeRegimeBreakdown, customCandlesCsv, tunableParams, ...engineOverrides } = body;
  const interval = (body.interval || '1h') as MtfTimeframe;
  const strategyName = (body.strategyName || 'trendFollowing') as StrategyName;
  const barCount = Math.min(10000, Math.max(200, body.barCount ?? 1000));

  if (!symbol || !type) return Response.json({ error: 'symbol and type are required' }, { status: 400 });
  if (!MTF_TIMEFRAMES.includes(interval)) return Response.json({ error: `Unsupported interval: ${interval}` }, { status: 400 });
  const strategy = STRATEGY_REGISTRY[strategyName];
  if (!strategy) return Response.json({ error: `Unknown strategy: ${strategyName}. Valid: ${Object.keys(STRATEGY_REGISTRY).join(', ')}` }, { status: 400 });

  try {
    let primaryCandles: Candle[];
    let mtfCandles: Partial<Record<MtfTimeframe, Candle[]>> | undefined;
    let sourceNote: string;
    let mtfNotes: string[] = [];
    let providerWarnings: string[] = [];

    if (customCandlesCsv) {
      const parsed = parseCandlesCsv(customCandlesCsv);
      if ('error' in parsed) return Response.json({ error: `CSV import failed: ${parsed.error}` }, { status: 400 });
      primaryCandles = parsed.candles;
      sourceNote = `Custom CSV upload, ${primaryCandles.length} bars (Parquet import not supported — see lib/candleProviders/csvImport.ts).`;
      providerWarnings = parsed.warnings;
      // MTF confirmation isn't available for a custom CSV upload — there's
      // only the one series the user provided.
      if (includeMtf) mtfNotes.push('MTF confirmation skipped: not available for custom CSV uploads (only the uploaded series exists).');
    } else {
      const targets = includeMtf && strategy.usesMtf ? longerTimeframes(interval) : [];
      const history = await fetchPrimaryAndMtf(symbol, type, interval, barCount, targets);
      if ('error' in history) return Response.json({ error: history.error }, { status: 502 });
      primaryCandles = history.primaryCandles;
      mtfCandles = history.mtfCandles;
      sourceNote = history.sourceNote;
      mtfNotes = history.mtfNotes;
      providerWarnings = history.warnings;
    }

    const usingCustomTunable = strategyName === 'tunable' && !!tunableParams;
    const result = runBacktest({
      symbol,
      type,
      primaryInterval: interval,
      primaryCandles,
      mtfCandles,
      strategyFn: usingCustomTunable ? (ctx) => runTunableStrategy(ctx, tunableParams!) : strategy.fn,
      stopLossTakeProfitFn: usingCustomTunable ? (ctx, side) => computeTunableStopLossTakeProfit(ctx, side, tunableParams!) : undefined,
      ...engineOverrides,
    });

    if ('error' in result) return Response.json({ error: result.error }, { status: 422 });

    let regimeBreakdown: ReturnType<typeof computeRegimeBreakdown> | undefined;
    if (includeRegimeBreakdown) {
      regimeBreakdown = computeRegimeBreakdown(primaryCandles, result.trades);
    }

    return Response.json({
      result,
      regimeBreakdown,
      meta: {
        strategyName,
        strategyLabel: strategy.label,
        symbol,
        type,
        interval,
        dataSource: sourceNote,
        mtfIncluded: !!includeMtf && strategy.usesMtf && !customCandlesCsv,
        mtfNotes,
        providerWarnings,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return Response.json({ error: `Backtest failed: ${message}` }, { status: 502 });
  }
}
