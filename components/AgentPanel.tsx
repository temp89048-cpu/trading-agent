'use client';

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useAgent } from './Agent';
import { useMarketData } from './MarketData';
import { describeCondition } from '@/lib/plannerAgent';
import type { AgentTask } from '@/lib/types';

// Unrealized P&L for the currently-open leg of a take-profit/
// conditional-watch task, marked-to-market against the live tick price —
// same formula agentEngine.ts's checkTpSlClose uses to compute the
// REALIZED pnl once TP/SL actually fires, just evaluated against the
// live price instead of waiting for a close. pctMove mirrors the same
// plain price-move percent tpPercent/slPercent are already defined in
// (not a leveraged ROI%), so it's directly comparable to "watching for
// {tpPercent}% move" shown right next to it.
function computeLivePnl(task: AgentTask, livePrice: number): { pnl: number; pctMove: number } {
  const entry = task.currentEntryPrice!;
  const qty = task.currentQty!;
  const sign = task.side === 'buy' ? 1 : -1;
  const pnl = (livePrice - entry) * qty * sign;
  const pctMove = sign * ((livePrice - entry) / entry) * 100;
  return { pnl, pctMove };
}

// Compact one-line summary of "TP/SL" for the header row — accounts for
// ATR-based stops (fixed tpPercent/slPercent don't apply then) so it
// never shows a literal "undefined%".
function describeStops(task: AgentTask): string {
  if (task.useAtrStops) return `ATR stop (×${task.atrMultiplierTp ?? 2} TP / ×${task.atrMultiplierSl ?? 1} SL)`;
  return `TP ${task.tpPercent}%${task.slPercent ? ` / SL ${task.slPercent}%` : ''}`;
}

// Any advanced feature configured on this task, for a compact badge row.
function describeAdvancedConfig(task: AgentTask): string[] {
  const badges: string[] = [];
  if (task.trailingStopPercent !== undefined) badges.push(`trailing ${task.trailingStopPercent}%`);
  if (task.scaleOutLevels && task.scaleOutLevels.length > 0) {
    const done = task.scaledOutLevels?.length ?? 0;
    badges.push(`scale-out ${done}/${task.scaleOutLevels.length}`);
  }
  if (task.breakEvenArmed) badges.push('breakeven armed');
  if (task.requireSignalConfirmation) badges.push('signal-gated');
  return badges;
}

function CountdownTo({ ts }: { ts: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, []);
  const remaining = Math.max(0, Math.round((ts - now) / 1000));
  const mm = Math.floor(remaining / 60);
  const ss = remaining % 60;
  return <span>{mm}:{ss.toString().padStart(2, '0')}</span>;
}

export function AgentPanel() {
  const { tasks, cancelAgent } = useAgent();
  const { ticks } = useMarketData();
  const sorted = [...tasks].sort((a, b) => b.createdAt - a.createdAt).slice(0, 8);

  if (sorted.length === 0) {
    return <p className="text-[11px] text-txt2">No agent running — mention @papertrade or @real with "take N trades" in chat to start one.</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      {sorted.map((t) => {
        const statusColor =
          t.status === 'running' ? 'var(--amber)' : t.status === 'completed' ? 'var(--green)' : t.status === 'error' ? 'var(--red)' : 'var(--txt-2)';
        return (
          <div key={t.id} className="rounded-md border border-line bg-bg2 px-2.5 py-2 flex flex-col gap-1">
            <div className="flex items-center justify-between text-[11px] font-mono">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: statusColor }} />
                <span className="truncate text-txt0">{t.symbol}</span>
                <span className="text-txt2 shrink-0">{t.tab}</span>
              </div>
              {t.status === 'running' && (
                <button onClick={() => cancelAgent(t.id)} className="p-0.5 rounded hover:text-red text-txt2" title="Cancel">
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
            <div className="flex items-center justify-between text-[10px] font-mono text-txt2">
              <span>
                {t.executedTrades}/{t.totalTrades} trades ·{' '}
                {t.mode === 'interval' ? `every ${t.intervalMinutes}m` : t.mode === 'take-profit' ? describeStops(t) : `conditional · ${describeStops(t)}`}
              </span>
              <span style={{ color: t.realizedTotal >= 0 ? 'var(--green)' : 'var(--red)' }}>
                {t.realizedTotal >= 0 ? '+' : ''}${t.realizedTotal.toFixed(2)}{' '}
                <span className="text-txt2 font-normal">realized</span>
              </span>
            </div>
            {describeAdvancedConfig(t).length > 0 && (
              <div className="flex flex-wrap gap-1">
                {describeAdvancedConfig(t).map((badge, i) => (
                  <span key={i} className="text-[9px] font-mono px-1 py-0.5 rounded border border-line text-txt2">
                    {badge}
                  </span>
                ))}
              </div>
            )}
            {t.status === 'running' && t.mode === 'interval' && t.nextRunAt && (
              <p className="text-[9.5px] text-txt2">
                next trade in <CountdownTo ts={t.nextRunAt} />
              </p>
            )}
            {t.status === 'running' && t.currentEntryPrice === undefined && t.requireSignalConfirmation && ((t.mode === 'interval' && t.nextRunAt !== undefined && t.nextRunAt <= Date.now()) || t.mode === 'take-profit') && (
              <p className="text-[9.5px] text-amber">armed — waiting for Strategy Ensemble{t.minDebateConfidencePct !== undefined ? '/Debate' : ''} to confirm {t.side} before entering</p>
            )}
            {t.status === 'running' && t.currentEntryPrice !== undefined && t.currentQty !== undefined && (t.mode === 'take-profit' || t.mode === 'conditional-watch') && (() => {
              const livePrice = ticks[t.symbol]?.price;
              const live = livePrice !== undefined ? computeLivePnl(t, livePrice) : null;
              return (
                <div className="flex flex-col gap-0.5">
                  <p className="text-[9.5px] text-txt2">
                    {t.mode === 'conditional-watch' ? 'position open — ' : ''}watching for {describeStops(t)}
                    {t.trailingStopPercent !== undefined && t.currentPeakPrice !== undefined ? ` · trail from peak $${t.currentPeakPrice.toLocaleString()}` : ''}
                  </p>
                  {live ? (
                    <p className="text-[10.5px] font-mono font-semibold" style={{ color: live.pnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      Live: {live.pnl >= 0 ? '+' : ''}${live.pnl.toFixed(2)} ({live.pctMove >= 0 ? '+' : ''}{live.pctMove.toFixed(2)}%) @ ${livePrice!.toLocaleString()}
                    </p>
                  ) : (
                    <p className="text-[9.5px] text-txt2">no live price yet — can't mark this leg to market</p>
                  )}
                </div>
              );
            })()}
            {t.status === 'running' && t.mode === 'conditional-watch' && !t.currentEntryPrice && (t.planStage ?? 'trigger') === 'trigger' && t.triggerCondition && (
              <p className="text-[9.5px] text-txt2">waiting for trigger: {describeCondition(t.triggerCondition)}</p>
            )}
            {t.status === 'running' && t.mode === 'conditional-watch' && !t.currentEntryPrice && t.planStage === 'watch' && t.watchCondition && (
              <p className="text-[9.5px] text-txt2">triggered — watching for entry: {describeCondition(t.watchCondition)}</p>
            )}
            {t.status !== 'running' && <p className="text-[9.5px] text-txt2 capitalize">{t.status}</p>}
          </div>
        );
      })}
    </div>
  );
}
