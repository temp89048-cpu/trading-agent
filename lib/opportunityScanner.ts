import type { StrategyContext } from './strategyContext';
import type { EnsembleResult } from './strategyEnsemble';
import type { MarketEvent } from './eventDetection';
import type { Recommendation } from './debate/types';

// ---------------------------------------------------------------------
// Opportunity Scanner — the "what should I even be looking at?" stage
// the autonomous loop needs before it can decide anything.
//
// This is the ranking half of the Thinking Engine's Observe -> Interpret
// -> Reason chain (spec Section 13): instead of the operator naming a
// symbol, the system scores every watchlist symbol it has real data for
// and ranks them. It answers "which of these is the best candidate right
// now, and why," NOT "should I trade" — that stays with the Supervisor
// and Risk gates, which this module never touches.
//
// Deliberately a PURE, deterministic function — no LLM call, no I/O,
// same reasoning as lib/debate/moderator.ts's header comment: every
// input here is already a real computed number, so asking a model to
// "rank" them would add hallucination risk to a financial decision for
// no benefit over just computing it, and would not be reproducible
// run-to-run. Every score component below traces to a real signal, and
// every candidate carries the reasons for its own score so the decision
// is explainable (spec's non-negotiable "every agent must explain every
// decision").
// ---------------------------------------------------------------------

export type OpportunityCandidate = {
  symbol: string;
  ctx: StrategyContext;
  ensemble: EnsembleResult;
  // Optional signals — a candidate is scorable without them, and their
  // absence is recorded as a reason rather than silently treated as
  // neutral-positive.
  debate?: { recommendation: Recommendation; compositeConfidencePct: number } | null;
  events?: MarketEvent[];
  // True when the portfolio already holds this symbol. Not disqualifying
  // by itself (the caller decides), but it lowers the score — adding to
  // an existing position concentrates risk rather than diversifying.
  alreadyHeld?: boolean;
};

export type RankedOpportunity = {
  symbol: string;
  side: 'buy' | 'sell';
  score: number; // 0..100
  reasons: string[]; // why it scored what it did — every entry traces to a real signal
  blockers: string[]; // reasons this is NOT actionable despite its score
  actionable: boolean; // false when blockers exist, or score is below the floor
};

// A candidate must clear this to be considered at all. Set to match the
// same 0.5-confidence discipline the rest of this app already applies to
// model-proposed trades (see lib/tradeIntent.ts's confidence floor).
export const MIN_ACTIONABLE_SCORE = 55;

// Score weights. Deliberately conservative and additive rather than
// multiplicative — no single signal can carry a candidate on its own,
// which is the point of having an ensemble at all.
const W_ENSEMBLE = 40; // the strategy ensemble's own confidence-weighted vote
const W_STRUCTURE = 20; // market structure agreeing with the proposed side
const W_DEBATE = 25; // the debate system's independent composite read
const W_MTF = 15; // multi-timeframe trend alignment

export function scoreOpportunity(candidate: OpportunityCandidate): RankedOpportunity {
  const reasons: string[] = [];
  const blockers: string[] = [];
  const { ctx, ensemble } = candidate;

  // --- Direction comes from the ensemble; HOLD means no candidate at all.
  if (ensemble.consensus === 'HOLD') {
    return {
      symbol: candidate.symbol,
      side: 'buy',
      score: 0,
      reasons: ['Strategy Ensemble consensus is HOLD — no directional edge to act on.'],
      blockers: ['No directional consensus.'],
      actionable: false,
    };
  }
  const side: 'buy' | 'sell' = ensemble.consensus === 'BUY' ? 'buy' : 'sell';

  let score = 0;

  // --- 1. Ensemble confidence (always available).
  const ensembleFraction = Math.min(100, Math.max(0, ensemble.confidencePct)) / 100;
  score += W_ENSEMBLE * ensembleFraction;
  reasons.push(`Strategy Ensemble: ${ensemble.consensus} at ${ensemble.confidencePct.toFixed(0)}% confidence.`);

  // --- 2. Market structure alignment.
  const trend = ctx.structure.currentTrend;
  if (trend === 'undefined') {
    reasons.push('Market structure has no confirmed trend yet — no structural support or contradiction.');
  } else {
    const structureAgrees = (side === 'buy' && trend === 'bullish') || (side === 'sell' && trend === 'bearish');
    if (structureAgrees) {
      score += W_STRUCTURE;
      reasons.push(`Market structure is ${trend}, agreeing with a ${side}.`);
    } else {
      reasons.push(`Market structure is ${trend}, which contradicts a ${side} — no structural credit given.`);
    }
  }

  // --- 3. Debate system (independent read).
  if (candidate.debate) {
    const d = candidate.debate;
    const debateAgrees = (side === 'buy' && d.recommendation === 'BUY') || (side === 'sell' && d.recommendation === 'SELL');
    if (debateAgrees) {
      score += W_DEBATE * (Math.min(100, Math.max(0, d.compositeConfidencePct)) / 100);
      reasons.push(`Debate System independently agrees (${d.recommendation} at ${d.compositeConfidencePct.toFixed(0)}% composite confidence).`);
    } else if (d.recommendation === 'HOLD') {
      reasons.push(`Debate System says HOLD (${d.compositeConfidencePct.toFixed(0)}%) — no credit, but not opposing either.`);
    } else {
      // A high-confidence opposing debate is a genuine blocker, matching
      // the Supervisor's own Tier-1 blocking rule (lib/supervisorAgent.ts).
      // Better to surface it here than to let the loop propose a trade
      // the Supervisor will predictably veto a moment later.
      blockers.push(`Debate System opposes this ${side} (${d.recommendation} at ${d.compositeConfidencePct.toFixed(0)}%).`);
      reasons.push('Debate System actively disagrees with this direction.');
    }
  } else {
    reasons.push('No Debate result available for this symbol yet — scored without that input rather than assuming agreement.');
  }

  // --- 4. Multi-timeframe alignment.
  const mtfAligned = countMtfAlignment(ctx, side);
  if (mtfAligned.total > 0) {
    const fraction = mtfAligned.agreeing / mtfAligned.total;
    score += W_MTF * fraction;
    reasons.push(`Multi-timeframe: ${mtfAligned.agreeing}/${mtfAligned.total} timeframes align with a ${side}.`);
  } else {
    reasons.push('No multi-timeframe data computed yet for this symbol.');
  }

  // --- Penalties / blockers that don't fit the additive score.
  if (candidate.alreadyHeld) {
    score = score * 0.5;
    reasons.push('Already holding this symbol — score halved, since adding to it concentrates risk rather than diversifying.');
  }

  if (ctx.atrValue === null) {
    // Without ATR there is no computable stop, and lib/riskManager.ts now
    // hard-rejects any trade with no stop. Surfacing it here avoids
    // proposing something guaranteed to be rejected downstream.
    blockers.push('No ATR available — a stop-loss cannot be computed, and every position requires a hard exit.');
  }

  const highSeverityEvents = (candidate.events ?? []).filter((e) => e.severity === 'high');
  if (highSeverityEvents.length > 0) {
    blockers.push(`High-severity market event(s) active: ${highSeverityEvents.map((e) => e.kind).join(', ')} — standing down rather than entering into unusual conditions.`);
  }

  const finalScore = Math.min(100, Math.max(0, score));
  if (finalScore < MIN_ACTIONABLE_SCORE && blockers.length === 0) {
    blockers.push(`Score ${finalScore.toFixed(0)} is below the ${MIN_ACTIONABLE_SCORE} actionable floor.`);
  }

  return {
    symbol: candidate.symbol,
    side,
    score: finalScore,
    reasons,
    blockers,
    actionable: blockers.length === 0,
  };
}

// Counts how many of the multi-timeframe trend reads agree with the
// proposed side. Only timeframes that actually had enough candle data to
// classify appear in perTimeframe at all (see computeMtfSnapshot), and
// 'neutral' ones are counted in the total but never as agreeing — so a
// symbol that's directionless across the board scores low here rather
// than being credited for ambiguity.
function countMtfAlignment(ctx: StrategyContext, side: 'buy' | 'sell'): { agreeing: number; total: number } {
  const frames = ctx.mtf?.perTimeframe ?? [];
  let agreeing = 0;
  for (const frame of frames) {
    if ((side === 'buy' && frame.trend === 'bullish') || (side === 'sell' && frame.trend === 'bearish')) agreeing++;
  }
  return { agreeing, total: frames.length };
}

// Ranks every candidate, best first. Non-actionable candidates are kept
// in the result (not filtered out) so the caller can record WHY nothing
// was traded on a given cycle — a no-trade decision with stated reasons
// is itself a decision worth journaling, per the spec's Section 14
// continuous-monitoring questions.
export function rankOpportunities(candidates: OpportunityCandidate[]): RankedOpportunity[] {
  return candidates.map(scoreOpportunity).sort((a, b) => {
    if (a.actionable !== b.actionable) return a.actionable ? -1 : 1;
    return b.score - a.score;
  });
}
