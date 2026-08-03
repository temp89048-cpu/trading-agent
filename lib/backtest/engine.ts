import type { Candle } from '../indicators';
import { atr } from '../indicators';
import { buildStrategyContext, type StrategyContext, type StrategySignal } from '../strategyContext';
import { computeStopLossTakeProfit, type StopLossTakeProfit } from '../riskManager';
import { fixedFractionalSize, volatilityBasedSize, capToMaxExposure } from '../positionSizing';
import type { MtfLookup, MtfTimeframe } from '../multiTimeframe';
import type { WatchItem } from '../types';
import { mulberry32, resolveAmbiguousBar, computeDynamicSlippageBps, tickModeAvailable, type ExecutionMode } from './executionModel';
import { computeFee, type VipLevel } from './feeModel';
import { computeEquityMetrics, type EquityMetrics } from './riskMetrics';

// ---------------------------------------------------------------------
// Correctness note, since this is the part every toy backtester gets
// wrong: at bar i, the strategy is only ever shown primaryCandles[0..i]
// (a rolling window ending at i) and, for MTF, other timeframes
// truncated to t <= primaryCandles[i].t. Nothing downstream of "now" in
// the replay is ever visible to the strategy. The existing MtfLookup
// type has no time parameter, so a fresh, time-truncated lookup closure
// is built for every single bar rather than reusing one lookup across
// the whole run — reusing one would leak future MTF candles into early
// bars.
// ---------------------------------------------------------------------

export type SizingMethod = 'fixed-fractional' | 'volatility-based';

export type BacktestParams = {
  symbol: string;
  type: 'crypto' | 'equity';
  primaryInterval: MtfTimeframe; // which of the 7 MTF slots primaryCandles represents, so MTF lookups for that slot reuse the same rolling window rather than requiring the caller to duplicate it
  primaryCandles: Candle[]; // ascending by time
  mtfCandles?: Partial<Record<MtfTimeframe, Candle[]>>; // optional additional timeframes, each ascending by time. Omit entirely = MTF-dependent strategies see "insufficient data" for every timeframe, same honest degrade as live.
  strategyFn: (ctx: StrategyContext) => StrategySignal;
  confidenceThreshold?: number;
  initialCapitalUsd?: number;
  riskPct?: number;
  sizingMethod?: SizingMethod;
  rewardRiskRatio?: number;
  feeBps?: number;
  slippageBps?: number;
  rollingWindowBars?: number;
  stopLossTakeProfitFn?: (ctx: StrategyContext, side: 'buy' | 'sell') => StopLossTakeProfit | null;
  // Execution realism additions:
  executionMode?: ExecutionMode; // default 'conservative' — how to resolve a bar whose range spans both SL and TP
  executionSeed?: number; // default 42 — for 'random' execution mode reproducibility
  useDynamicSlippage?: boolean; // default false — scale slippage by order-size-vs-bar-volume and ATR-vs-price instead of the fixed slippageBps
  feeModel?: 'fixed' | 'exchange'; // default 'fixed' (feeBps/slippageBps as before); 'exchange' uses lib/backtest/feeModel.ts's published schedule
  vipLevel?: VipLevel; // only used when feeModel === 'exchange'
  isMaker?: boolean; // only used when feeModel === 'exchange'
};

export type ExitReason = 'stop-loss' | 'take-profit' | 'signal-reversal' | 'end-of-data';

export type BacktestTrade = {
  entryTs: number;
  exitTs: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  pnlUsd: number;
  pnlPct: number;
  exitReason: ExitReason;
  agent: string;
  entryReason: string;
  barsHeld: number;
};

export type EquityPoint = { t: number; equity: number };

export type BacktestMetrics = {
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  profitFactor: number | null; // null when there are no losses to divide by (reported honestly, never Infinity) or no trades at all
  totalReturnPct: number;
  maxDrawdownPct: number;
  expectancyUsd: number | null;
  avgWinPct: number | null;
  avgLossPct: number | null;
  avgBarsHeld: number | null;
  sharpeApprox: number | null; // mean/stddev of PER-TRADE pnl% — explicitly not an annualized daily-return Sharpe, labeled as such wherever it's shown
};

export type BacktestResult = {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  metrics: BacktestMetrics;
  equityMetrics: EquityMetrics; // annualized Sharpe/Sortino/Calmar/Sterling/MAR/Ulcer — see lib/backtest/riskMetrics.ts
  dataWindow: { startTs: number; endTs: number; barCount: number };
  warnings: string[];
};

const DEFAULT_CONFIDENCE_THRESHOLD = 0.5; // mirrors the live "confidence < 0.5 -> don't act" gate from Commit 13
const MIN_BARS_TO_START = 55; // matches buildStrategyContext's own MIN_CANDLES floor

// Candle.t is the bar's OPEN time (confirmed against candleSource.server.ts —
// Binance kline field 0). A candle is only real, lookahead-safe data once
// it has actually CLOSED — i.e. t + this timeframe's duration <= asOfTs —
// not merely once its open time has passed. Used below to fix a lookahead
// leak: a still-forming 1h candle whose open time is <= the current 15m
// primary bar was previously included as if it had already closed.
export const MTF_INTERVAL_MS: Record<MtfTimeframe, number> = {
  '1m': 60_000,
  '5m': 5 * 60_000,
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1d': 24 * 60 * 60_000,
  '1w': 7 * 24 * 60 * 60_000,
};

// Binary-search upper bound: index of the last candle that has fully
// CLOSED by asOfTs (t + durationMs <= asOfTs), not just opened by then.
// Candles must be sorted ascending by t. Returns -1 if none qualify.
export function upperBoundIndex(candles: Candle[], asOfTs: number, durationMs: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].t + durationMs <= asOfTs) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

function makeMtfLookupAsOf(
  mtfCandles: Partial<Record<MtfTimeframe, Candle[]>> | undefined,
  primaryInterval: MtfTimeframe,
  primaryWindow: Candle[],
  asOfTs: number,
): MtfLookup {
  return (_symbol: string, interval: string) => {
    if (interval === primaryInterval) {
      // Reuse the exact rolling window already sliced for the primary
      // timeframe this bar — no separate truncation needed, and no
      // possibility of it disagreeing with what the strategy itself sees.
      return primaryWindow.length > 0 ? { candles: primaryWindow } : undefined;
    }
    const set = mtfCandles?.[interval as MtfTimeframe];
    if (!set || set.length === 0) return undefined;
    const idx = upperBoundIndex(set, asOfTs, MTF_INTERVAL_MS[interval as MtfTimeframe]);
    if (idx < 0) return undefined;
    return { candles: set.slice(0, idx + 1) };
  };
}

export function runBacktest(params: BacktestParams): BacktestResult | { error: string } {
  const {
    symbol,
    type,
    primaryInterval,
    primaryCandles,
    mtfCandles,
    strategyFn,
    confidenceThreshold = DEFAULT_CONFIDENCE_THRESHOLD,
    initialCapitalUsd = 10000,
    riskPct = 0.02,
    sizingMethod = 'fixed-fractional',
    rewardRiskRatio = 2,
    feeBps = 10,
    slippageBps = 5,
    rollingWindowBars = 250,
    executionMode = 'conservative',
    executionSeed = 42,
    useDynamicSlippage = false,
    feeModel = 'fixed',
    vipLevel = 0,
    isMaker = false,
  } = params;

  const slTpFn = params.stopLossTakeProfitFn ?? ((ctx: StrategyContext, side: 'buy' | 'sell') => computeStopLossTakeProfit(ctx, side, rewardRiskRatio));

  if (primaryCandles.length < MIN_BARS_TO_START + 1) {
    return { error: `Need at least ${MIN_BARS_TO_START + 1} candles to run a backtest (got ${primaryCandles.length}).` };
  }
  if (initialCapitalUsd <= 0) return { error: 'initialCapitalUsd must be positive.' };

  const warnings: string[] = [];
  if (!mtfCandles || Object.keys(mtfCandles).length === 0) {
    warnings.push(
      'No additional multi-timeframe history supplied — MTF-dependent strategies (e.g. Trend Following, Momentum) will see "insufficient data" for every timeframe besides the primary one and will HOLD more often than they would live.',
    );
  }

  let effectiveExecutionMode = executionMode;
  if (executionMode === 'tick' && !tickModeAvailable()) {
    warnings.push("Tick-level execution mode requested, but no tick-level historical data provider is configured (same honest gap as Commit 11's live order-flow limitation) — falling back to 'conservative' bar-level execution instead of fabricating tick fills.");
    effectiveExecutionMode = 'conservative';
  }
  const executionRng = mulberry32(executionSeed);

  const item: WatchItem = { symbol, type };
  const feeRate = feeBps / 10000;
  const slippageRate = slippageBps / 10000;

  let cash = initialCapitalUsd;
  let position: {
    qty: number;
    entryPrice: number; // fill price, includes slippage
    entryCostUsd: number; // qty * entryPrice + entry fee — what actually left cash
    entryTs: number;
    stopLoss: number;
    takeProfit: number;
    agent: string;
    entryReason: string;
    entryBarIndex: number;
  } | null = null;

  const trades: BacktestTrade[] = [];
  const equityCurve: EquityPoint[] = [];
  let peakEquity = initialCapitalUsd;
  let maxDrawdownPct = 0;

  function effectiveSlippageRate(orderNotionalUsd: number, barIndex: number): number {
    if (!useDynamicSlippage) return slippageRate;
    const bar = primaryCandles[barIndex];
    const atrHere = atr(primaryCandles.slice(Math.max(0, barIndex - 14), barIndex + 1), 14);
    const dyn = computeDynamicSlippageBps({ orderNotionalUsd, barVolumeBaseUnits: bar.v, barPrice: bar.c, atrValue: atrHere, baselineSlippageBps: slippageBps });
    return dyn.totalBps / 10000;
  }

  function effectiveFeeUsd(notionalUsd: number): number {
    if (feeModel === 'fixed') return notionalUsd * feeRate;
    return computeFee({ notionalUsd, vipLevel, isMaker }).tradingFeeUsd;
  }

  function closePosition(rawExitPrice: number, ts: number, reason: ExitReason, barIndex: number) {
    if (!position) return;
    const rawNotional = position.qty * rawExitPrice;
    const slipRate = effectiveSlippageRate(rawNotional, barIndex);
    // Selling always fills slightly worse than the raw price, regardless of why we're exiting.
    const fillPrice = rawExitPrice * (1 - slipRate);
    const proceeds = position.qty * fillPrice;
    const fee = effectiveFeeUsd(proceeds);
    cash += proceeds - fee;
    const pnlUsd = proceeds - fee - position.entryCostUsd;
    const pnlPct = position.entryCostUsd > 0 ? (pnlUsd / position.entryCostUsd) * 100 : 0;
    trades.push({
      entryTs: position.entryTs,
      exitTs: ts,
      entryPrice: position.entryPrice,
      exitPrice: fillPrice,
      qty: position.qty,
      pnlUsd,
      pnlPct,
      exitReason: reason,
      agent: position.agent,
      entryReason: position.entryReason,
      barsHeld: barIndex - position.entryBarIndex,
    });
    position = null;
  }

  for (let i = MIN_BARS_TO_START; i < primaryCandles.length; i++) {
    const windowStart = Math.max(0, i - rollingWindowBars + 1);
    const window = primaryCandles.slice(windowStart, i + 1); // no lookahead: bars up to and including i only
    const bar = primaryCandles[i];
    const mtfLookup = makeMtfLookupAsOf(mtfCandles, primaryInterval, window, bar.t);

    if (position) {
      const hitStop = bar.l <= position.stopLoss;
      const hitTarget = bar.h >= position.takeProfit;
      if (hitStop && hitTarget) {
        // Genuinely ambiguous from OHLC alone — resolved per the chosen
        // execution mode (see lib/backtest/executionModel.ts) rather than
        // always silently assuming one order.
        const resolution = resolveAmbiguousBar(effectiveExecutionMode, executionRng);
        const exitPrice = resolution === 'stop-loss' ? position.stopLoss : position.takeProfit;
        closePosition(exitPrice, bar.t, resolution, i);
      } else if (hitStop || hitTarget) {
        const exitPrice = hitStop ? position.stopLoss : position.takeProfit;
        closePosition(exitPrice, bar.t, hitStop ? 'stop-loss' : 'take-profit', i);
      } else {
        const ctx = buildStrategyContext(item, window, mtfLookup, undefined);
        if (ctx) {
          const signal = strategyFn(ctx);
          if (signal.signal === 'SELL' && signal.confidence >= confidenceThreshold) {
            closePosition(bar.c, bar.t, 'signal-reversal', i);
          }
        }
      }
    }

    if (!position) {
      const ctx = buildStrategyContext(item, window, mtfLookup, undefined);
      if (ctx) {
        const signal = strategyFn(ctx);
        if (signal.signal === 'BUY' && signal.confidence >= confidenceThreshold) {
          const sl = slTpFn(ctx, 'buy');
          if (sl) {
            const equityUsd = cash; // flat right now, so equity === cash
            const sizing =
              sizingMethod === 'volatility-based'
                ? volatilityBasedSize(equityUsd, riskPct, bar.c, ctx.atrValue ?? 0)
                : fixedFractionalSize(equityUsd, riskPct, bar.c, sl.stopLoss);
            if (sizing && sizing.qty > 0) {
              const capped = capToMaxExposure(sizing.qty, bar.c, equityUsd);
              const qty = capped.qty;
              const rawNotional = qty * bar.c;
              const slipRate = effectiveSlippageRate(rawNotional, i);
              const fillPrice = bar.c * (1 + slipRate); // buying fills slightly worse than the raw price
              const cost = qty * fillPrice;
              const fee = effectiveFeeUsd(cost);
              const entryCostUsd = cost + fee;
              if (entryCostUsd <= cash && qty > 0) {
                cash -= entryCostUsd;
                position = {
                  qty,
                  entryPrice: fillPrice,
                  entryCostUsd,
                  entryTs: bar.t,
                  stopLoss: sl.stopLoss,
                  takeProfit: sl.takeProfit,
                  agent: signal.agent,
                  entryReason: signal.reason,
                  entryBarIndex: i,
                };
              }
              // else: insufficient cash for even the capped size — skip this bar, same honest
              // outcome as buyPaper() rejecting a trade for insufficient paper cash.
            }
          }
          // else: no ATR/stop available yet — can't size or set exits defensibly, skip rather
          // than fabricate a stop level.
        }
      }
    }

    const equity = cash + (position ? position.qty * bar.c : 0);
    equityCurve.push({ t: bar.t, equity });
    peakEquity = Math.max(peakEquity, equity);
    const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    maxDrawdownPct = Math.max(maxDrawdownPct, dd);
  }

  if (position) {
    const lastBar = primaryCandles[primaryCandles.length - 1];
    closePosition(lastBar.c, lastBar.t, 'end-of-data', primaryCandles.length - 1);
    warnings.push("Position still open at the end of the backtest window — force-closed at the final bar's close so it's counted in the results, rather than silently dropped.");
  }

  const metrics = computeMetrics(trades, equityCurve, initialCapitalUsd, maxDrawdownPct);
  const equityMetrics = computeEquityMetrics(equityCurve, initialCapitalUsd, type);
  warnings.push(...equityMetrics.warnings);

  return {
    trades,
    equityCurve,
    metrics,
    equityMetrics,
    dataWindow: {
      startTs: primaryCandles[MIN_BARS_TO_START].t,
      endTs: primaryCandles[primaryCandles.length - 1].t,
      barCount: primaryCandles.length - MIN_BARS_TO_START,
    },
    warnings,
  };
}

function computeMetrics(trades: BacktestTrade[], equityCurve: EquityPoint[], initialCapitalUsd: number, maxDrawdownPct: number): BacktestMetrics {
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd < 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const finalEquity = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].equity : initialCapitalUsd;

  let sharpeApprox: number | null = null;
  if (trades.length >= 2) {
    const rets = trades.map((t) => t.pnlPct);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
    const stddev = Math.sqrt(variance);
    sharpeApprox = stddev > 0 ? mean / stddev : null;
  }

  return {
    tradeCount: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length > 0 ? wins.length / trades.length : null,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    totalReturnPct: ((finalEquity - initialCapitalUsd) / initialCapitalUsd) * 100,
    maxDrawdownPct: maxDrawdownPct * 100,
    expectancyUsd: trades.length > 0 ? trades.reduce((s, t) => s + t.pnlUsd, 0) / trades.length : null,
    avgWinPct: wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : null,
    avgLossPct: losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : null,
    avgBarsHeld: trades.length > 0 ? trades.reduce((s, t) => s + t.barsHeld, 0) / trades.length : null,
    sharpeApprox,
  };
}
