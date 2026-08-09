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
    contract: {
      purpose: 'Hold veto authority over every proposed trade, and compute the position size and stop/target it would need to be acceptable.',
      inputs: [
        'StrategyContext (price, ATR, structure, order flow), requested qty/leverage, equity baseline, trade log, tab',
        'Optional: news headlines, correlation inputs, operator RiskConfig overrides, declared real starting capital',
      ],
      outputs: [
        'RiskValidation: approved flag, 9 named check results, stop-loss/take-profit levels, recommended size, rejectionReasons, cautionNotes',
      ],
      // Notably does NOT include 'execute-trades'. The Risk Manager can
      // only ever say no; it has no path to an exchange.
      permissions: ['read-market-data', 'read-trade-log', 'read-portfolio', 'veto-trade'],
      memory: 'None. Every check is recomputed per request from the trade log and live context, so a stale cached limit can never govern a decision.',
      metrics: ['rejection rate per check', 'how often each check reads unavailable', 'Kelly-vs-fixed cap divergence'],
      failureRecovery:
        'Fails closed. A check whose inputs are missing returns an explicit "unavailable" status that is surfaced as a caution note rather than a silent pass — except the mandatory stop-loss, which hard-rejects when no stop is computable.',
      healthCheck: 'Pure function with no external dependencies; correctness is guarded by lib/riskManager.test.ts, including tests that specifically assert the leverage ceiling and mandatory-stop rules cannot be bypassed.',
      explainability:
        'Every check returns a human-readable detail string stating the actual numbers and the threshold breached. These propagate into the trade\'s explainability record and the audit trail.',
    },
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
    contract: {
      purpose: 'The single execution gate for every AI-initiated trade — nothing else may reach an exchange or ledger.',
      inputs: [
        'A trade proposal (symbol, side, tab, qty, price, originTag) from chat trade-actions, agent-plan ticks, the Debate panel, or the autonomous loop',
        'Strategy context, correlation matrix, ensemble consensus, Debate result, news, mission alignment, event detections — all gathered by the Supervisor itself, not by callers',
      ],
      outputs: [
        'SupervisorDecision (approved/rejected, urgency, reasons, conflictNotes, cautionNotes, ExplainableRecommendation)',
        'An append-only decision record to /api/decisions for every decision, executed or not',
      ],
      permissions: ['read-market-data', 'read-trade-log', 'read-portfolio', 'veto-trade', 'execute-trades', 'write-store'],
      memory: 'None of its own. Reads the trade log and portfolio snapshot per request; the decision store is append-only history, not state it consults.',
      metrics: ['approval/rejection rate', 'rejection reason distribution', 'urgency mix', 'conflict-note frequency'],
      failureRecovery:
        'Degrades to rejection, never to approval: a missing strategy context, an uncomputable stop-loss, or any failed risk check all reject rather than pass. A thrown error inside one caller\'s review does not affect others (see Agent.tsx\'s per-task try/catch).',
      healthCheck: 'Every decision writes an audit record — an absence of records while trades are being attempted indicates a failure. Rollup via assessSystemHealth().',
      explainability:
        'Every decision carries an ExplainableRecommendation with sourced reason bullets, plus explicit rejectionReasons/conflictNotes/cautionNotes. A rejection always states which rule was breached.',
    },
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
    contract: {
      purpose: 'Produce an honest post-mortem of every closed trade, so the system accumulates understanding of why outcomes happened.',
      inputs: ['A closed trade (entry/exit price, qty, realized P&L)', 'Entry-context and exit-context indicator/structure snapshots'],
      outputs: ['A ReflectionRecord with five parsed sections (WHY, FAILED_SIGNAL, EARLIER_EXIT, CONFIDENCE, LESSON) plus the raw model text and finishReason'],
      // 'call-llm' and 'write-store' but explicitly NOT propose-trade or
      // execute-trades. There is no code path from a reflection's text to
      // a trade action, by design.
      permissions: ['read-market-data', 'read-trade-log', 'call-llm', 'write-store'],
      memory: 'One record per closed trade, persisted indefinitely in .data/reflections.json. Upserted by tradeId, so a regenerate replaces rather than accumulates.',
      metrics: ['reflection coverage (% of closed trades with one)', 'parse success rate of the 5-section format', 'truncation rate (finishReason === length)'],
      failureRecovery:
        'Fails quietly and un-marks the trade as processed so a later retry can succeed — a missing advisory note is not treated as a permanent gap. A truncated response is surfaced as such rather than trusted as complete.',
      healthCheck: 'Coverage gap: closed trades with no reflection record after several minutes indicates the LLM path is failing (usually a missing API key).',
      explainability:
        'The output IS the explanation. The fixed five-section format exists so each dimension is separately extractable rather than buried in prose; an unparsed response falls back to showing raw text rather than claiming structure it does not have.',
    },
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
    contract: {
      purpose: 'Give the system a stated strategic goal so trades contribute to something, rather than being evaluated purely in isolation.',
      inputs: ['Active mission definition and constraints', 'Portfolio equity/positions, today\'s trade count'],
      outputs: ['MissionProgress (currentPct, status, detail)', 'MissionAlignmentResult (aligned/neutral/misaligned + reasons) per proposed trade'],
      // Advisory only. scoreMissionAlignment explicitly does not block.
      permissions: ['read-portfolio', 'read-trade-log', 'emit-signal', 'write-store'],
      memory: 'Missions and up to 100 progress checkpoints each, persisted in .data/missions.json.',
      metrics: ['progress-to-target %', 'alignment verdict distribution', 'mission completion/expiry rate'],
      failureRecovery: 'A mission that cannot be evaluated leaves its prior progress untouched rather than resetting it. Absence of an active mission is a normal state, not an error — the autonomous loop stands down and says so.',
      healthCheck: 'Progress lastEvaluatedAt should advance every 30s while a mission is active.',
      explainability: 'Both progress and alignment carry human-readable reason strings; alignment reasons are surfaced to the Supervisor as caution notes.',
    },
  },

  // ---- Autonomous operation + self-learning (this session) -----------
  //
  // These four existed as working modules before being registered here.
  // Registering them means they appear in the Agent OS panel and are
  // covered by contractCoverage() — an agent that can open positions
  // unprompted should not be invisible to the runtime inventory.

  {
    id: 'autonomous-trader',
    name: 'Autonomous Trader',
    version: '1.0.0',
    description: 'The "AI never sleeps" loop. Every 60s, ranks watchlist opportunities and — opt-in only — opens a position toward the active mission without being prompted. Routes every execution through the Supervisor.',
    changelog: 'v1.0.0: Initial — 60s cycle, opportunity ranking, mission-constrained sizing, full cycle journaling including no-trade decisions.',
    capabilities: ['opportunity-discovery', 'signal-generation'],
    dependencies: ['strategy-ensemble', 'debate', 'mission-planner', 'supervisor', 'event-detection'],
    category: 'execution',
    priority: 5,
    tickIntervalMs: 60_000,
    contract: {
      purpose: 'Decide, unprompted, whether any current market opportunity is worth acting on toward the active mission — and open it if so.',
      inputs: ['Full watchlist strategy contexts, ensemble consensus, Debate reads, event detections', 'Active mission + constraints, portfolio equity, operator config (enabled/tab/size/concurrency/cooldown)'],
      outputs: ['A new AgentTask via startAgent() when it acts', 'An AutonomousCycleRecord for EVERY cycle including no-trade ones, with the full ranked slate and stated reasons'],
      // Proposes, never executes: it calls startAgent(), and that task's
      // tick routes through the Supervisor like any other AI trade.
      permissions: ['read-market-data', 'read-portfolio', 'read-trade-log', 'propose-trade', 'write-store', 'human-gated'],
      memory: 'Its own config, last-trade timestamp, and the ids of tasks it created (localStorage). Cycle journal capped at 500 records in .data/autonomous-cycles.json.',
      metrics: ['cycles run', 'trade vs no-trade ratio', 'stand-down reason distribution', 'score of acted-on vs rejected candidates'],
      failureRecovery:
        'Every precondition failure records an explicit stand-down reason rather than failing silently. A thrown startAgent error is journaled as outcome=error. Disabled by default; switching to real money requires typing a confirmation phrase.',
      healthCheck: 'lastCycle timestamp should advance every 60s while enabled — a stale timestamp while enabled is the "bot went silent" case and is surfaced in the panel.',
      explainability:
        'Each cycle records the entire ranked candidate slate with per-candidate reasons AND blockers, so the decision is auditable against what it was chosen over — not just what was chosen.',
    },
  },
  {
    id: 'hypothesis',
    name: 'Hypothesis Agent',
    version: '1.0.0',
    description: 'Stage 2 of the self-learning pipeline: turns a reflection lesson into one specific, falsifiable claim plus a concrete way to test it. Cannot apply anything itself.',
    changelog: 'v1.0.0: Initial — CLAIM/TEST format, human-gated status workflow (proposed -> validated/rejected -> applied).',
    capabilities: ['post-trade-analysis'],
    dependencies: ['reflection'],
    category: 'learning',
    priority: 10,
    tickIntervalMs: 0, // on-demand — triggered once a reflection with a lesson exists
    contract: {
      purpose: 'Convert accumulated reflection lessons into testable claims, so learning produces something falsifiable rather than commentary.',
      inputs: ['A ReflectionRecord with a LESSON section'],
      outputs: ['A HypothesisRecord (claim, suggestedTest, status, reviewNote)'],
      // The critical boundary: human-gated, and NO write access to any
      // production strategy or risk config. Enforcing spec Section 12.
      permissions: ['read-trade-log', 'call-llm', 'write-store', 'human-gated'],
      memory: 'One hypothesis per trade, persisted in .data/hypotheses.json, upserted by tradeId.',
      metrics: ['hypotheses generated', 'validated vs rejected vs dismissed rate', 'how many reach applied'],
      failureRecovery: 'A response missing CLAIM or TEST is discarded rather than partially saved, and the trade is un-marked so a retry can succeed.',
      healthCheck: 'Reflections carrying a lesson but no hypothesis after several minutes indicates the LLM path is failing.',
      explainability: 'The claim and its suggested test ARE the output; status changes carry the human\'s own review note so the record shows who concluded what.',
    },
  },
  {
    id: 'curiosity',
    name: 'Curiosity Engine',
    version: '1.0.0',
    description: 'Asks four self-questions on an interval (what failed, what do I not understand, what contradicts my positions, has this happened before) answered only from real data — unanswerable questions return null rather than filler.',
    changelog: 'v1.0.0: Initial — 4 grounded findings with evidence and a suggested follow-up action each.',
    capabilities: ['opportunity-discovery'],
    dependencies: ['strategy-ensemble', 'market-structure'],
    category: 'learning',
    priority: 10,
    tickIntervalMs: 900_000, // computed alongside the 15-minute research digest
    contract: {
      purpose: 'Make the system notice its own knowledge gaps and internal contradictions, instead of only reacting to price.',
      inputs: ['Trade log', 'Per-symbol ensemble consensus vs market-structure trend', 'Open positions'],
      outputs: ['A CuriosityDigest of findings, each with question, answer (or null), real evidence, and a suggested action'],
      permissions: ['read-market-data', 'read-trade-log', 'read-portfolio', 'emit-signal'],
      memory: 'Latest digest only, held in memory — not persisted, since it is fully recomputable from current data.',
      metrics: ['answerable vs unanswerable question ratio', 'actionable finding count', 'suggested-action distribution'],
      failureRecovery: 'Pure computation; a symbol lacking data is excluded from inputs rather than guessed at, so "nothing to say" stays distinguishable from "nothing is wrong".',
      healthCheck: 'Digest timestamp should advance every 15 minutes.',
      explainability: 'Every finding carries the concrete data points behind it; a question with no supporting data is explicitly rendered as unanswerable rather than answered.',
    },
  },
  {
    id: 'collaboration',
    name: 'Collaboration Protocol',
    version: '1.0.0',
    description: 'Requests an independent read from a separately-configured second model when the Supervisor\'s own signals are low-confidence or conflicting. Fire-and-forget; never delays or overrides a decision.',
    changelog: 'v1.0.0: Initial — separate provider/model slot, structured request, audit-recorded response.',
    capabilities: ['cross-exchange'], // nearest existing capability tag; a dedicated one would need an AgentCapability addition
    dependencies: ['supervisor'],
    category: 'orchestration',
    priority: 9,
    tickIntervalMs: 0, // on-demand — triggered by low confidence or conflict
    contract: {
      purpose: 'Get a genuinely independent second opinion when internal evidence conflicts, without ever letting that opinion bypass the risk layer.',
      inputs: ['Symbol, side, own confidence, own reason bullets, and what specifically conflicted'],
      outputs: ['A CollaborationRecord with the parsed {recommendation, confidencePct, reasoning} or an explicit error'],
      permissions: ['call-llm', 'write-store'],
      memory: 'Append-only request/response history in .data/collaboration.json.',
      metrics: ['requests made', 'agreement vs disagreement with the internal decision', 'parse failure rate', 'response latency'],
      failureRecovery:
        'Fire-and-forget by design — a slow or failed second model can never delay or block the trade decision that triggered it. Failures are recorded with the error rather than dropped.',
      healthCheck: 'No-ops entirely when no second-opinion model is configured, and says so rather than appearing broken.',
      explainability: 'The record stores the request context, the provider/model asked, and the verbatim parsed opinion, so a later reader knows exactly who said what and why it was asked.',
    },
  },
];
