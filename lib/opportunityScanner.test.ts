import { describe, it, expect } from 'vitest';
import { scoreOpportunity, rankOpportunities, MIN_ACTIONABLE_SCORE, type OpportunityCandidate } from './opportunityScanner';
import type { StrategyContext } from './strategyContext';
import type { EnsembleResult } from './strategyEnsemble';

function fakeCtx(overrides: Partial<StrategyContext> = {}): StrategyContext {
  return {
    symbol: 'BTC/USDT',
    price: 100,
    candles: [],
    rsiValue: null,
    macdValue: null,
    ema20: null,
    ema50: null,
    bb: null,
    atrValue: 2,
    vwapValue: null,
    mtf: { symbol: 'BTC/USDT', perTimeframe: [], overall: null },
    structure: { swings: [], events: [], currentTrend: 'undefined', lastSwingHigh: null, lastSwingLow: null },
    liquidity: {} as StrategyContext['liquidity'],
    volumeProfile: null,
    orderFlow: null,
    ...overrides,
  } as StrategyContext;
}

function fakeEnsemble(consensus: EnsembleResult['consensus'], confidencePct: number): EnsembleResult {
  return { signals: [], plannedAgents: [], consensus, confidencePct, buyWeight: 0, sellWeight: 0, holdWeight: 0 } as unknown as EnsembleResult;
}

function candidate(overrides: Partial<OpportunityCandidate> = {}): OpportunityCandidate {
  return {
    symbol: 'BTC/USDT',
    ctx: fakeCtx(),
    ensemble: fakeEnsemble('BUY', 80),
    ...overrides,
  };
}

describe('scoreOpportunity', () => {
  it('returns a zero, non-actionable score when the ensemble says HOLD', () => {
    const result = scoreOpportunity(candidate({ ensemble: fakeEnsemble('HOLD', 50) }));
    expect(result.score).toBe(0);
    expect(result.actionable).toBe(false);
    expect(result.blockers.length).toBeGreaterThan(0);
  });

  it('derives side from the ensemble consensus', () => {
    expect(scoreOpportunity(candidate({ ensemble: fakeEnsemble('BUY', 80) })).side).toBe('buy');
    expect(scoreOpportunity(candidate({ ensemble: fakeEnsemble('SELL', 80) })).side).toBe('sell');
  });

  it('credits structure that agrees and withholds credit when it contradicts', () => {
    const agreeing = scoreOpportunity(
      candidate({ ctx: fakeCtx({ structure: { swings: [], events: [], currentTrend: 'bullish', lastSwingHigh: null, lastSwingLow: null } }) }),
    );
    const contradicting = scoreOpportunity(
      candidate({ ctx: fakeCtx({ structure: { swings: [], events: [], currentTrend: 'bearish', lastSwingHigh: null, lastSwingLow: null } }) }),
    );
    expect(agreeing.score).toBeGreaterThan(contradicting.score);
    expect(contradicting.reasons.some((r) => r.includes('contradicts'))).toBe(true);
  });

  it('blocks when the Debate System actively opposes the direction', () => {
    const result = scoreOpportunity(candidate({ debate: { recommendation: 'SELL', compositeConfidencePct: 70 } }));
    expect(result.actionable).toBe(false);
    expect(result.blockers.some((b) => b.includes('opposes'))).toBe(true);
  });

  it('does not block on a HOLD debate, but gives it no credit either', () => {
    const withHold = scoreOpportunity(candidate({ debate: { recommendation: 'HOLD', compositeConfidencePct: 70 } }));
    const withAgree = scoreOpportunity(candidate({ debate: { recommendation: 'BUY', compositeConfidencePct: 70 } }));
    expect(withHold.blockers.some((b) => b.includes('opposes'))).toBe(false);
    expect(withAgree.score).toBeGreaterThan(withHold.score);
  });

  it('states plainly when no debate input was available rather than assuming agreement', () => {
    const result = scoreOpportunity(candidate({ debate: null }));
    expect(result.reasons.some((r) => r.includes('No Debate result'))).toBe(true);
  });

  it('blocks when no ATR is available, since no stop-loss could be computed', () => {
    const result = scoreOpportunity(candidate({ ctx: fakeCtx({ atrValue: null }) }));
    expect(result.actionable).toBe(false);
    expect(result.blockers.some((b) => b.includes('ATR'))).toBe(true);
  });

  it('blocks on a high-severity market event', () => {
    const result = scoreOpportunity(
      candidate({
        events: [{ kind: 'volatility-explosion', symbol: 'BTC/USDT', severity: 'high', detail: 'x', ts: 0 }],
      }),
    );
    expect(result.actionable).toBe(false);
    expect(result.blockers.some((b) => b.includes('High-severity'))).toBe(true);
  });

  it('ignores medium-severity events as blockers', () => {
    const result = scoreOpportunity(
      candidate({
        events: [{ kind: 'unusual-volume', symbol: 'BTC/USDT', severity: 'medium', detail: 'x', ts: 0 }],
      }),
    );
    expect(result.blockers.some((b) => b.includes('High-severity'))).toBe(false);
  });

  it('halves the score for an already-held symbol', () => {
    const fresh = scoreOpportunity(candidate({ alreadyHeld: false }));
    const held = scoreOpportunity(candidate({ alreadyHeld: true }));
    expect(held.score).toBeCloseTo(fresh.score / 2, 5);
    expect(held.reasons.some((r) => r.includes('concentrates risk'))).toBe(true);
  });

  it('marks a below-floor score as non-actionable with an explicit reason', () => {
    // Weak ensemble, no structure, no debate, no MTF — should land under the floor.
    const result = scoreOpportunity(candidate({ ensemble: fakeEnsemble('BUY', 20) }));
    expect(result.score).toBeLessThan(MIN_ACTIONABLE_SCORE);
    expect(result.actionable).toBe(false);
    expect(result.blockers.some((b) => b.includes('below'))).toBe(true);
  });

  it('counts multi-timeframe agreement and never credits neutral frames', () => {
    const allBullish = scoreOpportunity(
      candidate({
        ctx: fakeCtx({
          mtf: {
            symbol: 'BTC/USDT',
            perTimeframe: [
              { timeframe: '1h', trend: 'bullish', detail: '' },
              { timeframe: '4h', trend: 'bullish', detail: '' },
            ],
            overall: null,
          },
        }),
      }),
    );
    const allNeutral = scoreOpportunity(
      candidate({
        ctx: fakeCtx({
          mtf: {
            symbol: 'BTC/USDT',
            perTimeframe: [
              { timeframe: '1h', trend: 'neutral', detail: '' },
              { timeframe: '4h', trend: 'neutral', detail: '' },
            ],
            overall: null,
          },
        }),
      }),
    );
    expect(allBullish.score).toBeGreaterThan(allNeutral.score);
  });

  it('always produces at least one reason, so no decision is unexplained', () => {
    expect(scoreOpportunity(candidate()).reasons.length).toBeGreaterThan(0);
    expect(scoreOpportunity(candidate({ ensemble: fakeEnsemble('HOLD', 0) })).reasons.length).toBeGreaterThan(0);
  });
});

describe('rankOpportunities', () => {
  it('sorts actionable candidates ahead of non-actionable ones regardless of score', () => {
    const strongButBlocked = candidate({
      symbol: 'BLOCKED',
      ensemble: fakeEnsemble('BUY', 100),
      ctx: fakeCtx({ atrValue: null }), // blocked: no stop computable
    });
    const weakerButClean = candidate({
      symbol: 'CLEAN',
      ensemble: fakeEnsemble('BUY', 90),
      ctx: fakeCtx({ structure: { swings: [], events: [], currentTrend: 'bullish', lastSwingHigh: null, lastSwingLow: null } }),
      debate: { recommendation: 'BUY', compositeConfidencePct: 80 },
    });
    const ranked = rankOpportunities([strongButBlocked, weakerButClean]);
    expect(ranked[0].symbol).toBe('CLEAN');
    expect(ranked[0].actionable).toBe(true);
  });

  it('keeps non-actionable candidates in the result so no-trade cycles can be explained', () => {
    const ranked = rankOpportunities([candidate({ ensemble: fakeEnsemble('HOLD', 0) })]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0].actionable).toBe(false);
  });

  it('orders actionable candidates by descending score', () => {
    const mk = (symbol: string, conf: number) =>
      candidate({
        symbol,
        ensemble: fakeEnsemble('BUY', conf),
        ctx: fakeCtx({ structure: { swings: [], events: [], currentTrend: 'bullish', lastSwingHigh: null, lastSwingLow: null } }),
        debate: { recommendation: 'BUY', compositeConfidencePct: 90 },
      });
    const ranked = rankOpportunities([mk('LOW', 60), mk('HIGH', 100), mk('MID', 80)]);
    expect(ranked.map((r) => r.symbol)).toEqual(['HIGH', 'MID', 'LOW']);
  });

  it('returns an empty array for no candidates rather than throwing', () => {
    expect(rankOpportunities([])).toEqual([]);
  });
});
