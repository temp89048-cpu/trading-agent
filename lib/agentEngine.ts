import type { AgentTask, PlanStage } from './types';
import { evaluatePlanCondition, type PlanSnapshot } from './plannerAgent';

// ATR expressed as a percent of price — computed by the caller
// (components/Agent.tsx) from live candles, since agentTick itself has
// no candle access and stays pure. Only consulted when a task has
// useAtrStops set.
export type VolatilityContext = { atrPercent: number };

const DEFAULT_ATR_TP_MULTIPLIER = 2;
const DEFAULT_ATR_SL_MULTIPLIER = 1;
export const DEFAULT_SIGNAL_CONFIRM_ENSEMBLE_PCT = 55;

export type AgentTickResult =
  | { action: 'none'; patch?: Partial<AgentTask> } // patch: bookkeeping-only state (e.g. trailing-stop peak) with no side effect to execute
  | { action: 'stage'; planStage: PlanStage } // conditional-watch only: trigger fired, now arm the watch stage
  | { action: 'open'; qty: number; price: number; marginUsed: number }
  | { action: 'close'; qty: number; price: number; entryPrice: number; pnl: number; scaleOutLevelIndex?: number } // scaleOutLevelIndex set = a PARTIAL close (qty is only the closed fraction, the leg continues); unset = a full close
  | { action: 'complete' };

function computeMarginUsed(task: AgentTask): number {
  // 'interval' mode uses a fixed margin per leg, not compounding.
  // 'take-profit' and 'conditional-watch' modes compound: each new
  // leg's margin is the original margin PLUS whatever's been realized
  // so far.
  return task.mode === 'interval' ? task.marginUsd : task.marginUsd + Math.max(0, task.realizedTotal);
}

function openResult(task: AgentTask, livePrice: number): AgentTickResult {
  const marginUsed = computeMarginUsed(task);
  const notional = marginUsed * task.leverage;
  const qty = notional / livePrice;
  if (!qty || qty <= 0) return { action: 'none' };
  return { action: 'open', qty, price: livePrice, marginUsed };
}

// Resolves the effective TP/SL distances (in percent) for the open leg
// right now. ATR-based stops (when useAtrStops is set and a live ATR
// reading is available) override the static tpPercent/slPercent
// entirely — same fallback-to-static behavior as when ATR data isn't
// ready yet, so a task never silently goes unprotected.
function effectiveTpSl(task: AgentTask, volCtx: VolatilityContext | undefined): { tp?: number; sl?: number } {
  if (task.useAtrStops && volCtx) {
    return {
      tp: volCtx.atrPercent * (task.atrMultiplierTp ?? DEFAULT_ATR_TP_MULTIPLIER),
      sl: volCtx.atrPercent * (task.atrMultiplierSl ?? DEFAULT_ATR_SL_MULTIPLIER),
    };
  }
  return { tp: task.tpPercent, sl: task.slPercent };
}

function checkOpenLegTick(task: AgentTask, livePrice: number, volCtx: VolatilityContext | undefined): AgentTickResult {
  if (task.currentEntryPrice === undefined || task.currentQty === undefined) return { action: 'none' };
  const entry = task.currentEntryPrice;
  const qty = task.currentQty;
  const sign = task.side === 'buy' ? 1 : -1;
  const pnlPct = sign * ((livePrice - entry) / entry) * 100;

  // Scale-out levels are checked BEFORE the full TP/SL/trailing exits
  // below, in order, and each fires at most once (scaledOutLevels
  // records which indices already triggered this leg). A level firing
  // closes only its configured fraction of the ORIGINAL qty — the leg
  // stays open with the remainder — and arms the breakeven floor.
  const levels = task.scaleOutLevels ?? [];
  if (levels.length > 0) {
    const alreadyScaled = new Set(task.scaledOutLevels ?? []);
    for (let i = 0; i < levels.length; i++) {
      if (alreadyScaled.has(i)) continue;
      if (pnlPct < levels[i].tpPercent) continue;
      const closeQty = Math.min(qty, Math.max(0, levels[i].closeFraction) * qty);
      if (closeQty <= 0) continue;
      const pnl = (livePrice - entry) * closeQty * sign;
      return { action: 'close', qty: closeQty, price: livePrice, entryPrice: entry, pnl, scaleOutLevelIndex: i };
    }
  }

  // Breakeven floor — once armed by a prior scale-out, the leg can
  // never close worse than flat, regardless of tpPercent/slPercent or
  // where the trailing stop happens to be.
  const breakEvenHit = task.breakEvenArmed === true && sign * (livePrice - entry) <= 0;

  // Trailing stop: the stop rides trailingStopPercent behind the best
  // (most favorable) price seen since entry, rather than staying fixed.
  const priorPeak = task.currentPeakPrice ?? entry;
  const peak = task.side === 'buy' ? Math.max(priorPeak, livePrice) : Math.min(priorPeak, livePrice);
  const trailHit =
    task.trailingStopPercent !== undefined &&
    (task.side === 'buy' ? livePrice <= peak * (1 - task.trailingStopPercent / 100) : livePrice >= peak * (1 + task.trailingStopPercent / 100));

  const { tp, sl } = effectiveTpSl(task, volCtx);
  const tpHit = tp !== undefined && pnlPct >= tp;
  const slHit = sl !== undefined && pnlPct <= -sl;

  if (tpHit || slHit || trailHit || breakEvenHit) {
    const pnl = (livePrice - entry) * qty * sign;
    return { action: 'close', qty, price: livePrice, entryPrice: entry, pnl };
  }

  // Nothing closed this tick — still persist an updated trailing-stop
  // peak if price moved favorably, so the NEXT tick's trail level is
  // correct. No side effect, just bookkeeping (see AgentTickResult's
  // `patch` field).
  if (peak !== priorPeak) return { action: 'none', patch: { currentPeakPrice: peak } };
  return { action: 'none' };
}

// One tick = "what should this task do right now, given the real
// current time and the real current price?" Nothing here waits or
// sleeps — the caller (components/Agent.tsx) re-runs this every few
// seconds against the real clock, which is the actual fix for the bug
// report: the model can't pause mid-generation and re-check reality,
// but a real setInterval checking Date.now() and a live tick can.
//
// `snapshot` (Commit 20 / conditional-watch mode only) carries the live
// RSI/EMA readings alongside price, computed by the caller from the
// same candles strategyContext.ts uses. It's undefined for interval and
// take-profit modes, which never need it.
export function agentTick(
  task: AgentTask,
  now: number,
  livePrice: number | undefined,
  snapshot?: PlanSnapshot,
  volCtx?: VolatilityContext,
): AgentTickResult {
  if (task.status !== 'running') return { action: 'none' };
  if (task.executedTrades >= task.totalTrades) return { action: 'complete' };
  if (livePrice === undefined || !isFinite(livePrice) || livePrice <= 0) return { action: 'none' };

  if (task.mode === 'interval') {
    if (task.nextRunAt === undefined || now < task.nextRunAt) return { action: 'none' };
    return openResult(task, livePrice);
  }

  if (task.mode === 'take-profit') {
    if (task.currentEntryPrice === undefined || task.currentQty === undefined) {
      return openResult(task, livePrice);
    }
    return checkOpenLegTick(task, livePrice, volCtx);
  }

  // 'conditional-watch' mode
  if (task.currentEntryPrice !== undefined && task.currentQty !== undefined) {
    // A leg is already open — behaves exactly like take-profit's close
    // check from here (same tpPercent/slPercent/trailing/scale-out
    // fields, once entered).
    return checkOpenLegTick(task, livePrice, volCtx);
  }

  const stage: PlanStage = task.planStage ?? 'trigger';
  const effectiveSnapshot: PlanSnapshot = snapshot ?? { price: livePrice, rsi14: null, ema20: null, ema50: null, volumeRatio: null };

  if (stage === 'trigger') {
    if (!task.triggerCondition) return { action: 'none' }; // shouldn't happen — honest no-op guard
    const met = evaluatePlanCondition(task.triggerCondition, effectiveSnapshot);
    if (met !== true) return { action: 'none' }; // false OR null (can't evaluate yet) — both just wait
    if (!task.watchCondition) {
      // No separate watch stage — the trigger firing IS the entry signal.
      return openResult(task, livePrice);
    }
    return { action: 'stage', planStage: 'watch' };
  }

  // stage === 'watch'
  if (!task.watchCondition) return { action: 'none' };
  const met = evaluatePlanCondition(task.watchCondition, effectiveSnapshot);
  if (met !== true) return { action: 'none' };
  return openResult(task, livePrice);
}
