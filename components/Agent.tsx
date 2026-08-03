'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { loadLS, saveLS, uid } from '@/lib/storage';
import { agentTick, DEFAULT_SIGNAL_CONFIRM_ENSEMBLE_PCT, type VolatilityContext } from '@/lib/agentEngine';
import { atr } from '@/lib/indicators';
import { useMarketData } from './MarketData';
import { usePortfolio } from './Portfolio';
import { useCandles } from './Candles';
import { useOrderFlow } from './OrderFlow';
import { useMultiExchange } from './MultiExchange';
import { useDebate } from './Debate';
import { buildStrategyContext } from '@/lib/strategyContext';
import { runStrategyEnsemble } from '@/lib/strategyEnsemble';
import { useSupervisor } from './Supervisor';
import { captureContextSnapshot } from '@/lib/reflectionAgent';
import { buildPlanSnapshot, describeCondition, type PlanCondition } from '@/lib/plannerAgent';
import type { AgentEvent, AgentMode, AgentTask, TradeSide, TradeTab } from '@/lib/types';

const LS_AGENTS = 'qt_agents_v1';
const TICK_MS = 3000; // real wall-clock check, every 3s — not a fixed "wait N minutes in one breath"

export type NewAgentSpec = {
  conversationId?: string;
  tab: TradeTab;
  symbol: string;
  side: TradeSide;
  marginUsd: number;
  leverage: number;
  totalTrades: number;
  mode: AgentMode;
  intervalMinutes?: number;
  tpPercent?: number;
  slPercent?: number;
  triggerCondition?: PlanCondition; // 'conditional-watch' mode only
  watchCondition?: PlanCondition; // 'conditional-watch' mode only, optional
  rationale?: string;
  // Advanced enhancements — all optional, see lib/types.ts's AgentTask
  // for what each does. Omitting all of these reproduces the exact
  // original fixed TP/SL behavior.
  trailingStopPercent?: number;
  scaleOutLevels?: { tpPercent: number; closeFraction: number }[];
  useAtrStops?: boolean;
  atrMultiplierTp?: number;
  atrMultiplierSl?: number;
  requireSignalConfirmation?: boolean;
  minEnsembleConfidencePct?: number;
  minDebateConfidencePct?: number;
};

type AgentValue = {
  tasks: AgentTask[];
  events: AgentEvent[];
  startAgent: (spec: NewAgentSpec) => AgentTask;
  cancelAgent: (id: string) => void;
  markEventsSeen: (ids: string[]) => void;
};

const AgentContext = createContext<AgentValue | null>(null);

export function useAgent(): AgentValue {
  const ctx = useContext(AgentContext);
  if (!ctx) throw new Error('useAgent must be used within AgentProvider');
  return ctx;
}

export function AgentProvider({ children }: { children: React.ReactNode }) {
  const { ticks } = useMarketData();
  const { getCandles } = useCandles();
  const { getOrderFlow } = useOrderFlow();
  const { getSnapshot } = useMultiExchange();
  const { getLatestDebate } = useDebate();
  const { reviewAndExecute } = useSupervisor();
  const [tasks, setTasks] = useState<AgentTask[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Kept in sync with state via the effect below, and read from inside
  // the tick interval. This — NOT a functional setState updater — is
  // where "what are the current tasks right now" gets answered. See the
  // long comment above the tick effect for exactly why that distinction
  // matters; it's the fix for a real bug, not a style preference.
  const tasksRef = useRef<AgentTask[]>(tasks);
  const ticksRef = useRef(ticks);
  ticksRef.current = ticks;
  // getCandles/getOrderFlow are plain reads over each provider's local
  // `cache` state, closed over at the time they're created — unlike
  // buyPaper/sellPaper (which call setPortfolio with a functional
  // updater, so a "stale" reference is still always correct). Since the
  // scheduler effect below only runs once ([hydrated]), closing over
  // getCandles/getOrderFlow directly would permanently read whichever
  // cache existed at mount time. Refs, refreshed every render, fix that
  // the same way ticksRef already does for live prices.
  const getCandlesRef = useRef(getCandles);
  getCandlesRef.current = getCandles;
  const getOrderFlowRef = useRef(getOrderFlow);
  getOrderFlowRef.current = getOrderFlow;
  // Same ref-freshness reasoning, for signal-gated entries' ensemble/
  // debate reads below.
  const getSnapshotRef = useRef(getSnapshot);
  getSnapshotRef.current = getSnapshot;
  const getLatestDebateRef = useRef(getLatestDebate);
  getLatestDebateRef.current = getLatestDebate;
  // Commit 24: the Supervisor is now the ONLY thing this scheduler
  // calls to actually execute anything — same ref-freshness reasoning
  // as getCandlesRef/getOrderFlowRef above, since reviewAndExecute
  // closes over the latest portfolio/tradeLog/watchlist state itself.
  const reviewAndExecuteRef = useRef(reviewAndExecute);
  reviewAndExecuteRef.current = reviewAndExecute;

  useEffect(() => {
    const loaded = loadLS<AgentTask[]>(LS_AGENTS, []);
    setTasks(loaded);
    tasksRef.current = loaded;
    setHydrated(true);
  }, []);

  useEffect(() => {
    tasksRef.current = tasks;
    if (hydrated) saveLS(LS_AGENTS, tasks);
  }, [tasks, hydrated]);

  function pushEvent(agentId: string, kind: AgentEvent['kind'], message: string, conversationId?: string) {
    setEvents((prev) => [...prev, { id: uid(), ts: Date.now(), agentId, conversationId, kind, message }].slice(-200));
  }

  function startAgent(spec: NewAgentSpec): AgentTask {
    const task: AgentTask = {
      id: uid(),
      conversationId: spec.conversationId,
      tab: spec.tab,
      symbol: spec.symbol,
      side: spec.side,
      marginUsd: spec.marginUsd,
      leverage: spec.leverage,
      totalTrades: spec.totalTrades,
      executedTrades: 0,
      mode: spec.mode,
      intervalMinutes: spec.intervalMinutes,
      tpPercent: spec.tpPercent,
      slPercent: spec.slPercent,
      triggerCondition: spec.triggerCondition,
      watchCondition: spec.watchCondition,
      planStage: spec.mode === 'conditional-watch' ? 'trigger' : undefined,
      status: 'running',
      createdAt: Date.now(),
      nextRunAt: spec.mode === 'interval' ? Date.now() : undefined,
      realizedTotal: 0,
      rationale: spec.rationale,
      trailingStopPercent: spec.trailingStopPercent,
      scaleOutLevels: spec.scaleOutLevels,
      useAtrStops: spec.useAtrStops,
      atrMultiplierTp: spec.atrMultiplierTp,
      atrMultiplierSl: spec.atrMultiplierSl,
      requireSignalConfirmation: spec.requireSignalConfirmation,
      minEnsembleConfidencePct: spec.minEnsembleConfidencePct,
      minDebateConfidencePct: spec.minDebateConfidencePct,
    };
    setTasks((prev) => {
      const next = [...prev, task];
      tasksRef.current = next;
      return next;
    });
    return task;
  }

  function cancelAgent(id: string) {
    const target = tasksRef.current.find((t) => t.id === id);
    if (!target || target.status !== 'running') return;
    const next = tasksRef.current.map((t) => (t.id === id ? { ...t, status: 'cancelled' as const } : t));
    tasksRef.current = next;
    setTasks(next); // plain array, computed above — pushEvent runs exactly once, outside any updater
    pushEvent(id, 'cancelled', `🤖 Agent on ${target.symbol} cancelled after ${target.executedTrades}/${target.totalTrades} trades.`, target.conversationId);
  }

  function markEventsSeen(ids: string[]) {
    setEvents((prev) => prev.filter((e) => !ids.includes(e.id)));
  }

  // BUG FIX, documented so it doesn't come back: this used to call
  // buyPaper/sellPaper/pushEvent (all side effects — buyPaper mutates
  // OTHER state, pushEvent mutates events, both fire network/localStorage
  // writes) from *inside* the function passed to setTasks(prev => ...).
  //
  // React 18 Strict Mode deliberately invokes that function TWICE per
  // update, specifically to catch exactly this kind of impurity. The
  // pure decision logic (agentTick) doesn't care — calling a pure
  // function twice is harmless. But buyPaper() is NOT pure: it really
  // deducts cash. Called twice for one real tick, the first deduction
  // succeeds and the second — now genuinely short on cash — fails,
  // which is exactly the "opened, then immediately insufficient cash"
  // sequence in the bug report.
  //
  // The fix: read tasks from a ref (a plain synchronous value, not a
  // setState updater), decide what should happen, execute every side
  // effect exactly once in normal function-call code, and only THEN
  // call setTasks with a plain array — never a function — so there's
  // no updater for Strict Mode to double-invoke in the first place.
  useEffect(() => {
    if (!hydrated) return;
    const iv = setInterval(() => {
      const currentTasks = tasksRef.current;
      const now = Date.now();

      // Pass 1: pure decision only (agentTick has no side effects) — work
      // out what SHOULD happen to every running task before anything
      // with a side effect (reviewAndExecuteRef, pushEvent) runs, so
      // execution order across tasks can be chosen independently of
      // array order.
      type TickResult = ReturnType<typeof agentTick>;
      type ActedTickResult = Exclude<TickResult, { action: 'none' }>;
      const pending: { task: AgentTask; result: ActedTickResult }[] = [];
      // Bookkeeping-only patches (currently just the trailing-stop peak
      // price) reported alongside a 'none' decision — no side effect to
      // execute, but still needs to land in the next setTasks so the
      // NEXT tick's trail level is computed off the right peak.
      const peakUpdates = new Map<string, Partial<AgentTask>>();
      for (const task of currentTasks) {
        if (task.status !== 'running') continue;
        const price = ticksRef.current[task.symbol]?.price;
        // Only compute the RSI/EMA snapshot for conditional-watch tasks
        // still in the trigger/watch stages (no point once a leg is
        // open, or for the other two modes, which never read it) —
        // avoids extra indicator work on every tick for every task.
        const needsSnapshot = task.mode === 'conditional-watch' && task.currentEntryPrice === undefined;
        const snapshot = needsSnapshot && price !== undefined
          ? (() => {
              const primary = getCandlesRef.current(task.symbol, '1h');
              return primary && primary.candles.length > 0 ? buildPlanSnapshot(primary.candles, price) : undefined;
            })()
          : undefined;
        // ATR-based stops (Level 3 volatility-adaptive TP/SL): only
        // computed when a task actually opts in and has an open leg to
        // protect — no point running ATR for interval-mode tasks or
        // legs not yet entered.
        const needsVolCtx = task.useAtrStops === true && task.currentEntryPrice !== undefined;
        const volCtx = needsVolCtx
          ? (() => {
              const primary = getCandlesRef.current(task.symbol, '1h');
              if (!primary || primary.candles.length === 0) return undefined;
              const atrValue = atr(primary.candles, 14);
              const lastClose = primary.candles[primary.candles.length - 1]?.c;
              return atrValue !== null && lastClose ? { atrPercent: (atrValue / lastClose) * 100 } : undefined;
            })()
          : undefined;
        const result = agentTick(task, now, price, snapshot, volCtx);
        if (result.action === 'none') {
          if (result.patch) peakUpdates.set(task.id, result.patch);
          continue;
        }
        pending.push({ task, result });
      }

      if (pending.length === 0 && peakUpdates.size === 0) return;

      // Pass 2: order side effects by urgency (Level 19's Supervisor
      // urgency classification — 'close' actions are always
      // stop/target-triggered exits, i.e. always 'critical' per
      // classifyUrgency — made real instead of a computed-but-unread
      // field). Closes run before new opens within the same tick, since
      // a close can free up cash/exposure headroom an open in the same
      // batch would otherwise get rejected for. Array.prototype.sort is
      // stable, so tasks of equal priority still process in their
      // original array order.
      const ACTION_PRIORITY: Record<TickResult['action'], number> = { close: 0, stage: 1, complete: 1, open: 2, none: 3 };
      const ordered = [...pending].sort((a, b) => ACTION_PRIORITY[a.result.action] - ACTION_PRIORITY[b.result.action]);

      // Pass 3: execute side effects in that order, collecting each
      // task's update keyed by id.
      const updates = new Map<string, AgentTask>();
      for (const { task, result } of ordered) {
        // A throw anywhere in one task's side effects (risk/correlation
        // math, Supervisor review, etc.) must not lose the bookkeeping
        // already committed for the other tasks processed earlier in
        // this same tick — setTasks only runs once, after this whole
        // loop, so an unhandled exception here would otherwise discard
        // every prior task's update along with it. Catching per-task and
        // leaving that task's entry out of `updates` means it just keeps
        // its previous state (via `updates.get(task.id) ?? task` below)
        // and gets re-evaluated next tick, instead of silently losing
        // sibling tasks' already-real side effects.
        try {
          if (result.action === 'stage') {
          const label = task.planStage === undefined || task.planStage === 'trigger'
            ? (task.watchCondition ? `now watching entry condition: ${describeCondition(task.watchCondition)}` : 'entering')
            : 'staged';
          pushEvent(task.id, 'staged', `🤖 Agent on ${task.symbol} — trigger condition met (${task.triggerCondition ? describeCondition(task.triggerCondition) : 'n/a'}), ${label}.`, task.conversationId);
          updates.set(task.id, { ...task, planStage: result.planStage });
          continue;
        }

        if (result.action === 'complete') {
          pushEvent(task.id, 'completed', `🤖 Agent on ${task.symbol} finished all ${task.totalTrades} trades. Realized P&L: ${task.realizedTotal >= 0 ? '+' : ''}$${task.realizedTotal.toFixed(2)}.`, task.conversationId);
          updates.set(task.id, { ...task, status: 'completed' as const });
          continue;
        }

        if (result.action === 'open') {
          // Commit 13: the scheduler is autonomous — nothing is watching
          // each tick — so a risk veto here needs to actually stop it,
          // the same seriousness as running out of cash below. Only the
          // OPEN action is gated; a close (TP/SL hit) is never blocked,
          // since refusing to let someone exit a position they're
          // already in because "spread is wide" would be actively
          // harmful, not protective.
          const primary = getCandlesRef.current(task.symbol, '1h');
          const strategyCtx = primary && primary.candles.length > 0
            ? buildStrategyContext({ symbol: task.symbol, type: task.symbol.includes('/') ? 'crypto' : 'equity' }, primary.candles, getCandlesRef.current, getOrderFlowRef.current(task.symbol))
            : null;

          if (!strategyCtx) {
            pushEvent(task.id, 'error', `🤖 Agent on ${task.symbol} couldn't open trade ${task.executedTrades + 1}/${task.totalTrades} — not enough market data loaded yet to run risk checks. Agent stopped rather than trade blind.`, task.conversationId);
            updates.set(task.id, { ...task, status: 'error' as const, errorMessage: 'insufficient data for risk check' });
            continue;
          }

          // Signal-gated entries: require the Strategy Ensemble and/or
          // Debate System to actually AGREE with task.side above a
          // confidence floor before firing. This is stricter than (and
          // separate from) the Supervisor's own conflict resolution
          // below, which only VETOES a strong opposing signal — it
          // never requires an affirmative one. A gate that hasn't
          // passed yet is not an error: `continue` without touching
          // `updates` leaves the task's state unchanged, so it's simply
          // re-checked again next tick (no nextRunAt/planStage consumed).
          if (task.requireSignalConfirmation) {
            const ensemble = runStrategyEnsemble(strategyCtx, getSnapshotRef.current(task.symbol) ?? null);
            const minEnsemblePct = task.minEnsembleConfidencePct ?? DEFAULT_SIGNAL_CONFIRM_ENSEMBLE_PCT;
            const ensembleAgrees = ensemble.consensus === task.side.toUpperCase() && ensemble.confidencePct >= minEnsemblePct;

            const debate = getLatestDebateRef.current(task.symbol);
            // No debate result yet for this symbol isn't a reason to
            // block forever on data that doesn't exist — the ensemble
            // check alone gates in that case. Once a debate result DOES
            // exist, it must actually agree (and clear the confidence
            // floor, if one's set) same as the ensemble.
            const debateAgrees = !debate
              ? true
              : debate.result.moderator.recommendation === task.side.toUpperCase() &&
                debate.result.composite.compositeConfidence * 100 >= (task.minDebateConfidencePct ?? 0);

            if (!ensembleAgrees || !debateAgrees) continue;
          }

          // Commit 24: the autonomous scheduler no longer builds its own
          // risk/correlation context or calls buyPaper/addRealPosition
          // directly — it asks the Supervisor, same as every other
          // AI-agent-initiated execution path now does. The Supervisor
          // gathers strategy context, correlation, ensemble consensus,
          // and the latest Debate result itself.
          const { decision, executed, pendingApprovalId, realOrderSubmitted } = reviewAndExecuteRef.current({
            symbol: task.symbol,
            side: task.side,
            tab: task.tab,
            qty: result.qty,
            price: result.price,
            originTag: 'agent-plan',
            rationale: task.rationale,
            requestedLeverage: task.leverage,
            entryContext: captureContextSnapshot(task.symbol, getCandlesRef.current),
            pendingApprovalKey: task.id,
          });

          if (!decision.approved) {
            pushEvent(
              task.id,
              'error',
              `🤖 Agent on ${task.symbol} — Supervisor rejected trade ${task.executedTrades + 1}/${task.totalTrades}: ${decision.reasons.join('; ')}. Agent stopped.`,
              task.conversationId,
            );
            updates.set(task.id, { ...task, status: 'error' as const, errorMessage: `Supervisor rejected: ${decision.reasons.join('; ')}` });
            continue;
          }
          if (pendingApprovalId) {
            // Passed every risk check but exceeds the operator's manual-
            // approval threshold — queued, not failed. Stopping the task
            // here (same as a rejection) rather than silently retrying
            // every tick is deliberate: approving/rejecting it happens
            // in the Trading Controls panel, and re-arming this agent
            // (if still wanted) is a fresh "start agent" afterward.
            pushEvent(
              task.id,
              'error',
              `🤖 Agent on ${task.symbol} — trade ${task.executedTrades + 1}/${task.totalTrades} exceeds the manual-approval threshold and is queued in Trading Controls. Approve/reject it there; restart this agent afterward if you want it to continue.`,
              task.conversationId,
            );
            updates.set(task.id, { ...task, status: 'error' as const, errorMessage: 'queued for manual approval' });
            continue;
          }
          if (realOrderSubmitted) {
            // A real exchange order was just submitted asynchronously —
            // not a failure, and not "insufficient cash" (that check
            // doesn't even apply; the exchange enforces its own balance
            // check). This task's own TP/SL tracking below uses the
            // REQUESTED price/qty as a placeholder — the real fill,
            // whatever it turns out to be, updates the actual real-tab
            // ledger separately (see components/Supervisor.tsx's
            // submitRealOrderAsync) and is visible in the Audit Trail
            // once confirmed.
            pushEvent(
              task.id,
              'opened',
              `🤖 Agent on ${task.symbol} — real order ${task.executedTrades + 1}/${task.totalTrades} submitted to the exchange. Confirming fill — check the Audit Trail for the result.`,
              task.conversationId,
            );
            if (task.mode === 'interval') {
              const executedTrades = task.executedTrades + 1;
              updates.set(task.id, { ...task, executedTrades, nextRunAt: executedTrades < task.totalTrades ? now + (task.intervalMinutes ?? 1) * 60000 : undefined });
              continue;
            }
            updates.set(task.id, { ...task, currentEntryPrice: result.price, currentQty: result.qty, currentPeakPrice: result.price, scaledOutLevels: [], breakEvenArmed: false });
            continue;
          }
          if (!executed) {
            pushEvent(task.id, 'error', `🤖 Agent on ${task.symbol} couldn't open trade ${task.executedTrades + 1}/${task.totalTrades} — insufficient paper cash. Agent stopped.`, task.conversationId);
            updates.set(task.id, { ...task, status: 'error' as const, errorMessage: 'insufficient paper cash' });
            continue;
          }
          const conflictSuffix = decision.conflictNotes.length > 0 ? ` (Supervisor notes: ${decision.conflictNotes.length} cross-agent conflict note${decision.conflictNotes.length > 1 ? 's' : ''} — see explanation.)` : '';
          pushEvent(
            task.id,
            'opened',
            `🤖 Agent trade ${task.executedTrades + 1}/${task.totalTrades}: ${task.side.toUpperCase()} ${result.qty.toFixed(6).replace(/\.?0+$/, '')} ${task.symbol} @ $${result.price.toLocaleString()} (margin $${result.marginUsed.toFixed(2)} × ${task.leverage}x).${conflictSuffix}`,
            task.conversationId,
          );
          if (task.mode === 'interval') {
            const executedTrades = task.executedTrades + 1;
            updates.set(task.id, {
              ...task,
              executedTrades,
              nextRunAt: executedTrades < task.totalTrades ? now + (task.intervalMinutes ?? 1) * 60000 : undefined,
            });
            continue;
          }
          updates.set(task.id, {
            ...task,
            currentEntryPrice: result.price,
            currentQty: result.qty,
            // Fresh leg — reset the trailing-stop peak and scale-out
            // bookkeeping so a PRIOR leg's progress never leaks into
            // this one.
            currentPeakPrice: result.price,
            scaledOutLevels: [],
            breakEvenArmed: false,
          });
          continue;
        }

        // result.action === 'close' (take-profit/conditional-watch mode)
        // — closing/de-risking is never blocked by the Supervisor, but
        // it still reviews the close for the explanation record and
        // urgency tagging (a stop/target-triggered close is flagged
        // 'critical', which is exactly why this branch now runs first —
        // see Pass 2 above — in any tick that also has opens pending).
        const { executed: closeExecuted, realOrderSubmitted: closeOrderSubmitted } = reviewAndExecuteRef.current({
          symbol: task.symbol,
          side: 'sell',
          tab: task.tab,
          qty: result.qty,
          price: result.price,
          originTag: 'agent-plan',
          isStopOrTargetTriggered: true,
        });
        if (!closeExecuted && !closeOrderSubmitted) {
          // The real position no longer has this qty available — most
          // likely a manual sell/reduce happened out-of-band on the same
          // symbol (manual actions are never gated by the Supervisor).
          // Recording this as a completed close anyway would report a
          // phantom P&L that never actually hit cash/positions, so stop
          // the task and surface it instead of silently diverging.
          pushEvent(
            task.id,
            'error',
            `🤖 Agent on ${task.symbol} — could not close trade ${task.executedTrades + 1}/${task.totalTrades}: position no longer holds enough qty (likely a manual trade on this symbol). Agent stopped rather than record an unreal P&L.`,
            task.conversationId,
          );
          updates.set(task.id, { ...task, status: 'error' as const, errorMessage: 'close failed — position qty mismatch' });
          continue;
        }
        if (closeOrderSubmitted) {
          // Real exchange sell submitted asynchronously — this task's
          // bookkeeping below proceeds using the agent's own estimated
          // price/pnl (same approximation the open path uses); the real
          // fill updates the actual real-tab ledger separately once
          // confirmed (see components/Supervisor.tsx's submitRealOrderAsync).
          pushEvent(task.id, 'closed', `🤖 Agent on ${task.symbol} — real close order submitted to the exchange. Confirming fill — check the Audit Trail for the result.`, task.conversationId);
        }

        if (result.scaleOutLevelIndex !== undefined) {
          // Partial close — this leg's remaining qty stays open, only
          // the scaled-out fraction is realized. Never counts as a
          // completed trade of its own (executedTrades untouched) and
          // arms the breakeven floor so the remaining runner can't turn
          // a winning trade into a loss.
          const remainingQty = task.currentQty! - result.qty;
          const realizedTotal = task.realizedTotal + result.pnl;
          const levelNum = result.scaleOutLevelIndex + 1;
          pushEvent(
            task.id,
            'closed',
            `🤖 Agent scaled out level ${levelNum} on ${task.symbol}: closed ${result.qty.toFixed(6).replace(/\.?0+$/, '')} @ $${result.price.toLocaleString()}, P&L ${result.pnl >= 0 ? '+' : ''}$${result.pnl.toFixed(2)}. ${remainingQty > 1e-9 ? `Remainder ${remainingQty.toFixed(6).replace(/\.?0+$/, '')} still open, stop moved to breakeven.` : 'Fully scaled out.'}`,
            task.conversationId,
          );
          if (remainingQty > 1e-9) {
            updates.set(task.id, {
              ...task,
              realizedTotal,
              currentQty: remainingQty,
              scaledOutLevels: [...(task.scaledOutLevels ?? []), result.scaleOutLevelIndex],
              breakEvenArmed: true,
            });
            continue;
          }
          // Scale-out levels summed to the entire position — treat this
          // as the leg's final close, same bookkeeping as a full close.
          const executedTrades = task.executedTrades + 1;
          updates.set(task.id, {
            ...task,
            executedTrades,
            realizedTotal,
            currentEntryPrice: undefined,
            currentQty: undefined,
            currentPeakPrice: undefined,
            scaledOutLevels: [],
            breakEvenArmed: false,
            planStage: task.mode === 'conditional-watch' ? ('trigger' as const) : task.planStage,
            status: executedTrades >= task.totalTrades ? ('completed' as const) : task.status,
          });
          continue;
        }

        const executedTrades = task.executedTrades + 1;
        const realizedTotal = task.realizedTotal + result.pnl;
        const hitLabel = result.pnl >= 0 ? 'TP' : 'SL';
        pushEvent(
          task.id,
          'closed',
          `🤖 Agent trade ${executedTrades}/${task.totalTrades} closed (${hitLabel}): ${task.symbol} @ $${result.price.toLocaleString()}, P&L ${result.pnl >= 0 ? '+' : ''}$${result.pnl.toFixed(2)}. Running total: ${realizedTotal >= 0 ? '+' : ''}$${realizedTotal.toFixed(2)}.`,
          task.conversationId,
        );
        updates.set(task.id, {
          ...task,
          executedTrades,
          realizedTotal,
          currentEntryPrice: undefined,
          currentQty: undefined,
          currentPeakPrice: undefined,
          scaledOutLevels: [],
          breakEvenArmed: false,
          planStage: task.mode === 'conditional-watch' ? ('trigger' as const) : task.planStage,
          status: executedTrades >= task.totalTrades ? ('completed' as const) : task.status,
        });
        } catch (err) {
          // Deliberately no `updates.set(task.id, ...)` here — leaving
          // this task out of `updates` means Pass 4 falls back to its
          // unchanged prior state, so whatever side effects already ran
          // for tasks earlier in `ordered` this tick are still committed
          // via setTasks below, instead of the whole tick's bookkeeping
          // being lost to one task's exception.
          console.error(`Agent tick: task ${task.id} (${task.symbol}) threw`, err);
          pushEvent(task.id, 'error', `🤖 Agent on ${task.symbol} hit an internal error processing trade ${task.executedTrades + 1}/${task.totalTrades}: ${err instanceof Error ? err.message : 'unknown error'}. Will retry next tick.`, task.conversationId);
        }
      }

      // Pass 4: reassemble the task list in its ORIGINAL order — only
      // the execution order of side effects above changed, not the
      // visible list order. A task with no acted result but a
      // bookkeeping-only patch (trailing-stop peak) from Pass 1 still
      // needs that patch applied here, or the next tick loses it.
      const nextTasks = currentTasks.map((task) => {
        const acted = updates.get(task.id);
        if (acted) return acted;
        const patch = peakUpdates.get(task.id);
        return patch ? { ...task, ...patch } : task;
      });
      tasksRef.current = nextTasks;
      setTasks(nextTasks); // a plain array, never a function — nothing for Strict Mode to double-invoke
    }, TICK_MS);
    return () => clearInterval(iv);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hydrated]);

  const value: AgentValue = { tasks, events, startAgent, cancelAgent, markEventsSeen };
  return <AgentContext.Provider value={value}>{children}</AgentContext.Provider>;
}
