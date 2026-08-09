import { describe, it, expect } from 'vitest';
import { updateBelief, evidenceFromConfidence, describeBeliefUpdate, type BayesianEvidence } from './bayesian';

function ev(label: string, ratio: number): BayesianEvidence {
  return { label, source: 'test', likelihoodRatio: ratio };
}

describe('updateBelief', () => {
  it('leaves the prior unchanged when there is no evidence', () => {
    const r = updateBelief({ prior: 0.58, evidence: [] });
    expect(r.posteriorPct).toBeCloseTo(r.priorPct, 6);
    expect(r.notes.some((n) => n.includes('No informative evidence'))).toBe(true);
  });

  it('raises the posterior on supporting evidence', () => {
    const r = updateBelief({ prior: 0.5, evidence: [ev('funding', 2)] });
    expect(r.posteriorPct).toBeGreaterThan(50);
    expect(r.steps[0].direction).toBe('supports');
  });

  it('lowers the posterior on opposing evidence', () => {
    const r = updateBelief({ prior: 0.5, evidence: [ev('news', 0.5)] });
    expect(r.posteriorPct).toBeLessThan(50);
    expect(r.steps[0].direction).toBe('opposes');
  });

  it('treats a likelihood ratio of exactly 1 as uninformative, moving nothing', () => {
    const r = updateBelief({ prior: 0.6, evidence: [ev('flat', 1)] });
    expect(r.posteriorPct).toBeCloseTo(r.priorPct, 6);
    expect(r.uninformative).toHaveLength(1);
    expect(r.steps).toHaveLength(0);
  });

  it('ignores invalid ratios rather than corrupting the posterior', () => {
    const r = updateBelief({ prior: 0.6, evidence: [ev('bad', 0), ev('worse', -1), ev('nan', NaN)] });
    expect(r.posteriorPct).toBeCloseTo(r.priorPct, 6);
    expect(r.uninformative).toHaveLength(3);
  });

  it('accumulates multiple pieces of evidence in sequence', () => {
    const r = updateBelief({ prior: 0.5, evidence: [ev('a', 2), ev('b', 2), ev('c', 2)] });
    expect(r.steps).toHaveLength(3);
    // Each step must be monotonically higher than the last for all-supporting evidence.
    expect(r.steps[1].runningPct).toBeGreaterThan(r.steps[0].runningPct);
    expect(r.steps[2].runningPct).toBeGreaterThan(r.steps[1].runningPct);
  });

  it('lets opposing evidence pull a raised belief back down', () => {
    // The spec's example shape: 58 -> up on funding -> down on bad news.
    const r = updateBelief({ prior: 0.58, evidence: [ev('funding rose', 2.5), ev('bad news', 0.4)] });
    expect(r.steps[0].runningPct).toBeGreaterThan(r.priorPct);
    expect(r.steps[1].runningPct).toBeLessThan(r.steps[0].runningPct);
  });

  it('never reaches certainty no matter how much evidence agrees', () => {
    // This is the safety-relevant property: a 100% probability would be
    // an indefensible claim AND would break Kelly sizing downstream.
    const piles = Array.from({ length: 50 }, (_, i) => ev(`e${i}`, 20));
    const r = updateBelief({ prior: 0.9, evidence: piles });
    expect(r.posteriorPct).toBeLessThan(100);
    expect(r.posteriorPct).toBeLessThanOrEqual(98);
  });

  it('never reaches zero no matter how much evidence opposes', () => {
    const piles = Array.from({ length: 50 }, (_, i) => ev(`e${i}`, 0.05));
    const r = updateBelief({ prior: 0.1, evidence: piles });
    expect(r.posteriorPct).toBeGreaterThan(0);
    expect(r.posteriorPct).toBeGreaterThanOrEqual(2);
  });

  it('clamps an out-of-range prior instead of throwing', () => {
    expect(updateBelief({ prior: 1, evidence: [] }).priorPct).toBeLessThanOrEqual(98);
    expect(updateBelief({ prior: 0, evidence: [] }).priorPct).toBeGreaterThanOrEqual(2);
    expect(updateBelief({ prior: -5, evidence: [] }).priorPct).toBeGreaterThanOrEqual(2);
  });

  it('dampening reduces how far evidence moves the belief', () => {
    const damped = updateBelief({ prior: 0.5, evidence: [ev('a', 4)], dampening: 0.3 });
    const undamped = updateBelief({ prior: 0.5, evidence: [ev('a', 4)], dampening: 1 });
    expect(undamped.posteriorPct).toBeGreaterThan(damped.posteriorPct);
  });

  it('discloses that dampening was applied and why', () => {
    const r = updateBelief({ prior: 0.5, evidence: [ev('a', 2)] });
    expect(r.notes.some((n) => n.includes('correlated'))).toBe(true);
  });

  it('is symmetric: inverse evidence returns to the prior', () => {
    const r = updateBelief({ prior: 0.5, evidence: [ev('up', 3), ev('down', 1 / 3)] });
    expect(r.posteriorPct).toBeCloseTo(50, 4);
  });

  it('is order-independent for the final posterior', () => {
    // Log-odds addition is commutative — a useful property to pin, since
    // it means evidence arrival order can't bias the result.
    const a = updateBelief({ prior: 0.55, evidence: [ev('x', 2), ev('y', 0.6)] });
    const b = updateBelief({ prior: 0.55, evidence: [ev('y', 0.6), ev('x', 2)] });
    expect(a.posteriorPct).toBeCloseTo(b.posteriorPct, 6);
  });
});

describe('evidenceFromConfidence', () => {
  it('maps a 0.5 confidence to a no-op (ratio exactly 1)', () => {
    // An abstaining agent must not drag the posterior anywhere.
    expect(evidenceFromConfidence('x', 's', 0.5, true).likelihoodRatio).toBeCloseTo(1, 9);
    expect(evidenceFromConfidence('x', 's', 0.5, false).likelihoodRatio).toBeCloseTo(1, 9);
  });

  it('produces a supporting ratio when the signal agrees', () => {
    expect(evidenceFromConfidence('x', 's', 0.9, true).likelihoodRatio).toBeGreaterThan(1);
  });

  it('produces an opposing ratio when the signal disagrees', () => {
    expect(evidenceFromConfidence('x', 's', 0.9, false).likelihoodRatio).toBeLessThan(1);
  });

  it('scales with confidence', () => {
    const weak = evidenceFromConfidence('x', 's', 0.6, true).likelihoodRatio;
    const strong = evidenceFromConfidence('x', 's', 0.95, true).likelihoodRatio;
    expect(strong).toBeGreaterThan(weak);
  });

  it('caps how much a single signal can claim', () => {
    expect(evidenceFromConfidence('x', 's', 1, true).likelihoodRatio).toBeLessThanOrEqual(4);
  });

  it('clamps out-of-range confidence', () => {
    expect(evidenceFromConfidence('x', 's', 5, true).likelihoodRatio).toBeLessThanOrEqual(4);
    expect(evidenceFromConfidence('x', 's', -1, true).likelihoodRatio).toBeGreaterThan(0);
  });

  it('agreeing and disagreeing at equal confidence are exact inverses', () => {
    const up = evidenceFromConfidence('x', 's', 0.8, true).likelihoodRatio;
    const down = evidenceFromConfidence('x', 's', 0.8, false).likelihoodRatio;
    expect(up * down).toBeCloseTo(1, 9);
  });
});

describe('describeBeliefUpdate', () => {
  it('renders the full update chain', () => {
    const r = updateBelief({ prior: 0.58, evidence: [ev('funding', 2), ev('news', 0.5)] });
    const text = describeBeliefUpdate(r);
    expect(text).toContain('→');
    expect(text).toContain('funding supports');
    expect(text).toContain('news opposes');
  });

  it('says unchanged when nothing informative arrived', () => {
    expect(describeBeliefUpdate(updateBelief({ prior: 0.5, evidence: [] }))).toContain('unchanged');
  });
});
