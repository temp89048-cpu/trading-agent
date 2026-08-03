import type { Candle } from '../indicators';
import type { AssetType, SupportedInterval } from '../candleProviders/types';
import { selectProvider } from '../candleProviders/registry';
import { getCached, setCached } from '../mtfCache.server';
import { aggregateCandles, canAggregate } from './aggregate';
import type { MtfTimeframe } from '../multiTimeframe';

const TIMEFRAME_MINUTES: Record<MtfTimeframe, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 };
// Aggregating a target more than this many multiples above the base
// would mean fetching an impractically large base-interval history just
// to derive one higher timeframe (e.g. deriving '1w' from '1m' would
// need ~10,000x the bars). Beyond this ratio, fetch the target directly
// instead — still cached, just not derived.
const MAX_AGGREGATION_RATIO = 16;

async function fetchViaCacheAndProvider(
  symbol: string,
  type: AssetType,
  interval: SupportedInterval,
  totalBars: number,
): Promise<{ candles: Candle[]; sourceNote: string; warnings: string[]; fromCache: boolean } | { error: string }> {
  const selection = selectProvider(type, interval, totalBars);
  if ('error' in selection) return selection;

  const cached = getCached(selection.provider.id, symbol, interval, totalBars);
  if (cached) {
    return { candles: cached.candles, sourceNote: `${cached.sourceNote} (cached)`, warnings: selection.warnings, fromCache: true };
  }

  try {
    const result = await selection.provider.fetchCandles(symbol, interval, totalBars);
    setCached(selection.provider.id, symbol, interval, totalBars, result.candles, result.sourceNote);
    return { candles: result.candles, sourceNote: result.sourceNote, warnings: selection.warnings, fromCache: false };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'unknown provider error' };
  }
}

export type HistoryResult = {
  primaryCandles: Candle[];
  mtfCandles: Partial<Record<MtfTimeframe, Candle[]>>;
  sourceNote: string;
  mtfNotes: string[];
  warnings: string[];
};

export async function fetchPrimaryAndMtf(
  symbol: string,
  type: AssetType,
  primaryInterval: MtfTimeframe,
  primaryBars: number,
  mtfTargets: MtfTimeframe[],
  mtfBarsEach = 500,
): Promise<HistoryResult | { error: string }> {
  const primary = await fetchViaCacheAndProvider(symbol, type, primaryInterval, primaryBars);
  if ('error' in primary) return primary;

  const mtfCandles: Partial<Record<MtfTimeframe, Candle[]>> = {};
  const mtfNotes: string[] = [];
  const warnings = [...primary.warnings];

  for (const target of mtfTargets) {
    if (target === primaryInterval) continue; // engine already reuses the primary window for this slot — see lib/backtest/engine.ts
    const ratio = TIMEFRAME_MINUTES[target] / TIMEFRAME_MINUTES[primaryInterval];

    if (canAggregate(primaryInterval, target) && ratio > 1 && ratio <= MAX_AGGREGATION_RATIO) {
      try {
        const aggregated = aggregateCandles(primary.candles, primaryInterval, target);
        mtfCandles[target] = aggregated;
        mtfNotes.push(`${target}: aggregated from ${primaryInterval} (${aggregated.length} bars, no extra fetch, perfectly time-aligned)`);
        continue;
      } catch {
        // fall through to a direct fetch below
      }
    }

    const direct = await fetchViaCacheAndProvider(symbol, type, target, mtfBarsEach);
    if ('error' in direct) {
      mtfNotes.push(`${target}: fetch failed (${direct.error}) — will read as insufficient data`);
      continue;
    }
    mtfCandles[target] = direct.candles;
    warnings.push(...direct.warnings);
    mtfNotes.push(`${target}: ${direct.fromCache ? 'from cache' : 'fetched'}, ${direct.candles.length} bars`);
  }

  return { primaryCandles: primary.candles, mtfCandles, sourceNote: primary.sourceNote, mtfNotes, warnings };
}
