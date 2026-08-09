import type { TradeLogEntry } from './types';
import { reconstructClosedTrades, type ClosedTrade } from './learningDashboard';

// ---------------------------------------------------------------------
// Universal Knowledge Graph (engineering spec Sections 7 & 22.6,
// roadmap Phase 90).
//
// The spec's requirement: "Everything becomes connected — not files, not
// databases, knowledge," with every entity linked to the entities that
// caused or explain it, queryable at the level of the roadmap's own
// example: "show every successful BTC breakout during high funding with
// positive news and low volatility where Trend Strategy made more than
// 3R."
//
// DESIGN DECISION — this graph is DERIVED, not persisted.
//
// Every input (trade log, reflections, hypotheses, events) is already
// persisted in its own store. Persisting the graph too would create a
// second source of truth that silently drifts from the first, and would
// need invalidation logic on every write. Rebuilding it is cheap (it's a
// linear pass over data already in memory), so it's rebuilt on demand
// instead. If graph size ever outgrows that, the fix is caching with a
// real invalidation story — not a duplicate store.
//
// HONEST SCOPE — what this can and cannot answer.
//
// The roadmap's example query names five constraints. Four map onto data
// this app genuinely records: symbol, outcome, strategy/origin, and
// market-condition + volatility regime (reconstructed from the
// entry-context snapshot captured at buy time — see
// lib/learningDashboard.ts's classifyEntryContext). "During high
// funding" and "with positive news" are NOT reliably answerable per
// historical trade, because funding/news are polled live and are not
// snapshotted into each trade record. Rather than approximate them and
// present a guess as history, queries for them are reported as
// unsupported. Closing that gap means snapshotting funding/sentiment at
// entry the way indicators already are — a real, small, future change.
//
// "Strategy" here means originTag — which decision path produced the
// trade — because that is the attribution actually recorded at execution
// time. This app cannot say which of nine ensemble agents "caused" a
// trade, and does not pretend to.
// ---------------------------------------------------------------------

export type KnowledgeNodeType =
  | 'trade'
  | 'symbol'
  | 'origin' // the decision path that produced a trade (this app's "strategy" attribution)
  | 'reflection'
  | 'lesson'
  | 'hypothesis'
  | 'market-condition'
  | 'volatility-regime'
  | 'outcome';

export type KnowledgeNode = {
  id: string; // globally unique: `${type}:${key}`
  type: KnowledgeNodeType;
  label: string;
  /** Type-specific payload. Kept loose deliberately — this is a graph over heterogeneous records. */
  data?: Record<string, unknown>;
};

// Edge verbs are past-tense//causal on purpose: the spec asks for
// entities linked to what "caused or explains" them, so the direction
// carries meaning rather than being an undirected association.
export type KnowledgeEdgeType =
  | 'traded-symbol' // trade -> symbol
  | 'originated-from' // trade -> origin
  | 'produced-reflection' // trade -> reflection
  | 'yielded-lesson' // reflection -> lesson
  | 'became-hypothesis' // lesson -> hypothesis
  | 'occurred-in-condition' // trade -> market-condition
  | 'occurred-in-volatility' // trade -> volatility-regime
  | 'resulted-in'; // trade -> outcome

export type KnowledgeEdge = {
  from: string;
  to: string;
  type: KnowledgeEdgeType;
};

export type KnowledgeGraph = {
  nodes: Map<string, KnowledgeNode>;
  edges: KnowledgeEdge[];
  builtAt: number;
};

// Minimal shapes, kept local rather than imported from the *.server.ts
// stores — those pull in Node's `fs` and aren't safe to import into a
// client-usable module. Same pattern as lib/memoryContext.ts's
// ReflectionLessonInput.
export type GraphReflectionInput = { tradeId: string; symbol: string; lesson: string | null };
export type GraphHypothesisInput = { id: string; tradeId: string; claim: string; status: string };

function nodeId(type: KnowledgeNodeType, key: string): string {
  return `${type}:${key}`;
}

function addNode(graph: KnowledgeGraph, node: KnowledgeNode): string {
  if (!graph.nodes.has(node.id)) graph.nodes.set(node.id, node);
  return node.id;
}

function addEdge(graph: KnowledgeGraph, from: string, to: string, type: KnowledgeEdgeType): void {
  graph.edges.push({ from, to, type });
}

export function buildKnowledgeGraph(params: {
  tradeLog: TradeLogEntry[];
  reflections?: GraphReflectionInput[];
  hypotheses?: GraphHypothesisInput[];
  now?: number;
}): KnowledgeGraph {
  const graph: KnowledgeGraph = { nodes: new Map(), edges: [], builtAt: params.now ?? Date.now() };
  const reflections = params.reflections ?? [];
  const hypotheses = params.hypotheses ?? [];

  const reflectedIds = new Set(reflections.map((r) => r.tradeId));
  const closed = reconstructClosedTrades(params.tradeLog, reflectedIds);

  const reflectionByTradeId = new Map(reflections.map((r) => [r.tradeId, r]));
  const hypothesesByTradeId = new Map<string, GraphHypothesisInput[]>();
  for (const h of hypotheses) {
    const list = hypothesesByTradeId.get(h.tradeId) ?? [];
    list.push(h);
    hypothesesByTradeId.set(h.tradeId, list);
  }

  for (const trade of closed) {
    const tradeNode = addNode(graph, {
      id: nodeId('trade', trade.exitTradeId),
      type: 'trade',
      label: `${trade.symbol} ${trade.pnl >= 0 ? '+' : ''}$${trade.pnl.toFixed(2)}`,
      // Every ClosedTrade field is carried, so queryTrades can rebuild a
      // complete ClosedTrade from the node without a partially-undefined
      // object masquerading as one.
      data: {
        symbol: trade.symbol,
        tab: trade.tab,
        pnl: trade.pnl,
        originTag: trade.originTag,
        marketCondition: trade.marketCondition,
        volatilityRegime: trade.volatilityRegime,
        holdMinutes: trade.holdMinutes,
        entryTs: trade.entryTs,
        exitTs: trade.exitTs,
        hasReflection: trade.hasReflection,
      },
    });

    addEdge(graph, tradeNode, addNode(graph, { id: nodeId('symbol', trade.symbol), type: 'symbol', label: trade.symbol }), 'traded-symbol');

    const origin = trade.originTag ?? 'unknown';
    addEdge(graph, tradeNode, addNode(graph, { id: nodeId('origin', origin), type: 'origin', label: origin }), 'originated-from');

    const outcome = trade.pnl >= 0 ? 'win' : 'loss';
    addEdge(graph, tradeNode, addNode(graph, { id: nodeId('outcome', outcome), type: 'outcome', label: outcome }), 'resulted-in');

    addEdge(
      graph,
      tradeNode,
      addNode(graph, { id: nodeId('market-condition', trade.marketCondition), type: 'market-condition', label: trade.marketCondition }),
      'occurred-in-condition',
    );
    addEdge(
      graph,
      tradeNode,
      addNode(graph, { id: nodeId('volatility-regime', trade.volatilityRegime), type: 'volatility-regime', label: trade.volatilityRegime }),
      'occurred-in-volatility',
    );

    // trade -> reflection -> lesson -> hypothesis: the causal chain the
    // self-learning pipeline actually produces.
    const reflection = reflectionByTradeId.get(trade.exitTradeId);
    if (reflection) {
      const reflectionNode = addNode(graph, {
        id: nodeId('reflection', reflection.tradeId),
        type: 'reflection',
        label: `Reflection on ${reflection.symbol}`,
      });
      addEdge(graph, tradeNode, reflectionNode, 'produced-reflection');

      if (reflection.lesson) {
        const lessonNode = addNode(graph, {
          id: nodeId('lesson', reflection.tradeId),
          type: 'lesson',
          label: reflection.lesson,
        });
        addEdge(graph, reflectionNode, lessonNode, 'yielded-lesson');

        for (const h of hypothesesByTradeId.get(trade.exitTradeId) ?? []) {
          const hypothesisNode = addNode(graph, {
            id: nodeId('hypothesis', h.id),
            type: 'hypothesis',
            label: h.claim,
            data: { status: h.status },
          });
          addEdge(graph, lessonNode, hypothesisNode, 'became-hypothesis');
        }
      }
    }
  }

  return graph;
}

// ---------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------

export type TradeQuery = {
  symbol?: string;
  outcome?: 'win' | 'loss';
  originTag?: string;
  marketCondition?: 'bullish' | 'bearish' | 'range' | 'unknown';
  volatilityRegime?: 'low' | 'medium' | 'high' | 'unknown';
  minPnl?: number;
  maxHoldMinutes?: number;
  // Constraints this app cannot answer from historical records. Passing
  // one is not an error — it's reported back as unsupported so the caller
  // can say so honestly rather than silently returning a subset that
  // looks like it honored the filter.
  requireHighFunding?: boolean;
  requirePositiveNews?: boolean;
};

export type TradeQueryResult = {
  matches: ClosedTrade[];
  /** Constraints that were ignored because the data to evaluate them isn't recorded per-trade. */
  unsupportedConstraints: string[];
  /** Every constraint that WAS applied, for an honest description of what the result means. */
  appliedConstraints: string[];
};

export function queryTrades(graph: KnowledgeGraph, query: TradeQuery): TradeQueryResult {
  const unsupportedConstraints: string[] = [];
  const appliedConstraints: string[] = [];

  if (query.requireHighFunding) {
    unsupportedConstraints.push(
      'high funding at entry — funding rate is polled live and not snapshotted per trade, so it cannot be filtered historically',
    );
  }
  if (query.requirePositiveNews) {
    unsupportedConstraints.push(
      'positive news at entry — sentiment is computed live and not snapshotted per trade, so it cannot be filtered historically',
    );
  }

  const trades: ClosedTrade[] = [];
  for (const node of graph.nodes.values()) {
    if (node.type !== 'trade' || !node.data) continue;
    const d = node.data as unknown as ClosedTrade & { originTag: string };
    trades.push({ ...d, exitTradeId: node.id.slice('trade:'.length) } as ClosedTrade);
  }

  let matches = trades;
  if (query.symbol !== undefined) {
    const wanted = query.symbol.toUpperCase();
    matches = matches.filter((t) => t.symbol.toUpperCase() === wanted);
    appliedConstraints.push(`symbol = ${query.symbol}`);
  }
  if (query.outcome !== undefined) {
    matches = matches.filter((t) => (query.outcome === 'win' ? t.pnl >= 0 : t.pnl < 0));
    appliedConstraints.push(`outcome = ${query.outcome}`);
  }
  if (query.originTag !== undefined) {
    matches = matches.filter((t) => (t.originTag ?? 'unknown') === query.originTag);
    appliedConstraints.push(`origin = ${query.originTag}`);
  }
  if (query.marketCondition !== undefined) {
    matches = matches.filter((t) => t.marketCondition === query.marketCondition);
    appliedConstraints.push(`market condition = ${query.marketCondition}`);
  }
  if (query.volatilityRegime !== undefined) {
    matches = matches.filter((t) => t.volatilityRegime === query.volatilityRegime);
    appliedConstraints.push(`volatility regime = ${query.volatilityRegime}`);
  }
  if (query.minPnl !== undefined) {
    matches = matches.filter((t) => t.pnl >= query.minPnl!);
    appliedConstraints.push(`P&L >= ${query.minPnl}`);
  }
  if (query.maxHoldMinutes !== undefined) {
    matches = matches.filter((t) => t.holdMinutes <= query.maxHoldMinutes!);
    appliedConstraints.push(`hold time <= ${query.maxHoldMinutes}m`);
  }

  matches = [...matches].sort((a, b) => b.exitTs - a.exitTs);
  return { matches, unsupportedConstraints, appliedConstraints };
}

// ---------------------------------------------------------------------
// Traversal — "what explains this?" walks the causal chain from a trade
// to its lesson and any hypothesis that came out of it.
// ---------------------------------------------------------------------
export function explainTrade(graph: KnowledgeGraph, exitTradeId: string): { lesson: string | null; hypotheses: { claim: string; status: string }[] } {
  const tradeKey = nodeId('trade', exitTradeId);
  const reflectionEdge = graph.edges.find((e) => e.from === tradeKey && e.type === 'produced-reflection');
  if (!reflectionEdge) return { lesson: null, hypotheses: [] };

  const lessonEdge = graph.edges.find((e) => e.from === reflectionEdge.to && e.type === 'yielded-lesson');
  if (!lessonEdge) return { lesson: null, hypotheses: [] };

  const lessonNode = graph.nodes.get(lessonEdge.to);
  const hypotheses = graph.edges
    .filter((e) => e.from === lessonEdge.to && e.type === 'became-hypothesis')
    .map((e) => graph.nodes.get(e.to))
    .filter((n): n is KnowledgeNode => n !== undefined)
    .map((n) => ({ claim: n.label, status: String(n.data?.status ?? 'unknown') }));

  return { lesson: lessonNode?.label ?? null, hypotheses };
}

export function graphStats(graph: KnowledgeGraph): { nodesByType: Record<string, number>; edgeCount: number } {
  const nodesByType: Record<string, number> = {};
  for (const node of graph.nodes.values()) {
    nodesByType[node.type] = (nodesByType[node.type] ?? 0) + 1;
  }
  return { nodesByType, edgeCount: graph.edges.length };
}

// ---------------------------------------------------------------------
// Chat context injection — same pattern as every other build*Context.
// Gives the model the ability to answer "has this setup worked before?"
// from real linked history instead of guessing.
// ---------------------------------------------------------------------
export function buildKnowledgeGraphContext(graph: KnowledgeGraph): string {
  const stats = graphStats(graph);
  const tradeCount = stats.nodesByType['trade'] ?? 0;
  if (tradeCount === 0) {
    return 'KNOWLEDGE GRAPH: no closed round-trip trades recorded yet, so there is no linked history to reason over.';
  }

  const lines: string[] = [
    `KNOWLEDGE GRAPH (${tradeCount} closed trades linked across ${stats.edgeCount} relationships — derived live from the trade log, reflections, and hypotheses; not a separate persisted copy):`,
  ];

  // Win rate by (origin, market condition) — the most useful real
  // cross-section this data supports, and the closest honest answer to
  // the roadmap's "which setups have an edge" question.
  const buckets = new Map<string, { wins: number; total: number; pnl: number }>();
  for (const node of graph.nodes.values()) {
    if (node.type !== 'trade' || !node.data) continue;
    const origin = String(node.data.originTag ?? 'unknown');
    const condition = String(node.data.marketCondition ?? 'unknown');
    const pnl = Number(node.data.pnl ?? 0);
    const key = `${origin} in ${condition} markets`;
    const b = buckets.get(key) ?? { wins: 0, total: 0, pnl: 0 };
    b.total++;
    if (pnl >= 0) b.wins++;
    b.pnl += pnl;
    buckets.set(key, b);
  }

  const MIN_SAMPLE = 3; // same discipline as the Learning Dashboard — no win rate off 1-2 trades
  const ranked = Array.from(buckets.entries())
    .filter(([, b]) => b.total >= MIN_SAMPLE)
    .sort((a, b) => b[1].pnl - a[1].pnl);

  if (ranked.length > 0) {
    lines.push('Linked setup performance (min 3 trades per bucket — smaller samples omitted rather than shown as a shaky rate):');
    for (const [key, b] of ranked) {
      lines.push(`  ${key}: ${((b.wins / b.total) * 100).toFixed(0)}% win rate over ${b.total} trades, ${b.pnl >= 0 ? '+' : ''}$${b.pnl.toFixed(2)} total`);
    }
  } else {
    lines.push('No (origin × market-condition) bucket has 3+ closed trades yet — not enough linked history to report a rate honestly.');
  }

  const lessonCount = stats.nodesByType['lesson'] ?? 0;
  const hypothesisCount = stats.nodesByType['hypothesis'] ?? 0;
  lines.push(`Causal chain coverage: ${lessonCount} trade(s) have a recorded lesson, ${hypothesisCount} of which produced a testable hypothesis.`);
  lines.push(
    'Not queryable from history: funding rate and news sentiment at entry are polled live and not snapshotted per trade, so historical questions involving them cannot be answered from this graph and should not be guessed at.',
  );

  return lines.join('\n');
}
