// =====================================================================
// Agent Descriptors — Phase 21
//
// Registers every intelligent subsystem in TradingOS as a formal agent
// in the Agent OS. Each descriptor captures the agent's identity,
// version, capabilities, dependencies, and scheduling configuration.
//
// Categories:
//   market-intelligence — data ingestion and analysis
//   strategy — trade signal generation
//   risk — trade validation and position sizing
//   execution — plan creation and trade execution
//   learning — post-trade analysis and memory
//   orchestration — multi-agent coordination
// =====================================================================

import type { AgentDescriptor } from './agentOS';

export const AGENT_DESCRIPTORS: AgentDescriptor[] = [
  // ---- Market Intelligence Layer ------------------------------------

  {
    id: 'market-data',
    name: 'Market Data',
    version: '1.0.0',
    description: 'Live price feeds via WebSocket (crypto) and polling (equities). Provides real-time tick data for all watchlist symbols.',
    changelog: 'v1.0.0: Initial — WebSocket for Binance, polling fallback, simulation fallback.',
    capabilities: ['live-price', 'tick-stream'],
    dependencies: [],
    category: 'market-intelligence',
    priority: 0,
    tickIntervalMs: 0, // WebSocket-driven, not scheduler-driven
  },
  {
    id: 'candle-feed',
    name: 'Candle Feed',
    version: '1.0.0',
    description: 'OHLC candle history from Binance (crypto) and Yahoo (equities). Background-refreshes 1h/4h candles every 60s for all watchlist symbols.',
    changelog: 'v1.0.0: Initial — Binance klines, Yahoo chart endpoint, 60s background refresh.',
    capabilities: ['ohlc-history', 'multi-timeframe'],
    dependencies: ['market-data'],
    category: 'market-intelligence',
    priority: 1,
    tickIntervalMs: 60_000, // 60s refresh cycle
  },
  {
    id: 'market-structure',
    name: 'Market Structure',
    version: '1.0.0',
    description: 'Detects HH, HL, LH, LL, BOS, CHoCH, swing points from candle data. Determines current trend and structure events.',
    changelog: 'v1.0.0: Initial — swing detection, BOS/CHoCH, trend classification.',
    capabilities: ['trend-detection', 'structure-events'],
    dependencies: ['candle-feed'],
    category: 'market-intelligence',
    priority: 2,
    tickIntervalMs: 5_000,
  },
  {
    id: 'liquidity',
    name: 'Liquidity Agent',
    version: '1.0.0',
    description: 'Identifies liquidity sweeps, equal highs/lows, stop hunts, and large liquidity pools from price action.',
    changelog: 'v1.0.0: Initial — equal high/low detection, sweep detection, pool identification.',
    capabilities: ['liquidity-zones', 'sweep-detection'],
    dependencies: ['candle-feed'],
    category: 'market-intelligence',
    priority: 2,
    tickIntervalMs: 10_000,
  },
  {
    id: 'volume-profile',
    name: 'Volume Profile',
    version: '1.0.0',
    description: 'Computes Point of Control (POC), Value Area High/Low, and volume nodes from candle volume data.',
    changelog: 'v1.0.0: Initial — POC, VAH, VAL, high/low volume node detection.',
    capabilities: ['poc', 'value-area'],
    dependencies: ['candle-feed'],
    category: 'market-intelligence',
    priority: 2,
    tickIntervalMs: 10_000,
  },
  {
    id: 'order-flow',
    name: 'Order Flow',
    version: '1.0.0',
    description: 'Analyzes bid/ask imbalance, order book pressure, and aggressive buyer/seller detection.',
    changelog: 'v1.0.0: Initial — imbalance detection, pressure scoring.',
    capabilities: ['bid-ask-imbalance', 'pressure'],
    dependencies: ['market-data'],
    category: 'market-intelligence',
    priority: 2,
    tickIntervalMs: 5_000,
  },
  {
    id: 'sentiment',
    name: 'Sentiment Agent',
    version: '1.0.0',
    description: 'Keyword-based news sentiment (not NLP), funding rate analysis, Fear & Greed Index, derivatives snapshot.',
    changelog: 'v1.0.0: Initial — keyword scan, funding/OI/F&G integration.',
    capabilities: ['news-sentiment', 'funding-analysis'],
    dependencies: ['market-data'],
    category: 'market-intelligence',
    priority: 3,
    tickIntervalMs: 30_000,
  },
  {
    id: 'event-detection',
    name: 'Event Detection',
    version: '1.0.0',
    description: 'Detects whale transfers, exchange inflows/outflows, liquidation cascades, funding spikes, volatility explosions, unusual volume.',
    changelog: 'v1.0.0: Initial — anomaly detection across multiple event types.',
    capabilities: ['anomaly-detection'],
    dependencies: ['candle-feed', 'order-flow'],
    category: 'market-intelligence',
    priority: 3,
    tickIntervalMs: 15_000,
  },

  // ---- Strategy Layer -----------------------------------------------

  {
    id: 'trend-following',
    name: 'Trend Following',
    version: '1.0.0',
    description: 'EMA crossover + ADX-based trend following strategy. Votes BUY in uptrends, SELL in downtrends.',
    changelog: 'v1.0.0: Initial — EMA20/50 cross with ADX filter.',
    capabilities: ['signal-generation'],
    dependencies: ['candle-feed', 'market-structure'],
    category: 'strategy',
    priority: 5,
    tickIntervalMs: 5_000,
  },
  {
    id: 'momentum',
    name: 'Momentum',
    version: '1.0.0',
    description: 'RSI + MACD momentum strategy. Detects momentum shifts and divergences.',
    changelog: 'v1.0.0: Initial — RSI threshold + MACD histogram direction.',
    capabilities: ['signal-generation'],
    dependencies: ['candle-feed'],
    category: 'strategy',
    priority: 5,
    tickIntervalMs: 5_000,
  },
  {
    id: 'scalping',
    name: 'Scalping',
    version: '1.0.0',
    description: 'Short-term scalping strategy using Bollinger Bands and RSI extremes.',
    changelog: 'v1.0.0: Initial — BB squeeze + RSI oversold/overbought.',
    capabilities: ['signal-generation'],
    dependencies: ['candle-feed'],
    category: 'strategy',
    priority: 5,
    tickIntervalMs: 3_000,
  },
  {
    id: 'swing-trading',
    name: 'Swing Trading',
    version: '1.0.0',
    description: 'Multi-day swing trading strategy using market structure and EMA support/resistance.',
    changelog: 'v1.0.0: Initial — structure + EMA confluence.',
    capabilities: ['signal-generation'],
    dependencies: ['candle-feed', 'market-structure'],
    category: 'strategy',
    priority: 5,
    tickIntervalMs: 10_000,
  },
  {
    id: 'mean-reversion',
    name: 'Mean Reversion',
    version: '1.0.0',
    description: 'Mean reversion strategy using Bollinger Bands and RSI divergence from the mean.',
    changelog: 'v1.0.0: Initial — BB deviation + RSI extremes.',
    capabilities: ['signal-generation'],
    dependencies: ['candle-feed'],
    category: 'strategy',
    priority: 5,
    tickIntervalMs: 5_000,
  },
  {
    id: 'breakout',
    name: 'Breakout',
    version: '1.0.0',
    description: 'Range breakout detection with volume confirmation and structure context.',
    changelog: 'v1.0.0: Initial — range detection + volume spike + BOS confirmation.',
    capabilities: ['signal-generation'],
    dependencies: ['candle-feed', 'market-structure'],
    category: 'strategy',
    priority: 5,
    tickIntervalMs: 5_000,
  },
  {
    id: 'range-trading',
    name: 'Range Trading',
    version: '1.0.0',
    description: 'Detects and trades within identified ranges. Buys near support, sells near resistance.',
    changelog: 'v1.0.0: Initial — range boundary detection + mean reversion within range.',
    capabilities: ['signal-generation'],
    dependencies: ['candle-feed'],
    category: 'strategy',
    priority: 5,
    tickIntervalMs: 5_000,
  },
  {
    id: 'grid',
    name: 'Grid Strategy',
    version: '0.9.0',
    description: 'Assesses whether conditions favor a grid strategy. Votes HOLD (no execution capability yet). Execution is planned.',
    changelog: 'v0.9.0: Votes in ensemble but cannot execute grid orders.',
    capabilities: ['signal-generation'],
    dependencies: ['candle-feed'],
    category: 'strategy',
    priority: 6,
    tickIntervalMs: 10_000,
  },
  {
    id: 'arbitrage',
    name: 'Arbitrage',
    version: '0.9.0',
    description: 'Detects cross-exchange price discrepancies. Votes directionally on detected spreads. Execution is planned.',
    changelog: 'v0.9.0: Votes in ensemble using real spread detection but cannot execute arb trades.',
    capabilities: ['signal-generation', 'cross-exchange'],
    dependencies: ['order-flow'],
    category: 'strategy',
    priority: 6,
    tickIntervalMs: 10_000,
  },

  // ---- Orchestration Layer ------------------------------------------

  {
    id: 'strategy-ensemble',
    name: 'Strategy Ensemble',
    version: '1.0.0',
    description: '9-agent ensemble that aggregates all strategy signals into a confidence-weighted BUY/SELL/HOLD consensus. Informational-only — never executes directly.',
    changelog: 'v1.0.0: Initial — confidence-weighted voting, directional consensus.',
    capabilities: ['consensus-signal'],
    dependencies: [
      'trend-following', 'momentum', 'scalping', 'swing-trading',
      'mean-reversion', 'breakout', 'range-trading', 'grid', 'arbitrage',
    ],
    category: 'orchestration',
    priority: 7,
    tickIntervalMs: 5_000,
  },
  {
    id: 'debate',
    name: 'Debate System',
    version: '1.0.0',
    description: 'Multi-analyst debate with 7 independent agents (Bull, Bear, Neutral, Technical, Fundamental, Sentiment, Risk) plus a moderator. Produces calibrated composite confidence.',
    changelog: 'v1.0.0: Initial — 7 analyst agents, moderator synthesis, confidence calibration.',
    capabilities: ['multi-analyst-debate'],
    dependencies: ['strategy-ensemble', 'sentiment'],
    category: 'orchestration',
    priority: 8,
    tickIntervalMs: 0, // on-demand — triggered by user or agent request
  },

  // ---- Risk Layer ---------------------------------------------------

  {
    id: 'risk-manager',
    name: 'Risk Manager',
    version: '1.0.0',
    description: '9 independent risk checks (position, daily loss, drawdown, liquidity, spread, leverage, portfolio exposure, correlation, news). Approves or rejects trade requests.',
    changelog: 'v1.0.0: Initial — 9 checks, dynamic SL/TP (ATR + swing), configurable risk limits.',
    capabilities: ['trade-validation', 'position-sizing'],
    dependencies: ['candle-feed', 'market-structure'],
    category: 'risk',
    priority: 4,
    tickIntervalMs: 0, // on-demand — invoked per trade request
  },
  {
    id: 'portfolio-intelligence',
    name: 'Portfolio Intelligence',
    version: '1.0.0',
    description: 'Portfolio-level optimization: correlation analysis, sector exposure, capital allocation, risk parity.',
    changelog: 'v1.0.0: Initial — correlation matrix, sector tracking, allocation recommendations.',
    capabilities: ['portfolio-analysis', 'correlation-analysis'],
    dependencies: ['candle-feed'],
    category: 'risk',
    priority: 4,
    tickIntervalMs: 30_000,
  },

  // ---- Execution Layer ----------------------------------------------

  {
    id: 'supervisor',
    name: 'Supervisor AI',
    version: '1.0.0',
    description: 'The orchestration and final authority layer. Coordinates all agents, resolves disagreements (2-tier conflict resolution), approves/rejects trades, monitors system health.',
    changelog: 'v1.0.0: Initial — trade gate, conflict resolution, urgency classification, system health rollup.',
    capabilities: ['trade-approval', 'conflict-resolution'],
    dependencies: ['risk-manager', 'strategy-ensemble', 'debate'],
    category: 'orchestration',
    priority: 9,
    tickIntervalMs: 0, // on-demand — invoked per trade request
  },
  {
    id: 'planner',
    name: 'Planner Agent',
    version: '1.0.0',
    description: 'Creates conditional trade plans (if triggerCondition, then watch for watchCondition, then enter). Evaluates PlanConditions against live indicator snapshots.',
    changelog: 'v1.0.0: Initial — two-stage plans, RSI/EMA/price conditions.',
    capabilities: ['conditional-plans'],
    dependencies: ['candle-feed'],
    category: 'execution',
    priority: 5,
    tickIntervalMs: 0, // evaluated per agent task tick, not independently
  },

  // ---- Learning Layer -----------------------------------------------

  {
    id: 'reflection',
    name: 'Reflection Agent',
    version: '1.0.0',
    description: 'Post-trade analysis: why did we lose, which indicator failed, could we exit earlier. Read/advisory only — never touches execution.',
    changelog: 'v1.0.0: Initial — 5-section labeled analysis (WHY, FAILED_SIGNAL, EARLIER_EXIT, CONFIDENCE, LESSON).',
    capabilities: ['post-trade-analysis'],
    dependencies: ['candle-feed'],
    category: 'learning',
    priority: 10,
    tickIntervalMs: 0, // on-demand — triggered on trade close
  },
  {
    id: 'memory',
    name: 'AI Memory',
    version: '1.0.0',
    description: 'Persistent memory for risk preferences. Win rate, favorite assets, trading hours are computed live from trade log, not duplicated.',
    changelog: 'v1.0.0: Initial — server-persisted risk preference, computed stats.',
    capabilities: ['memory-persistence'],
    dependencies: [],
    category: 'learning',
    priority: 10,
    tickIntervalMs: 0, // on-demand — updated on preference change
  },
  {
    id: 'autonomous-research',
    name: 'Autonomous Research',
    version: '1.0.0',
    description: 'Proactively discovers opportunities: trending coins, outperforming sectors, highest-edge setups, overnight changes.',
    changelog: 'v1.0.0: Initial — periodic autonomous scanning.',
    capabilities: ['opportunity-discovery'],
    dependencies: ['candle-feed', 'sentiment'],
    category: 'learning',
    priority: 10,
    tickIntervalMs: 300_000, // every 5 minutes
  },

  // ---- Phase 22: Mission Planner -----------------------------------

  {
    id: 'mission-planner',
    name: 'Mission Planner',
    version: '1.0.0',
    description: 'Strategic mission layer — every trade contributes to an active mission (growth, capital-preservation, event-reduction, accumulation, cash-allocation). Evaluates progress, scores trade alignment, and enforces mission constraints.',
    changelog: 'v1.0.0: Initial — 5 mission types, progress evaluation, trade alignment scoring, constraint enforcement.',
    capabilities: ['mission-planning', 'trade-alignment', 'strategic-goal-tracking'],
    dependencies: ['supervisor'],
    category: 'orchestration',
    priority: 3,
    tickIntervalMs: 30_000, // evaluates mission progress every 30s
  },
];
