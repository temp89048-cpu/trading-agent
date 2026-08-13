'use client';

import { createContext, useContext } from 'react';
import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { useOrderFlow } from './OrderFlow';
import { useMarketIntel } from './MarketIntel';
import { useEventDetection } from './EventDetection';
import { usePortfolio } from './Portfolio';
import { useDebate } from './Debate';
import { useMultiExchange } from './MultiExchange';
import { useTradingControls } from './TradingControls';
import { useExchangeAccounts } from './ExchangeAccounts';
import { useMissionPlanner } from './MissionPlanner';
import { buildStrategyContext } from '@/lib/strategyContext';
import { runStrategyEnsembleGated } from '@/lib/strategyEnsemble';
import { computeCorrelationMatrix } from '@/lib/portfolioIntelligence';
import { reviewTradeRequest, type SupervisorDecision, type SupervisorRequest } from '@/lib/supervisorAgent';
import { computeSentiment } from '@/lib/sentimentAgent';
import { checkCapability } from '@/lib/providerCapabilities';
import { readSSEStream } from '@/lib/sse';
import { buildCollaborationMessages, parseCollaborationResponse, type CollaborationRequestInput } from '@/lib/collaborationAgent';
import { buildClientOrderId, computeExecutionQuality, describeExecutionQuality, isDuplicateOrderError } from '@/lib/executionQuality';
import { uid } from '@/lib/storage';
import type { CorrelationInputs } from '@/lib/riskManager';
import type { DecisionOutcome, TradeTab, TradeSide, WatchItem, TradeLogEntry } from '@/lib/types';

// ---------------------------------------------------------------------
// The single execution gate for AI-agent-initiated trades (see
// lib/supervisorAgent.ts's header for exactly what's in vs. out of
// scope). Everything this provider needs to build a full
// SupervisorRequest — strategy context, correlation matrix, ensemble
// consensus, the latest Debate result, news, equity — it gathers
// itself from the other providers already in the tree, so callers only
// need to say WHAT they want to do, not rebuild all that context
// themselves. This also DRYs up correlation-matrix-building and
// strategy-context-lookup code that was previously duplicated between
// components/AppState.tsx and components/Agent.tsx.
// ---------------------------------------------------------------------

export type SupervisorExecuteParams = {
  symbol: string;
  side: TradeSide;
  tab: TradeTab;
  qty: number;
  price: number;
  originTag: NonNullable<TradeLogEntry['originTag']>;
  rationale?: string;
  requestedLeverage?: number;
  isStopOrTargetTriggered?: boolean; // Agent.tsx sets this true for TP/SL-triggered closes
  entryContext?: string; // pre-captured context snapshot, buys only
  debateId?: string;
  // A repeating caller (Agent.tsx's tick loop) re-evaluates the same
  // logical trade every tick until it actually executes. Without a
  // stable key, a buy stuck above the manual-approval threshold would
  // get queued again every tick, one PendingApproval per tick. Passing
  // the task's own id here lets TradingControls dedupe against an
  // already-queued entry instead. One-off callers (chat, manual,
  // Debate's "Act on this") can omit it — they're never retried.
  pendingApprovalKey?: string;
  // Stable identifier for this LOGICAL trade intent, used to build the
  // exchange idempotency key (see lib/executionQuality.ts). Must be the
  // same across retries of the same intended order and different for
  // genuinely different orders — e.g. `${taskId}-${legNumber}` for an
  // agent leg. When omitted, one is derived from the request's own
  // fields, which is still stable for a repeating caller re-proposing
  // the identical trade but does NOT distinguish two deliberately
  // identical orders — pass an explicit id when that matters.
  intentId?: string;
};

// executed=false with pendingApprovalId set means "not rejected — queued
// for manual approval," a distinct case from "rejected" or "executed
// failed" that every caller needs to handle separately (see
// components/AppState.tsx, components/Agent.tsx, components/DebatePanel.tsx).
//
// executed=false with realOrderSubmitted set means "a REAL exchange
// order was just submitted asynchronously" — placing a live order is
// network I/O (an HMAC-signed call to Binance/Bybit), which this
// synchronous function can't wait on without becoming async itself and
// rippling that through every caller (Agent.tsx's tick loop, chat
// completion handling, the Debate panel button). The actual fill is
// confirmed and ledgered (or logged as a failure to the audit trail)
// once the request resolves — see submitRealOrderAsync below.
export type SupervisorExecuteResult = { decision: SupervisorDecision; executed: boolean; pendingApprovalId?: string; realOrderSubmitted?: boolean };

type SupervisorValue = {
  reviewAndExecute: (params: SupervisorExecuteParams) => SupervisorExecuteResult;
  // Executes a request that already cleared the risk gate and just got
  // a human's manual approval (components/TradingControlsPanel.tsx's
  // Approve button) — routes to a real exchange order if one is
  // connected+preferred for this tab, same logic reviewAndExecute itself
  // uses, otherwise falls back to the plain ledger entry. Kept here
  // rather than duplicated in the approval UI so there's exactly one
  // place that decides "does this go to a real exchange."
  executeApprovedRequest: (params: { symbol: string; side: TradeSide; tab: TradeTab; qty: number; price: number; originTag: NonNullable<TradeLogEntry['originTag']>; entryContext?: string; debateId?: string; requestedLeverage?: number }) => void;
};

const SupervisorContext = createContext<SupervisorValue | null>(null);

export function useSupervisor(): SupervisorValue {
  const ctx = useContext(SupervisorContext);
  if (!ctx) throw new Error('useSupervisor must be used within SupervisorProvider');
  return ctx;
}

export function SupervisorProvider({ children }: { children: React.ReactNode }) {
  const { watchlist, ticks } = useMarketData();
  const { getCandles } = useCandles();
  const { getOrderFlow } = useOrderFlow();
  const { getNews, getFearGreed, getDerivatives } = useMarketIntel();
  const { getEvents } = useEventDetection();
  const { tradeLog, buyPaper, sellPaper, addRealPosition, removeRealPosition, getPortfolioSnapshot } = usePortfolio();
  const { getLatestDebate, runDebateSync } = useDebate();
  const { getSnapshot } = useMultiExchange();
  const {
    paused,
    manualApprovalThresholdUsd,
    realStartingCapitalUsd,
    riskConfig,
    addPendingApproval,
    secondOpinionConfigured,
    secondOpinionProviderObj,
    secondOpinionResolvedModel,
    secondOpinionResolvedApiKey,
    secondOpinionResolvedBaseUrl,
  } = useTradingControls();
  const { realTradingMode, preferredExchange, isConnected: isExchangeConnected, placeRealOrder, getRealOrderStatus } = useExchangeAccounts();
  const { getMissionAlignment } = useMissionPlanner();

  function getStrategyContextFor(item: WatchItem) {
    const primary = getCandles(item.symbol, '1h');
    if (!primary || primary.candles.length === 0) return null;
    return buildStrategyContext(item, primary.candles, getCandles, getOrderFlow(item.symbol));
  }

  // Read via getPortfolioSnapshot() (a ref, not the React `portfolio`
  // state) rather than closing over React state directly — several
  // reviewAndExecute calls can run back-to-back within one synchronous
  // batch (e.g. Agent.tsx processing multiple tasks in one tick), and
  // `portfolio` state only reflects trades already committed as of the
  // last render, not ones executed earlier in the SAME batch. Using the
  // snapshot means the second trade's exposure/correlation check sees
  // the first trade's effect instead of stale pre-batch headroom.
  function paperEquityUsd(): number {
    const portfolio = getPortfolioSnapshot();
    return portfolio.paper.cash + portfolio.paper.positions.reduce((sum, p) => sum + p.qty * (ticks[p.symbol]?.price ?? p.avgCost), 0);
  }

  function paperExistingExposureUsd(): number {
    const portfolio = getPortfolioSnapshot();
    return portfolio.paper.positions.reduce((sum, p) => sum + p.qty * (ticks[p.symbol]?.price ?? p.avgCost), 0);
  }

  // The 'real' tab has no tracked cash balance the way paper does (it's
  // a manual ledger — see REAL_TRADING.md) — so equity here is
  // reconstructed from the user-declared starting capital plus realized
  // P&L on closed real trades plus unrealized P&L on currently open
  // real positions, rather than read off a cash field that doesn't
  // exist. Returns null (same as before this feature existed) when no
  // starting capital has been declared.
  function realEquityUsd(): number | null {
    if (realStartingCapitalUsd === null) return null;
    const portfolio = getPortfolioSnapshot();
    const realizedPnl = tradeLog.filter((t) => t.tab === 'real' && typeof t.pnl === 'number').reduce((sum, t) => sum + (t.pnl as number), 0);
    const unrealizedPnl = portfolio.real.positions.reduce((sum, p) => sum + p.qty * ((ticks[p.symbol]?.price ?? p.avgCost) - p.avgCost), 0);
    return realStartingCapitalUsd + realizedPnl + unrealizedPnl;
  }

  function realExistingExposureUsd(): number {
    const portfolio = getPortfolioSnapshot();
    return portfolio.real.positions.reduce((sum, p) => sum + p.qty * (ticks[p.symbol]?.price ?? p.avgCost), 0);
  }

  function correlationInputsFor(symbol: string): CorrelationInputs {
    const portfolio = getPortfolioSnapshot();
    const priceHistories: Record<string, number[]> = {};
    for (const w of watchlist) {
      const c = getCandles(w.symbol, '1h');
      if (c && c.candles.length > 0) priceHistories[w.symbol] = c.candles.map((k) => k.c);
    }
    return {
      matrix: computeCorrelationMatrix(priceHistories),
      existingPositions: portfolio.paper.positions.filter((p) => p.symbol !== symbol).map((p) => ({ symbol: p.symbol, valueUsd: p.qty * (ticks[p.symbol]?.price ?? p.avgCost) })),
      equityUsd: paperEquityUsd(),
    };
  }

  // Complete Audit Trail (Production Readiness Review #9): every
  // Supervisor decision, not just executed trades — fire-and-forget,
  // same idiom as Portfolio.tsx's logTrade optimistic POST. A failed
  // POST (server unreachable) never blocks or fails the actual trade
  // decision — the audit trail is a record of what happened, not a gate
  // on whether it's allowed to happen.
  function logDecisionRecord(
    params: SupervisorExecuteParams,
    decision: SupervisorDecision,
    executed: boolean,
    pendingApprovalId: string | undefined,
    ensembleConsensus: { signal: string; confidencePct: number } | null,
    debateRecommendation: { recommendation: string; compositeConfidencePct: number } | null,
  ) {
    const outcome: DecisionOutcome = pendingApprovalId
      ? 'pending-approval'
      : !decision.approved
        ? 'rejected'
        : executed
          ? 'approved-executed'
          : 'approved-not-executed';
    const rv = decision.riskValidation;
    fetch('/api/decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: params.symbol,
        side: params.side,
        tab: params.tab,
        originTag: params.originTag,
        requestedQty: params.qty,
        requestedPrice: params.price,
        outcome,
        urgency: decision.urgency,
        rejectionReasons: decision.reasons,
        conflictNotes: decision.conflictNotes,
        cautionNotes: rv?.cautionNotes ?? [],
        riskChecks: rv ? Object.fromEntries(Object.entries(rv.checks).map(([k, v]) => [k, { ok: v.ok, status: v.status, detail: v.detail }])) : null,
        stopLoss: rv?.stopLossTakeProfit?.stopLoss ?? null,
        takeProfit: rv?.stopLossTakeProfit?.takeProfit ?? null,
        recommendedQty: rv?.recommendedSize?.qty ?? null,
        ensembleConsensus: ensembleConsensus?.signal ?? null,
        ensembleConfidencePct: ensembleConsensus?.confidencePct ?? null,
        debateRecommendation: debateRecommendation?.recommendation ?? null,
        debateConfidencePct: debateRecommendation?.compositeConfidencePct ?? null,
        rationale: params.rationale,
      }),
    }).catch(() => {
      // Audit logging is best-effort — never surfaced to the user, never
      // retried. The trade decision itself already happened either way.
    });
  }

  // A second, follow-up audit record once a real exchange order actually
  // resolves — the synchronous logDecisionRecord call already wrote a
  // 'approved-not-executed' row the instant this was submitted (accurate:
  // risk-approved, not yet executed, because a live order was still in
  // flight). This appends the real outcome rather than editing that row —
  // decisions are append-only by design (see lib/decisionStore.server.ts).
  function logRealOrderFollowup(
    params: SupervisorExecuteParams,
    exchange: string,
    outcome: 'approved-executed' | 'rejected' | 'approved-not-executed',
    exchangeOrderId?: string,
    errorMsg?: string,
    // Execution-quality summary (slippage/latency/score) — appended to
    // the audit record so a bad fill is visible next to the decision that
    // caused it, not buried in a separate metrics surface.
    executionNote?: string,
  ) {
    fetch('/api/decisions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: params.symbol,
        side: params.side,
        tab: params.tab,
        originTag: params.originTag,
        requestedQty: params.qty,
        requestedPrice: params.price,
        outcome,
        urgency: 'critical', // a real-money order resolving (either way) always deserves visibility
        rejectionReasons: errorMsg ? [`Real ${exchange} order failed: ${errorMsg}`] : [],
        conflictNotes: [],
        riskChecks: null,
        stopLoss: null,
        takeProfit: null,
        recommendedQty: null,
        ensembleConsensus: null,
        ensembleConfidencePct: null,
        debateRecommendation: null,
        debateConfidencePct: null,
        rationale: [
          exchangeOrderId ? `Real ${exchange} order ${exchangeOrderId} confirmed.` : params.rationale,
          executionNote,
        ]
          .filter(Boolean)
          .join(' '),
        cautionNotes: executionNote ? [executionNote] : [],
      }),
    }).catch(() => {});
  }

  // Fire-and-forget: places a REAL order on the connected exchange, waits
  // for fill confirmation (polling order status once if the exchange
  // didn't return fills synchronously — Bybit's market-order response
  // doesn't, Binance's does), then ledgers the REAL fill price/qty (never
  // the app's own live tick price — the exchange's fill is the only
  // number that's actually true) or logs the failure to the audit trail
  // if the order was rejected. Never throws into the caller — this runs
  // detached from the synchronous reviewAndExecute call that kicked it off.
  async function submitRealOrderAsync(exchange: 'binance' | 'bybit', params: SupervisorExecuteParams) {
    // Deterministic idempotency key (spec Section 19). Derived from the
    // caller's stable intent id when supplied, otherwise from the
    // request's own defining fields — either way the SAME logical order
    // produces the SAME key, so the exchange itself rejects a duplicate
    // if a retry ever races a lost response.
    const intentId = params.intentId ?? `${params.tab}:${params.symbol}:${params.side}:${params.qty}:${params.price}`;
    const clientOrderId = buildClientOrderId(intentId);
    const submittedAtMs = Date.now();
    try {
      const result = await placeRealOrder(exchange, { symbol: params.symbol, side: params.side, qty: params.qty, clientOrderId });
      if (!result.ok) {
        // A duplicate-id rejection is NOT a failure — with a
        // deterministic key it proves our earlier attempt already
        // reached the exchange, so no duplicate was created. Reported as
        // such rather than as an error the operator needs to act on.
        if (isDuplicateOrderError(result.error)) {
          console.warn(`Real ${exchange} order for ${params.symbol} was already submitted (idempotency key ${clientOrderId}) — not retried, no duplicate created.`);
          logRealOrderFollowup(
            params,
            exchange,
            'approved-not-executed',
            undefined,
            `Duplicate suppressed by idempotency key ${clientOrderId} — a prior attempt for this same intent already reached the exchange. Verify the fill in the exchange's own order history.`,
          );
          return;
        }
        console.error(`Real ${exchange} order failed for ${params.symbol}:`, result.error);
        logRealOrderFollowup(params, exchange, 'rejected', undefined, result.error);
        return;
      }
      let avgFillPrice = result.avgFillPrice;
      let filledQty = result.filledQty;
      if (avgFillPrice === null || filledQty === null) {
        const status = await getRealOrderStatus(exchange, params.symbol, result.exchangeOrderId);
        if (status.ok) {
          avgFillPrice = status.avgFillPrice ?? avgFillPrice;
          filledQty = status.filledQty ?? filledQty;
        }
      }
      const fillPrice = avgFillPrice ?? params.price;
      const fillQty = filledQty ?? params.qty;
      if (params.side === 'buy') {
        addRealPosition(params.symbol, fillQty, fillPrice, params.entryContext, params.debateId, params.originTag, result.exchangeOrderId);
      } else {
        removeRealPosition(params.symbol, fillPrice, result.exchangeOrderId);
      }
      // Execution quality (spec Sections 19/22.4): measured against what
      // was REQUESTED, so a bad fill is distinguishable from a bad
      // signal. Written into the audit trail so the Evaluation layer and
      // any later review can see it — a losing trade that filled 0.8%
      // adverse is a different problem from one whose thesis was wrong.
      const quality = computeExecutionQuality({
        side: params.side,
        requestedPrice: params.price,
        fillPrice: avgFillPrice,
        filledQty,
        submittedAtMs,
        confirmedAtMs: Date.now(),
      });
      logRealOrderFollowup(
        params,
        exchange,
        'approved-executed',
        result.exchangeOrderId,
        undefined,
        `Execution quality — ${describeExecutionQuality(quality)}. ${quality.notes.join(' ')}`,
      );
    } catch (err) {
      console.error(`Real ${exchange} order threw for ${params.symbol}:`, err);
      logRealOrderFollowup(params, exchange, 'rejected', undefined, err instanceof Error ? err.message : 'unknown error');
    }
  }

  // Collaboration Protocol (Section 16) — fire-and-forget, same idiom as
  // submitRealOrderAsync above: a second model's response takes real
  // seconds, and the trade decision this was triggered by has already
  // been made (Debate + Ensemble + Risk, all already built) by the time
  // this resolves. It NEVER re-executes, cancels, or otherwise touches
  // the trade — the audit record it appends is the only effect. Never
  // throws into the caller.
  async function requestCollaborationOpinion(input: CollaborationRequestInput) {
    if (!secondOpinionProviderObj) return;
    const id = uid();
    let opinion = null;
    let error: string | null = null;
    try {
      const messages = buildCollaborationMessages(input);
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: secondOpinionResolvedApiKey,
          baseUrl: secondOpinionResolvedBaseUrl || undefined,
          model: secondOpinionResolvedModel,
          messages,
          temperature: 0.2,
          maxTokens: 250,
        }),
      });
      if (!res.ok || !res.body) throw new Error('second-opinion request failed');
      let content = '';
      await readSSEStream(res.body, (delta) => {
        content += delta;
      });
      opinion = parseCollaborationResponse(content.trim());
      if (!opinion) error = 'response did not follow the expected RECOMMENDATION/CONFIDENCE/REASONING format';
    } catch (err) {
      error = err instanceof Error ? err.message : 'unknown error';
    }
    fetch('/api/collaboration', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        symbol: input.symbol,
        side: input.side,
        ownConfidencePct: input.ownConfidencePct,
        triggerReason: input.conflicts.join('; '),
        provider: secondOpinionProviderObj.id,
        model: secondOpinionResolvedModel,
        opinion,
        error,
      }),
    }).catch(() => {});
  }

  // requestedLeverage is carried through here (rather than dropped) so the
  // margin actually locked by buyPaper matches the leverage the Supervisor
  // just validated against the ABSOLUTE_MAX_LEVERAGE ceiling. Omitting it
  // would silently book a 1x-margin position for a trade approved as
  // leveraged, understating locked capital in every downstream equity and
  // exposure calculation.
  function executeApprovedRequest(params: { symbol: string; side: TradeSide; tab: TradeTab; qty: number; price: number; originTag: NonNullable<TradeLogEntry['originTag']>; entryContext?: string; debateId?: string; requestedLeverage?: number }) {
    const targetExchange = params.tab === 'real' && preferredExchange && isExchangeConnected(preferredExchange) ? preferredExchange : null;
    if (targetExchange) {
      submitRealOrderAsync(targetExchange, params);
      return;
    }
    if (params.tab === 'paper') {
      buyPaper(params.symbol, params.qty, params.price, params.requestedLeverage, params.entryContext, params.debateId, params.originTag);
    } else {
      addRealPosition(params.symbol, params.qty, params.price, params.entryContext, params.debateId, params.originTag);
    }
  }

  function reviewAndExecute(params: SupervisorExecuteParams): SupervisorExecuteResult {
    const item: WatchItem = watchlist.find((w) => w.symbol === params.symbol) ?? { symbol: params.symbol, type: params.symbol.includes('/') ? 'crypto' : 'equity' };
    const ctx = getStrategyContextFor(item);

    // Ask another agent for help when this one doesn't already have a
    // recent opinion: previously, an AI-initiated BUY only ever
    // consulted the Debate System if a human happened to have clicked
    // "Run Debate" on this exact symbol within the last 10 minutes
    // (components/Debate.tsx's DEBATE_FRESHNESS_MS) — otherwise
    // debateRecommendation was just null and the Supervisor decided
    // alone. runFullDebate is a deterministic computation over data
    // already on hand (no LLM call, no network round-trip — see
    // lib/debate/moderator.ts's header comment), so there's no reason
    // the Supervisor can't just run it itself right here for every
    // autonomous buy that doesn't already have a fresh read, the same
    // way a trader would ask a colleague for a second opinion before
    // sizing up a position. Sells/closes never need this — closing risk
    // is never blocked regardless of what Debate says (see
    // lib/supervisorAgent.ts's resolveConflicts).
    let debate = getLatestDebate(params.symbol);
    if (!debate && params.side === 'buy' && ctx) {
      const primary = getCandles(params.symbol, '1h');
      if (primary && primary.candles.length > 0) {
        const cap = checkCapability(item, 'fundingRate');
        const derivatives = cap.supported ? getDerivatives(item.symbol) : undefined;
        const fearGreed = item.type === 'crypto' ? getFearGreed() : undefined;
        const sentiment = computeSentiment(item.symbol, getNews(), derivatives ?? null, fearGreed ?? null);
        const { id, result } = runDebateSync({ symbol: params.symbol, ctx, sentiment, liveCandles: primary.candles });
        debate = { id, result, ts: Date.now() };
      }
    }
    const debateRecommendation = debate
      ? {
          recommendation: debate.result.moderator.recommendation,
          compositeConfidencePct: debate.result.composite.compositeConfidence * 100,
          supportingEvidence: debate.result.moderator.supportingEvidence,
        }
      : null;
    // Link this trade to whichever debate backed the decision — a
    // caller-supplied one (e.g. the Debate panel's "Act on this") takes
    // priority; otherwise the auto-run above still lets the outcome
    // win/loss tracking in components/Debate.tsx apply to this trade too.
    if (!params.debateId && debate) params.debateId = debate.id;
    const ensemble = ctx ? runStrategyEnsembleGated(ctx, getSnapshot(params.symbol) ?? null) : null;
    const ensembleConsensus = ensemble ? { signal: ensemble.consensus, confidencePct: ensemble.confidencePct } : null;

    const request: SupervisorRequest = {
      symbol: params.symbol,
      side: params.side,
      tab: params.tab,
      qty: params.qty,
      ctx,
      equityUsd: params.tab === 'paper' ? paperEquityUsd() : realEquityUsd(),
      tradeLog,
      requestedLeverage: params.requestedLeverage,
      existingExposureUsd: params.tab === 'paper' ? paperExistingExposureUsd() : realExistingExposureUsd(),
      newsHeadlines: getNews(),
      correlationInputs: params.tab === 'paper' && params.side === 'buy' ? correlationInputsFor(params.symbol) : null,
      originTag: params.originTag,
      rationale: params.rationale,
      isClosingAction: params.side === 'sell',
      isStopOrTargetTriggered: params.isStopOrTargetTriggered,
      ensembleConsensus,
      debateRecommendation,
      riskConfig,
      realStartingEquityUsd: params.tab === 'real' ? realStartingCapitalUsd : null,
      // Same events that become caution notes below — passed in so they
      // also shift the Bayesian posterior, rather than only appearing as
      // prose the reader has to weigh themselves.
      eventNotes: getEvents(params.symbol).map((e) => ({ kind: e.kind, severity: e.severity })),
      // Phase 22: Mission alignment
      missionAlignment: getMissionAlignment({ symbol: params.symbol, side: params.side, qty: params.qty, price: params.price, leverage: params.requestedLeverage }),
    };

    const decision = reviewTradeRequest(request);

    // Event Detection (Level 16) previously only ever reached the chat
    // system prompt — a detected liquidation cascade or volatility
    // explosion never touched an autonomous decision at all, even
    // though the model reading it in chat context has no ability to
    // stop an agent-plan or signal-gated trade from executing. Surfaced
    // here as a caution note (never a rejection — these events "often
    // precede significant moves but are not trade signals on their
    // own," per lib/eventDetection.ts's own chat framing, so a real risk
    // check still has to be the thing that actually blocks something).
    if (params.side === 'buy') {
      for (const evt of getEvents(params.symbol)) {
        decision.cautionNotes.push(`Event Detection [${evt.severity.toUpperCase()}] ${evt.kind}: ${evt.detail}`);
      }
    }

    // Human-in-the-loop pause (Production Readiness Review #17): blocks
    // NEW buys only — never sells/closes, same "never block an exit"
    // principle applied everywhere else in this file. A paused buy is
    // treated exactly like a risk-rejected one by every caller (they all
    // already branch on `!decision.approved`), so no new call-site logic
    // is needed for this specific case.
    if (params.side === 'buy' && paused && decision.approved) {
      decision.approved = false;
      decision.reasons = [...decision.reasons, 'Trading is paused by the operator (Trading Controls) — no new positions until resumed.'];
    }

    // Collaboration Protocol (Section 16): ask a genuinely separate,
    // human-configured model for an independent read whenever this
    // decision's own internal signals were low-confidence or
    // conflicting — the exact trigger the spec names. Only for approved
    // buys (a rejected trade isn't about to risk anything, and closes
    // are never gated in this app regardless). Fire-and-forget — see
    // requestCollaborationOpinion's own comment for why it must never
    // delay this decision.
    if (params.side === 'buy' && decision.approved && secondOpinionConfigured) {
      const conflicts = [...decision.conflictNotes];
      const compositeConfidencePct = debateRecommendation?.compositeConfidencePct;
      if (compositeConfidencePct !== undefined && compositeConfidencePct < 55) {
        conflicts.push(`Debate composite confidence only ${compositeConfidencePct.toFixed(0)}%`);
      }
      if (conflicts.length > 0) {
        requestCollaborationOpinion({
          symbol: params.symbol,
          side: params.side,
          ownConfidencePct: compositeConfidencePct ?? 50,
          ownReasoning: decision.explainable?.reasonBullets?.map((b) => b.text) ?? [],
          conflicts,
        });
      }
    }

    let executed = false;
    let pendingApprovalId: string | undefined;
    let realOrderSubmitted = false;

    // A real trade only actually reaches a live exchange when an
    // exchange is configured AND connected AND selected as the preferred
    // one — otherwise 'real' tab keeps its original, pre-existing
    // behavior of a manual ledger entry (addRealPosition/removeRealPosition
    // with no exchange call). This is deliberate backward compatibility:
    // connecting an exchange is opt-in, not a silent behavior change for
    // anyone already using the real tab as a plain trade journal.
    const targetExchange = params.tab === 'real' && preferredExchange && isExchangeConnected(preferredExchange) ? preferredExchange : null;

    if (decision.approved) {
      if (params.side === 'buy') {
        const notionalUsd = params.qty * params.price;
        // Real Trading Mode (Manual) gates EVERY real buy regardless of
        // the approval-threshold amount — a deliberate operator-comfort
        // control distinct from (and layered on top of) the size-based
        // threshold below. Sells are never gated here, matching the
        // "never block an exit" principle applied everywhere else in
        // this file — that holds for real money too, arguably more so.
        const requiresManualApproval =
          (manualApprovalThresholdUsd !== null && notionalUsd > manualApprovalThresholdUsd) || (targetExchange !== null && realTradingMode === 'manual');

        if (requiresManualApproval) {
          // Large enough to require a human to click Approve — queue it
          // rather than auto-executing, even though it passed every risk
          // check. Dedup via pendingApprovalKey so a repeating caller
          // (Agent.tsx) re-checking the same still-queued request every
          // tick doesn't pile up duplicate entries.
          pendingApprovalId = addPendingApproval({
            dedupeKey: params.pendingApprovalKey,
            symbol: params.symbol,
            side: params.side,
            tab: params.tab,
            qty: params.qty,
            price: params.price,
            notionalUsd,
            originTag: params.originTag,
            rationale: params.rationale,
            requestedLeverage: params.requestedLeverage,
            entryContext: params.entryContext,
            debateId: params.debateId,
            decisionSummary:
              targetExchange && realTradingMode === 'manual'
                ? `Passed risk checks (${decision.urgency} urgency) — Real Trading Mode is set to Manual, so every real ${targetExchange} order needs your approval.`
                : `Passed risk checks (${decision.urgency} urgency)${decision.conflictNotes.length > 0 ? `, ${decision.conflictNotes.length} conflict note(s)` : ''} — exceeds the $${manualApprovalThresholdUsd?.toLocaleString()} manual-approval threshold ($${notionalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} notional).`,
          });
        } else if (targetExchange) {
          submitRealOrderAsync(targetExchange, params);
          realOrderSubmitted = true;
        } else {
          executed =
            params.tab === 'paper'
              ? buyPaper(params.symbol, params.qty, params.price, params.requestedLeverage, params.entryContext, params.debateId, params.originTag)
              : (addRealPosition(params.symbol, params.qty, params.price, params.entryContext, params.debateId, params.originTag), true);
        }
      } else {
        if (targetExchange) {
          submitRealOrderAsync(targetExchange, params);
          realOrderSubmitted = true;
        } else if (params.tab === 'paper') {
          executed = sellPaper(params.symbol, params.qty, params.price);
        } else {
          const had = getPortfolioSnapshot().real.positions.some((p) => p.symbol === params.symbol);
          removeRealPosition(params.symbol, params.price);
          executed = had;
        }
      }
    }

    logDecisionRecord(params, decision, executed, pendingApprovalId, ensembleConsensus, debateRecommendation);
    return { decision, executed, pendingApprovalId, realOrderSubmitted };
  }

  return <SupervisorContext.Provider value={{ reviewAndExecute, executeApprovedRequest }}>{children}</SupervisorContext.Provider>;
}
