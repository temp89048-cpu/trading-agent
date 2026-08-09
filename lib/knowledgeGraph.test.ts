import { describe, it, expect } from 'vitest';
import { buildKnowledgeGraph, queryTrades, explainTrade, graphStats, buildKnowledgeGraphContext } from './knowledgeGraph';
import type { TradeLogEntry } from './types';

const T0 = new Date('2026-08-01T00:00:00Z').getTime();
const HOUR = 60 * 60_000;

// A closed round-trip: buy then a sell carrying pnl that returns qty to
// zero. `entryContext` is what classifyEntryContext reads to derive
// market condition / volatility regime, so tests that care about those
// supply a realistic snapshot string.
function roundTrip(params: {
  symbol: string;
  exitId: string;
  at: number;
  pnl: number;
  originTag?: TradeLogEntry['originTag'];
  entryContext?: string;
}): TradeLogEntry[] {
  return [
    {
      id: `${params.exitId}-buy`,
      ts: params.at,
      symbol: params.symbol,
      tab: 'paper',
      side: 'buy',
      qty: 1,
      price: 100,
      originTag: params.originTag ?? 'agent-plan',
      entryContext: params.entryContext,
    } as TradeLogEntry,
    {
      id: params.exitId,
      ts: params.at + HOUR,
      symbol: params.symbol,
      tab: 'paper',
      side: 'sell',
      qty: 1,
      price: 100 + params.pnl,
      pnl: params.pnl,
    } as TradeLogEntry,
  ];
}

describe('buildKnowledgeGraph', () => {
  it('returns an empty graph for an empty trade log', () => {
    const graph = buildKnowledgeGraph({ tradeLog: [] });
    expect(graph.nodes.size).toBe(0);
    expect(graph.edges).toEqual([]);
  });

  it('creates a trade node linked to symbol, origin, and outcome', () => {
    const graph = buildKnowledgeGraph({ tradeLog: roundTrip({ symbol: 'BTC/USDT', exitId: 'x1', at: T0, pnl: 10 }) });
    expect(graph.nodes.has('trade:x1')).toBe(true);
    expect(graph.nodes.has('symbol:BTC/USDT')).toBe(true);
    expect(graph.nodes.has('origin:agent-plan')).toBe(true);
    expect(graph.nodes.has('outcome:win')).toBe(true);

    const types = graph.edges.filter((e) => e.from === 'trade:x1').map((e) => e.type);
    expect(types).toContain('traded-symbol');
    expect(types).toContain('originated-from');
    expect(types).toContain('resulted-in');
  });

  it('classifies a losing trade as a loss outcome', () => {
    const graph = buildKnowledgeGraph({ tradeLog: roundTrip({ symbol: 'ETH/USDT', exitId: 'x2', at: T0, pnl: -5 }) });
    expect(graph.nodes.has('outcome:loss')).toBe(true);
    expect(graph.nodes.has('outcome:win')).toBe(false);
  });

  it('deduplicates shared nodes across trades', () => {
    // Two BTC trades from the same origin share one symbol node and one
    // origin node — that sharing is the whole point of a graph.
    const graph = buildKnowledgeGraph({
      tradeLog: [
        ...roundTrip({ symbol: 'BTC/USDT', exitId: 'a', at: T0, pnl: 5 }),
        ...roundTrip({ symbol: 'BTC/USDT', exitId: 'b', at: T0 + 5 * HOUR, pnl: 7 }),
      ],
    });
    const stats = graphStats(graph);
    expect(stats.nodesByType['trade']).toBe(2);
    expect(stats.nodesByType['symbol']).toBe(1);
    expect(stats.nodesByType['origin']).toBe(1);
  });

  it('links the full causal chain: trade -> reflection -> lesson -> hypothesis', () => {
    const graph = buildKnowledgeGraph({
      tradeLog: roundTrip({ symbol: 'BTC/USDT', exitId: 'x3', at: T0, pnl: -8 }),
      reflections: [{ tradeId: 'x3', symbol: 'BTC/USDT', lesson: 'Entered before confirmation.' }],
      hypotheses: [{ id: 'h1', tradeId: 'x3', claim: 'Waiting for a confirmation candle improves win rate.', status: 'proposed' }],
    });
    expect(graph.edges.some((e) => e.from === 'trade:x3' && e.type === 'produced-reflection')).toBe(true);
    expect(graph.edges.some((e) => e.type === 'yielded-lesson')).toBe(true);
    expect(graph.edges.some((e) => e.type === 'became-hypothesis')).toBe(true);
  });

  it('does not create a lesson node when the reflection has no lesson', () => {
    const graph = buildKnowledgeGraph({
      tradeLog: roundTrip({ symbol: 'BTC/USDT', exitId: 'x4', at: T0, pnl: 3 }),
      reflections: [{ tradeId: 'x4', symbol: 'BTC/USDT', lesson: null }],
    });
    expect(graphStats(graph).nodesByType['reflection']).toBe(1);
    expect(graphStats(graph).nodesByType['lesson']).toBeUndefined();
  });

  it('ignores a hypothesis whose trade has no lesson to hang it from', () => {
    const graph = buildKnowledgeGraph({
      tradeLog: roundTrip({ symbol: 'BTC/USDT', exitId: 'x5', at: T0, pnl: 3 }),
      reflections: [{ tradeId: 'x5', symbol: 'BTC/USDT', lesson: null }],
      hypotheses: [{ id: 'h2', tradeId: 'x5', claim: 'orphan', status: 'proposed' }],
    });
    expect(graphStats(graph).nodesByType['hypothesis']).toBeUndefined();
  });
});

describe('queryTrades', () => {
  const graph = buildKnowledgeGraph({
    tradeLog: [
      ...roundTrip({ symbol: 'BTC/USDT', exitId: 'w1', at: T0, pnl: 30, originTag: 'agent-plan' }),
      ...roundTrip({ symbol: 'BTC/USDT', exitId: 'l1', at: T0 + 5 * HOUR, pnl: -10, originTag: 'agent-plan' }),
      ...roundTrip({ symbol: 'ETH/USDT', exitId: 'w2', at: T0 + 10 * HOUR, pnl: 5, originTag: 'chat-trade-action' }),
    ],
  });

  it('returns everything with no filters, newest first', () => {
    const result = queryTrades(graph, {});
    expect(result.matches).toHaveLength(3);
    expect(result.matches[0].exitTradeId).toBe('w2'); // most recent exit
    expect(result.appliedConstraints).toEqual([]);
  });

  it('filters by symbol, case-insensitively', () => {
    expect(queryTrades(graph, { symbol: 'BTC/USDT' }).matches).toHaveLength(2);
    expect(queryTrades(graph, { symbol: 'btc/usdt' }).matches).toHaveLength(2);
  });

  it('filters by outcome', () => {
    expect(queryTrades(graph, { outcome: 'win' }).matches).toHaveLength(2);
    expect(queryTrades(graph, { outcome: 'loss' }).matches).toHaveLength(1);
  });

  it('filters by origin', () => {
    expect(queryTrades(graph, { originTag: 'chat-trade-action' }).matches).toHaveLength(1);
  });

  it('filters by minimum P&L', () => {
    expect(queryTrades(graph, { minPnl: 10 }).matches).toHaveLength(1);
  });

  it('combines filters and reports every one it applied', () => {
    const result = queryTrades(graph, { symbol: 'BTC/USDT', outcome: 'win', minPnl: 20 });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].exitTradeId).toBe('w1');
    expect(result.appliedConstraints).toHaveLength(3);
  });

  it('rebuilds complete ClosedTrade objects, including hasReflection', () => {
    const withReflection = buildKnowledgeGraph({
      tradeLog: roundTrip({ symbol: 'BTC/USDT', exitId: 'r1', at: T0, pnl: 4 }),
      reflections: [{ tradeId: 'r1', symbol: 'BTC/USDT', lesson: 'x' }],
    });
    const trade = queryTrades(withReflection, {}).matches[0];
    expect(trade.hasReflection).toBe(true);
    expect(trade.exitTradeId).toBe('r1');
    expect(trade.symbol).toBe('BTC/USDT');
    expect(typeof trade.holdMinutes).toBe('number');
  });

  it('reports funding/news constraints as unsupported rather than silently ignoring them', () => {
    // This is the honesty-critical case: the roadmap's example query asks
    // for these, and pretending to honor them would return a subset that
    // looks filtered but isn't.
    const result = queryTrades(graph, { requireHighFunding: true, requirePositiveNews: true });
    expect(result.unsupportedConstraints).toHaveLength(2);
    expect(result.unsupportedConstraints[0]).toContain('funding');
    expect(result.unsupportedConstraints[1]).toContain('news');
    // Still returns the unfiltered set — the caller is told exactly what
    // was and wasn't applied.
    expect(result.matches).toHaveLength(3);
  });

  it('returns no matches (not an error) when filters exclude everything', () => {
    expect(queryTrades(graph, { symbol: 'DOGE/USDT' }).matches).toEqual([]);
  });
});

describe('explainTrade', () => {
  it('walks trade -> lesson -> hypotheses', () => {
    const graph = buildKnowledgeGraph({
      tradeLog: roundTrip({ symbol: 'BTC/USDT', exitId: 'e1', at: T0, pnl: -12 }),
      reflections: [{ tradeId: 'e1', symbol: 'BTC/USDT', lesson: 'Stop was too tight.' }],
      hypotheses: [{ id: 'h9', tradeId: 'e1', claim: 'Wider ATR stops reduce premature exits.', status: 'validated' }],
    });
    const result = explainTrade(graph, 'e1');
    expect(result.lesson).toBe('Stop was too tight.');
    expect(result.hypotheses).toEqual([{ claim: 'Wider ATR stops reduce premature exits.', status: 'validated' }]);
  });

  it('returns nulls for a trade with no reflection, without throwing', () => {
    const graph = buildKnowledgeGraph({ tradeLog: roundTrip({ symbol: 'BTC/USDT', exitId: 'e2', at: T0, pnl: 1 }) });
    expect(explainTrade(graph, 'e2')).toEqual({ lesson: null, hypotheses: [] });
  });

  it('returns nulls for an unknown trade id', () => {
    const graph = buildKnowledgeGraph({ tradeLog: [] });
    expect(explainTrade(graph, 'nope')).toEqual({ lesson: null, hypotheses: [] });
  });
});

describe('buildKnowledgeGraphContext', () => {
  it('says plainly when there is no history rather than implying analysis', () => {
    const text = buildKnowledgeGraphContext(buildKnowledgeGraph({ tradeLog: [] }));
    expect(text).toContain('no closed round-trip trades recorded yet');
  });

  it('withholds win rates below the minimum sample', () => {
    const graph = buildKnowledgeGraph({ tradeLog: roundTrip({ symbol: 'BTC/USDT', exitId: 's1', at: T0, pnl: 5 }) });
    const text = buildKnowledgeGraphContext(graph);
    expect(text).toContain('not enough linked history');
  });

  it('reports a bucket win rate once the sample is large enough', () => {
    const graph = buildKnowledgeGraph({
      tradeLog: [
        ...roundTrip({ symbol: 'BTC/USDT', exitId: 'm1', at: T0, pnl: 5 }),
        ...roundTrip({ symbol: 'BTC/USDT', exitId: 'm2', at: T0 + 5 * HOUR, pnl: 5 }),
        ...roundTrip({ symbol: 'BTC/USDT', exitId: 'm3', at: T0 + 10 * HOUR, pnl: -2 }),
      ],
    });
    const text = buildKnowledgeGraphContext(graph);
    expect(text).toContain('win rate over 3 trades');
  });

  it('always discloses what is not queryable from history', () => {
    const graph = buildKnowledgeGraph({ tradeLog: roundTrip({ symbol: 'BTC/USDT', exitId: 'd1', at: T0, pnl: 5 }) });
    const text = buildKnowledgeGraphContext(graph);
    expect(text).toContain('Not queryable from history');
  });
});
