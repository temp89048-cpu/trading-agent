import type { Candle } from '../indicators';
import { classifyRegimes } from '../backtest/regime';
import type { AgentName, DebateRecord, DebateRegimeTag } from './types';
import { AGENT_LABELS } from './types';

// Reuses the EXACT SAME regime classifier as the backtesting engine
// (lib/backtest/regime.ts) — a live "bull/high-vol" tag and a backtest
// "bull/high-vol" tag mean the same thing because they're the same
// function, not two independently-drifting definitions of "bull."

export function currentRegime(candles: Candle[]): DebateRegimeTag {
  if (candles.length === 0) return null;
  const regimes = classifyRegimes(candles);
  const last = regimes[regimes.length - 1];
  return last ?? null;
}

export function regimeKey(tag: DebateRegimeTag): string | null {
  return tag ? `${tag.trend}/${tag.vol}` : null;
}

export type RegimeAgentPerformance = { agent: AgentName; label: string; accuracy: number | null; sampleSize: number };

const MIN_SAMPLES_FOR_REGIME_STAT = 5; // smaller bar than overall reputation — regime buckets naturally split the data thinner, but still enough to say something

// For the CURRENT regime specifically: how has each agent done,
// historically, on trades taken while that same regime was in effect?
// Same "only count agent calls that matched what was actually traded"
// rule as lib/debate/reputation.ts, just filtered to one regime bucket
// first.
export function computeRegimePerformance(records: DebateRecord[], regime: DebateRegimeTag): Record<AgentName, RegimeAgentPerformance> {
  const key = regimeKey(regime);
  const inRegime = records.filter((r) => r.outcome !== null && r.tradeId !== null && regimeKey(r.regime) === key);

  const agents: AgentName[] = ['trend', 'momentum', 'meanReversion', 'breakout', 'news', 'volatility', 'orderFlow'];
  const out = {} as Record<AgentName, RegimeAgentPerformance>;

  for (const agent of agents) {
    let correct = 0;
    let total = 0;
    for (const record of inRegime) {
      const opinion = record.opinions.find((o) => o.agent === agent);
      if (!opinion || opinion.recommendation === 'HOLD') continue;
      if (opinion.recommendation !== record.moderator.recommendation) continue;
      total++;
      if (record.outcome === 'win') correct++;
    }
    out[agent] = { agent, label: AGENT_LABELS[agent], accuracy: total >= MIN_SAMPLES_FOR_REGIME_STAT ? correct / total : null, sampleSize: total };
  }

  return out;
}

// Combines regime-specific performance with overall reputation into
// moderate()'s weight format: regime performance takes priority when
// there's enough regime-specific sample size, otherwise falls back to
// the agent's overall reputation weight, otherwise neutral 1.0 — never
// silently drops back to "no data" without a defined fallback chain.
export function regimeAwareWeights(regimePerf: Record<AgentName, RegimeAgentPerformance>, overallWeights: Partial<Record<AgentName, number>>): Partial<Record<AgentName, number>> {
  const weights: Partial<Record<AgentName, number>> = {};
  for (const agent of Object.keys(regimePerf) as AgentName[]) {
    const regimeAcc = regimePerf[agent].accuracy;
    weights[agent] = regimeAcc !== null ? 0.5 + regimeAcc : (overallWeights[agent] ?? 1);
  }
  return weights;
}
