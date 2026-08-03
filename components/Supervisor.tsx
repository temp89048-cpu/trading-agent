'use client';

import { createContext, useContext } from 'react';
import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { useOrderFlow } from './OrderFlow';
import { useMarketIntel } from './MarketIntel';
import { usePortfolio } from './Portfolio';
import { useDebate } from './Debate';
import { useMultiExchange } from './MultiExchange';
import { useTradingControls } from './TradingControls';
import { useExchangeAccounts } from './ExchangeAccounts';
import { buildStrategyContext } from '@/lib/strategyContext';
import { runStrategyEnsemble } from '@/lib/strategyEnsemble';
import { computeCorrelationMatrix } from '@/lib/portfolioIntelligence';
import { reviewTradeRequest, type SupervisorDecision, type SupervisorRequest } from '@/lib/supervisorAgent';
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
  executeApprovedRequest: (params: { symbol: string; side: TradeSide; tab: TradeTab; qty: number; price: number; originTag: NonNullable<TradeLogEntry['originTag']>; entryContext?: string; debateId?: string }) => void;
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
  const { getNews } = useMarketIntel();
  const { tradeLog, buyPaper, sellPaper, addRealPosition, removeRealPosition, getPortfolioSnapshot } = usePortfolio();
  const { getLatestDebate } = useDebate();
  const { getSnapshot } = useMultiExchange();
  const { paused, manualApprovalThresholdUsd, riskConfig, addPendingApproval } = useTradingControls();
  const { realTradingMode, preferredExchange, isConnected: isExchangeConnected, placeRealOrder, getRealOrderStatus } = useExchangeAccounts();

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
  function logRealOrderFollowup(params: SupervisorExecuteParams, exchange: string, outcome: 'approved-executed' | 'rejected', exchangeOrderId?: string, errorMsg?: string) {
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
        cautionNotes: [],
        riskChecks: null,
        stopLoss: null,
        takeProfit: null,
        recommendedQty: null,
        ensembleConsensus: null,
        ensembleConfidencePct: null,
        debateRecommendation: null,
        debateConfidencePct: null,
        rationale: exchangeOrderId ? `Real ${exchange} order ${exchangeOrderId} confirmed.` : params.rationale,
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
    try {
      const result = await placeRealOrder(exchange, { symbol: params.symbol, side: params.side, qty: params.qty });
      if (!result.ok) {
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
      logRealOrderFollowup(params, exchange, 'approved-executed', result.exchangeOrderId);
    } catch (err) {
      console.error(`Real ${exchange} order threw for ${params.symbol}:`, err);
      logRealOrderFollowup(params, exchange, 'rejected', undefined, err instanceof Error ? err.message : 'unknown error');
    }
  }

  function executeApprovedRequest(params: { symbol: string; side: TradeSide; tab: TradeTab; qty: number; price: number; originTag: NonNullable<TradeLogEntry['originTag']>; entryContext?: string; debateId?: string }) {
    const targetExchange = params.tab === 'real' && preferredExchange && isExchangeConnected(preferredExchange) ? preferredExchange : null;
    if (targetExchange) {
      submitRealOrderAsync(targetExchange, params);
      return;
    }
    if (params.tab === 'paper') {
      buyPaper(params.symbol, params.qty, params.price, params.entryContext, params.debateId, params.originTag);
    } else {
      addRealPosition(params.symbol, params.qty, params.price, params.entryContext, params.debateId, params.originTag);
    }
  }

  function reviewAndExecute(params: SupervisorExecuteParams): SupervisorExecuteResult {
    const item: WatchItem = watchlist.find((w) => w.symbol === params.symbol) ?? { symbol: params.symbol, type: params.symbol.includes('/') ? 'crypto' : 'equity' };
    const ctx = getStrategyContextFor(item);

    const debate = getLatestDebate(params.symbol);
    const debateRecommendation = debate
      ? {
          recommendation: debate.result.moderator.recommendation,
          compositeConfidencePct: debate.result.composite.compositeConfidence * 100,
          supportingEvidence: debate.result.moderator.supportingEvidence,
        }
      : null;
    const ensemble = ctx ? runStrategyEnsemble(ctx, getSnapshot(params.symbol) ?? null) : null;
    const ensembleConsensus = ensemble ? { signal: ensemble.consensus, confidencePct: ensemble.confidencePct } : null;

    const request: SupervisorRequest = {
      symbol: params.symbol,
      side: params.side,
      tab: params.tab,
      qty: params.qty,
      ctx,
      equityUsd: params.tab === 'paper' ? paperEquityUsd() : null,
      tradeLog,
      requestedLeverage: params.requestedLeverage,
      existingExposureUsd: params.tab === 'paper' ? paperExistingExposureUsd() : null,
      newsHeadlines: getNews(),
      correlationInputs: params.tab === 'paper' && params.side === 'buy' ? correlationInputsFor(params.symbol) : null,
      originTag: params.originTag,
      rationale: params.rationale,
      isClosingAction: params.side === 'sell',
      isStopOrTargetTriggered: params.isStopOrTargetTriggered,
      ensembleConsensus,
      debateRecommendation,
      riskConfig,
    };

    const decision = reviewTradeRequest(request);

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
              ? buyPaper(params.symbol, params.qty, params.price, params.entryContext, params.debateId, params.originTag)
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
