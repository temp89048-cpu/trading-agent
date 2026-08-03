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
import type { MultiExchangeSnapshot } from './multiExchange';
import type { WatchItem } from './types';

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
];

export type EnsembleResult = {
  signals: StrategySignal[];
  plannedAgents: PlannedAgentStatus[];
  consensus: 'BUY' | 'SELL' | 'HOLD';
  confidencePct: number; // 0..100
  buyWeight: number;
  sellWeight: number;
  holdWeight: number;
};

export function runStrategyEnsemble(ctx: StrategyContext, arbitrageSnapshot: MultiExchangeSnapshot | null = null): EnsembleResult {
  const signals = [...CORE_AGENTS.map((run) => run(ctx)), runGridAgent(ctx), runArbitrageAgent(ctx, arbitrageSnapshot)];

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

  return { signals, plannedAgents: PLANNED_AGENTS, consensus, confidencePct, buyWeight, sellWeight, holdWeight };
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
