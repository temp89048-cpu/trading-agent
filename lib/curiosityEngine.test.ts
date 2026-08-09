import { describe, it, expect } from 'vitest';
import {
  findTodaysFailures,
  findSignalConflicts,
  findContradictedHoldings,
  findRepeatedMistakes,
  buildCuriosityDigest,
  actionableFindings,
  buildCuriosityContext,
} from './curiosityEngine';
import type { TradeLogEntry } from './types';

const NOW = new Date('2026-08-07T12:00:00Z').getTime();
const TODAY_EARLIER = new Date('2026-08-07T03:00:00Z').getTime();
const YESTERDAY = new Date('2026-08-06T12:00:00Z').getTime();

// A closed round-trip is reconstructed from a buy then a sell that
// returns qty to zero — matching lib/learningDashboard.ts's model. Note
// the buy is placed 1 minute BEFORE `ts`, so callers stacking multiple
// round-trips on one symbol must space `ts` by more than a minute or the
// buys/sells interleave and qty never cleanly returns to zero.
function roundTrip(symbol: string, ts: number, pnl: number, originTag: TradeLogEntry['originTag'] = 'agent-plan'): TradeLogEntry[] {
  return [
    { id: `${symbol}-b-${ts}`, ts: ts - 60_000, symbol, tab: 'paper', side: 'buy', qty: 1, price: 100, originTag } as TradeLogEntry,
    { id: `${symbol}-s-${ts}`, ts, symbol, tab: 'paper', side: 'sell', qty: 1, price: 100 + pnl, pnl } as TradeLogEntry,
  ];
}

const HOUR = 60 * 60_000; // spacing between stacked round-trips on one symbol

describe('findTodaysFailures', () => {
  it('is unanswerable with no trades closed today', () => {
    const result = findTodaysFailures(roundTrip('BTC/USDT', YESTERDAY, -5), NOW);
    expect(result.answer).toBeNull();
    expect(result.suggestedAction).toBe('none');
  });

  it('reports plainly when nothing failed today', () => {
    const result = findTodaysFailures(roundTrip('BTC/USDT', TODAY_EARLIER, 10), NOW);
    expect(result.answer).toContain('Nothing failed');
    expect(result.suggestedAction).toBe('none');
  });

  it('identifies the worst-performing decision path among today losses', () => {
    // Different symbols, so no interleaving concern.
    const log = [
      ...roundTrip('BTC/USDT', TODAY_EARLIER, -20, 'agent-plan'),
      ...roundTrip('ETH/USDT', TODAY_EARLIER, -5, 'chat-trade-action'),
    ];
    const result = findTodaysFailures(log, NOW);
    expect(result.answer).toContain('agent-plan');
    expect(result.evidence.length).toBeGreaterThan(1);
  });

  it('suggests creating a hypothesis once one path fails repeatedly', () => {
    const log = [
      ...roundTrip('BTC/USDT', TODAY_EARLIER, -10, 'agent-plan'),
      ...roundTrip('ETH/USDT', TODAY_EARLIER, -10, 'agent-plan'),
    ];
    expect(findTodaysFailures(log, NOW).suggestedAction).toBe('create-hypothesis');
  });

  it('does not over-escalate a single isolated loss', () => {
    const result = findTodaysFailures(roundTrip('BTC/USDT', TODAY_EARLIER, -10, 'agent-plan'), NOW);
    expect(result.suggestedAction).toBe('none');
  });

  it('never claims a failure cause the trade log cannot support', () => {
    const result = findTodaysFailures(roundTrip('BTC/USDT', TODAY_EARLIER, -10), NOW);
    expect(result.answer).toContain('not inferable');
  });
});

describe('findSignalConflicts', () => {
  it('is unanswerable with no evaluated symbols', () => {
    expect(findSignalConflicts([]).answer).toBeNull();
  });

  it('reports no conflict when signals agree', () => {
    const result = findSignalConflicts([
      { symbol: 'BTC/USDT', ensembleSays: 'BUY', ensembleConfidencePct: 80, structureSays: 'bullish' },
    ]);
    expect(result.answer).toContain('Nothing is contradicting');
    expect(result.suggestedAction).toBe('none');
  });

  it('flags a genuine BUY-vs-bearish contradiction and escalates to a second opinion', () => {
    const result = findSignalConflicts([
      { symbol: 'BTC/USDT', ensembleSays: 'BUY', ensembleConfidencePct: 80, structureSays: 'bearish' },
    ]);
    expect(result.answer).toContain('contradict');
    expect(result.suggestedAction).toBe('ask-second-opinion');
    expect(result.evidence[0]).toContain('BTC/USDT');
  });

  it('flags the mirrored SELL-vs-bullish contradiction too', () => {
    const result = findSignalConflicts([
      { symbol: 'ETH/USDT', ensembleSays: 'SELL', ensembleConfidencePct: 70, structureSays: 'bullish' },
    ]);
    expect(result.suggestedAction).toBe('ask-second-opinion');
  });

  it('does not treat an undefined structure trend as a contradiction', () => {
    const result = findSignalConflicts([
      { symbol: 'BTC/USDT', ensembleSays: 'BUY', ensembleConfidencePct: 80, structureSays: 'undefined' },
    ]);
    expect(result.suggestedAction).toBe('none');
  });

  it('does not treat a HOLD ensemble as a contradiction', () => {
    const result = findSignalConflicts([
      { symbol: 'BTC/USDT', ensembleSays: 'HOLD', ensembleConfidencePct: 50, structureSays: 'bearish' },
    ]);
    expect(result.suggestedAction).toBe('none');
  });
});

describe('findContradictedHoldings', () => {
  it('is unanswerable with no open positions', () => {
    expect(findContradictedHoldings([]).answer).toBeNull();
  });

  it('reports none when no holding is opposed', () => {
    const result = findContradictedHoldings([
      { symbol: 'BTC/USDT', side: 'long', ensembleNowSays: 'BUY', ensembleConfidencePct: 70 },
    ]);
    expect(result.answer).toContain('None');
    expect(result.suggestedAction).toBe('none');
  });

  it('flags a long now opposed by the ensemble and suggests reducing exposure', () => {
    const result = findContradictedHoldings([
      { symbol: 'BTC/USDT', side: 'long', ensembleNowSays: 'SELL', ensembleConfidencePct: 75 },
    ]);
    expect(result.suggestedAction).toBe('reduce-exposure');
    expect(result.evidence[0]).toContain('SELL');
  });

  it('treats a HOLD read as non-contradicting', () => {
    const result = findContradictedHoldings([
      { symbol: 'BTC/USDT', side: 'long', ensembleNowSays: 'HOLD', ensembleConfidencePct: 50 },
    ]);
    expect(result.suggestedAction).toBe('none');
  });
});

describe('findRepeatedMistakes', () => {
  it('refuses to call anything a pattern below the minimum sample', () => {
    const result = findRepeatedMistakes(roundTrip('BTC/USDT', YESTERDAY, -5));
    expect(result.answer).toBeNull();
    expect(result.evidence[0]).toContain('too few');
  });

  it('reports no pattern when losses are not a majority', () => {
    const log = [
      ...roundTrip('BTC/USDT', YESTERDAY, -5),
      ...roundTrip('BTC/USDT', YESTERDAY + HOUR, 10),
      ...roundTrip('BTC/USDT', YESTERDAY + 2 * HOUR, 10),
      ...roundTrip('BTC/USDT', YESTERDAY + 3 * HOUR, 10),
    ];
    const result = findRepeatedMistakes(log);
    expect(result.answer).toContain('No repeated-loss pattern');
    expect(result.suggestedAction).toBe('none');
  });

  it('flags a symbol losing on a majority of a meaningful sample', () => {
    const log = [
      ...roundTrip('DOGE/USDT', YESTERDAY, -5),
      ...roundTrip('DOGE/USDT', YESTERDAY + HOUR, -5),
      ...roundTrip('DOGE/USDT', YESTERDAY + 2 * HOUR, -5),
    ];
    const result = findRepeatedMistakes(log);
    expect(result.answer).toContain('Yes');
    expect(result.suggestedAction).toBe('run-backtest');
    expect(result.evidence[0]).toContain('DOGE/USDT');
  });
});

describe('buildCuriosityDigest', () => {
  it('always produces all four findings, even with completely empty inputs', () => {
    const digest = buildCuriosityDigest({ tradeLog: [], signalConflicts: [], contradictedHoldings: [], ts: NOW });
    expect(digest.findings).toHaveLength(4);
    for (const f of digest.findings) {
      expect(f.question.length).toBeGreaterThan(0);
      expect(f.evidence.length).toBeGreaterThan(0); // always says WHY it can't answer
    }
  });

  it('filters to only findings implying real follow-up', () => {
    const digest = buildCuriosityDigest({
      tradeLog: [],
      signalConflicts: [{ symbol: 'BTC/USDT', ensembleSays: 'BUY', ensembleConfidencePct: 80, structureSays: 'bearish' }],
      contradictedHoldings: [],
      ts: NOW,
    });
    const actionable = actionableFindings(digest);
    expect(actionable).toHaveLength(1);
    expect(actionable[0].suggestedAction).toBe('ask-second-opinion');
  });
});

describe('buildCuriosityContext', () => {
  it('states plainly when no digest exists rather than inventing one', () => {
    expect(buildCuriosityContext(null, [{ symbol: 'BTC/USDT', type: 'crypto' }])).toContain('no self-review generated yet');
  });

  it('handles an empty watchlist', () => {
    const digest = buildCuriosityDigest({ tradeLog: [], signalConflicts: [], contradictedHoldings: [], ts: NOW });
    expect(buildCuriosityContext(digest, [])).toContain('no watchlist symbols');
  });

  it('renders unanswerable questions as unanswerable, never as filler', () => {
    const digest = buildCuriosityDigest({ tradeLog: [], signalConflicts: [], contradictedHoldings: [], ts: NOW });
    const text = buildCuriosityContext(digest, [{ symbol: 'BTC/USDT', type: 'crypto' }]);
    expect(text).toContain('Not answerable from available data yet.');
  });

  it('makes clear these are observations, not instructions', () => {
    const digest = buildCuriosityDigest({ tradeLog: [], signalConflicts: [], contradictedHoldings: [], ts: NOW });
    const text = buildCuriosityContext(digest, [{ symbol: 'BTC/USDT', type: 'crypto' }]);
    expect(text).toContain('not instructions');
  });
});
