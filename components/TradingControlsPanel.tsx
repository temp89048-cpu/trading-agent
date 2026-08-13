'use client';

import { useState } from 'react';
import { useTradingControls } from './TradingControls';
import { useAgent } from './Agent';
import { useSupervisor } from './Supervisor';
import { usePortfolio } from './Portfolio';
import { DEFAULT_RISK_CONFIG, type RiskConfig } from '@/lib/riskManager';
import { DEFAULT_PORTFOLIO, type PendingApproval } from '@/lib/types';

// Human-in-the-Loop Controls (Production Readiness Review #17). See
// components/TradingControls.tsx's header comment for why pause/
// threshold/riskConfig live in their own provider instead of the main
// Config object, and why the emergency-stop wiring (which needs BOTH
// TradingControls and Agent) lives here in the UI layer instead of in
// either provider.

const RISK_FIELDS: { key: keyof RiskConfig; label: string; asPercent: boolean; step: number }[] = [
  { key: 'maxRiskPctPerTrade', label: 'Max risk / trade', asPercent: true, step: 0.1 },
  { key: 'maxDailyLossPct', label: 'Max daily loss', asPercent: true, step: 1 },
  { key: 'maxDrawdownPct', label: 'Max drawdown', asPercent: true, step: 1 },
  { key: 'maxPortfolioExposurePct', label: 'Max portfolio exposure', asPercent: true, step: 5 },
  { key: 'maxSpreadPct', label: 'Max spread', asPercent: false, step: 0.1 },
  { key: 'minBookDepthMultiple', label: 'Min book depth ×', asPercent: false, step: 0.5 },
  { key: 'liquidationSafetyBuffer', label: 'Liquidation safety buffer ×', asPercent: false, step: 0.1 },
  { key: 'correlationRejectThreshold', label: 'Correlation reject threshold', asPercent: false, step: 0.05 },
  { key: 'correlationExposureLimitPct', label: 'Correlated exposure limit', asPercent: true, step: 5 },
];

function logManualDecision(pending: PendingApproval, outcome: 'manually-approved' | 'manually-rejected') {
  fetch('/api/decisions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      symbol: pending.symbol,
      side: pending.side,
      tab: pending.tab,
      originTag: pending.originTag,
      requestedQty: pending.qty,
      requestedPrice: pending.price,
      outcome,
      urgency: 'normal',
      rejectionReasons: outcome === 'manually-rejected' ? ['Rejected by operator in Trading Controls.'] : [],
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
      rationale: pending.rationale,
    }),
  }).catch(() => {});
}

export function TradingControlsPanel() {
  const { paused, setPaused, manualApprovalThresholdUsd, setManualApprovalThresholdUsd, realStartingCapitalUsd, setRealStartingCapitalUsd, riskConfig, riskConfigOverrides, setRiskConfigOverride, resetRiskConfig, pendingApprovals, removePendingApproval } = useTradingControls();
  const { restorePortfolio, portfolio } = usePortfolio();
  const { tasks, cancelAgent } = useAgent();
  const { executeApprovedRequest } = useSupervisor();
  const [showRiskConfig, setShowRiskConfig] = useState(false);
  const [customCash, setCustomCash] = useState<string>('');

  const runningTasks = tasks.filter((t) => t.status === 'running');

  function emergencyStop() {
    if (!confirm(`Pause trading AND cancel all ${runningTasks.length} running agent(s)? This can't be undone.`)) return;
    setPaused(true);
    for (const t of runningTasks) cancelAgent(t.id);
  }

  function approve(pending: PendingApproval) {
    // The risk checks already passed at queue time. For a paper/ledger
    // trade this executes at the ORIGINALLY captured price, not a
    // re-quote — a known, documented limitation of a manual approval
    // step, not a bug. For a real exchange order, executeApprovedRequest
    // routes to a live market order instead (see components/Supervisor.tsx) —
    // that one fills at whatever the exchange actually gives it, same as
    // any real market order always does.
    executeApprovedRequest({
      symbol: pending.symbol,
      side: pending.side,
      tab: pending.tab,
      qty: pending.qty,
      price: pending.price,
      originTag: pending.originTag,
      entryContext: pending.entryContext,
      debateId: pending.debateId,
      // Carried through so the approved trade locks the same margin the
      // Supervisor validated at queue time. Dropping it here would book a
      // leveraged trade as 1x, over-reserving cash and misreporting exposure.
      requestedLeverage: pending.requestedLeverage,
    });
    logManualDecision(pending, 'manually-approved');
    removePendingApproval(pending.id);
  }

  function reject(pending: PendingApproval) {
    logManualDecision(pending, 'manually-rejected');
    removePendingApproval(pending.id);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <button
          onClick={() => setPaused(!paused)}
          className={`flex-1 px-2 py-1.5 rounded-md text-[11px] font-mono border transition ${paused ? 'border-red bg-red/10 text-red' : 'border-line bg-bg2 text-txt0 hover:bg-bg3'}`}
        >
          {paused ? '⏸ Trading paused — click to resume' : 'Pause trading'}
        </button>
        <button
          onClick={emergencyStop}
          disabled={paused && runningTasks.length === 0}
          className="px-2 py-1.5 rounded-md text-[11px] font-mono border border-red text-red hover:bg-red/10 transition disabled:opacity-40"
          title="Pause trading and cancel every running agent task"
        >
          Emergency stop
        </button>
      </div>
      <p className="text-[9.5px] text-txt2">
        Pause blocks new BUYs only (chat, agent plans, Debate's Act-on-this) — closes/sells are never blocked, same as every
        other risk check in this app. {runningTasks.length} agent{runningTasks.length === 1 ? '' : 's'} currently running.
      </p>

      <div className="border-t border-line pt-2 flex flex-col gap-1.5">
        <label className="text-[10px] font-mono text-txt2">Manual-approval threshold (USD notional)</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            value={manualApprovalThresholdUsd ?? ''}
            placeholder="no limit"
            onChange={(e) => setManualApprovalThresholdUsd(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
            className="flex-1 bg-bg2 border border-line rounded-md px-2 py-1 text-[11px] font-mono text-txt0"
          />
          {manualApprovalThresholdUsd !== null && (
            <button onClick={() => setManualApprovalThresholdUsd(null)} className="text-[10px] font-mono text-txt2 hover:text-txt0">
              Clear
            </button>
          )}
        </div>
        <p className="text-[9.5px] text-txt2">
          A BUY notional above this queues for your explicit Approve/Reject instead of auto-executing, even after passing every
          risk check. Leave blank for no threshold.
        </p>
      </div>

      <div className="border-t border-line pt-2 flex flex-col gap-1.5">
        <label className="text-[10px] font-mono text-txt2">Real account starting capital ($)</label>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={0}
            step={0.01}
            value={realStartingCapitalUsd ?? ''}
            placeholder="not set — real-tab risk checks read 'unavailable'"
            onChange={(e) => setRealStartingCapitalUsd(e.target.value === '' ? null : Math.max(0, Number(e.target.value)))}
            className="flex-1 bg-bg2 border border-line rounded-md px-2 py-1 text-[11px] font-mono text-txt0"
          />
          {realStartingCapitalUsd !== null && (
            <button onClick={() => setRealStartingCapitalUsd(null)} className="text-[10px] font-mono text-txt2 hover:text-txt0">
              Clear
            </button>
          )}
        </div>
        <p className="text-[9.5px] text-txt2">
          The real tab has no exchange-tracked cash balance, so per-trade risk %, daily-loss, drawdown, and portfolio-exposure
          checks have always silently skipped ('unavailable') for real trades. Declaring your actual starting capital here lets
          those checks run for real — current equity is estimated as this number plus/minus realized P&amp;L from the real trade
          log. Leave blank to keep today's behavior exactly as-is.
        </p>
      </div>

      {pendingApprovals.length > 0 && (
        <div className="border-t border-line pt-2 flex flex-col gap-2">
          <p className="text-[10px] font-mono uppercase tracking-wider text-txt2">Pending approval ({pendingApprovals.length})</p>
          {pendingApprovals.map((p) => (
            <div key={p.id} className="rounded-md border border-amber/40 bg-amber/5 px-2.5 py-2 flex flex-col gap-1">
              <div className="flex items-center justify-between text-[11px] font-mono">
                <span className="text-txt0">
                  {p.side.toUpperCase()} {p.symbol} · {p.tab}
                </span>
                <span className="text-amber">${p.notionalUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}</span>
              </div>
              <p className="text-[9.5px] text-txt2">
                {p.qty.toFixed(6).replace(/\.?0+$/, '')} @ ${p.price.toLocaleString()} · {p.originTag}
              </p>
              <p className="text-[9.5px] text-txt2">{p.decisionSummary}</p>
              <div className="flex gap-2 mt-1">
                <button onClick={() => approve(p)} className="flex-1 px-2 py-1 rounded text-[10px] font-mono border border-green text-green hover:bg-green/10 transition">
                  Approve
                </button>
                <button onClick={() => reject(p)} className="flex-1 px-2 py-1 rounded text-[10px] font-mono border border-red text-red hover:bg-red/10 transition">
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-line pt-2">
        <button onClick={() => setShowRiskConfig(!showRiskConfig)} className="text-[10px] font-mono text-txt2 hover:text-txt0 flex items-center gap-1">
          {showRiskConfig ? '▾' : '▸'} Risk limit overrides
        </button>
        {showRiskConfig && (
          <div className="mt-2 flex flex-col gap-2">
            {RISK_FIELDS.map((f) => {
              const effective = riskConfig[f.key];
              const overridden = f.key in riskConfigOverrides;
              const display = f.asPercent ? effective * 100 : effective;
              return (
                <div key={f.key} className="flex items-center justify-between gap-2">
                  <label className={`text-[10px] font-mono ${overridden ? 'text-amber' : 'text-txt2'}`}>{f.label}</label>
                  <input
                    type="number"
                    step={f.step}
                    value={Number(display.toFixed(4))}
                    onChange={(e) => {
                      const raw = Number(e.target.value);
                      setRiskConfigOverride({ [f.key]: f.asPercent ? raw / 100 : raw } as Partial<RiskConfig>);
                    }}
                    className="w-20 bg-bg2 border border-line rounded px-1.5 py-0.5 text-[10.5px] font-mono text-txt0 text-right"
                  />
                </div>
              );
            })}
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  min={0}
                  value={customCash}
                  onChange={(e) => setCustomCash(e.target.value)}
                  placeholder="Custom Cash (USD)"
                  className="w-32 bg-bg2 border border-line rounded px-1.5 py-0.5 text-[10.5px] font-mono text-txt0 text-right"
                />
                <button
                  disabled={!customCash}
                  onClick={() => {
                    const val = Number(customCash);
                    if (val >= 0 && window.confirm(`Set paper cash to $${val}?`)) {
                      restorePortfolio({ ...portfolio, paper: { ...portfolio.paper, cash: val } });
                      setCustomCash('');
                    }
                  }}
                  className="text-[9.5px] font-mono text-txt2 hover:text-txt0 disabled:opacity-40"
                >
                  Set Cash
                </button>
              </div>
              <div className="flex gap-4">
                <button onClick={resetRiskConfig} className="mt-1 text-[9.5px] font-mono text-txt2 hover:text-txt0 self-start">
                  Reset all to defaults
                </button>
                <button 
                  onClick={() => {
                    if (window.confirm("Are you sure you want to reset your Paper Account? This will clear all paper positions and reset cash to $1,000,000.")) {
                      restorePortfolio(DEFAULT_PORTFOLIO);
                    }
                  }} 
                  className="mt-1 text-[9.5px] font-mono text-red hover:text-red/80 self-start">
                  Reset Paper Account ($1M)
                </button>
              </div>
            </div>
            <p className="text-[9px] text-txt2">
              Defaults: {(DEFAULT_RISK_CONFIG.maxRiskPctPerTrade * 100).toFixed(1)}% risk/trade,{' '}
              {(DEFAULT_RISK_CONFIG.maxDailyLossPct * 100).toFixed(0)}% daily loss, {(DEFAULT_RISK_CONFIG.maxDrawdownPct * 100).toFixed(0)}% drawdown,{' '}
              {(DEFAULT_RISK_CONFIG.maxPortfolioExposurePct * 100).toFixed(0)}% portfolio exposure.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
