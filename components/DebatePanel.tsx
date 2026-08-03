'use client';

import { useMemo, useState } from 'react';
import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { useOrderFlow } from './OrderFlow';
import { useMarketIntel } from './MarketIntel';
import { usePortfolio } from './Portfolio';
import { useDebate } from './Debate';
import { buildStrategyContext, type StrategyContext } from '@/lib/strategyContext';
import { computeSentiment } from '@/lib/sentimentAgent';
import { checkCapability } from '@/lib/providerCapabilities';
import { captureContextSnapshot } from '@/lib/reflectionAgent';
import { computeStopLossTakeProfit } from '@/lib/riskManager';
import { runTradeSimulation, type SimulationResult } from '@/lib/simulation';
import { buildExplainableRecommendation, sourced, unavailable, type ExplainableRecommendation } from '@/lib/explainableOutput';
import { ExplainableRecommendationCard } from './ExplainableRecommendationCard';
import { useSupervisor } from './Supervisor';
import type { SupervisorDecision } from '@/lib/supervisorAgent';
import type { FullDebateResult } from '@/lib/debate/runDebate';

const RECOMMENDATION_COLOR: Record<string, string> = { BUY: 'text-green', SELL: 'text-red', HOLD: 'text-txt2' };

export function DebatePanel() {
  const { watchlist, ticks } = useMarketData();
  const { getCandles } = useCandles();
  const { getOrderFlow } = useOrderFlow();
  const { getNews, getFearGreed, getDerivatives } = useMarketIntel();
  const { portfolio } = usePortfolio();
  const { runDebate, getLatestDebate } = useDebate();
  const { reviewAndExecute } = useSupervisor();

  const [symbol, setSymbol] = useState(watchlist[0]?.symbol ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bought, setBought] = useState(false);
  const [pendingApprovalId, setPendingApprovalId] = useState<string | null>(null);
  const [lastDecision, setLastDecision] = useState<SupervisorDecision | null>(null);
  // Kept alongside the debate result purely to feed the pre-trade
  // simulation below (needs price/ATR/structure) — the debate result
  // itself doesn't carry the full StrategyContext forward.
  const [lastCtx, setLastCtx] = useState<StrategyContext | null>(null);

  const item = watchlist.find((w) => w.symbol === symbol) ?? watchlist[0];
  const latest = symbol ? getLatestDebate(symbol) : undefined;

  async function run() {
    if (!item) return;
    setLoading(true);
    setError(null);
    setBought(false);
    setPendingApprovalId(null);
    try {
      const primary = getCandles(item.symbol, '1h');
      if (!primary || primary.candles.length === 0) {
        setError('No candle data loaded for this symbol yet.');
        return;
      }
      const ctx = buildStrategyContext(item, primary.candles, getCandles, getOrderFlow(item.symbol));
      if (!ctx) {
        setError('Not enough candle history yet to build a strategy context.');
        return;
      }
      const news = getNews();
      const cap = checkCapability(item, 'fundingRate');
      const derivatives = cap.supported ? getDerivatives(item.symbol) : undefined;
      const fearGreed = item.type === 'crypto' ? getFearGreed() : undefined;
      const sentiment = computeSentiment(item.symbol, news, derivatives ?? null, fearGreed ?? null);

      await runDebate({ symbol: item.symbol, ctx, sentiment, liveCandles: primary.candles });
      setLastCtx(ctx);
    } catch {
      setError('Debate run failed — check candle/order-flow data is loaded for this symbol.');
    } finally {
      setLoading(false);
    }
  }

  // Pre-trade stress test (Commit 20 / Level 18): only meaningful for a
  // BUY/SELL recommendation on the symbol the ctx snapshot actually
  // belongs to — recomputed only when the debate result or ctx changes,
  // not on every render. Feeds into, never bypasses, the risk gate: this
  // is purely informational, shown ahead of "Act on this."
  const simulation: SimulationResult | { error: string } | null = useMemo(() => {
    if (!latest || !lastCtx || lastCtx.symbol !== item?.symbol) return null;
    const rec = latest.result.moderator.recommendation;
    if (rec !== 'BUY' && rec !== 'SELL') return null;
    const side = rec === 'BUY' ? 'buy' : 'sell';
    const slTp = computeStopLossTakeProfit(lastCtx, side);
    if (!slTp || lastCtx.atrValue === null) return null;
    return runTradeSimulation({
      side,
      entryPrice: lastCtx.price,
      stopLoss: slTp.stopLoss,
      takeProfit: slTp.takeProfit,
      atrValue: lastCtx.atrValue,
    });
  }, [latest, lastCtx, item?.symbol]);

  // Explainable Output Schema (Level 15): every field below is sourced
  // from a real upstream module, never asked-for-from-the-model. SL/TP
  // come from the same Risk Manager computation the simulation above
  // uses; probability comes from Commit 19's calibration+composite
  // pipeline (empirical, not the model's self-reported confidence);
  // expected value comes from the Commit 20 simulation.
  const explainableRec: ExplainableRecommendation | null = useMemo(() => {
    if (!latest || !lastCtx || lastCtx.symbol !== item?.symbol) return null;
    const rec = latest.result.moderator.recommendation;
    if (rec !== 'BUY' && rec !== 'SELL') return null;
    const side = rec === 'BUY' ? 'buy' : 'sell';
    const slTp = computeStopLossTakeProfit(lastCtx, side);

    const reasonBullets = [
      ...latest.result.moderator.supportingEvidence.slice(0, 3).map((text) => ({ text, source: 'Debate Moderator — supporting evidence' })),
      ...latest.result.composite.breakdown
        .filter((b) => b.adjustmentPct !== 0)
        .map((b) => ({ text: `${b.factor}: ${b.detail}`, source: 'Confidence Composite (Commit 19)' })),
    ];

    return buildExplainableRecommendation({
      symbol: lastCtx.symbol,
      side,
      reasonBullets,
      probability: sourced(latest.result.composite.compositeConfidence * 100, 'Confidence Calibration + Composite (Commit 19, empirical)'),
      expectedR: simulation && !('error' in simulation)
        ? sourced(simulation.expectedValueR, 'Pre-Trade Simulation (Commit 20, Monte Carlo)')
        : unavailable('simulation not computed for this recommendation (missing ATR or SL/TP)'),
      stopLoss: slTp ? sourced(slTp.stopLoss, 'Risk Manager (ATR + swing structure)') : unavailable('no ATR available yet to compute a dynamic stop'),
      takeProfit: slTp ? sourced(slTp.takeProfit, 'Risk Manager (ATR + swing structure)') : unavailable('no ATR available yet to compute a dynamic target'),
    });
  }, [latest, lastCtx, item?.symbol, simulation]);

  function actOnDebate() {
    if (!item || !latest) return;
    const price = ticks[item.symbol]?.price;
    if (!price || price <= 0) return;
    const equity = portfolio.paper.cash;
    const notional = equity * (latest.result.suggestedPositionPct / 100);
    const qty = notional / price;
    if (qty <= 0) return;
    const primary = getCandles(item.symbol, '1h');
    const entryContext = primary ? captureContextSnapshot(item.symbol, getCandles) : undefined;
    // Commit 24: this button used to call buyPaper() directly with NO
    // risk validation at all — a real gap, since it's executing on an
    // AI recommendation same as the chat trade-action path, just with a
    // confirm click in between. It now goes through the same Supervisor
    // gate every other agent-initiated trade does.
    const { decision, executed, pendingApprovalId: queuedId } = reviewAndExecute({
      symbol: item.symbol,
      side: 'buy',
      tab: 'paper',
      qty,
      price,
      originTag: 'debate',
      rationale: latest.result.moderator.supportingEvidence[0],
      entryContext,
      debateId: latest.id,
    });
    setLastDecision(decision);
    setBought(executed);
    setPendingApprovalId(queuedId ?? null);
  }

  if (watchlist.length === 0) {
    return <p className="text-[11px] text-txt2">No watchlist symbols to analyze.</p>;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="flex-1 bg-bg2 border border-line rounded-md px-2 py-1.5 text-[11px] font-mono text-txt0">
          {watchlist.map((w) => (
            <option key={w.symbol} value={w.symbol}>{w.symbol}</option>
          ))}
        </select>
        <button onClick={run} disabled={loading} className="px-3 py-1.5 rounded-md text-[11px] font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 transition disabled:opacity-50">
          {loading ? 'Debating…' : 'Run Debate'}
        </button>
      </div>

      {error && <p className="text-[11px] font-mono text-red">{error}</p>}

      {latest && (
        <DebateResultView
          symbol={item!.symbol}
          result={latest.result}
          simulation={simulation}
          explainableRec={explainableRec}
          onAct={actOnDebate}
          bought={bought}
          pendingApprovalId={pendingApprovalId}
          canAct={!!ticks[item!.symbol]?.price}
          lastDecision={lastDecision}
        />
      )}

      {!latest && !error && <p className="text-[10px] font-mono text-txt2">Run a debate to see all 7 agents weigh in.</p>}
    </div>
  );
}

function DebateResultView({
  symbol,
  result,
  simulation,
  explainableRec,
  onAct,
  bought,
  pendingApprovalId,
  canAct,
  lastDecision,
}: {
  symbol: string;
  result: FullDebateResult;
  simulation: SimulationResult | { error: string } | null;
  explainableRec: ExplainableRecommendation | null;
  onAct: () => void;
  bought: boolean;
  pendingApprovalId: string | null;
  canAct: boolean;
  lastDecision: SupervisorDecision | null;
}) {
  const rec = result.moderator.recommendation;
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-line p-3 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className={`text-[14px] font-mono font-bold ${RECOMMENDATION_COLOR[rec]}`}>{rec}</span>
          <span className="text-[12px] font-mono text-txt1">{(result.composite.compositeConfidence * 100).toFixed(0)}% confidence</span>
        </div>
        <p className="text-[10px] font-mono text-txt2">{result.moderator.agreementSummary}</p>
        <div className="flex justify-between text-[10px] font-mono">
          <span className="text-txt2">Risk</span>
          <span className={result.composite.riskLevel === 'High' ? 'text-red' : result.composite.riskLevel === 'Medium' ? 'text-amber' : 'text-green'}>{result.composite.riskLevel}</span>
        </div>
        <div className="flex justify-between text-[10px] font-mono">
          <span className="text-txt2">Suggested position</span>
          <span className="text-txt0">{result.suggestedPositionPct}%</span>
        </div>
        {result.regime && (
          <div className="flex justify-between text-[10px] font-mono">
            <span className="text-txt2">Regime</span>
            <span className="text-txt0">{result.regime.trend}/{result.regime.vol}</span>
          </div>
        )}
        {simulation && (
          <div className="mt-1.5 pt-1.5 border-t border-line flex flex-col gap-1">
            <p className="text-[9.5px] font-mono uppercase tracking-wider text-txt2">Pre-trade stress test</p>
            {'error' in simulation ? (
              <p className="text-[9.5px] font-mono text-txt2">{simulation.error}</p>
            ) : (
              <>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-txt2">TP hit first</span>
                  <span className="text-green">{simulation.probTakeProfitFirstPct.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-txt2">SL hit first</span>
                  <span className="text-red">{simulation.probStopLossFirstPct.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-txt2">Neither within {simulation.maxBars} bars</span>
                  <span className="text-txt0">{simulation.probNeitherWithinHorizonPct.toFixed(1)}%</span>
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-txt2">Expected value</span>
                  <span className={simulation.expectedValueR >= 0 ? 'text-green' : 'text-red'}>
                    {simulation.expectedValueR >= 0 ? '+' : ''}{simulation.expectedValueR.toFixed(2)}R
                  </span>
                </div>
                <div className="flex justify-between text-[10px] font-mono">
                  <span className="text-txt2">Potential drawdown (avg / P95)</span>
                  <span className="text-amber">
                    {simulation.avgMaxAdverseExcursionR.toFixed(2)}R / {simulation.worstMaxAdverseExcursionR.toFixed(2)}R
                  </span>
                </div>
                <p className="text-[9px] font-mono text-txt2">
                  {simulation.simulations.toLocaleString()} paths, ATR-scaled random walk, no directional drift assumed — a stress test of the SL/TP placement, not a price forecast. "Potential drawdown" is the deepest adverse move against the position before resolution, in units of risk (1R = the stop distance) — average and 95th-percentile across all paths.
                </p>
                {simulation.warnings.map((w, i) => (
                  <p key={i} className="text-[9px] font-mono text-amber">⚠ {w}</p>
                ))}
              </>
            )}
          </div>
        )}

        {rec === 'BUY' && (
          <button onClick={onAct} disabled={bought || !!pendingApprovalId || !canAct} className="mt-1 px-2 py-1.5 rounded-md text-[10px] font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 transition disabled:opacity-50">
            {bought ? 'Position opened (paper)' : pendingApprovalId ? 'Queued for approval' : canAct ? 'Act on this — Buy (paper)' : 'No live price yet'}
          </button>
        )}
        {pendingApprovalId && (
          <p className="text-[10px] font-mono text-amber mt-1">⏸️ Exceeds your manual-approval threshold — approve or reject it in Trading Controls.</p>
        )}
        {lastDecision && !lastDecision.approved && (
          <p className="text-[10px] font-mono text-red mt-1">🛡️ Supervisor rejected this trade: {lastDecision.reasons.join('; ')}</p>
        )}
        {lastDecision && lastDecision.approved && lastDecision.conflictNotes.length > 0 && (
          <div className="mt-1 flex flex-col gap-0.5">
            {lastDecision.conflictNotes.map((n, i) => (
              <p key={i} className="text-[9.5px] font-mono text-amber">⚠ {n}</p>
            ))}
          </div>
        )}
      </div>

      {explainableRec && <ExplainableRecommendationCard rec={explainableRec} />}

      <details className="text-[10px] font-mono text-txt2">
        <summary className="cursor-pointer text-txt1">Confidence breakdown</summary>
        <div className="mt-1 flex flex-col gap-1">
          {result.composite.breakdown.map((b, i) => (
            <p key={i}>
              <span className="text-txt1">{b.factor}</span>
              {b.adjustmentPct !== 0 && <span className={b.adjustmentPct > 0 ? 'text-green' : 'text-red'}> ({b.adjustmentPct > 0 ? '+' : ''}{b.adjustmentPct.toFixed(1)}%)</span>}
              <br />
              {b.detail}
            </p>
          ))}
        </div>
      </details>

      {result.moderator.supportingEvidence.length > 0 && (
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-txt2 mb-1">Supporting evidence</p>
          {result.moderator.supportingEvidence.map((e, i) => (
            <p key={i} className="text-[10px] font-mono text-green">✔ {e}</p>
          ))}
        </div>
      )}
      {result.moderator.opposingViews.length > 0 && (
        <div>
          <p className="text-[10px] font-mono uppercase tracking-wider text-txt2 mb-1">Opposing views</p>
          {result.moderator.opposingViews.map((e, i) => (
            <p key={i} className="text-[10px] font-mono text-amber">• {e}</p>
          ))}
        </div>
      )}

      <div>
        <p className="text-[10px] font-mono uppercase tracking-wider text-txt2 mb-1">All {result.opinions.length} agents</p>
        <div className="flex flex-col gap-1.5">
          {result.opinions.map((o) => (
            <div key={o.agent} className="border-t border-line pt-1.5">
              <div className="flex justify-between text-[10px] font-mono">
                <span className="text-txt1">{o.label}</span>
                <span className={RECOMMENDATION_COLOR[o.recommendation]}>{o.recommendation} · {(o.confidence * 100).toFixed(0)}%</span>
              </div>
              {o.evidence.map((e, i) => (
                <p key={i} className="text-[9.5px] text-txt2">- {e}</p>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
