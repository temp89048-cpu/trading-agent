import type { PlanCondition } from './plannerAgent';

export type Role = 'user' | 'assistant';

export type Message = {
  id: string;
  role: Role;
  content: string;
  ts: number;
};

export type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  createdAt: number;
  updatedAt: number;
};

export type ThemeId = 'amber' | 'cyan' | 'green' | 'magenta';

export type WatchItem = { symbol: string; type: 'crypto' | 'equity'; binance?: string };

export type TickSource = 'ws-live' | 'poll-live' | 'sim-fallback';

export type Tick = { price: number; prevClose: number | null; ts: number; source: TickSource };

export type McpServer = { id: string; name: string; url: string };

export type AgentMode = 'interval' | 'take-profit' | 'conditional-watch';
export type AgentStatus = 'running' | 'completed' | 'cancelled' | 'error';

// 'conditional-watch' mode only: which stage the plan is currently in.
// undefined is treated as 'trigger' (the initial stage) — see
// lib/agentEngine.ts. A leg closing (TP/SL hit) resets this back to
// 'trigger' for the next leg, same as currentEntryPrice/currentQty reset.
export type PlanStage = 'trigger' | 'watch';

export type AgentTask = {
  id: string;
  conversationId?: string;
  tab: TradeTab;
  symbol: string;
  side: TradeSide;
  marginUsd: number;
  leverage: number;
  totalTrades: number;
  executedTrades: number;
  mode: AgentMode;
  intervalMinutes?: number; // 'interval' mode
  tpPercent?: number; // 'take-profit' mode, and the close condition for 'conditional-watch' once a leg is open
  slPercent?: number; // optional, either mode
  // 'conditional-watch' mode (Commit 20 / Level 7): a two-stage plan —
  // "if triggerCondition, then watch for watchCondition, then enter."
  // watchCondition is optional; if omitted, triggerCondition firing IS
  // the entry signal (single-stage plan). See lib/plannerAgent.ts for
  // PlanCondition and how these get evaluated — never asked-for-from-
  // the-model-and-trusted, always a real indicator read.
  triggerCondition?: PlanCondition;
  watchCondition?: PlanCondition;
  planStage?: PlanStage;
  status: AgentStatus;
  createdAt: number;
  nextRunAt?: number; // 'interval' mode countdown
  currentEntryPrice?: number; // 'take-profit'/'conditional-watch' mode: entry of the currently-open leg
  currentQty?: number; // 'take-profit'/'conditional-watch' mode: qty of the currently-open leg
  realizedTotal: number; // running realized P&L across legs — this is the "new profit" that compounds into the next leg's size
  rationale?: string;
  errorMessage?: string;

  // --- Advanced enhancements — all purely additive/optional; omitting
  // every field below reproduces the exact original fixed TP/SL
  // behavior. See lib/agentEngine.ts's checkOpenLegTick for how these
  // combine (trailing stop / scale-out / breakeven / ATR stops all
  // apply to the SAME open leg, whichever condition fires first wins).

  // Trailing stop-loss: once a leg is open, the effective stop rides
  // trailingStopPercent behind the best (most favorable) price seen
  // since entry, instead of staying fixed relative to entry.
  // currentPeakPrice tracks that best price and is reset whenever a new
  // leg opens; undefined while no leg is open.
  trailingStopPercent?: number;
  currentPeakPrice?: number;

  // Partial take-profit / scale-out: an ordered list of (percent move,
  // fraction of the leg's ORIGINAL entry qty to close) levels. Each
  // level fires at most once per leg (scaledOutLevels records which
  // indices already fired). The first level to fire also arms
  // breakEvenArmed, moving the effective floor to entry price so the
  // remaining runner can't turn what was a winning trade into a loss.
  scaleOutLevels?: { tpPercent: number; closeFraction: number }[];
  scaledOutLevels?: number[];
  breakEvenArmed?: boolean;

  // Volatility-adaptive TP/SL: when true, tpPercent/slPercent are
  // ignored in favor of ATR-derived distances (current ATR, expressed
  // as a % of price, × these multipliers) recomputed from live candles
  // every tick by the caller (components/Agent.tsx) — agentTick itself
  // stays pure and just receives the resulting percent thresholds.
  useAtrStops?: boolean;
  atrMultiplierTp?: number; // default 2 if useAtrStops is true and unset
  atrMultiplierSl?: number; // default 1 if useAtrStops is true and unset

  // Signal-gated entries: an 'open' decision from agentTick is NOT
  // executed until the Strategy Ensemble and/or Debate System actually
  // agree with task.side above these confidence floors — checked by the
  // caller (components/Agent.tsx), since agentTick has no ensemble/
  // debate access and stays pure. Neither present = no gate (old
  // behavior: open fires as soon as agentTick says to).
  requireSignalConfirmation?: boolean;
  minEnsembleConfidencePct?: number; // default 55 if requireSignalConfirmation is true and unset
  minDebateConfidencePct?: number; // only enforced when a Debate result actually exists for the symbol
};

export type AgentEventKind = 'opened' | 'closed' | 'completed' | 'cancelled' | 'error' | 'staged';

export type AgentEvent = {
  id: string;
  ts: number;
  agentId: string;
  conversationId?: string;
  kind: AgentEventKind;
  message: string; // human-readable, ready to post into chat as-is
};

export type Position = { symbol: string; qty: number; avgCost: number };

export type PortfolioState = {
  paper: { cash: number; positions: Position[] };
  real: { positions: Position[] };
};

export const DEFAULT_PORTFOLIO: PortfolioState = {
  paper: { cash: 25000, positions: [] },
  real: { positions: [] },
};

export type TradeSide = 'buy' | 'sell';
export type TradeTab = 'paper' | 'real';

export type TradeLogEntry = {
  id: string;
  ts: number;
  tab: TradeTab;
  symbol: string;
  side: TradeSide;
  qty: number;
  price: number;
  note?: string;
  pnl?: number; // realized profit/loss for this entry, when it closes/reduces a position
  // Compact indicator/structure snapshot captured at the moment a 'buy'
  // entry was placed (see lib/reflectionAgent.ts). Only ever set on buy
  // rows, by whichever caller had indicator access at the time (AppState
  // or Agent) — Portfolio.tsx itself has no candle access, so it can't
  // compute this; it just threads through whatever the caller supplies.
  // Absent on trades placed before this existed, or on imported/restored
  // logs — the reflection agent falls back honestly when it's missing.
  entryContext?: string;
  // Set on a buy row when the user acted on a live Debate System
  // recommendation (Commit 18) for this symbol — links the trade back
  // to that debate record so its outcome can feed confidence
  // calibration and agent reputation once this trade closes. Absent
  // when a trade wasn't placed via/near an active debate result.
  debateId?: string;
  // Commit 23: which path originated this BUY (never set on sell/close
  // rows — a close inherits its origin from the position it's closing,
  // reconstructed by lib/learningDashboard.ts's hold-time/position-
  // lifecycle matching, not re-tagged here). Deliberately coarse — the
  // Strategy Ensemble (Commit 12) is informational-only and never
  // auto-executes, so there is no real per-strategy-agent attribution
  // to report; this tags by ACTUAL origin instead of guessing one.
  // Absent on trades placed before this existed.
  originTag?: 'debate' | 'chat-trade-action' | 'agent-plan' | 'user-command' | 'manual-click';
  // Real Exchange Trading — set only when this row was actually filled
  // by a live Binance/Bybit order (see components/ExchangeAccounts.tsx,
  // components/Supervisor.tsx's submitRealOrderAsync), not the plain
  // real-tab manual ledger. Lets a real-tab row be traced back to the
  // exact exchange order that produced it.
  exchangeOrderId?: string;
};

export type Config = {
  provider: string; // Provider.id from lib/constants.ts
  model: string; // '' means "use provider default"
  temperature: number;
  maxTokens: number;
  theme: ThemeId;
  apiKeys: Record<string, string>; // keyed by provider id
  baseUrlOverride: string; // '' means "use provider default baseUrl"
};

export const DEFAULT_CONFIG: Config = {
  provider: 'nvidia',
  model: '',
  temperature: 0.2,
  maxTokens: 1536,
  theme: 'amber',
  apiKeys: {},
  baseUrlOverride: '',
};

// ---------------------------------------------------------------------
// Complete Audit Trail (Production Readiness Review #9) — one record per
// Supervisor review, APPROVED, REJECTED, or PENDING-APPROVAL alike, not
// just the ones that actually became a TradeLogEntry. This is the piece
// that was previously missing: a rejected/gated AI decision only ever
// flashed as a transient UI event (components/Agent.tsx's pushEvent,
// capped at 200 and never persisted) — reload the page and it's gone.
// Every field here is something the Supervisor already computed at
// decision time (lib/supervisorAgent.ts's SupervisorDecision) — this
// type just captures it for the record instead of letting it evaporate.
// ---------------------------------------------------------------------
export type DecisionOutcome = 'approved-executed' | 'approved-not-executed' | 'rejected' | 'pending-approval' | 'manually-approved' | 'manually-rejected';

export type DecisionRecord = {
  id: string;
  ts: number;
  symbol: string;
  side: TradeSide;
  tab: TradeTab;
  originTag: NonNullable<TradeLogEntry['originTag']>;
  requestedQty: number;
  requestedPrice: number;
  outcome: DecisionOutcome;
  urgency: string; // SupervisorUrgency, kept as string here to avoid a lib/supervisorAgent.ts -> lib/types.ts import cycle
  rejectionReasons: string[];
  conflictNotes: string[];
  cautionNotes: string[];
  // Individual risk checks by name (positionRisk, dailyLoss, drawdown,
  // liquidity, spread, leverage, portfolioExposure, correlation, news),
  // each { ok, status, detail } — the full evidence, not just the verdict.
  riskChecks: Record<string, { ok: boolean; status: string; detail: string }> | null;
  stopLoss: number | null;
  takeProfit: number | null;
  recommendedQty: number | null;
  ensembleConsensus: string | null; // 'BUY' | 'SELL' | 'HOLD', if computed
  ensembleConfidencePct: number | null;
  debateRecommendation: string | null;
  debateConfidencePct: number | null;
  rationale?: string;
  tradeLogEntryId?: string; // linked once/if this decision actually produced a logged trade
};

// ---------------------------------------------------------------------
// Human-in-the-Loop Controls (Production Readiness Review #17) — a
// trade queued because it exceeded the operator's manual-approval
// threshold. Stored client-side (components/TradingControls.tsx) since
// it's a live, in-session queue, not historical record-keeping (that's
// what DecisionRecord above is for — a pending approval also gets
// written there with outcome 'pending-approval' when queued, and
// 'manually-approved'/'manually-rejected' once resolved).
// ---------------------------------------------------------------------
export type PendingApproval = {
  id: string;
  dedupeKey?: string; // e.g. an AgentTask id, so a repeating tick loop re-checking the same still-queued request doesn't create duplicates
  createdAt: number;
  symbol: string;
  side: TradeSide;
  tab: TradeTab;
  qty: number;
  price: number;
  notionalUsd: number;
  originTag: NonNullable<TradeLogEntry['originTag']>;
  rationale?: string;
  requestedLeverage?: number;
  entryContext?: string;
  debateId?: string;
  decisionSummary: string; // one-line "why this passed risk checks" for display
};
