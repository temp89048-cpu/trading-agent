'use client';

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { loadLS, saveLS, uid } from '@/lib/storage';
import { rankOpportunities, type OpportunityCandidate, type RankedOpportunity } from '@/lib/opportunityScanner';
import { buildStrategyContext } from '@/lib/strategyContext';
import { runStrategyEnsembleGated } from '@/lib/strategyEnsemble';
import { computeSentiment } from '@/lib/sentimentAgent';
import { checkCapability } from '@/lib/providerCapabilities';
import { maxLeverageCeiling } from '@/lib/riskManager';
import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { useOrderFlow } from './OrderFlow';
import { useMultiExchange } from './MultiExchange';
import { useEventDetection } from './EventDetection';
import { useMarketIntel } from './MarketIntel';
import { useDebate } from './Debate';
import { usePortfolio } from './Portfolio';
import { useMissionPlanner } from './MissionPlanner';
import { useTradingControls } from './TradingControls';
import { useAgent } from './Agent';
import type { TradeTab, WatchItem } from '@/lib/types';

// =====================================================================
// Autonomous Trader — the "AI never sleeps" loop (spec Sections 13-14).
//
// This is the piece that makes the system actually AUTONOMOUS rather
// than merely automated: every cycle it observes the whole watchlist,
// ranks opportunities (lib/opportunityScanner.ts), and — if and only if
// everything below lines up — starts an agent task toward the active
// mission WITHOUT being asked. Before this existed, a human had to name
// the symbol and the plan in chat; the system only ever executed a
// human-specified intent.
//
// WHAT THIS DOES NOT DO, deliberately:
// - It does not execute trades itself. It calls startAgent(), and that
//   task's tick loop routes every actual execution through
//   components/Supervisor.tsx's reviewAndExecute — the same single gate
//   (Risk Manager + Debate veto + hard leverage ceiling + mandatory
//   stop-loss + pause + manual-approval threshold) that governs every
//   other AI-initiated trade. This loop cannot bypass any of it, which
//   is exactly the spec's "no AI agent may bypass risk controls."
// - It does not size beyond the active mission's own constraints.
// - It does not run at all unless explicitly enabled. Default is OFF.
//
// Two independent gates by design: the scanner decides WHETHER a
// candidate is worth proposing (using ensemble + structure + debate +
// MTF), and the Supervisor independently decides whether the proposed
// trade may execute at the moment it fires. The scanner is deliberately
// NOT wired to also set requireSignalConfirmation on the task it
// creates: a third gate that can silently never pass would consume the
// max-concurrent slot with a task that never enters, which is worse than
// the small window between proposing and executing (a window the
// Supervisor's own re-check at execution time already covers).
// =====================================================================

const LS_AUTONOMOUS = 'qt_autonomous_v1';
const CYCLE_MS = 60_000; // "every minute" per spec Section 14

export type AutonomousConfig = {
  enabled: boolean;
  tab: TradeTab;
  maxConcurrentPositions: number;
  cooldownMinutes: number; // minimum gap between opened trades
  // Fraction of equity to commit per trade, before mission constraints
  // are applied on top (the stricter of the two always wins).
  positionSizePct: number;
};

const DEFAULT_CONFIG: AutonomousConfig = {
  enabled: false, // OFF by default — autonomy is opt-in, always
  tab: 'paper', // paper by default — moving to 'real' is a deliberate act
  maxConcurrentPositions: 1,
  cooldownMinutes: 5,
  positionSizePct: 10,
};

type PersistedState = {
  config: AutonomousConfig;
  lastTradeAt: number | null;
  createdTaskIds: string[]; // tasks this loop started, so it can count its own concurrency
};

const DEFAULT_PERSISTED: PersistedState = { config: DEFAULT_CONFIG, lastTradeAt: null, createdTaskIds: [] };

export type CycleSummary = {
  ts: number;
  outcome: 'traded' | 'no-trade' | 'error';
  decisionSummary: string;
  considered: RankedOpportunity[];
};

type AutonomousTraderValue = {
  config: AutonomousConfig;
  setConfig: (partial: Partial<AutonomousConfig>) => void;
  lastCycle: CycleSummary | null;
  runCycleNow: () => void;
  /**
   * Heartbeat for the watchdog (lib/watchdog.ts). Updated at the END of
   * every cycle including stand-downs — a cycle that decided not to trade
   * still proves the loop is alive, which is the whole point. null until
   * the first cycle completes.
   */
  lastCycleAt: number | null;
  cycleIntervalMs: number;
};

const AutonomousTraderContext = createContext<AutonomousTraderValue | null>(null);

export function useAutonomousTrader(): AutonomousTraderValue {
  const ctx = useContext(AutonomousTraderContext);
  if (!ctx) throw new Error('useAutonomousTrader must be used within AutonomousTraderProvider');
  return ctx;
}

export function AutonomousTraderProvider({ children }: { children: React.ReactNode }) {
  const { watchlist, ticks } = useMarketData();
  const { getCandles } = useCandles();
  const { getOrderFlow } = useOrderFlow();
  const { getSnapshot } = useMultiExchange();
  const { getEvents } = useEventDetection();
  const { getNews, getFearGreed, getDerivatives } = useMarketIntel();
  const { getLatestDebate, runDebateSync } = useDebate();
  const { tradeLog, getPortfolioSnapshot } = usePortfolio();
  const { activeMission } = useMissionPlanner();
  const { paused, realStartingCapitalUsd } = useTradingControls();
  const { tasks, startAgent } = useAgent();

  const [persisted, setPersisted] = useState<PersistedState>(DEFAULT_PERSISTED);
  const [hydrated, setHydrated] = useState(false);
  const [lastCycle, setLastCycle] = useState<CycleSummary | null>(null);
  // Separate from lastCycle: a stand-down doesn't produce a CycleSummary
  // in every branch, but it still proves the interval fired. The
  // watchdog needs liveness, not outcomes.
  const [lastCycleAt, setLastCycleAt] = useState<number | null>(null);

  // Everything the cycle reads goes through a ref, refreshed every
  // render — the cycle runs inside a setInterval created once, so
  // closing over values directly would permanently read mount-time
  // state. Same pattern and same reasoning as components/Agent.tsx's
  // ticksRef/getCandlesRef.
  const depsRef = useRef({
    watchlist,
    ticks,
    getCandles,
    getOrderFlow,
    getSnapshot,
    getEvents,
    getNews,
    getFearGreed,
    getDerivatives,
    getLatestDebate,
    runDebateSync,
    tradeLog,
    getPortfolioSnapshot,
    activeMission,
    paused,
    realStartingCapitalUsd,
    tasks,
    startAgent,
  });
  depsRef.current = {
    watchlist,
    ticks,
    getCandles,
    getOrderFlow,
    getSnapshot,
    getEvents,
    getNews,
    getFearGreed,
    getDerivatives,
    getLatestDebate,
    runDebateSync,
    tradeLog,
    getPortfolioSnapshot,
    activeMission,
    paused,
    realStartingCapitalUsd,
    tasks,
    startAgent,
  };
  const persistedRef = useRef(persisted);
  persistedRef.current = persisted;

  useEffect(() => {
    setPersisted(loadLS(LS_AUTONOMOUS, DEFAULT_PERSISTED));
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (hydrated) saveLS(LS_AUTONOMOUS, persisted);
  }, [persisted, hydrated]);

  function setConfig(partial: Partial<AutonomousConfig>) {
    setPersisted((p) => ({ ...p, config: { ...p.config, ...partial } }));
  }

  function journalCycle(summary: CycleSummary, acted: { symbol: string; side: 'buy' | 'sell'; marginUsd: number; leverage: number; taskId: string } | null) {
    const d = depsRef.current;
    fetch('/api/autonomous-cycles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: uid(),
        outcome: summary.outcome,
        considered: summary.considered.map((c) => ({
          symbol: c.symbol,
          side: c.side,
          score: c.score,
          actionable: c.actionable,
          reasons: c.reasons,
          blockers: c.blockers,
        })),
        actedSymbol: acted?.symbol ?? null,
        actedSide: acted?.side ?? null,
        actedMarginUsd: acted?.marginUsd ?? null,
        actedLeverage: acted?.leverage ?? null,
        agentTaskId: acted?.taskId ?? null,
        decisionSummary: summary.decisionSummary,
        missionId: d.activeMission?.id ?? null,
        missionProgressPct: d.activeMission?.progress.currentPct ?? null,
      }),
    }).catch(() => {
      // Journalling is best-effort — a failed POST never affects whether
      // a trade happened, same policy as the audit trail.
    });
  }

  // Records a cycle that stopped before ranking anything, with the
  // reason. Kept separate so "why did nothing happen" is always
  // answerable, never silent.
  function standDown(reason: string, considered: RankedOpportunity[] = []) {
    const summary: CycleSummary = { ts: Date.now(), outcome: 'no-trade', decisionSummary: reason, considered };
    setLastCycle(summary);
    journalCycle(summary, null);
  }

  function equityFor(tab: TradeTab): number | null {
    const d = depsRef.current;
    const portfolio = d.getPortfolioSnapshot();
    if (tab === 'paper') {
      return portfolio.paper.cash + portfolio.paper.positions.reduce((sum, p) => sum + p.qty * (d.ticks[p.symbol]?.price ?? p.avgCost), 0);
    }
    // Real tab has no tracked cash — reconstruct from the user-declared
    // starting capital, same approach as components/Supervisor.tsx's
    // realEquityUsd(). Without a declared figure there is no defensible
    // size to trade, so the loop stands down rather than guessing.
    if (d.realStartingCapitalUsd === null) return null;
    const realized = d.tradeLog.filter((t) => t.tab === 'real' && typeof t.pnl === 'number').reduce((sum, t) => sum + (t.pnl as number), 0);
    const unrealized = portfolio.real.positions.reduce((sum, p) => sum + p.qty * ((d.ticks[p.symbol]?.price ?? p.avgCost) - p.avgCost), 0);
    return d.realStartingCapitalUsd + realized + unrealized;
  }

  function runCycle() {
    const d = depsRef.current;
    const { config, lastTradeAt, createdTaskIds } = persistedRef.current;

    // Heartbeat first, before any early return. The failure modes the
    // watchdog exists to catch — tab closed, machine asleep, timer
    // throttled, process crashed — all stop the interval from firing at
    // all, so "runCycle was entered" is exactly the liveness signal.
    // Recording it only on a successful trade would make a correctly
    // standing-down loop look dead.
    setLastCycleAt(Date.now());

    // --- Preconditions. Each one records WHY it stood down.
    if (!config.enabled) return; // silent: the loop is off, journaling every minute would be noise
    if (d.paused) return standDown('Trading is paused by the operator (Trading Controls) — autonomous loop standing down.');

    const mission = d.activeMission;
    if (!mission) {
      return standDown('No active mission — the loop needs a stated goal before it will open anything on its own. Create a mission (e.g. a capital target) to give it direction.');
    }
    if (mission.status !== 'active') {
      return standDown(`Mission "${mission.name}" is ${mission.status}, not active — standing down.`);
    }

    const myRunning = d.tasks.filter((t) => createdTaskIds.includes(t.id) && t.status === 'running');
    if (myRunning.length >= config.maxConcurrentPositions) {
      return standDown(`Already running ${myRunning.length}/${config.maxConcurrentPositions} autonomous position(s) — waiting for one to close before opening another.`);
    }

    if (lastTradeAt !== null) {
      const minsSince = (Date.now() - lastTradeAt) / 60_000;
      if (minsSince < config.cooldownMinutes) {
        return standDown(`Cooldown active — ${(config.cooldownMinutes - minsSince).toFixed(1)} min remaining since the last autonomous entry.`);
      }
    }

    const equity = equityFor(config.tab);
    if (equity === null) {
      return standDown(`No equity baseline for the ${config.tab} tab — set "Real account starting capital" in Trading Controls before letting the loop trade real funds.`);
    }
    if (equity <= 0) {
      return standDown(`Equity for the ${config.tab} tab is $${equity.toFixed(2)} — nothing to trade with.`);
    }

    // --- Observe: build a candidate for every watchlist symbol that has
    // enough real data. Symbols without enough history are simply not
    // candidates (never guessed at).
    const portfolio = d.getPortfolioSnapshot();
    const heldSymbols = new Set(
      (config.tab === 'paper' ? portfolio.paper.positions : portfolio.real.positions).map((p) => p.symbol),
    );
    const openAgentSymbols = new Set(d.tasks.filter((t) => t.status === 'running').map((t) => t.symbol));

    const candidates: OpportunityCandidate[] = [];
    for (const item of d.watchlist) {
      const primary = d.getCandles(item.symbol, '1h');
      if (!primary || primary.candles.length === 0) continue;
      const ctx = buildStrategyContext(item, primary.candles, d.getCandles, d.getOrderFlow(item.symbol));
      if (!ctx) continue; // not enough candle history for a meaningful read

      // Never propose a symbol another agent task is already working —
      // two tasks fighting over one symbol produces the exact qty
      // mismatch components/Agent.tsx already has to defend against.
      if (openAgentSymbols.has(item.symbol)) continue;

      const ensemble = runStrategyEnsembleGated(ctx, d.getSnapshot(item.symbol) ?? null);

      // Reuse a fresh debate if one exists; otherwise run one now. It's a
      // pure deterministic computation (no LLM, no network — see
      // lib/debate/moderator.ts), so the loop can afford a real read
      // rather than scoring blind.
      let debateRead = d.getLatestDebate(item.symbol);
      if (!debateRead) {
        try {
          const cap = checkCapability(item, 'fundingRate');
          const derivatives = cap.supported ? d.getDerivatives(item.symbol) : undefined;
          const fearGreed = item.type === 'crypto' ? d.getFearGreed() : undefined;
          const sentiment = computeSentiment(item.symbol, d.getNews(), derivatives ?? null, fearGreed ?? null);
          const { id, result } = d.runDebateSync({ symbol: item.symbol, ctx, sentiment, liveCandles: primary.candles });
          debateRead = { id, result, ts: Date.now() };
        } catch {
          debateRead = undefined; // scored without it; the scanner says so explicitly
        }
      }

      candidates.push({
        symbol: item.symbol,
        ctx,
        ensemble,
        debate: debateRead
          ? {
              recommendation: debateRead.result.moderator.recommendation,
              compositeConfidencePct: debateRead.result.composite.compositeConfidence * 100,
            }
          : null,
        events: d.getEvents(item.symbol),
        alreadyHeld: heldSymbols.has(item.symbol),
      });
    }

    if (candidates.length === 0) {
      return standDown('No watchlist symbol has enough loaded market data to evaluate yet (or all are already being worked by another agent task).');
    }

    // --- Rank, then decide.
    const ranked = rankOpportunities(candidates);
    const best = ranked.find((r) => r.actionable);

    if (!best) {
      const topReason = ranked[0] ? ` Best candidate ${ranked[0].symbol} (score ${ranked[0].score.toFixed(0)}) blocked by: ${ranked[0].blockers.join('; ')}` : '';
      return standDown(`Evaluated ${ranked.length} symbol(s); none cleared the actionable bar.${topReason}`, ranked);
    }

    // --- Size it, respecting BOTH this loop's own config and the
    // mission's constraints — whichever is stricter wins, always.
    const missionMaxPositionPct = mission.constraints.find((c) => c.kind === 'max-position-size-pct');
    const effectivePositionPct = Math.min(
      config.positionSizePct,
      missionMaxPositionPct && 'value' in missionMaxPositionPct ? missionMaxPositionPct.value : config.positionSizePct,
    );
    const marginUsd = (equity * effectivePositionPct) / 100;

    const missionMaxLeverage = mission.constraints.find((c) => c.kind === 'max-leverage');
    // Default 1x (no leverage). The mission may permit more, but the hard
    // per-tab ceiling in lib/riskManager.ts always caps it — and that
    // ceiling is not overridable by anything here.
    const requestedLeverage = Math.min(
      missionMaxLeverage && 'value' in missionMaxLeverage ? missionMaxLeverage.value : 1,
      maxLeverageCeiling(config.tab),
    );

    if (marginUsd <= 0) {
      return standDown(`Computed position size was $${marginUsd.toFixed(2)} (${effectivePositionPct}% of $${equity.toFixed(2)} equity) — too small to trade.`, ranked);
    }

    // --- Act: create the task. Actual execution still goes through the
    // Supervisor on the task's first tick.
    const rationale = `Autonomous loop selected ${best.symbol} (score ${best.score.toFixed(0)}/100) toward mission "${mission.name}" (${mission.progress.currentPct.toFixed(0)}% complete). ${best.reasons.join(' ')}`;

    try {
      const task = d.startAgent({
        tab: config.tab,
        symbol: best.symbol,
        side: best.side,
        marginUsd,
        leverage: requestedLeverage,
        totalTrades: 1, // one leg per cycle; the loop opens another next cycle if warranted
        mode: 'take-profit',
        // ATR-derived stops adapt to live volatility; the fixed percents
        // are the fallback if an ATR read isn't available at tick time,
        // so a leg is never left with no exit at all.
        useAtrStops: true,
        atrMultiplierTp: 2,
        atrMultiplierSl: 1,
        tpPercent: 3,
        slPercent: 1.5,
        // Continuous monitoring (spec Section 14): since nobody is
        // watching this position, it must be able to notice its own
        // premise breaking and exit, not just sit until TP or SL.
        exitOnThesisInvalidation: true,
        rationale,
      });

      const summary: CycleSummary = {
        ts: Date.now(),
        outcome: 'traded',
        decisionSummary: `Opened an autonomous ${best.side} on ${best.symbol}: $${marginUsd.toFixed(2)} margin × ${requestedLeverage}x (${effectivePositionPct}% of $${equity.toFixed(2)} equity). ${best.reasons.join(' ')}`,
        considered: ranked,
      };
      setLastCycle(summary);
      journalCycle(summary, { symbol: best.symbol, side: best.side, marginUsd, leverage: requestedLeverage, taskId: task.id });
      setPersisted((p) => ({ ...p, lastTradeAt: Date.now(), createdTaskIds: [...p.createdTaskIds, task.id].slice(-200) }));
    } catch (err) {
      const summary: CycleSummary = {
        ts: Date.now(),
        outcome: 'error',
        decisionSummary: `Failed to start an autonomous task on ${best.symbol}: ${err instanceof Error ? err.message : 'unknown error'}`,
        considered: ranked,
      };
      setLastCycle(summary);
      journalCycle(summary, null);
    }
  }

  const runCycleRef = useRef(runCycle);
  runCycleRef.current = runCycle;

  useEffect(() => {
    if (!hydrated) return;
    // A short initial delay lets candles/ticks populate on a fresh load
    // before the first evaluation, so cycle #1 isn't a guaranteed
    // "not enough data" stand-down.
    const timeout = setTimeout(() => runCycleRef.current(), 15_000);
    const iv = setInterval(() => runCycleRef.current(), CYCLE_MS);
    return () => {
      clearTimeout(timeout);
      clearInterval(iv);
    };
  }, [hydrated]);

  const value: AutonomousTraderValue = {
    config: persisted.config,
    setConfig,
    lastCycle,
    runCycleNow: () => runCycleRef.current(),
    lastCycleAt,
    cycleIntervalMs: CYCLE_MS,
  };

  return <AutonomousTraderContext.Provider value={value}>{children}</AutonomousTraderContext.Provider>;
}
