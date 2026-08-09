// ---------------------------------------------------------------------
// Bayesian Probability Engine (spec Section 10 — the one algorithm on
// that list with no implementation anywhere; roadmap Phase 52).
//
// The problem it solves: everything else in this app emits a STATIC
// confidence. The ensemble votes once, the Debate composites once, and
// that number is then treated as "the" probability until something
// recomputes it from scratch. The spec asks for the opposite behavior —
// a belief that gets UPDATED as each new piece of evidence arrives:
//
//   prior 58% -> new candle -> 66% -> funding rose -> 72% -> bad news -> 64%
//
// Implemented as textbook Bayes in LOG-ODDS space, because that turns
// each independent piece of evidence into a simple additive term and
// avoids the numerical instability of repeatedly multiplying small
// probabilities.
//
//   posterior_logodds = prior_logodds + sum(log likelihood ratio)
//
// The likelihood ratio for a piece of evidence is P(E | success) /
// P(E | failure). A ratio of 1 (log 0) is uninformative and moves
// nothing — which is the correct behavior for evidence this app cannot
// actually measure, and is why unavailable inputs are OMITTED rather
// than passed as 0.5.
//
// HONEST LIMITATION, stated because it matters for how much weight to
// put on the output: true Bayes requires the evidence terms to be
// conditionally independent, and market signals emphatically are not
// (RSI, MACD, and EMA separation all read the same price series). Naive
// independence therefore OVERSTATES certainty when several correlated
// signals agree. Two things mitigate it rather than hide it:
// `dampening` shrinks each contribution, and the final posterior is
// clamped away from 0/1 so no amount of agreeing evidence ever produces
// a claim of certainty. The output should be read as a calibrated
// leaning, not a true probability.
//
// Pure and deterministic — same discipline as the rest of lib/.
// ---------------------------------------------------------------------

export type EvidenceDirection = 'supports' | 'opposes' | 'neutral';

export type BayesianEvidence = {
  label: string;
  /**
   * P(observing this | hypothesis true) / P(observing this | hypothesis false).
   * > 1 supports, < 1 opposes, exactly 1 is uninformative.
   * Callers normally use `evidenceFromConfidence` rather than setting this by hand.
   */
  likelihoodRatio: number;
  /** Where the evidence came from, so a posterior is auditable. */
  source: string;
};

export type BayesianResult = {
  priorPct: number;
  posteriorPct: number;
  /** Step-by-step, so the number is explainable rather than emitted bare. */
  steps: { label: string; source: string; direction: EvidenceDirection; runningPct: number }[];
  /** Evidence that was supplied but moved nothing. */
  uninformative: string[];
  notes: string[];
};

// Posterior is never allowed to reach 0% or 100%. Claiming certainty
// about a market outcome is always wrong, and a 100% would also make
// downstream sizing math (Kelly in particular) misbehave badly.
const MIN_PROB = 0.02;
const MAX_PROB = 0.98;

// Shrinks every evidence contribution. Set below 1 specifically because
// of the correlated-evidence problem described in the header — without
// it, five signals derived from the same price series read as five
// independent confirmations.
const DEFAULT_DAMPENING = 0.6;

function toLogOdds(p: number): number {
  const clamped = Math.min(MAX_PROB, Math.max(MIN_PROB, p));
  return Math.log(clamped / (1 - clamped));
}

function fromLogOdds(logOdds: number): number {
  const odds = Math.exp(logOdds);
  return Math.min(MAX_PROB, Math.max(MIN_PROB, odds / (1 + odds)));
}

/**
 * Converts a signal's own 0..1 confidence and direction into a
 * likelihood ratio.
 *
 * A confidence of 0.5 means "no view" and maps to a ratio of exactly 1
 * (moves nothing) — which is why a HOLD/abstaining agent correctly has
 * no effect on the posterior instead of dragging it toward 50%.
 */
export function evidenceFromConfidence(
  label: string,
  source: string,
  confidence: number,
  agrees: boolean,
): BayesianEvidence {
  const c = Math.min(1, Math.max(0, confidence));
  // Map 0.5..1 confidence onto a 1..~4 likelihood ratio. Capped: no
  // single signal in this app is strong enough to justify more.
  const strength = Math.max(0, (c - 0.5) * 2); // 0..1
  const ratio = 1 + strength * 3;
  return { label, source, likelihoodRatio: agrees ? ratio : 1 / ratio };
}

export function updateBelief(params: {
  /** Starting probability, 0..1. Typically the ensemble or calibrated Debate confidence. */
  prior: number;
  evidence: BayesianEvidence[];
  dampening?: number;
}): BayesianResult {
  const dampening = params.dampening ?? DEFAULT_DAMPENING;
  const steps: BayesianResult['steps'] = [];
  const uninformative: string[] = [];
  const notes: string[] = [];

  let logOdds = toLogOdds(params.prior);
  const priorPct = fromLogOdds(logOdds) * 100;

  for (const e of params.evidence) {
    if (!isFinite(e.likelihoodRatio) || e.likelihoodRatio <= 0) {
      uninformative.push(`${e.label} (invalid likelihood ratio — ignored rather than guessed at)`);
      continue;
    }
    if (Math.abs(e.likelihoodRatio - 1) < 1e-9) {
      uninformative.push(`${e.label} (no directional information)`);
      continue;
    }
    logOdds += Math.log(e.likelihoodRatio) * dampening;
    steps.push({
      label: e.label,
      source: e.source,
      direction: e.likelihoodRatio > 1 ? 'supports' : 'opposes',
      runningPct: fromLogOdds(logOdds) * 100,
    });
  }

  const posteriorPct = fromLogOdds(logOdds) * 100;

  if (steps.length === 0) {
    notes.push('No informative evidence supplied — the posterior equals the prior.');
  }
  if (dampening < 1) {
    notes.push(
      `Each contribution was dampened to ${(dampening * 100).toFixed(0)}% because market signals are correlated, not independent — undampened naive Bayes would overstate certainty when several price-derived signals agree.`,
    );
  }
  if (posteriorPct >= MAX_PROB * 100 - 0.001 || posteriorPct <= MIN_PROB * 100 + 0.001) {
    notes.push(`Clamped to the ${MIN_PROB * 100}%-${MAX_PROB * 100}% band — certainty about a market outcome is never a defensible claim.`);
  }

  return { priorPct, posteriorPct, steps, uninformative, notes };
}

/** Human-readable trace: "58% -> 66% (funding supports) -> 61% (news opposes)". */
export function describeBeliefUpdate(result: BayesianResult): string {
  if (result.steps.length === 0) {
    return `${result.priorPct.toFixed(0)}% (unchanged — no informative evidence)`;
  }
  const chain = result.steps
    .map((s) => `${s.runningPct.toFixed(0)}% (${s.label} ${s.direction})`)
    .join(' → ');
  return `${result.priorPct.toFixed(0)}% → ${chain}`;
}
