'use client';

import { useEffect, useState } from 'react';
import { loadLS, saveLS, LS_KEYS } from '@/lib/storage';
import { useMarketData } from './MarketData';
import { usePortfolio } from './Portfolio';
import { computeLiveEquityMetrics } from '@/lib/liveAnalytics';

type Snapshot = { date: string; value: number };
type HistoryMap = Record<'paper' | 'real', Snapshot[]>;

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

function recordSnapshot(tab: 'paper' | 'real', value: number): Snapshot[] {
  const all = loadLS<Partial<HistoryMap>>(LS_KEYS.pvHistory, {});
  const series = all[tab] ?? [];
  const today = todayStr();
  const last = series[series.length - 1];
  const next = last && last.date === today ? [...series.slice(0, -1), { date: today, value }] : [...series, { date: today, value }];
  const trimmed = next.slice(-90); // keep last 90 recorded sessions
  saveLS(LS_KEYS.pvHistory, { ...all, [tab]: trimmed });
  return trimmed;
}

export function PortfolioAnalytics({ tab }: { tab: 'paper' | 'real' }) {
  const { ticks } = useMarketData();
  const { portfolio, tradeLog } = usePortfolio();
  const [series, setSeries] = useState<Snapshot[]>([]);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setSeries(loadLS<Partial<HistoryMap>>(LS_KEYS.pvHistory, {})[tab] ?? []);
    setMounted(true);
  }, [tab]);

  // Real-Time Performance Analytics (Production Readiness Review #12) —
  // Sharpe/Sortino/Calmar/Sterling/Ulcer computed from the actual live
  // trade log, reusing the exact backtest risk-metrics math. Paper-only:
  // buildRealizedEquityCurve's starting-equity anchor only means
  // something for the paper account (see lib/liveAnalytics.ts).
  const liveMetrics = tab === 'paper' ? computeLiveEquityMetrics(tradeLog) : null;

  const positions = tab === 'paper' ? portfolio.paper.positions : portfolio.real.positions;
  const cash = tab === 'paper' ? portfolio.paper.cash : 0;
  const marketValue = positions.reduce((s, p) => s + p.qty * (ticks[p.symbol]?.price ?? p.avgCost), 0);
  const totalValue = cash + marketValue;

  useEffect(() => {
    if (!mounted || !isFinite(totalValue)) return;
    const next = recordSnapshot(tab, totalValue);
    setSeries(next);
    // Snapshot once per render-triggering value change is intentional —
    // recordSnapshot itself collapses same-day writes, so this can't spam
    // localStorage even though it re-runs on every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mounted, tab, Math.round(totalValue)]);

  const hasSessionSeries = series.length >= 2;
  const first = hasSessionSeries ? series[0].value : null;
  const prev = hasSessionSeries ? series[series.length - 2].value : null;
  const curr = hasSessionSeries ? series[series.length - 1].value : null;
  const sinceStart = first !== null && curr !== null ? ((curr - first) / first) * 100 : null;
  const sinceLastSession = prev !== null && curr !== null ? ((curr - prev) / prev) * 100 : null;
  const values = series.map((s) => s.value);
  const high = values.length > 0 ? Math.max(...values) : null;
  const low = values.length > 0 ? Math.min(...values) : null;

  return (
    <div className="flex flex-col gap-2">
      {hasSessionSeries ? (
        <div className="flex flex-col gap-1.5">
          <Row label="Since last session" value={`${sinceLastSession! >= 0 ? '+' : ''}${sinceLastSession!.toFixed(2)}%`} colorize={sinceLastSession!} />
          <Row label={`Since first recorded (${series[0].date})`} value={`${sinceStart! >= 0 ? '+' : ''}${sinceStart!.toFixed(2)}%`} colorize={sinceStart!} />
          <Row label="Recorded high" value={`$${high!.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
          <Row label="Recorded low" value={`$${low!.toLocaleString(undefined, { maximumFractionDigits: 0 })}`} />
          <p className="text-[10px] pt-1 text-txt2">
            Based on {series.length} sessions recorded on this device — one snapshot per day you had the app open, not full
            historical daily bars.
          </p>
        </div>
      ) : (
        <p className="text-[11px] text-txt2">
          Recording daily snapshots as you use the app — check back tomorrow for change-over-time stats. ({series.length}/2
          recorded)
        </p>
      )}

      {liveMetrics && (
        <div className="border-t border-line pt-2 flex flex-col gap-1.5">
          <p className="text-[10px] font-mono uppercase tracking-wider text-txt2">Live performance (real-time analytics)</p>
          {liveMetrics.hasData ? (
            <>
              <Row label="Annualized return" value={liveMetrics.annualizedReturnPct !== null ? `${liveMetrics.annualizedReturnPct >= 0 ? '+' : ''}${liveMetrics.annualizedReturnPct.toFixed(1)}%` : 'n/a'} colorize={liveMetrics.annualizedReturnPct ?? undefined} />
              <Row label="Annualized volatility" value={liveMetrics.annualizedVolatilityPct !== null ? `${liveMetrics.annualizedVolatilityPct.toFixed(1)}%` : 'n/a'} />
              <Row label="Sharpe" value={liveMetrics.sharpe !== null ? liveMetrics.sharpe.toFixed(2) : 'n/a'} colorize={liveMetrics.sharpe ?? undefined} />
              <Row label="Sortino" value={liveMetrics.sortino !== null ? liveMetrics.sortino.toFixed(2) : 'n/a'} colorize={liveMetrics.sortino ?? undefined} />
              <Row label="Calmar" value={liveMetrics.calmar !== null ? liveMetrics.calmar.toFixed(2) : 'n/a'} colorize={liveMetrics.calmar ?? undefined} />
              <Row label="Ulcer Index" value={liveMetrics.ulcerIndex !== null ? liveMetrics.ulcerIndex.toFixed(2) : 'n/a'} />
              <p className="text-[9px] text-txt2 pt-0.5">
                {liveMetrics.daysCovered} distinct trading day(s) with closed trades, risk-free rate assumed 0. Same math as
                the Backtest Lab's equity metrics, computed against your real paper trade log instead of a replay.
              </p>
            </>
          ) : (
            <p className="text-[10.5px] text-txt2">{liveMetrics.warnings[0]}</p>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, colorize }: { label: string; value: string; colorize?: number }) {
  const color = colorize === undefined ? 'var(--txt-0)' : colorize >= 0 ? 'var(--green)' : 'var(--red)';
  return (
    <div className="flex items-center justify-between text-[11px] font-mono">
      <span className="text-txt2">{label}</span>
      <span style={{ color }}>{value}</span>
    </div>
  );
}
