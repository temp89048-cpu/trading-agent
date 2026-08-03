'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Icon } from '@/components/Icon';
import type { TradeTab } from '@/lib/types';
import type { DashboardStats, GroupStats } from '@/lib/learningDashboard';

type FilterTab = 'all' | TradeTab;

const ORIGIN_LABEL: Record<string, string> = {
  debate: 'Debate System',
  'chat-trade-action': 'Chat trade-action',
  'agent-plan': 'Autonomous agent plan',
  'user-command': 'Typed user command',
  'manual-click': 'Manual button click',
  unknown: 'Unknown (pre-Commit 23)',
};

function GroupBar({ g, labelMap }: { g: GroupStats; labelMap?: Record<string, string> }) {
  const label = labelMap?.[g.group] ?? g.group;
  const pct = g.winRatePct;
  return (
    <div className="flex flex-col gap-1 py-2 border-b border-line last:border-0">
      <div className="flex justify-between items-baseline text-[11px] font-mono">
        <span className="text-txt1">{label}</span>
        <span className="text-txt2">
          {g.trades} trade{g.trades === 1 ? '' : 's'} {pct !== null ? `· ${pct.toFixed(0)}% win rate` : '· win rate n/a (< 3 trades)'}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-bg3 overflow-hidden">
        <div className="h-full rounded-full" style={{ width: `${pct ?? 0}%`, background: pct === null ? 'var(--txt2)' : pct >= 50 ? 'var(--green)' : 'var(--red)' }} />
      </div>
      <div className="flex justify-between text-[10px] font-mono text-txt2">
        <span>avg P&amp;L / trade</span>
        <span style={{ color: g.avgPnl >= 0 ? 'var(--green)' : 'var(--red)' }}>
          {g.avgPnl >= 0 ? '+' : ''}${g.avgPnl.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <div className="border border-line rounded-lg bg-bg1 p-4">
      <p className="font-mono text-[11px] uppercase tracking-wider text-txt2 mb-1">{title}</p>
      {note && <p className="text-[10px] text-txt2 mb-2">{note}</p>}
      <div className="flex flex-col">{children}</div>
    </div>
  );
}

export default function DashboardPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<FilterTab>('all');
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/stats${filter !== 'all' ? `?tab=${filter}` : ''}`);
        const json = await res.json();
        if (!cancelled) setStats(json.stats);
      } catch {
        if (!cancelled) setError('Failed to load stats.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [filter]);

  return (
    <div className="min-h-screen bg-bg0 text-txt0">
      <header className="flex items-center gap-3 px-4 h-14 border-b border-line bg-bg1 sticky top-0 z-10">
        <button onClick={() => router.push('/')} className="p-1.5 rounded-md hover:bg-bg3 transition text-txt1" title="Back to terminal">
          <Icon name="x" size={18} />
        </button>
        <span className="font-mono text-sm font-semibold">Learning Dashboard</span>
        <div className="flex-1" />
        <div className="flex gap-1 text-[11px] font-mono">
          {(['all', 'paper', 'real'] as FilterTab[]).map((t) => (
            <button key={t} onClick={() => setFilter(t)} className={`tabbtn ${filter === t ? 'bg-bg3 text-amber' : 'text-txt2'}`}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 py-6 flex flex-col gap-4">
        {loading && <p className="text-sm text-txt2">Loading…</p>}
        {error && <p className="text-sm text-red">{error}</p>}

        {stats && !loading && (
          <>
            {stats.totalClosedTrades === 0 ? (
              <p className="text-sm text-txt2">No closed round-trip trades yet — this fills in as positions open and close.</p>
            ) : (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div className="border border-line rounded-lg bg-bg1 p-3">
                    <p className="text-[10px] font-mono uppercase text-txt2">Closed trades</p>
                    <p className="text-xl font-mono">{stats.totalClosedTrades}</p>
                  </div>
                  <div className="border border-line rounded-lg bg-bg1 p-3">
                    <p className="text-[10px] font-mono uppercase text-txt2">Expectancy / trade</p>
                    <p className="text-xl font-mono" style={{ color: (stats.expectancy.expectancyUsd ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>
                      {stats.expectancy.expectancyUsd !== null ? `${stats.expectancy.expectancyUsd >= 0 ? '+' : ''}$${stats.expectancy.expectancyUsd.toFixed(2)}` : 'n/a'}
                    </p>
                  </div>
                  <div className="border border-line rounded-lg bg-bg1 p-3">
                    <p className="text-[10px] font-mono uppercase text-txt2">Avg hold time</p>
                    <p className="text-xl font-mono">
                      {stats.holdTime.avgMinutes !== null
                        ? stats.holdTime.avgMinutes < 60
                          ? `${stats.holdTime.avgMinutes.toFixed(0)}m`
                          : `${(stats.holdTime.avgMinutes / 60).toFixed(1)}h`
                        : 'n/a'}
                    </p>
                  </div>
                  <div className="border border-line rounded-lg bg-bg1 p-3">
                    <p className="text-[10px] font-mono uppercase text-txt2">Max drawdown</p>
                    <p className="text-xl font-mono text-red">-${stats.maxDrawdown.maxDrawdownUsd.toFixed(2)}</p>
                  </div>
                </div>
                <p className="text-[10px] text-txt2 -mt-2">
                  Expectancy needs 3+ closed trades to report (n={stats.expectancy.sampleSize}). Max drawdown is computed from cumulative REALIZED P&amp;L
                  of closed trades only — not a full account-equity curve (no cash balance or unrealized positions included).
                </p>

                {(stats.bestOrigins.length > 0 || stats.worstOrigins.length > 0) && (
                  <div className="grid sm:grid-cols-2 gap-3">
                    <Section title="Best performing (by origin)" note="Ranked by total realized P&L, 3+ trades required.">
                      {stats.bestOrigins.length > 0 ? stats.bestOrigins.map((g) => <GroupBar key={g.group} g={g} labelMap={ORIGIN_LABEL} />) : <p className="text-[10px] text-txt2">Not enough data yet.</p>}
                    </Section>
                    <Section title="Worst performing (by origin)" note="Ranked by total realized P&L, 3+ trades required.">
                      {stats.worstOrigins.length > 0 ? stats.worstOrigins.map((g) => <GroupBar key={g.group} g={g} labelMap={ORIGIN_LABEL} />) : <p className="text-[10px] text-txt2">Not enough data yet.</p>}
                    </Section>
                  </div>
                )}

                <Section
                  title="Win rate by origin"
                  note="The Strategy Ensemble (Commit 12) is informational-only and never auto-executes, so trades can't be attributed to a specific strategy agent. Grouped by what actually placed the trade instead."
                >
                  {stats.byOrigin.map((g) => (
                    <GroupBar key={g.group} g={g} labelMap={ORIGIN_LABEL} />
                  ))}
                </Section>

                <div className="grid sm:grid-cols-2 gap-3">
                  <Section title="Win rate by market condition" note="From the structure-trend reading captured at entry (Commit 15). 'range' = no clear trend detected.">
                    {stats.byMarketCondition.map((g) => (
                      <GroupBar key={g.group} g={g} />
                    ))}
                  </Section>
                  <Section title="Win rate by volatility regime" note="ATR-at-entry as a % of entry price: low < 1%, medium 1–3%, high > 3%.">
                    {stats.byVolatilityRegime.map((g) => (
                      <GroupBar key={g.group} g={g} />
                    ))}
                  </Section>
                </div>

                <div className="grid sm:grid-cols-2 gap-3">
                  <Section title="Performance by weekday" note="Grouped by entry timestamp, UTC.">
                    {stats.byWeekday.map((g) => (
                      <GroupBar key={g.group} g={g} />
                    ))}
                  </Section>
                  <Section title="Performance by time of day" note="Grouped by entry hour, UTC. Empty hours are omitted, not shown as zero.">
                    {stats.byHourOfDay.map((g) => (
                      <GroupBar key={g.group} g={g} />
                    ))}
                  </Section>
                </div>

                {stats.reflectionCoveragePct !== null && (
                  <p className="text-[10px] text-txt2">
                    {stats.reflectionCoveragePct.toFixed(0)}% of closed trades have a stored AI reflection (Commit 15) — view them from each trade's detail page in the Trade Log.
                  </p>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  );
}
