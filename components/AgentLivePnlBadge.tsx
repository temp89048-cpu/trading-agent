'use client';

import { useAgent } from './Agent';
import { useMarketData } from './MarketData';
import { computeLiveUnrealizedPnl } from '@/lib/agentEngine';

// A single always-visible readout of "how are my running agents doing
// right now" — the same live mark-to-market AgentPanel already computes
// per open leg, just summed across every running take-profit/
// conditional-watch task and shown in the header so it's visible without
// opening the Trading panel. Renders nothing when no agent currently
// holds an open leg (interval-mode tasks and armed-but-not-yet-entered
// tasks have nothing to mark to market) — an empty header badge would
// just be noise.
export function AgentLivePnlBadge() {
  const { tasks } = useAgent();
  const { ticks } = useMarketData();

  const openLegs = tasks.filter((t) => t.status === 'running' && t.currentEntryPrice !== undefined && t.currentQty !== undefined);
  if (openLegs.length === 0) return null;

  let totalPnl = 0;
  let priced = 0;
  for (const t of openLegs) {
    const livePrice = ticks[t.symbol]?.price;
    if (livePrice === undefined) continue;
    totalPnl += computeLiveUnrealizedPnl(t, livePrice).pnl;
    priced++;
  }
  if (priced === 0) return null;

  const positive = totalPnl >= 0;
  return (
    <div
      className="hidden sm:flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[11px] font-mono border border-line bg-bg2"
      title={`Live unrealized P&L across ${priced} open agent position${priced > 1 ? 's' : ''}`}
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: positive ? 'var(--green)' : 'var(--red)' }} />
      <span className="text-txt2">Live</span>
      <span className="font-semibold" style={{ color: positive ? 'var(--green)' : 'var(--red)' }}>
        {positive ? '+' : ''}${totalPnl.toFixed(2)}
      </span>
      <span className="text-txt2">
        · {priced} open
      </span>
    </div>
  );
}
