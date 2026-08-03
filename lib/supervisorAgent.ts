import type { StrategyContext } from './strategyContext';
import type { TradeLogEntry, TradeTab } from './types';
import { validateTrade, computeStopLossTakeProfit, type RiskValidation, type CorrelationInputs, type RiskConfig } from './riskManager';
import type { NewsItem } from './sentimentAgent';
import { runTradeSimulation } from './simulation';
import { buildExplainableRecommendation, sourced, unavailable, type ExplainableRecommendation, type ReasonBullet } from './explainableOutput';

// ---------------------------------------------------------------------
// Supervisor Agent (Level 19) — the orchestration layer.
//
// Scope, stated plainly: "no individual agent should execute trades
// directly" means AI-AGENT-initiated execution — the autonomous Agent
// scheduler (Commit 20), the chat trade-action path the model emits
// (Commit 12+), and the Debate System's "Act on this" convenience
// button (Commit 18). Those three now route through
// reviewTradeRequest() below via components/Supervisor.tsx, the single
// client-side execution gate, instead of each calling buyPaper/sellPaper
// with their own ad hoc (or, in the Debate panel's case, previously
// NONEXISTENT) risk checks.
//
// Deliberately OUT of scope: a human typing "@papertrade buy SOL 10" or
// clicking the manual Buy button in the Paper Trade panel. That's the
// operator directly exercising their own agency, not an agent deciding
// anything — this app has never gated direct manual actions behind the
// risk system (Commit 13 scoped its wiring to AI-decision paths on
// purpose), and Commit 24 doesn't change that. Supervising agents means
// supervising agents, not overriding the person running the terminal.
//
// Responsibilities, and where each one actually lives:
// - "Coordinate all specialized agents" -> this function is the one
//   place that pulls together Risk Manager (13), Portfolio Intelligence
//   correlation (21), Simulation (20), and optionally Strategy Ensemble
//   (12) / Debate (18) signals into one decision.
// - "Resolve disagreements" -> see CONFLICT RESOLUTION below. A real,
//   stated, two-tier rule — not a vague "uses judgment."
// - "Prioritize tasks based on urgency" -> classifyUrgency() below feeds
//   a real consumer: components/Agent.tsx's tick loop now computes every
//   running task's pending action BEFORE executing any of them, orders
//   closes/exits ahead of new opens (closes are always 'critical' by
//   this same urgency logic), and only then runs each one's Supervisor
//   review/execution in that order — so a close freeing up cash/
//   exposure in a given tick is actually available to an open evaluated
//   later in that same tick, not just a label nothing reads.
// - "Approve or reject trades after reviewing all evidence" -> the
//   actual return value of reviewTradeRequest().
// - "Monitor system health and recover from failures" -> assessSystemHealth()
//   below aggregates signals from real active checks, not just a passive
//   readout: candle feeds are checked for presence, last-fetch error, AND
//   staleness (components/SystemHealthPanel.tsx), MCP servers are
//   auto-rechecked on an interval rather than only on manual click
//   (components/Mcp.tsx), and app/api/health/route.ts independently
//   exercises the trade store and Binance reachability server-side. Still
//   not full production infrastructure (no external uptime pinger against
//   this app's own process, no alerting/paging) — that remains out of
//   scope for a single-process app. "Recover from failures" otherwise
//   happens throughout this app at the point of failure (news provider
//   fallback, partial multi-exchange tolerance, graceful "unavailable"
//   checks, and the background candle-refresh loop's own auto-retry on
//   error) — the Supervisor surfaces that state, it doesn't reimplement
//   each module's recovery.
// - "Produce the final explanation shown to the user" -> every decision
//   carries an ExplainableRecommendation (Commit 23), approved or not.
// ---------------------------------------------------------------------

export type SupervisorUrgency = 'low' | 'normal' | 'high' | 'critical';

export type SupervisorRequest = {
  symbol: string;
  side: 'buy' | 'sell';
  tab: TradeTab;
  qty: number;
  ctx: StrategyContext | null;
  equityUsd: number | null;
  tradeLog: TradeLogEntry[];
  requestedLeverage?: number;
  existingExposureUsd?: number | null;
  newsHeadlines?: NewsItem[];
  correlationInputs?: CorrelationInputs | null;
  originTag: NonNullable<TradeLogEntry['originTag']>;
  rationale?: string;
  // A sell that reduces/closes an existing position. Closing risk is
  // never blocked (see below) — this flag just affects urgency and the
  // explanation text, not the approval outcome.
  isClosingAction?: boolean;
  // True when this specific close was triggered by a stop-loss or
  // take-profit level being hit (Agent.tsx's tick loop knows this;
  // manual/chat closes don't set it) — bumps urgency to 'critical' so a
  // batch of pending Supervisor actions surfaces these first.
  isStopOrTargetTriggered?: boolean;
  // Cross-agent signals, both optional — a request can be reviewed with
  // neither (falls back to Risk Manager only) or either/both.
  ensembleConsensus?: { signal: 'BUY' | 'SELL' | 'HOLD'; confidencePct: number } | null;
  debateRecommendation?: { recommendation: 'BUY' | 'SELL' | 'HOLD'; compositeConfidencePct: number; supportingEvidence: string[] } | null;
  // Human-in-the-loop configurable risk limits (Production Readiness
  // Review #17) — merged over DEFAULT_RISK_CONFIG inside validateTrade.
  riskConfig?: Partial<RiskConfig>;
};

export type SupervisorDecision = {
  approved: boolean;
  urgency: SupervisorUrgency;
  reasons: string[]; // rejection reasons — empty when approved
  conflictNotes: string[]; // disagreements surfaced regardless of approval
  explainable: ExplainableRecommendation | null;
  riskValidation: RiskValidation | null;
};

// ---------------------------------------------------------------------
// Conflict resolution — a real, two-tier rule, not vague "judgment":
//
// TIER 1 (can BLOCK): the Debate System (Commit 18) is the most
// rigorous signal this app produces — seven independent agents,
// empirical confidence calibration, composite adjustment. If it ran for
// this exact symbol and came back with a HIGH-CONFIDENCE recommendation
// that directly contradicts the requested side (BUY requested while
// Debate says SELL with >=60% composite confidence, or vice versa), the
// Supervisor rejects the buy outright. This never blocks a SELL/close —
// closing risk is never blocked, full stop (see below).
//
// TIER 2 (can only CAUTION, never block): the Strategy Ensemble
// (Commit 12) is explicitly informational-only per its own design — it
// was never meant to have execution authority, and giving it blocking
// power here would contradict that established scoping. A disagreeing
// ensemble consensus is surfaced as a conflictNote so the explanation
// is honest about it, but it never rejects a request by itself.
// ---------------------------------------------------------------------
const DEBATE_BLOCK_CONFIDENCE_PCT = 60;

function resolveConflicts(request: SupervisorRequest): { conflictNotes: string[]; blockedByDebate: string | null } {
  const conflictNotes: string[] = [];
  let blockedByDebate: string | null = null;

  if (request.side === 'buy' && request.debateRecommendation) {
    const d = request.debateRecommendation;
    if (d.recommendation === 'SELL' && d.compositeConfidencePct >= DEBATE_BLOCK_CONFIDENCE_PCT) {
      blockedByDebate = `Debate System recommends SELL at ${d.compositeConfidencePct.toFixed(0)}% composite confidence — directly conflicts with this BUY request. Run a fresh Debate (conditions may have changed) before proceeding, or act via a path that doesn't route through the Supervisor if you're certain this is stale.`;
    } else if (d.recommendation !== 'BUY') {
      conflictNotes.push(`Debate System's last read on ${request.symbol} was ${d.recommendation} (${d.compositeConfidencePct.toFixed(0)}% confidence), not BUY — noted, not blocking (below the ${DEBATE_BLOCK_CONFIDENCE_PCT}% block threshold or a HOLD, not an opposing high-confidence call).`);
    }
  }
  if (request.side === 'sell' && request.debateRecommendation?.recommendation === 'BUY' && request.debateRecommendation.compositeConfidencePct >= DEBATE_BLOCK_CONFIDENCE_PCT && !request.isStopOrTargetTriggered) {
    conflictNotes.push(`Closing against an active Debate BUY thesis (${request.debateRecommendation.compositeConfidencePct.toFixed(0)}% confidence) — noted for the record. Closing/de-risking is never blocked by the Supervisor regardless.`);
  }

  if (request.ensembleConsensus && request.ensembleConsensus.signal !== 'HOLD') {
    const wantsBuy = request.side === 'buy';
    const ensembleAgrees = (wantsBuy && request.ensembleConsensus.signal === 'BUY') || (!wantsBuy && request.ensembleConsensus.signal === 'SELL');
    if (!ensembleAgrees) {
      conflictNotes.push(`Strategy Ensemble consensus is ${request.ensembleConsensus.signal} (${request.ensembleConsensus.confidencePct.toFixed(0)}%) — disagrees with this ${request.side}. The Ensemble is informational-only (Commit 12) and never blocks by itself.`);
    }
  }

  return { conflictNotes, blockedByDebate };
}

// ---------------------------------------------------------------------
// Urgency — used by callers (Agent.tsx's tick loop, in particular) to
// order a batch of pending Supervisor reviews when several tasks fire
// in the same tick: closes and rejections surface before routine opens.
// ---------------------------------------------------------------------
function classifyUrgency(request: SupervisorRequest, approved: boolean): SupervisorUrgency {
  if (request.isStopOrTargetTriggered) return 'critical';
  if (request.side === 'sell') return 'high'; // closes/de-risking always prioritized over new opens
  if (!approved) return 'critical'; // a blocked buy needs visibility — something stopped it
  return 'normal';
}

// ---------------------------------------------------------------------
// The main gate.
// ---------------------------------------------------------------------
export function reviewTradeRequest(request: SupervisorRequest): SupervisorDecision {
  const { conflictNotes, blockedByDebate } = resolveConflicts(request);

  // Closing/de-risking is NEVER blocked — same principle already
  // established throughout this app (sellPaper has never gone through
  // an opening-risk gate, because reducing exposure can't itself create
  // the kind of risk that gate exists to catch). The Supervisor's job
  // for a close is producing the explanation and urgency tag, not
  // approving/rejecting.
  if (request.side === 'sell') {
    const explainable = buildCloseExplainable(request, conflictNotes);
    return {
      approved: true,
      urgency: classifyUrgency(request, true),
      reasons: [],
      conflictNotes,
      explainable,
      riskValidation: null,
    };
  }

  if (blockedByDebate) {
    const explainable = request.ctx ? buildBuyExplainable(request, null, [{ text: blockedByDebate, source: 'Supervisor — Debate System conflict (Tier 1, blocking)' }]) : null;
    return {
      approved: false,
      urgency: 'critical',
      reasons: [blockedByDebate],
      conflictNotes,
      explainable,
      riskValidation: null,
    };
  }

  if (!request.ctx) {
    return {
      approved: false,
      urgency: 'critical',
      reasons: ['No strategy context available for this symbol yet (insufficient candle history) — the Supervisor cannot validate risk without it, so this is rejected rather than approved blind.'],
      conflictNotes,
      explainable: null,
      riskValidation: null,
    };
  }

  const riskValidation = validateTrade({
    ctx: request.ctx,
    side: 'buy',
    requestedQty: request.qty,
    equityUsd: request.equityUsd,
    tradeLog: request.tradeLog,
    tab: request.tab,
    requestedLeverage: request.requestedLeverage,
    existingExposureUsd: request.existingExposureUsd,
    newsHeadlines: request.newsHeadlines,
    correlationInputs: request.correlationInputs,
    riskConfig: request.riskConfig,
  });

  const conflictBullets: ReasonBullet[] = conflictNotes.map((text) => ({ text, source: 'Supervisor — cross-agent conflict check (Tier 2, non-blocking)' }));
  const explainable = buildBuyExplainable(request, riskValidation, conflictBullets);

  return {
    approved: riskValidation.approved,
    urgency: classifyUrgency(request, riskValidation.approved),
    reasons: riskValidation.rejectionReasons,
    conflictNotes,
    explainable,
    riskValidation,
  };
}

function buildBuyExplainable(request: SupervisorRequest, riskValidation: RiskValidation | null, conflictBullets: ReasonBullet[]): ExplainableRecommendation | null {
  if (!request.ctx) return null;
  const slTp = riskValidation?.stopLossTakeProfit ?? computeStopLossTakeProfit(request.ctx, 'buy');
  const sim = slTp && request.ctx.atrValue
    ? runTradeSimulation({ side: 'buy', entryPrice: request.ctx.price, stopLoss: slTp.stopLoss, takeProfit: slTp.takeProfit, atrValue: request.ctx.atrValue })
    : null;

  const reasonBullets: ReasonBullet[] = [];
  if (request.rationale) reasonBullets.push({ text: request.rationale, source: 'Caller-stated rationale (model, agent plan, or Debate System — see originTag)' });
  if (riskValidation) {
    for (const [name, check] of Object.entries(riskValidation.checks)) {
      if (check.status === 'reject') reasonBullets.push({ text: `${name}: ${check.detail}`, source: 'Risk Manager (Commit 13)' });
    }
    for (const note of riskValidation.cautionNotes) reasonBullets.push({ text: note, source: 'Risk Manager (Commit 13) — caution, not blocking' });
  }
  reasonBullets.push(...conflictBullets);
  if (reasonBullets.length === 0) reasonBullets.push({ text: 'All Risk Manager checks passed with no cross-agent conflicts.', source: 'Supervisor summary' });

  const probability = request.debateRecommendation
    ? sourced(request.debateRecommendation.compositeConfidencePct, 'Confidence Calibration + Composite (Commit 19, via Debate System)')
    : unavailable('no Debate run available for this request — see the Debate panel for a calibrated probability');

  return buildExplainableRecommendation({
    symbol: request.symbol,
    side: 'buy',
    reasonBullets,
    probability,
    expectedR: sim && !('error' in sim) ? sourced(sim.expectedValueR, 'Pre-Trade Simulation (Commit 20, Monte Carlo)') : unavailable('no ATR/SL-TP available to simulate against'),
    stopLoss: slTp ? sourced(slTp.stopLoss, 'Risk Manager (ATR + swing structure)') : unavailable('no ATR available yet to compute a dynamic stop'),
    takeProfit: slTp ? sourced(slTp.takeProfit, 'Risk Manager (ATR + swing structure)') : unavailable('no ATR available yet to compute a dynamic target'),
  });
}

function buildCloseExplainable(request: SupervisorRequest, conflictNotes: string[]): ExplainableRecommendation | null {
  const reasonBullets: ReasonBullet[] = [];
  if (request.isStopOrTargetTriggered) reasonBullets.push({ text: 'Triggered by a stop-loss or take-profit level being hit.', source: 'Agent Engine (Commit 20 tick loop)' });
  if (request.rationale) reasonBullets.push({ text: request.rationale, source: 'Caller-stated rationale' });
  for (const note of conflictNotes) reasonBullets.push({ text: note, source: 'Supervisor — cross-agent conflict check (informational only for closes)' });
  if (reasonBullets.length === 0) reasonBullets.push({ text: 'Closing/reducing an existing position — never blocked by the Supervisor.', source: 'Supervisor policy' });

  return buildExplainableRecommendation({
    symbol: request.symbol,
    side: 'sell',
    reasonBullets,
    probability: unavailable('not applicable to a closing action'),
    expectedR: unavailable('not applicable to a closing action'),
    stopLoss: unavailable('not applicable to a closing action'),
    takeProfit: unavailable('not applicable to a closing action'),
  });
}

// ---------------------------------------------------------------------
// System health — an honest ROLLUP of signals the caller already has,
// not new monitoring infrastructure. See module header.
// ---------------------------------------------------------------------
export type HealthSignal = { label: string; ok: boolean; detail: string };
export type SystemHealthReport = { overall: 'healthy' | 'degraded' | 'unhealthy'; signals: HealthSignal[] };

export function assessSystemHealth(signals: HealthSignal[]): SystemHealthReport {
  if (signals.length === 0) return { overall: 'healthy', signals: [] };
  const failing = signals.filter((s) => !s.ok).length;
  const overall: SystemHealthReport['overall'] = failing === 0 ? 'healthy' : failing <= signals.length / 2 ? 'degraded' : 'unhealthy';
  return { overall, signals };
}
