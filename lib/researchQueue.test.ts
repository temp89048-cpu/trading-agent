import { describe, it, expect } from 'vitest';
import { buildResearchQueue, buildFutureRecommendations, buildResearchQueueContext } from './researchQueue';
import type { TradeLogEntry } from './types';
import type { CuriosityFinding } from './curiosityEngine';

const T0 = new Date('2026-08-01T00:00:00Z').getTime();
const HOUR = 60 * 60_000;

// Round-trips must be spaced by more than the buy offset or they
// interleave and qty never returns to zero.
function roundTrip(symbol: string, exitId: string, at: number, pnl: number, originTag: TradeLogEntry['originTag'] = 'agent-plan'): TradeLogEntry[] {
  return [
    { id: `${exitId}-b`, ts: at, symbol, tab: 'paper', side: 'buy', qty: 1, price: 100, originTag } as TradeLogEntry,
    { id: exitId, ts: at + 60_000, symbol, tab: 'paper', side: 'sell', qty: 1, price: 100 + pnl, pnl } as TradeLogEntry,
  ];
}

function losingSymbol(symbol: string, count: number): TradeLogEntry[] {
  return Array.from({ length: count }, (_, i) => roundTrip(symbol, `${symbol}-${i}`, T0 + i * HOUR, -5)).flat();
}

describe('buildResearchQueue', () => {
  it('returns an empty queue for an empty trade log', () => {
    expect(buildResearchQueue({ tradeLog: [] })).toEqual([]);
  });

  it('flags a symbol losing on a majority of a meaningful sample as high priority', () => {
    const tasks = buildResearchQueue({ tradeLog: losingSymbol('DOGE/USDT', 4), reflectedTradeIds: new Set(['DOGE/USDT-0', 'DOGE/USDT-1', 'DOGE/USDT-2', 'DOGE/USDT-3']) });
    const repeated = tasks.find((t) => t.origin === 'repeated-loss');
    expect(repeated).toBeDefined();
    expect(repeated!.priority).toBe('high');
    expect(repeated!.question).toContain('DOGE/USDT');
    expect(repeated!.validationPlan.length).toBeGreaterThan(0);
  });

  it('does not flag a symbol below the minimum sample', () => {
    const tasks = buildResearchQueue({ tradeLog: losingSymbol('BTC/USDT', 2) });
    expect(tasks.find((t) => t.origin === 'repeated-loss')).toBeUndefined();
  });

  it('does not flag a profitable symbol', () => {
    const log = [
      ...roundTrip('BTC/USDT', 'w1', T0, 10),
      ...roundTrip('BTC/USDT', 'w2', T0 + HOUR, 10),
      ...roundTrip('BTC/USDT', 'w3', T0 + 2 * HOUR, 10),
    ];
    expect(buildResearchQueue({ tradeLog: log }).find((t) => t.origin === 'repeated-loss')).toBeUndefined();
  });

  it('flags a net-negative decision path', () => {
    const log = [
      ...roundTrip('BTC/USDT', 'a', T0, -20, 'chat-trade-action'),
      ...roundTrip('ETH/USDT', 'b', T0 + HOUR, -20, 'chat-trade-action'),
      ...roundTrip('SOL/USDT', 'c', T0 + 2 * HOUR, 5, 'chat-trade-action'),
    ];
    const task = buildResearchQueue({ tradeLog: log }).find((t) => t.origin === 'losing-origin');
    expect(task).toBeDefined();
    expect(task!.question).toContain('chat-trade-action');
  });

  it('flags closed trades that have no reflection, as a pipeline gap not a loss', () => {
    const tasks = buildResearchQueue({ tradeLog: roundTrip('BTC/USDT', 'x1', T0, 5), reflectedTradeIds: new Set() });
    const task = tasks.find((t) => t.origin === 'unreflected-trade');
    expect(task).toBeDefined();
    expect(task!.priority).toBe('medium');
    expect(task!.validationPlan).toContain('API key');
  });

  it('does not flag unreflected trades when all are reflected', () => {
    const tasks = buildResearchQueue({ tradeLog: roundTrip('BTC/USDT', 'x1', T0, 5), reflectedTradeIds: new Set(['x1']) });
    expect(tasks.find((t) => t.origin === 'unreflected-trade')).toBeUndefined();
  });

  it('queues untested hypotheses so a stalled pipeline is visible', () => {
    const tasks = buildResearchQueue({
      tradeLog: [],
      untestedHypotheses: [{ id: 'h1', claim: 'Wider stops reduce premature exits.', symbol: 'BTC/USDT' }],
    });
    const task = tasks.find((t) => t.origin === 'untested-hypothesis');
    expect(task).toBeDefined();
    expect(task!.question).toContain('Wider stops');
  });

  it('turns actionable curiosity findings into tasks and skips inert ones', () => {
    const findings: CuriosityFinding[] = [
      { question: 'Q1?', answer: 'A', evidence: ['e'], suggestedAction: 'ask-second-opinion' },
      { question: 'Q2?', answer: 'A', evidence: ['e'], suggestedAction: 'none' },
      { question: 'Q3?', answer: null, evidence: ['e'], suggestedAction: 'run-backtest' }, // unanswerable — skipped
    ];
    const tasks = buildResearchQueue({ tradeLog: [], curiosityFindings: findings });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].question).toBe('Q1?');
  });

  it('treats a contradicted open position as high priority', () => {
    const findings: CuriosityFinding[] = [
      { question: 'Contradicted?', answer: 'Yes', evidence: ['e'], suggestedAction: 'reduce-exposure' },
    ];
    const tasks = buildResearchQueue({ tradeLog: [], curiosityFindings: findings });
    expect(tasks[0].priority).toBe('high');
    expect(tasks[0].origin).toBe('contradicted-position');
  });

  it('sorts high priority ahead of medium', () => {
    const tasks = buildResearchQueue({
      tradeLog: losingSymbol('DOGE/USDT', 4),
      reflectedTradeIds: new Set(['DOGE/USDT-0', 'DOGE/USDT-1', 'DOGE/USDT-2', 'DOGE/USDT-3']),
      untestedHypotheses: [{ id: 'h1', claim: 'c', symbol: 'BTC/USDT' }],
    });
    expect(tasks[0].priority).toBe('high');
    expect(tasks[tasks.length - 1].priority).toBe('medium');
  });

  it('gives every task an evidence trail and a validation plan', () => {
    // A research task with no evidence or no way to settle it is just a
    // vague worry, which is what this module exists to avoid producing.
    const tasks = buildResearchQueue({
      tradeLog: losingSymbol('DOGE/USDT', 4),
      untestedHypotheses: [{ id: 'h1', claim: 'c', symbol: 'BTC/USDT' }],
      curiosityFindings: [{ question: 'Q?', answer: 'A', evidence: ['e'], suggestedAction: 'run-backtest' }],
    });
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      expect(t.evidence.length, `${t.id} evidence`).toBeGreaterThan(0);
      expect(t.validationPlan.length, `${t.id} validationPlan`).toBeGreaterThan(0);
      expect(t.question.length, `${t.id} question`).toBeGreaterThan(0);
    }
  });
});

describe('buildFutureRecommendations', () => {
  it('says plainly when there is nothing to recommend', () => {
    expect(buildFutureRecommendations([])[0]).toContain('No research tasks outstanding');
  });

  it('leads with high-priority loss-related items', () => {
    const tasks = buildResearchQueue({ tradeLog: losingSymbol('DOGE/USDT', 4) });
    const recs = buildFutureRecommendations(tasks);
    expect(recs[0]).toContain('high-priority');
  });

  it('always states that nothing is applied automatically', () => {
    const tasks = buildResearchQueue({ tradeLog: losingSymbol('DOGE/USDT', 4) });
    expect(buildFutureRecommendations(tasks).some((r) => r.includes('applied automatically'))).toBe(true);
  });
});

describe('buildResearchQueueContext', () => {
  it('states plainly when the queue is empty', () => {
    expect(buildResearchQueueContext([])).toContain('empty');
  });

  it('includes evidence and how to settle each item', () => {
    const tasks = buildResearchQueue({ tradeLog: losingSymbol('DOGE/USDT', 4) });
    const text = buildResearchQueueContext(tasks);
    expect(text).toContain('Evidence:');
    expect(text).toContain('How to settle it:');
  });

  it('makes clear the queue cannot deploy anything', () => {
    const tasks = buildResearchQueue({ tradeLog: losingSymbol('DOGE/USDT', 4) });
    expect(buildResearchQueueContext(tasks)).toContain('it does not deploy');
  });

  it('truncates a long queue rather than dumping everything into context', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `h${i}`, claim: `c${i}`, symbol: 'BTC/USDT' }));
    const tasks = buildResearchQueue({ tradeLog: [], untestedHypotheses: many });
    expect(buildResearchQueueContext(tasks)).toContain('more.');
  });
});
