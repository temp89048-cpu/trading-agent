import type { Candle } from '../indicators';
import { runBacktest, type BacktestParams, type BacktestMetrics, type BacktestResult } from './engine';
import { runTunableStrategy, computeTunableStopLossTakeProfit, type TunableParams } from './tunableStrategy';
import type { MtfTimeframe } from '../multiTimeframe';
import { searchGrid, searchRandom, searchGenetic, searchBayesian, type SearchAlgorithmName, type SearchResult } from './searchAlgorithms';
import { mulberry32 } from './executionModel';

export type ParamGrid = {
  emaFast: number[];
  emaSlow: number[];
  rsiThreshold: number[];
  atrMultiplier: number[];
  rewardRiskRatio: number[];
};

export type OptimizerObjective = 'profitFactor' | 'totalReturnPct' | 'sharpeApprox' | 'expectancyUsd';

export type OptimizerParams = {
  symbol: string;
  type: 'crypto' | 'equity';
  primaryInterval: MtfTimeframe;
  primaryCandles: Candle[]; // ascending by time — the full history to walk forward across
  grid: ParamGrid;
  folds?: number; // default 3
  trainRatio?: number; // default 0.7 — portion of each fold's window used for training
  objective?: OptimizerObjective; // default 'profitFactor'
  minTradesForViability?: number; // default 3 — a combo that produces fewer trades than this on the train window isn't scored, since 1-2 trades is noise, not an edge
  algorithm?: SearchAlgorithmName; // default 'grid' — see lib/backtest/searchAlgorithms.ts
  evaluationBudget?: number; // default 60 — max combos evaluated PER FOLD for random/genetic/bayesian (grid ignores this and evaluates its full cartesian product, capped by MAX_COMBINATIONS below)
  engine?: Partial<Pick<BacktestParams, 'initialCapitalUsd' | 'riskPct' | 'feeBps' | 'slippageBps' | 'confidenceThreshold' | 'rollingWindowBars' | 'sizingMethod'>>;
};

export type FoldResult = {
  foldIndex: number;
  trainWindow: { startTs: number; endTs: number; barCount: number };
  testWindow: { startTs: number; endTs: number; barCount: number };
  combosEvaluated: number;
  bestParams: TunableParams | null;
  trainMetrics: BacktestMetrics | null;
  testMetrics: BacktestMetrics | null;
};

export type RobustRange = { min: number; max: number; values: number[] };

export type OptimizerResult = {
  objective: OptimizerObjective;
  algorithm: SearchAlgorithmName;
  folds: FoldResult[];
  robustRanges: Record<keyof TunableParams, RobustRange> | null;
  warnings: string[];
};

const MAX_COMBINATIONS = 150;
const MAX_EVALUATION_BUDGET = 300; // per fold, for random/genetic/bayesian — each evaluation is a full backtest run, so this bounds total runtime similarly to MAX_COMBINATIONS for grid
const MAX_FOLDS = 6;
const MIN_BARS_PER_WINDOW = 90;

function cartesianProduct(grid: ParamGrid): TunableParams[] {
  const out: TunableParams[] = [];
  for (const emaFast of grid.emaFast) {
    for (const emaSlow of grid.emaSlow) {
      if (emaFast >= emaSlow) continue;
      for (const rsiThreshold of grid.rsiThreshold) {
        for (const atrMultiplier of grid.atrMultiplier) {
          for (const rewardRiskRatio of grid.rewardRiskRatio) {
            out.push({ emaFast, emaSlow, rsiThreshold, atrMultiplier, rewardRiskRatio });
          }
        }
      }
    }
  }
  return out;
}

function extractObjective(metrics: BacktestMetrics, objective: OptimizerObjective): number | null {
  const value = metrics[objective];
  return typeof value === 'number' && isFinite(value) ? value : null;
}

function runOneBacktest(
  base: { symbol: string; type: 'crypto' | 'equity'; primaryInterval: MtfTimeframe; engine: OptimizerParams['engine'] },
  candles: Candle[],
  tp: TunableParams,
): BacktestResult | { error: string } {
  return runBacktest({
    symbol: base.symbol,
    type: base.type,
    primaryInterval: base.primaryInterval,
    primaryCandles: candles,
    strategyFn: (ctx) => runTunableStrategy(ctx, tp),
    stopLossTakeProfitFn: (ctx, side) => computeTunableStopLossTakeProfit(ctx, side, tp),
    ...base.engine,
  });
}

export function runOptimizer(params: OptimizerParams): OptimizerResult | { error: string } {
  const { symbol, type, primaryInterval, primaryCandles, grid, folds = 3, trainRatio = 0.7, objective = 'profitFactor', minTradesForViability = 3, algorithm = 'grid', evaluationBudget = 60, engine } = params;

  if (folds < 1 || folds > MAX_FOLDS) return { error: `folds must be between 1 and ${MAX_FOLDS}.` };
  if (trainRatio <= 0 || trainRatio >= 1) return { error: 'trainRatio must be between 0 and 1 (exclusive).' };

  const gridKeys: (keyof typeof grid)[] = ['emaFast', 'emaSlow', 'rsiThreshold', 'atrMultiplier', 'rewardRiskRatio'];
  for (const key of gridKeys) {
    if (!grid[key] || grid[key].length === 0) return { error: `grid.${key} must have at least one value (used as bounds for non-grid algorithms, or as the literal search list for grid search).` };
  }

  let combos: TunableParams[] = [];
  if (algorithm === 'grid') {
    combos = cartesianProduct(grid);
    if (combos.length === 0) return { error: 'Parameter grid produced zero valid combinations (check emaFast < emaSlow for every pair).' };
    if (combos.length > MAX_COMBINATIONS) {
      return { error: `Grid produces ${combos.length} combinations, over the ${MAX_COMBINATIONS} cap — narrow the ranges, or switch to 'random'/'genetic'/'bayesian' which search within the same bounds using a fixed evaluation budget instead of enumerating everything.` };
    }
  } else {
    if (evaluationBudget < 5 || evaluationBudget > MAX_EVALUATION_BUDGET) {
      return { error: `evaluationBudget must be between 5 and ${MAX_EVALUATION_BUDGET} for the '${algorithm}' algorithm.` };
    }
  }

  const foldSize = Math.floor(primaryCandles.length / folds);
  if (foldSize < MIN_BARS_PER_WINDOW) {
    return { error: `Only ${primaryCandles.length} candles available for ${folds} folds (${foldSize} bars/fold) — need at least ${MIN_BARS_PER_WINDOW} bars per fold. Fetch more history or reduce the fold count.` };
  }

  const warnings: string[] = [];
  const foldResults: FoldResult[] = [];
  const base = { symbol, type, primaryInterval, engine };

  for (let f = 0; f < folds; f++) {
    const foldStart = f * foldSize;
    const foldEnd = f === folds - 1 ? primaryCandles.length : foldStart + foldSize;
    const foldCandles = primaryCandles.slice(foldStart, foldEnd);
    const trainCount = Math.floor(foldCandles.length * trainRatio);
    const trainCandles = foldCandles.slice(0, trainCount);
    const testCandles = foldCandles.slice(trainCount);

    if (trainCandles.length < MIN_BARS_PER_WINDOW || testCandles.length < MIN_BARS_PER_WINDOW) {
      warnings.push(`Fold ${f + 1}: train/test split too small after the ${(trainRatio * 100).toFixed(0)}%/${((1 - trainRatio) * 100).toFixed(0)}% split — skipped.`);
      continue;
    }

    let bestTrainMetrics: BacktestMetrics | null = null;
    const evaluate = (combo: TunableParams): number | null => {
      const result = runOneBacktest(base, trainCandles, combo);
      if ('error' in result) return null;
      if (result.metrics.tradeCount < minTradesForViability) return null;
      return extractObjective(result.metrics, objective);
    };

    // Deterministic per-fold seed — same optimizer call reproduces the
    // same result, which matters for trusting/debugging a stochastic
    // search algorithm's output.
    const rng = mulberry32(4242 + f);
    let searchResult: SearchResult;
    if (algorithm === 'grid') searchResult = searchGrid(combos, evaluate);
    else if (algorithm === 'random') searchResult = searchRandom(grid, evaluate, evaluationBudget, rng);
    else if (algorithm === 'genetic') searchResult = searchGenetic(grid, evaluate, evaluationBudget, rng);
    else searchResult = searchBayesian(grid, evaluate, evaluationBudget, rng);

    const bestParams = searchResult.best;
    if (bestParams) {
      const trainRun = runOneBacktest(base, trainCandles, bestParams);
      bestTrainMetrics = 'error' in trainRun ? null : trainRun.metrics;
    }

    let testMetrics: BacktestMetrics | null = null;
    if (bestParams) {
      const testResult = runOneBacktest(base, testCandles, bestParams);
      if (!('error' in testResult)) testMetrics = testResult.metrics;
    } else {
      warnings.push(`Fold ${f + 1}: no parameter combination produced at least ${minTradesForViability} trades on the training window — no winner picked for this fold rather than guessing.`);
    }

    foldResults.push({
      foldIndex: f,
      trainWindow: { startTs: trainCandles[0].t, endTs: trainCandles[trainCandles.length - 1].t, barCount: trainCandles.length },
      testWindow: { startTs: testCandles[0].t, endTs: testCandles[testCandles.length - 1].t, barCount: testCandles.length },
      combosEvaluated: searchResult.evaluatedCount,
      bestParams,
      trainMetrics: bestTrainMetrics,
      testMetrics,
    });
  }

  const winners = foldResults.filter((f) => f.bestParams !== null).map((f) => f.bestParams as TunableParams);
  let robustRanges: OptimizerResult['robustRanges'] = null;
  if (winners.length >= 2) {
    const keys: (keyof TunableParams)[] = ['emaFast', 'emaSlow', 'rsiThreshold', 'atrMultiplier', 'rewardRiskRatio'];
    robustRanges = {} as Record<keyof TunableParams, RobustRange>;
    for (const key of keys) {
      const values = winners.map((w) => w[key]);
      robustRanges[key] = { min: Math.min(...values), max: Math.max(...values), values };
    }
  } else {
    warnings.push(`Only ${winners.length} fold(s) produced a viable winner — can't assess parameter robustness from fewer than 2 folds. Results below are informational, not a robust range.`);
  }

  if (foldResults.length === 0) {
    return { error: 'No fold produced usable results — see warnings for why each fold was skipped.' };
  }

  return { objective, algorithm, folds: foldResults, robustRanges, warnings };
}
