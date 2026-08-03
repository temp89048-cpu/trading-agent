import type { AgentName, DebateRecord } from './types';
import { AGENT_LABELS } from './types';

// Scoping note, stated plainly because it matters: an agent's accuracy
// here is only measured on records where that agent's directional call
// (BUY/SELL) matched the direction the trade actually took. If an agent
// disagreed with what got traded, there's no way to know whether ITS
// call would have won or lost — that trade never happened. So a
// disagreeing agent's counterfactual is simply not counted, not
// guessed at. HOLD calls aren't scored either, since HOLD isn't being
// tested against a directional trade outcome.

export type AgentReputation = { agent: AgentName; label: string; accuracy: number | null; sampleSize: number };

const MIN_SAMPLES_FOR_REPUTATION = 6;

export function computeAgentReputation(records: DebateRecord[]): Record<AgentName, AgentReputation> {
  const withOutcome = records.filter((r) => r.outcome !== null && r.tradeId !== null);

  const agents: AgentName[] = ['trend', 'momentum', 'meanReversion', 'breakout', 'news', 'volatility', 'orderFlow'];
  const out = {} as Record<AgentName, AgentReputation>;

  for (const agent of agents) {
    let correct = 0;
    let total = 0;
    for (const record of withOutcome) {
      const opinion = record.opinions.find((o) => o.agent === agent);
      if (!opinion || opinion.recommendation === 'HOLD') continue;
      if (opinion.recommendation !== record.moderator.recommendation) continue; // agent disagreed with what was traded — uncountable, see note above
      total++;
      if (record.outcome === 'win') correct++;
    }
    out[agent] = {
      agent,
      label: AGENT_LABELS[agent],
      accuracy: total >= MIN_SAMPLES_FOR_REPUTATION ? correct / total : null,
      sampleSize: total,
    };
  }

  return out;
}

// Converts reputation into the weight multipliers moderate() accepts —
// agents with no track record yet (or too little to trust) stay at a
// neutral 1.0 rather than being penalized for lack of data.
export function reputationToWeights(reputation: Record<AgentName, AgentReputation>): Partial<Record<AgentName, number>> {
  const weights: Partial<Record<AgentName, number>> = {};
  for (const agent of Object.keys(reputation) as AgentName[]) {
    const acc = reputation[agent].accuracy;
    weights[agent] = acc === null ? 1 : 0.5 + acc;
  }
  return weights;
}
