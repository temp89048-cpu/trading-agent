'use client';

import { useEffect, useState } from 'react';
import { useAutonomousTrader } from './AutonomousTrader';
import { useMissionPlanner } from './MissionPlanner';
import { ABSOLUTE_MAX_LEVERAGE, ABSOLUTE_MAX_LEVERAGE_PAPER } from '@/lib/riskManager';
import { assessWatchdog, describeSilentRisk } from '@/lib/watchdog';
import { usePortfolio } from './Portfolio';
import type { AutonomousCycleRecord } from '@/lib/autonomousCycleStore.server';

// Control surface for the autonomous loop. Deliberately blunt about what
// enabling this means — it is the one toggle in this app that lets the
// system open positions nobody asked for, so the UI states that plainly
// rather than burying it.
export function AutonomousTraderPanel() {
  const { config, setConfig, lastCycle, runCycleNow, lastCycleAt, cycleIntervalMs } = useAutonomousTrader();
  const { activeMission } = useMissionPlanner();
  const { portfolio } = usePortfolio();
  const [showConsidered, setShowConsidered] = useState(false);
  // Re-tick locally so staleness is recomputed even while the monitored
  // loop itself is dead — a watchdog that only updates when the thing
  // it's watching runs would never fire.
  const [watchdogNow, setWatchdogNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setWatchdogNow(Date.now()), 5000);
    return () => clearInterval(iv);
  }, []);

  const openPositionCount =
    config.tab === 'paper' ? portfolio.paper.positions.length : portfolio.real.positions.length;
  const watchdog = assessWatchdog({
    loops: [
      {
        id: 'autonomous-trader',
        label: 'Autonomous loop',
        lastHeartbeatAt: lastCycleAt,
        expectedIntervalMs: cycleIntervalMs,
        enabled: config.enabled,
      },
    ],
    openPositionCount,
    nowMs: watchdogNow,
  });
  const [history, setHistory] = useState<AutonomousCycleRecord[] | null>(null);
  const [showHistory, setShowHistory] = useState(false);

  // Loaded on demand rather than on mount — the journal is a review
  // surface, not something the panel needs to render normally, and it can
  // hold hundreds of cycles.
  useEffect(() => {
    if (!showHistory || history !== null) return;
    fetch('/api/autonomous-cycles')
      .then((r) => r.json())
      .then((json) => setHistory(Array.isArray(json.cycles) ? json.cycles.slice().reverse() : []))
      .catch(() => setHistory([]));
  }, [showHistory, history]);

  const realConfirmText = 'TRADE REAL MONEY';

  function toggleTab() {
    if (config.tab === 'paper') {
      const answer = prompt(
        `Switch the autonomous loop to REAL money?\n\nThis lets the system open real positions on your connected exchange without asking you first, up to ${ABSOLUTE_MAX_LEVERAGE}x leverage, sized from your declared real starting capital.\n\nType "${realConfirmText}" to confirm.`,
      );
      if (answer !== realConfirmText) return;
      setConfig({ tab: 'real' });
    } else {
      setConfig({ tab: 'paper' });
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      {/* Master switch */}
      <div className="rounded-md border border-line bg-bg2 px-2.5 py-2 flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span
              className={`w-1.5 h-1.5 rounded-full shrink-0 ${config.enabled ? 'pulse' : ''}`}
              style={{ background: config.enabled ? 'var(--green)' : 'var(--txt-2)' }}
            />
            <span className="text-[11px] font-mono text-txt0">
              {config.enabled ? 'Running — evaluating every 60s' : 'Stopped'}
            </span>
          </div>
          <button
            onClick={() => setConfig({ enabled: !config.enabled })}
            className={`px-2 py-1 rounded text-[10px] font-mono border transition ${
              config.enabled
                ? 'border-red text-red hover:bg-red/10'
                : 'border-green text-green hover:bg-green/10'
            }`}
          >
            {config.enabled ? 'Stop' : 'Start'}
          </button>
        </div>
        <p className="text-[9.5px] text-txt2">
          When running, this opens positions on its own toward your active mission — nobody prompts it. Every trade
          it proposes still passes through the same Supervisor, Risk Manager, Debate veto, hard leverage ceiling and
          mandatory stop-loss as any other AI trade; it cannot bypass them.
        </p>
      </div>

      {/* Watchdog (spec Section 22.8). The failure this exists for is not
          "a bad trade" but "the loop went silent while holding a
          position" — so the silent-with-open-risk case gets its own loud
          treatment rather than a generic status line. */}
      {watchdog.silentWithOpenRisk && (
        <div className="rounded-md border px-2.5 py-2" style={{ borderColor: 'var(--red)', background: 'rgba(239,90,90,0.08)' }}>
          <p className="text-[10px] font-mono font-semibold text-red">⚠ MONITORING STOPPED WITH OPEN EXPOSURE</p>
          <p className="text-[9.5px] text-txt0 mt-0.5">{describeSilentRisk(openPositionCount)}</p>
        </div>
      )}
      {!watchdog.silentWithOpenRisk &&
        watchdog.findings
          .filter((f) => f.severity !== 'ok')
          .map((f) => (
            <p key={f.loopId} className="text-[10px]" style={{ color: f.severity === 'critical' ? 'var(--red)' : 'var(--amber)' }}>
              ⚠ {f.message}
            </p>
          ))}

      {!activeMission && (
        <p className="text-[10px] text-amber">
          ⚠ No active mission — the loop will stand down every cycle until you create one. It needs a stated goal
          before it will open anything on its own.
        </p>
      )}

      {/* Settings */}
      <div className="flex flex-col gap-1.5 border-t border-line pt-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-txt2">Account</span>
          <button
            onClick={toggleTab}
            className={`px-2 py-0.5 rounded text-[10px] font-mono border transition ${
              config.tab === 'real' ? 'border-red text-red' : 'border-line text-txt1 hover:bg-bg3'
            }`}
          >
            {config.tab === 'real' ? 'REAL MONEY' : 'Paper'}
          </button>
        </div>
        <p className="text-[9px] text-txt2">
          Hard leverage ceiling: {config.tab === 'real' ? `${ABSOLUTE_MAX_LEVERAGE}x (real)` : `${ABSOLUTE_MAX_LEVERAGE_PAPER}x (paper)`} — not
          overridable by any setting or agent.
        </p>

        <label className="text-[9px] font-mono text-txt2">
          Position size (% of equity)
          <input
            type="number"
            min={0.5}
            max={100}
            step={0.5}
            value={config.positionSizePct}
            onChange={(e) => setConfig({ positionSizePct: Math.max(0.5, Math.min(100, Number(e.target.value))) })}
            className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none"
          />
        </label>

        <label className="text-[9px] font-mono text-txt2">
          Max concurrent autonomous positions
          <input
            type="number"
            min={1}
            max={10}
            step={1}
            value={config.maxConcurrentPositions}
            onChange={(e) => setConfig({ maxConcurrentPositions: Math.max(1, Math.min(10, Number(e.target.value))) })}
            className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none"
          />
        </label>

        <label className="text-[9px] font-mono text-txt2">
          Cooldown between entries (minutes)
          <input
            type="number"
            min={0}
            max={1440}
            step={1}
            value={config.cooldownMinutes}
            onChange={(e) => setConfig({ cooldownMinutes: Math.max(0, Math.min(1440, Number(e.target.value))) })}
            className="w-full mt-0.5 text-[10px] font-mono px-2 py-1 rounded border border-line bg-bg2 text-txt0 focus:border-amber outline-none"
          />
        </label>

        <p className="text-[9px] text-txt2">
          The stricter of this panel&apos;s size/leverage and your mission&apos;s own constraints always wins.
        </p>
      </div>

      {/* Last cycle */}
      <div className="border-t border-line pt-2 flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono uppercase tracking-wider text-txt2">Last cycle</span>
          <button
            onClick={runCycleNow}
            className="px-2 py-0.5 rounded text-[9px] font-mono border border-line text-txt2 hover:bg-bg3 transition"
          >
            Run now
          </button>
        </div>
        {lastCycle ? (
          <>
            <div className="flex items-center gap-1.5">
              <span
                className="text-[9px] font-mono px-1 py-0.5 rounded border border-line"
                style={{
                  color:
                    lastCycle.outcome === 'traded'
                      ? 'var(--green)'
                      : lastCycle.outcome === 'error'
                        ? 'var(--red)'
                        : 'var(--txt-2)',
                }}
              >
                {lastCycle.outcome}
              </span>
              <span className="text-[9px] font-mono text-txt2">{new Date(lastCycle.ts).toLocaleTimeString()}</span>
            </div>
            <p className="text-[9.5px] text-txt0">{lastCycle.decisionSummary}</p>
            {lastCycle.considered.length > 0 && (
              <>
                <button
                  onClick={() => setShowConsidered(!showConsidered)}
                  className="self-start text-[9px] font-mono text-txt2 hover:text-amber transition"
                >
                  {showConsidered ? 'Hide' : 'Show'} all {lastCycle.considered.length} candidate(s) it weighed
                </button>
                {showConsidered && (
                  <div className="flex flex-col gap-1 mt-0.5">
                    {lastCycle.considered.map((c) => (
                      <div key={c.symbol} className="rounded border border-line bg-bg1 px-1.5 py-1 flex flex-col gap-0.5">
                        <div className="flex items-center justify-between text-[9px] font-mono">
                          <span className="text-txt0">
                            {c.symbol} · {c.side}
                          </span>
                          <span style={{ color: c.actionable ? 'var(--green)' : 'var(--txt-2)' }}>
                            {c.score.toFixed(0)}/100
                          </span>
                        </div>
                        {c.reasons.map((r, i) => (
                          <p key={i} className="text-[8.5px] text-txt2">
                            · {r}
                          </p>
                        ))}
                        {c.blockers.map((b, i) => (
                          <p key={i} className="text-[8.5px] text-red">
                            ✕ {b}
                          </p>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </>
        ) : (
          <p className="text-[9.5px] text-txt2">
            No cycle has run yet{config.enabled ? ' — first evaluation runs shortly after load' : ' (loop is stopped)'}.
          </p>
        )}
      </div>

      {/* Persisted decision journal — every cycle, including no-trade ones */}
      <div className="border-t border-line pt-2 flex flex-col gap-1">
        <button
          onClick={() => setShowHistory(!showHistory)}
          className="self-start text-[9px] font-mono text-txt2 hover:text-amber transition"
        >
          {showHistory ? 'Hide' : 'Show'} decision journal
        </button>
        {showHistory && (
          <>
            {history === null ? (
              <p className="text-[9.5px] text-txt2">Loading…</p>
            ) : history.length === 0 ? (
              <p className="text-[9.5px] text-txt2">No cycles journaled yet.</p>
            ) : (
              <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
                {history.slice(0, 50).map((c) => (
                  <div key={c.id} className="rounded border border-line bg-bg1 px-1.5 py-1 flex flex-col gap-0.5">
                    <div className="flex items-center justify-between text-[9px] font-mono">
                      <span
                        style={{
                          color:
                            c.outcome === 'traded' ? 'var(--green)' : c.outcome === 'error' ? 'var(--red)' : 'var(--txt-2)',
                        }}
                      >
                        {c.outcome}
                        {c.actedSymbol ? ` · ${c.actedSide} ${c.actedSymbol}` : ''}
                      </span>
                      <span className="text-txt2">{new Date(c.ts).toLocaleString()}</span>
                    </div>
                    <p className="text-[8.5px] text-txt2">{c.decisionSummary}</p>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[8.5px] text-txt2">
              Every cycle is recorded, including the ones that decided NOT to trade — a no-trade decision with a stated reason is
              still a decision.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
