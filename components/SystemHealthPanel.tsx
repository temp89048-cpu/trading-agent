'use client';

import { useEffect, useState } from 'react';
import { useMarketData } from './MarketData';
import { useCandles } from './Candles';
import { useMcp } from './Mcp';
import { useAgentRuntime } from './AgentRuntime';
import { assessSystemHealth, type HealthSignal } from '@/lib/supervisorAgent';

// System health, honestly scoped: this rolls up signals the app already
// knows about (candle feed presence/freshness/last-fetch-error, MCP
// reachability — auto-rechecked on an interval, see components/Mcp.tsx),
// plus two real server-side active checks via /api/health (a trade-store
// read round-trip, and Binance API reachability — the two external
// dependencies this app's server process can't function without). It is
// still not full production infrastructure monitoring (no external
// uptime pinger against this app's own process, no alerting) — but it is
// genuine active checking, not just a passive readout of whatever the
// UI happened to have cached.
const SERVER_HEALTH_POLL_MS = 60_000;
// 1h/4h candles are refreshed in the background every 60s (see
// Candles.tsx REFRESH_MS) — flag a feed as stale once it's gone
// noticeably longer than that without a successful fetch, since that's
// the signal that the background refresh loop itself has stopped
// working (network down, provider rate-limited, etc.), not just normal
// refresh cadence.
const CANDLE_STALE_MS = 3 * 60_000;

type ServerHealth = { overall: 'healthy' | 'degraded' | 'unhealthy'; checks: { label: string; ok: boolean; detail: string; latencyMs: number }[] } | null;

export function SystemHealthPanel() {
  const { watchlist } = useMarketData();
  const { getCandles, ensureCandles } = useCandles();
  const { servers, statusById, checkServer } = useMcp();
  const { snapshot: agentSnapshot } = useAgentRuntime();
  const [serverHealth, setServerHealth] = useState<ServerHealth>(null);
  const [checkingServerHealth, setCheckingServerHealth] = useState(false);

  async function refreshServerHealth() {
    setCheckingServerHealth(true);
    try {
      const res = await fetch('/api/health');
      const json = await res.json();
      setServerHealth({ overall: json.overall, checks: json.checks ?? [] });
    } catch (err) {
      setServerHealth({ overall: 'unhealthy', checks: [{ label: 'Server health endpoint', ok: false, detail: err instanceof Error ? err.message : 'unreachable', latencyMs: 0 }] });
    } finally {
      setCheckingServerHealth(false);
    }
  }

  useEffect(() => {
    refreshServerHealth();
    const iv = setInterval(refreshServerHealth, SERVER_HEALTH_POLL_MS);
    return () => clearInterval(iv);
  }, []);

  function retryAll() {
    for (const item of watchlist) {
      ensureCandles(item, '1h');
      ensureCandles(item, '4h');
    }
    for (const server of servers) checkServer(server.id);
    refreshServerHealth();
  }

  const signals: HealthSignal[] = [];

  for (const item of watchlist) {
    const primary = getCandles(item.symbol, '1h');
    const hasData = !!primary && primary.candles.length > 0;
    const ageMs = primary ? Date.now() - primary.fetchedAt : Infinity;
    const stale = hasData && !primary!.loading && ageMs > CANDLE_STALE_MS;
    // A feed with cached candles but a live fetch error, or one that's
    // gone stale, is degrading right now even though `candles.length > 0`
    // alone would read as fine — surface both, not just presence.
    const ok = hasData && !primary!.error && !stale;
    const detail = !hasData
      ? 'no candles loaded yet — Supervisor will reject any AI-agent buy on this symbol until this resolves'
      : primary!.error
      ? `${primary!.candles.length} bars cached, but last refresh failed: ${primary!.error}`
      : stale
      ? `${primary!.candles.length} bars cached, but last successful refresh was ${Math.round(ageMs / 1000)}s ago — background refresh may have stopped`
      : `${primary!.candles.length} bars cached, refreshed ${Math.round(ageMs / 1000)}s ago`;
    signals.push({ label: `${item.symbol} candle feed`, ok, detail });
  }

  for (const server of servers) {
    const status = statusById[server.id];
    const ok = status?.reachable === true;
    signals.push({
      label: `MCP: ${server.name}`,
      ok,
      detail: status?.reachable === null || status === undefined ? 'not checked yet' : ok ? `reachable (${status.latencyMs ?? '?'}ms, auto-rechecked every 60s)` : `unreachable — ${status.error ?? 'unknown error'}`,
    });
  }

  for (const check of serverHealth?.checks ?? []) {
    signals.push({ label: check.label, ok: check.ok, detail: `${check.detail} (${check.latencyMs}ms)` });
  }

  const report = assessSystemHealth(signals);

  // --- Agent OS health signals (Phase 21) ---
  const erroredAgents = agentSnapshot.agents.filter((a) => a.health.status === 'error');
  const staleAgents = agentSnapshot.agents.filter((a) => {
    if (a.descriptor.tickIntervalMs === 0) return false;
    if (a.health.lastHeartbeat === 0) return false;
    return Date.now() - a.health.lastHeartbeat > a.descriptor.tickIntervalMs * 3;
  });

  if (erroredAgents.length > 0) {
    signals.push({
      label: 'Agent OS',
      ok: false,
      detail: `${erroredAgents.length} agent(s) in error state: ${erroredAgents.map((a) => a.descriptor.name).join(', ')}`,
    });
  } else if (staleAgents.length > 0) {
    signals.push({
      label: 'Agent OS',
      ok: false,
      detail: `${staleAgents.length} agent(s) stale: ${staleAgents.map((a) => a.descriptor.name).join(', ')}`,
    });
  } else {
    signals.push({
      label: 'Agent OS',
      ok: true,
      detail: `${agentSnapshot.agents.length} agents registered, scheduler ${agentSnapshot.schedulerRunning ? 'active' : 'stopped'}`,
    });
  }

  const reportFinal = assessSystemHealth(signals);
  const color = reportFinal.overall === 'healthy' ? 'text-green' : reportFinal.overall === 'degraded' ? 'text-amber' : 'text-red';

  if (signals.length === 0) {
    return <p className="text-[11px] text-txt2">No watchlist symbols or MCP servers to check yet.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className={`text-[11px] font-mono font-bold uppercase ${color}`}>{reportFinal.overall}</p>
        <button
          onClick={retryAll}
          disabled={checkingServerHealth}
          className="text-[9.5px] font-mono text-txt2 hover:text-txt0 border border-line rounded px-1.5 py-0.5 disabled:opacity-50"
        >
          {checkingServerHealth ? 'Rechecking…' : 'Recheck now'}
        </button>
      </div>
      <div className="flex flex-col gap-1">
        {signals.map((s, i) => (
          <div key={i} className="flex justify-between text-[10px] font-mono gap-2">
            <span className="text-txt2 shrink-0">{s.label}</span>
            <span className={s.ok ? 'text-txt0' : 'text-red'}>{s.detail}</span>
          </div>
        ))}
      </div>
      <p className="text-[9px] text-txt2">
        Candle feed presence/freshness, MCP reachability (auto-rechecked every 60s), plus two real server-side checks
        (trade-store read, Binance reachability) polled every 60s. Not external uptime probing of this app's own process.
      </p>
    </div>
  );
}
