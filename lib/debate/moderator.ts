import type { AgentName, AgentOpinion, Recommendation, ModeratorDecisionSummary } from './types';
import { AGENT_LABELS } from './types';

// Deliberately a PURE, deterministic function — not an LLM call. The
// reasoning a moderator needs to do here (who agrees, who's weighted
// higher, what's the net vote) is fully computable from real numbers
// already on hand; asking a model to "reason over" them would add
// hallucination risk to a financial decision for no real benefit over
// just computing it, and it wouldn't be reproducible run-to-run. This
// mirrors the same "compute it, don't ask the model to invent it"
// principle Commit 19's confidence-calibration section itself asks for.

export type ModeratorDecision = ModeratorDecisionSummary;

export function moderate(opinions: AgentOpinion[], reputationWeights?: Partial<Record<AgentName, number>>): ModeratorDecision {
  const weighted = opinions.map((o) => ({
    ...o,
    // Reputation weight defaults to 1 (no track record yet — every
    // agent starts on equal footing, see lib/debate/reputation.ts for
    // how this gets populated from real trade history over time).
    weight: (reputationWeights?.[o.agent] ?? 1) * o.confidence,
  }));

  const totals: Record<Recommendation, number> = { BUY: 0, SELL: 0, HOLD: 0 };
  for (const w of weighted) totals[w.recommendation] += w.weight;
  const totalWeight = totals.BUY + totals.SELL + totals.HOLD || 1;

  const recommendation: Recommendation = (Object.keys(totals) as Recommendation[]).reduce((a, b) => (totals[b] > totals[a] ? b : a));
  const rawConfidence = totals[recommendation] / totalWeight;

  const opposite: Recommendation | null = recommendation === 'BUY' ? 'SELL' : recommendation === 'SELL' ? 'BUY' : null;
  const agreeing = weighted.filter((w) => w.recommendation === recommendation);
  const opposing = opposite ? weighted.filter((w) => w.recommendation === opposite) : [];
  const neutral = weighted.filter((w) => w.recommendation !== recommendation && (!opposite || w.recommendation !== opposite));

  const supportingEvidence = agreeing.flatMap((w) => w.evidence.map((e) => `${w.label}: ${e}`));
  const opposingViews = opposing.flatMap((w) => w.evidence.map((e) => `${w.label}: ${e}`));

  // Human-readable summary, built entirely from the same agreeing/
  // opposing/neutral buckets above — every sentence traces to a real
  // grouping, nothing paraphrased or invented.
  const parts: string[] = [];
  if (agreeing.length > 1) {
    parts.push(`${agreeing.map((w) => w.label.replace(' Agent', '')).join(', ')} agree on ${recommendation}.`);
  } else if (agreeing.length === 1) {
    parts.push(`${agreeing[0].label} is alone in recommending ${recommendation}.`);
  }
  if (opposing.length > 0) {
    const oppNames = opposing.map((w) => w.label.replace(' Agent', '')).join(', ');
    const avgOppConf = opposing.reduce((s, w) => s + w.confidence, 0) / opposing.length;
    const avgAgreeConf = agreeing.length > 0 ? agreeing.reduce((s, w) => s + w.confidence, 0) / agreeing.length : 0;
    parts.push(`${oppNames} ${opposing.length > 1 ? 'disagree' : 'disagrees'}, recommending ${opposite}${avgOppConf < avgAgreeConf ? ' but with lower confidence' : avgOppConf > avgAgreeConf ? ' with higher confidence — worth weighing carefully' : ''}.`);
  }
  if (neutral.length > 0) {
    parts.push(`${neutral.length} agent(s) see no clear edge either way.`);
  }
  const agreementSummary = parts.join(' ');

  return {
    recommendation,
    rawConfidence,
    agreementSummary,
    supportingEvidence,
    opposingViews,
    agentBreakdown: weighted.map((w) => ({ agent: w.agent, label: AGENT_LABELS[w.agent], recommendation: w.recommendation, confidence: w.confidence, weight: w.weight })),
  };
}
