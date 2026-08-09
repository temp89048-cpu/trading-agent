import type { StrategyContext, StrategySignal } from './strategyContext';
import { runTrendFollowingAgent } from './strategies/trendFollowing';
import { runMomentumAgent } from './strategies/momentum';
import { runScalpingAgent } from './strategies/scalping';
import { runSwingTradingAgent } from './strategies/swingTrading';
import { runMeanReversionAgent } from './strategies/meanReversion';
import { runBreakoutAgent } from './strategies/breakout';
import { runRangeTradingAgent } from './strategies/rangeTrading';
import { GRID_STRATEGY_STATUS, runGridAgent } from './strategies/grid';
import { ARBITRAGE_STRATEGY_STATUS, runArbitrageAgent } from './strategies/arbitrage';
import { runSmartMoneyAgent } from './strategies/smartMoney';
import { runVwapAgent } from './strategies/vwapReversion';
import { runVolumeProfileAgent } from './strategies/volumeProfileEdge';
import { runVolatilityAgent } from './strategies/volatilityRegime';
import type { MultiExchangeSnapshot } from './multiExchange';
import type { WatchItem } from './types';
import { classifyCurrentRegime, REGIME_LABELS, type RegimeLabel } from './marketRegime';
import { getStrategyProfile, isStrategyActiveInRegime } from './strategyProfiles';

// Grid and Arbitrage now cast real votes (see strategies/grid.ts and
// strategies/arbitrage.ts) — what's still Status: Planned for both is
// EXECUTION, not the ability to form an opinion: Grid always abstains
// (HOLD) since it can only assess whether conditions favor a grid, not
// place one; Arbitrage can vote directionally off real detected
// cross-exchange spreads, but still can't act on them. Listed in the
// roadmap output below so the execution gap stays visible and honest.
export type PlannedAgentStatus = {
  agent: string;
  status: 'planned';
  reason: string;
  requiredComponents: string[];
  complexity: 'Low' | 'Medium' | 'High';
  plannedVersion: string;
  recommendedProviders: string[];
};

const PLANNED_AGENTS: PlannedAgentStatus[] = [GRID_STRATEGY_STATUS, ARBITRAGE_STRATEGY_STATUS];
export { PLANNED_AGENTS };

const CORE_AGENTS: ((ctx: StrategyContext) => StrategySignal)[] = [
  runTrendFollowingAgent,
  runMomentumAgent,
  runScalpingAgent,
  runSwingTradingAgent,
  runMeanReversionAgent,
  runBreakoutAgent,
  runRangeTradingAgent,
  // Added to close spec Section 11.2 gaps using data the app already
  // computes but had no agent reading: structure events + liquidity
  // sweeps (SMC/ICT), VWAP, volume profile, and ATR-relative volatility
  // regime. SMC and ICT are deliberately ONE agent — their tradable
  // primitives overlap almost entirely, and two agents voting off the
  // same reads would double-count one perspective in the ensemble.
  runSmartMoneyAgent,
  runVwapAgent,
  runVolumeProfileAgent,
  runVolatilityAgent,
];

export type EnsembleResult = {
  signals: StrategySignal[];
  plannedAgents: PlannedAgentStatus[];
  consensus: 'BUY' | 'SELL' | 'HOLD';
  confidencePct: number; // 0..100
  buyWeight: number;
  sellWeight: number;
  holdWeight: number;
  /** The regime used for gating, when one was supplied. */
  regime: RegimeLabel | null;
  /** Agents forced to abstain because the live regime doesn't suit them. */
  gatedOut: { agent: string; reason: string }[];
};

// Regime-gated activation (roadmap Phase 34/71: "strategies activate only
// in suitable regimes").
//
// Previously every agent voted on every symbol in every condition. That
// actively degraded the consensus: a mean-reversion agent fading a strong
// trend isn't contributing a perspective, it's contributing noise that
// the confidence-weighted vote then has to average away — and worse, it
// can tip a genuine trend signal toward HOLD.
//
// Gating turns an unsuited agent's vote into an explicit abstention
// (HOLD) with a stated reason, rather than dropping it silently. That
// distinction matters: the ensemble still shows it was consulted and
// declined, so a reader can tell "unsuited here" from "had no opinion."
//
// `regime` is optional. Omitted (or 'unknown') = no gating, i.e. exactly
// the pre-existing behavior — this is deliberately not a silent behavior
// change for any caller that hasn't opted in by supplying a regime.
function applyRegimeGate(
  signals: StrategySignal[],
  regime: RegimeLabel | null,
): { signals: StrategySignal[]; gatedOut: { agent: string; reason: string }[] } {
  if (regime === null || regime === 'unknown') return { signals, gatedOut: [] };

  const gatedOut: { agent: string; reason: string }[] = [];
  const gated = signals.map((s) => {
    // An agent already abstaining needs no gate, and a profileless agent
    // is left alone rather than silently disabled.
    if (s.signal === 'HOLD') return s;
    if (isStrategyActiveInRegime(s.agent, regime)) return s;

    const profile = getStrategyProfile(s.agent);
    const reason = `${REGIME_LABELS[regime]} is outside this strategy's declared active regimes${profile ? ` (${profile.activeRegimes.join(', ')})` : ''}.`;
    gatedOut.push({ agent: s.agent, reason });
    return {
      agent: s.agent,
      signal: 'HOLD' as const,
      confidence: 0.5,
      reason: `Abstaining — wanted ${s.signal} (${s.reason}) but ${reason}`,
    };
  });
  return { signals: gated, gatedOut };
}

export function runStrategyEnsemble(
  ctx: StrategyContext,
  arbitrageSnapshot: MultiExchangeSnapshot | null = null,
  regime: RegimeLabel | null = null,
): EnsembleResult {
  const rawSignals = [...CORE_AGENTS.map((run) => run(ctx)), runGridAgent(ctx), runArbitrageAgent(ctx, arbitrageSnapshot)];
  const { signals, gatedOut } = applyRegimeGate(rawSignals, regime);

  const buyWeight = signals.filter((s) => s.signal === 'BUY').reduce((sum, s) => sum + s.confidence, 0);
  const sellWeight = signals.filter((s) => s.signal === 'SELL').reduce((sum, s) => sum + s.confidence, 0);
  const holdWeight = signals.filter((s) => s.signal === 'HOLD').reduce((sum, s) => sum + s.confidence, 0);

  // Consensus is decided between BUY and SELL only — a HOLD agent is
  // abstaining, not casting a vote for "no trade," so it doesn't dilute
  // the confidence of whichever direction the directional agents agree
  // on. If nothing is directional at all, the ensemble itself holds.
  const directionalTotal = buyWeight + sellWeight;
  let consensus: EnsembleResult['consensus'] = 'HOLD';
  let confidencePct = 0;

  if (directionalTotal > 0) {
    if (buyWeight > sellWeight) {
      consensus = 'BUY';
      confidencePct = (buyWeight / directionalTotal) * 100;
    } else if (sellWeight > buyWeight) {
      consensus = 'SELL';
      confidencePct = (sellWeight / directionalTotal) * 100;
    } else {
      consensus = 'HOLD'; // exact tie between BUY and SELL weight
      confidencePct = 50;
    }
  }

  return { signals, plannedAgents: PLANNED_AGENTS, consensus, confidencePct, buyWeight, sellWeight, holdWeight, regime, gatedOut };
}

/**
 * The regime-gated entry point every LIVE caller should use.
 *
 * Classifies the current regime from the same candles already on the
 * StrategyContext (no extra fetching) and gates unsuited strategies. A
 * convenience wrapper rather than folding classification into
 * runStrategyEnsemble itself, because the BACKTEST path deliberately
 * stays ungated: a backtest exists to measure a strategy's raw behavior,
 * and per-bar historical gating is a separate change with its own
 * correctness questions (lib/backtest/regime.ts already classifies
 * per-bar for attribution). Mixing the two silently would make backtest
 * results incomparable to previously recorded ones.
 */
export function runStrategyEnsembleGated(
  ctx: StrategyContext,
  arbitrageSnapshot: MultiExchangeSnapshot | null = null,
): EnsembleResult {
  const regime = classifyCurrentRegime(ctx.candles);
  return runStrategyEnsemble(ctx, arbitrageSnapshot, regime.label);
}

// ---------------------------------------------------------------------
// Chat context injection.
// ---------------------------------------------------------------------
export type StrategyEnsembleLookup = (item: WatchItem) => StrategyContext | null;

function formatPlannedAgent(p: PlannedAgentStatus): string {
  return (
    `  ${p.agent} Agent — Status: Planned\n` +
    `    Reason: ${p.reason}\n` +
    `    Required: ${p.requiredComponents.join('; ')}\n` +
    `    Recommended providers: ${p.recommendedProviders.join('; ')}\n` +
    `    Complexity: ${p.complexity}. Target: ${p.plannedVersion}.`
  );
}

export function buildStrategyEnsembleContext(
  watchlist: WatchItem[],
  lookup: StrategyEnsembleLookup,
  getSnapshot?: (symbol: string) => MultiExchangeSnapshot | null,
): string {
  if (watchlist.length === 0) return 'STRATEGY ENSEMBLE: no watchlist symbols to analyze.';

  const blocks: string[] = [];
  for (const item of watchlist) {
    const ctx = lookup(item);
    if (!ctx) {
      blocks.push(`${item.symbol}: not enough data yet for strategy analysis`);
      continue;
    }
    const result = runStrategyEnsemble(ctx, getSnapshot ? getSnapshot(item.symbol) : null);
    const lines = result.signals.map((s) => `  ${s.agent} Agent: ${s.signal} (conf ${(s.confidence * 100).toFixed(0)}%) — ${s.reason}`);
    blocks.push(
      `${item.symbol}:\n${lines.join('\n')}\n  Consensus: ${result.consensus}${result.consensus !== 'HOLD' ? ` — Confidence ${result.confidencePct.toFixed(0)}%` : ''} (BUY weight ${result.buyWeight.toFixed(2)}, SELL weight ${result.sellWeight.toFixed(2)}, HOLD weight ${result.holdWeight.toFixed(2)})`,
    );
  }

  const plannedBlock = PLANNED_AGENTS.map(formatPlannedAgent).join('\n');

  return `STRATEGY ENSEMBLE (9 independent rule-based agents voting, each reading only real computed data — Grid and Arbitrage vote too now, see below for what's still missing for them):\n${blocks.join(
    '\n\n',
  )}\n\nConsensus is a confidence-weighted vote between BUY and SELL agents only; HOLD agents abstain rather than dilute the vote. This is one input among many, not an instruction to trade — still apply the same confidence gating (<0.5 → don't act) and risk checks as everything else.\n\nEXECUTION STILL PLANNED for these two (they vote above using real data, but this app can't act on their specific strategy even if the ensemble consensus does):\n${plannedBlock}`;
}
