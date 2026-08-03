'use client';

import { useState, useMemo, useRef } from 'react';
import { useMarketData } from './MarketData';
import { STRATEGY_NAMES, STRATEGY_REGISTRY } from '@/lib/backtest/strategyRegistry';
import { MTF_TIMEFRAMES } from '@/lib/multiTimeframe';
import type { BacktestResult } from '@/lib/backtest/engine';
import type { RegimeBreakdown } from '@/lib/backtest/regime';
import type { MonteCarloResult } from '@/lib/backtest/monteCarlo';

type ApiResponse = {
  result: BacktestResult;
  regimeBreakdown?: { breakdown: RegimeBreakdown[]; warnings: string[] };
  meta: { strategyLabel: string; dataSource: string; mtfIncluded: boolean; mtfNotes: string[]; providerWarnings: string[] };
};

function EquityCurve({ points }: { points: { t: number; equity: number }[] }) {
  if (points.length < 2) return null;
  const w = 560;
  const h = 140;
  const pad = 4;
  const values = points.map((p) => p.equity);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const startEquity = points[0].equity;
  const path = points
    .map((p, i) => {
      const x = pad + (i / (points.length - 1)) * (w - pad * 2);
      const y = h - pad - ((p.equity - min) / range) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  const finalUp = points[points.length - 1].equity >= startEquity;
  const baselineY = h - pad - ((startEquity - min) / range) * (h - pad * 2);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[140px]">
      <line x1={pad} y1={baselineY} x2={w - pad} y2={baselineY} stroke="currentColor" className="text-line" strokeDasharray="3 3" />
      <path d={path} fill="none" stroke="currentColor" strokeWidth={1.5} className={finalUp ? 'text-green' : 'text-red'} />
    </svg>
  );
}

function MonteCarloHistogram({ fractions }: { fractions: number[] }) {
  if (fractions.length === 0) return null;
  const w = 560;
  const h = 100;
  const bins = 30;
  const min = fractions[0];
  const max = fractions[fractions.length - 1];
  const range = max - min || 1;
  const counts = new Array(bins).fill(0);
  for (const f of fractions) {
    const idx = Math.min(bins - 1, Math.floor(((f - min) / range) * bins));
    counts[idx]++;
  }
  const maxCount = Math.max(...counts);
  const barW = w / bins;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-[100px]">
      {counts.map((c, i) => {
        const barH = maxCount > 0 ? (c / maxCount) * (h - 4) : 0;
        const x = i * barW;
        const binStart = min + (i / bins) * range;
        return <rect key={i} x={x} y={h - barH} width={barW - 1} height={barH} className={binStart >= 1 ? 'fill-green' : 'fill-red'} opacity={0.7} />;
      })}
      <line x1={((1 - min) / range) * w} y1={0} x2={((1 - min) / range) * w} y2={h} stroke="currentColor" className="text-txt2" strokeDasharray="3 3" />
    </svg>
  );
}

export function BacktestPanel() {
  const { watchlist } = useMarketData();
  const [symbol, setSymbol] = useState(watchlist[0]?.symbol ?? 'BTC/USDT');
  const [type, setType] = useState<'crypto' | 'equity'>(watchlist[0]?.type ?? 'crypto');
  const [interval, setInterval_] = useState('1h');
  const [strategyName, setStrategyName] = useState('trendFollowing');
  const [barCount, setBarCount] = useState(1000);
  const [includeMtf, setIncludeMtf] = useState(false);
  const [includeRegimeBreakdown, setIncludeRegimeBreakdown] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [initialCapitalUsd, setInitialCapitalUsd] = useState(10000);
  const [riskPct, setRiskPct] = useState(2);
  const [rewardRiskRatio, setRewardRiskRatio] = useState(2);
  const [feeBps, setFeeBps] = useState(10);
  const [slippageBps, setSlippageBps] = useState(5);
  const [executionMode, setExecutionMode] = useState<'conservative' | 'optimistic' | 'random' | 'tick'>('conservative');
  const [useDynamicSlippage, setUseDynamicSlippage] = useState(false);
  const [feeModelMode, setFeeModelMode] = useState<'fixed' | 'exchange'>('fixed');
  const [vipLevel, setVipLevel] = useState(0);
  const [isMaker, setIsMaker] = useState(false);

  const [csvText, setCsvText] = useState<string | null>(null);
  const [csvFileName, setCsvFileName] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);

  const [mcLoading, setMcLoading] = useState(false);
  const [mcError, setMcError] = useState<string | null>(null);
  const [mcData, setMcData] = useState<MonteCarloResult | null>(null);

  const strategy = STRATEGY_REGISTRY[strategyName];

  async function handleCsvUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setCsvText(text);
    setCsvFileName(file.name);
  }

  async function run() {
    setLoading(true);
    setError(null);
    setMcData(null);
    setMcError(null);
    try {
      const res = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          type,
          interval,
          strategyName,
          barCount,
          includeMtf,
          includeRegimeBreakdown,
          customCandlesCsv: csvText ?? undefined,
          initialCapitalUsd,
          riskPct: riskPct / 100,
          rewardRiskRatio,
          feeBps,
          slippageBps,
          executionMode,
          useDynamicSlippage,
          feeModel: feeModelMode,
          vipLevel,
          isMaker,
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Backtest failed');
        setData(null);
      } else {
        setData(json);
      }
    } catch {
      setError('Request failed — check your connection.');
    } finally {
      setLoading(false);
    }
  }

  async function runMonteCarlo() {
    if (!data) return;
    setMcLoading(true);
    setMcError(null);
    try {
      const res = await fetch('/api/backtest/montecarlo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades: data.result.trades, initialCapitalUsd, simulations: 5000, mode: 'bootstrap' }),
      });
      const json = await res.json();
      if (!res.ok) {
        setMcError(json.error ?? 'Monte Carlo run failed');
      } else {
        setMcData(json.result);
      }
    } catch {
      setMcError('Request failed — check your connection.');
    } finally {
      setMcLoading(false);
    }
  }

  const metricsRows = useMemo(() => {
    if (!data) return [];
    const m = data.result.metrics;
    return [
      ['Trades', String(m.tradeCount)],
      ['Win rate', m.winRate !== null ? `${(m.winRate * 100).toFixed(1)}%` : 'n/a'],
      ['Profit factor', m.profitFactor !== null ? m.profitFactor.toFixed(2) : m.tradeCount > 0 && m.losses === 0 ? '∞ (no losses)' : 'n/a'],
      ['Total return', `${m.totalReturnPct >= 0 ? '+' : ''}${m.totalReturnPct.toFixed(2)}%`],
      ['Max drawdown', `${m.maxDrawdownPct.toFixed(2)}%`],
      ['Expectancy/trade', m.expectancyUsd !== null ? `$${m.expectancyUsd.toFixed(2)}` : 'n/a'],
      ['Avg win / loss', `${m.avgWinPct !== null ? m.avgWinPct.toFixed(2) : 'n/a'}% / ${m.avgLossPct !== null ? m.avgLossPct.toFixed(2) : 'n/a'}%`],
      ['Avg bars held', m.avgBarsHeld !== null ? m.avgBarsHeld.toFixed(1) : 'n/a'],
    ];
  }, [data]);

  const equityRows = useMemo(() => {
    if (!data) return null;
    const e = data.result.equityMetrics;
    if (e.sharpe === null && e.daysCovered < 14) return null;
    return [
      ['Annualized return', e.annualizedReturnPct !== null ? `${e.annualizedReturnPct.toFixed(1)}%` : 'n/a'],
      ['Annualized volatility', e.annualizedVolatilityPct !== null ? `${e.annualizedVolatilityPct.toFixed(1)}%` : 'n/a'],
      ['Sharpe (annualized)', e.sharpe !== null ? e.sharpe.toFixed(2) : 'n/a'],
      ['Sortino', e.sortino !== null ? e.sortino.toFixed(2) : 'n/a'],
      ['Calmar', e.calmar !== null ? e.calmar.toFixed(2) : 'n/a'],
      ['Sterling', e.sterling !== null ? e.sterling.toFixed(2) : 'n/a'],
      ['Ulcer Index', e.ulcerIndex !== null ? e.ulcerIndex.toFixed(2) : 'n/a'],
      ['Ulcer Performance Index', e.upi !== null ? e.upi.toFixed(2) : 'n/a'],
    ];
  }, [data]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Symbol
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} disabled={!!csvText} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0 disabled:opacity-50" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Type
          <select value={type} onChange={(e) => setType(e.target.value as 'crypto' | 'equity')} disabled={!!csvText} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0 disabled:opacity-50">
            <option value="crypto">Crypto</option>
            <option value="equity">Equity</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Interval
          <select value={interval} onChange={(e) => setInterval_(e.target.value)} disabled={!!csvText} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0 disabled:opacity-50">
            {MTF_TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>{tf}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Strategy
          <select value={strategyName} onChange={(e) => setStrategyName(e.target.value)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0">
            {STRATEGY_NAMES.map((name) => (
              <option key={name} value={name}>{STRATEGY_REGISTRY[name].label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Bars to fetch
          <input type="number" min={200} max={10000} value={barCount} disabled={!!csvText} onChange={(e) => setBarCount(parseInt(e.target.value, 10) || 1000)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0 disabled:opacity-50" />
        </label>
        <label className="flex items-center gap-2 text-[11px] font-mono text-txt2 mt-5">
          <input type="checkbox" checked={includeMtf} disabled={!!csvText} onChange={(e) => setIncludeMtf(e.target.checked)} />
          Include MTF confirmation {!strategy.usesMtf && '(n/a for this strategy)'}
        </label>
      </div>

      <div className="border-t border-line pt-2 flex flex-col gap-1.5">
        <p className="text-[11px] font-mono uppercase tracking-wider text-txt2">Data source</p>
        <div className="flex items-center gap-2">
          <input ref={fileInputRef} type="file" accept=".csv" onChange={handleCsvUpload} className="hidden" id="csv-upload" />
          <button onClick={() => fileInputRef.current?.click()} className="px-2 py-1.5 rounded-md text-[10px] font-mono border border-line text-txt1 hover:bg-bg3 transition">
            Upload CSV
          </button>
          {csvText && (
            <>
              <span className="text-[10px] font-mono text-green">{csvFileName}</span>
              <button onClick={() => { setCsvText(null); setCsvFileName(null); if (fileInputRef.current) fileInputRef.current.value = ''; }} className="text-[10px] font-mono text-txt2 hover:text-red">
                Clear
              </button>
            </>
          )}
        </div>
        <p className="text-[9.5px] text-txt2">
          CSV columns: t/time/timestamp/date, o/open, h/high, l/low, c/close, v/volume. Overrides live provider fetch — use this to backtest beyond a provider's history limit. Parquet not supported yet.
        </p>
      </div>

      <button onClick={() => setShowAdvanced((v) => !v)} className="text-[10px] font-mono text-txt2 text-left hover:text-txt1">
        {showAdvanced ? '▾' : '▸'} Advanced (capital, execution, fees, regime)
      </button>
      {showAdvanced && (
        <div className="flex flex-col gap-2 border-t border-line pt-2">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
              Initial capital ($)
              <input type="number" value={initialCapitalUsd} onChange={(e) => setInitialCapitalUsd(parseFloat(e.target.value) || 10000)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
              Risk per trade (%)
              <input type="number" step={0.1} value={riskPct} onChange={(e) => setRiskPct(parseFloat(e.target.value) || 2)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
              Reward:risk ratio
              <input type="number" step={0.1} value={rewardRiskRatio} onChange={(e) => setRewardRiskRatio(parseFloat(e.target.value) || 2)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
              Execution mode (ambiguous bars)
              <select value={executionMode} onChange={(e) => setExecutionMode(e.target.value as typeof executionMode)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0">
                <option value="conservative">Conservative (stop hits first)</option>
                <option value="optimistic">Optimistic (target hits first)</option>
                <option value="random">Random (seeded)</option>
                <option value="tick">Tick sim (falls back — no data)</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
              Baseline fee (bps/side)
              <input type="number" value={feeBps} disabled={feeModelMode === 'exchange'} onChange={(e) => setFeeBps(parseFloat(e.target.value) || 0)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0 disabled:opacity-50" />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
              Baseline slippage (bps/side)
              <input type="number" value={slippageBps} onChange={(e) => setSlippageBps(parseFloat(e.target.value) || 0)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
            </label>
          </div>

          <label className="flex items-center gap-2 text-[11px] font-mono text-txt2">
            <input type="checkbox" checked={useDynamicSlippage} onChange={(e) => setUseDynamicSlippage(e.target.checked)} />
            Dynamic slippage (scales with order size vs. bar volume, and ATR vs. price)
          </label>

          <div className="flex items-center gap-2">
            <label className="flex items-center gap-2 text-[11px] font-mono text-txt2">
              <input type="radio" name="feeModel" checked={feeModelMode === 'fixed'} onChange={() => setFeeModelMode('fixed')} />
              Fixed fee
            </label>
            <label className="flex items-center gap-2 text-[11px] font-mono text-txt2">
              <input type="radio" name="feeModel" checked={feeModelMode === 'exchange'} onChange={() => setFeeModelMode('exchange')} />
              Exchange schedule (Binance spot)
            </label>
          </div>
          {feeModelMode === 'exchange' && (
            <div className="flex items-center gap-3 pl-4">
              <label className="flex items-center gap-1 text-[10px] font-mono text-txt2">
                VIP
                <select value={vipLevel} onChange={(e) => setVipLevel(parseInt(e.target.value, 10))} className="bg-bg2 border border-line rounded-md px-1.5 py-1 text-txt0">
                  {Array.from({ length: 10 }, (_, i) => i).map((v) => (
                    <option key={v} value={v}>{v}</option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1 text-[10px] font-mono text-txt2">
                <input type="checkbox" checked={isMaker} onChange={(e) => setIsMaker(e.target.checked)} />
                Maker
              </label>
            </div>
          )}

          <label className="flex items-center gap-2 text-[11px] font-mono text-txt2">
            <input type="checkbox" checked={includeRegimeBreakdown} onChange={(e) => setIncludeRegimeBreakdown(e.target.checked)} />
            Break down performance by market regime (bull/bear/sideways × high/low-vol)
          </label>
        </div>
      )}

      <button onClick={run} disabled={loading} className="px-3 py-2 rounded-md text-[11px] font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 transition disabled:opacity-50">
        {loading ? 'Running…' : 'Run Backtest'}
      </button>

      {error && <p className="text-[11px] font-mono text-red">{error}</p>}

      {data && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <p className="text-[10px] font-mono text-txt2">
            {data.meta.strategyLabel} · {data.meta.dataSource}
            {data.meta.mtfIncluded ? ` · MTF: ${data.meta.mtfNotes.join('; ')}` : ''}
          </p>

          {(data.result.warnings.length > 0 || data.meta.providerWarnings.length > 0) && (
            <div className="rounded-md bg-bg2 border border-line p-2 flex flex-col gap-1">
              {[...data.result.warnings, ...data.meta.providerWarnings].map((w, i) => (
                <p key={i} className="text-[10px] font-mono text-amber">⚠ {w}</p>
              ))}
            </div>
          )}

          <EquityCurve points={data.result.equityCurve} />

          <div>
            <p className="text-[11px] font-mono uppercase tracking-wider text-txt2 mb-1">Trade metrics</p>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {metricsRows.map(([label, value]) => (
                <div key={label} className="flex justify-between text-[11px] font-mono">
                  <span className="text-txt2">{label}</span>
                  <span className="text-txt0">{value}</span>
                </div>
              ))}
            </div>
          </div>

          {equityRows ? (
            <div>
              <p className="text-[11px] font-mono uppercase tracking-wider text-txt2 mb-1">Equity-curve risk metrics ({data.result.equityMetrics.daysCovered} days)</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                {equityRows.map(([label, value]) => (
                  <div key={label} className="flex justify-between text-[11px] font-mono">
                    <span className="text-txt2">{label}</span>
                    <span className="text-txt0">{value}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-[10px] font-mono text-txt2">Equity-curve risk metrics (Sharpe/Sortino/Calmar/Ulcer) unavailable — window too short. See warnings above.</p>
          )}

          {data.regimeBreakdown && data.regimeBreakdown.breakdown.length > 0 && (
            <div>
              <p className="text-[11px] font-mono uppercase tracking-wider text-txt2 mb-1">Performance by regime</p>
              <div className="flex flex-col gap-1">
                {data.regimeBreakdown.breakdown.map((r) => (
                  <div key={r.key} className="flex justify-between text-[10px] font-mono">
                    <span className="text-txt2">{r.key} ({r.tradeCount} trades)</span>
                    <span className={r.totalPnlUsd >= 0 ? 'text-green' : 'text-red'}>
                      {r.totalPnlUsd >= 0 ? '+' : ''}{r.totalPnlUsd.toFixed(2)} ({r.winRate !== null ? (r.winRate * 100).toFixed(0) : 'n/a'}% win)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="max-h-60 overflow-y-auto border border-line rounded-md">
            <table className="w-full text-[10px] font-mono">
              <thead className="sticky top-0 bg-bg2">
                <tr className="text-txt2">
                  <th className="text-left px-2 py-1">Entry</th>
                  <th className="text-left px-2 py-1">Exit</th>
                  <th className="text-right px-2 py-1">P&L</th>
                  <th className="text-left px-2 py-1">Reason</th>
                  <th className="text-right px-2 py-1">Bars</th>
                </tr>
              </thead>
              <tbody>
                {data.result.trades.map((t, i) => (
                  <tr key={i} className="border-t border-line">
                    <td className="px-2 py-1 text-txt1">{t.entryPrice.toFixed(2)}</td>
                    <td className="px-2 py-1 text-txt1">{t.exitPrice.toFixed(2)}</td>
                    <td className={`px-2 py-1 text-right ${t.pnlUsd >= 0 ? 'text-green' : 'text-red'}`}>
                      {t.pnlUsd >= 0 ? '+' : ''}{t.pnlUsd.toFixed(2)} ({t.pnlPct >= 0 ? '+' : ''}{t.pnlPct.toFixed(1)}%)
                    </td>
                    <td className="px-2 py-1 text-txt2">{t.exitReason}</td>
                    <td className="px-2 py-1 text-right text-txt2">{t.barsHeld}</td>
                  </tr>
                ))}
                {data.result.trades.length === 0 && (
                  <tr><td colSpan={5} className="px-2 py-2 text-center text-txt2">No trades triggered in this window.</td></tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="border-t border-line pt-3 flex flex-col gap-2">
            <button onClick={runMonteCarlo} disabled={mcLoading || data.result.trades.length < 10} className="px-3 py-2 rounded-md text-[11px] font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 transition disabled:opacity-50">
              {mcLoading ? 'Simulating…' : 'Run Monte Carlo (5,000 resamples)'}
            </button>
            {data.result.trades.length < 10 && <p className="text-[10px] font-mono text-txt2">Need at least 10 trades for a meaningful Monte Carlo run.</p>}
            {mcError && <p className="text-[11px] font-mono text-red">{mcError}</p>}
            {mcData && (
              <div className="flex flex-col gap-2">
                <MonteCarloHistogram fractions={mcData.finalEquityFractions} />
                <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                  <div className="flex justify-between text-[11px] font-mono"><span className="text-txt2">Risk of ruin</span><span className={mcData.riskOfRuinPct > 10 ? 'text-red' : 'text-green'}>{mcData.riskOfRuinPct.toFixed(1)}%</span></div>
                  <div className="flex justify-between text-[11px] font-mono"><span className="text-txt2">Expected return</span><span className="text-txt0">{mcData.expectedReturnPct >= 0 ? '+' : ''}{mcData.expectedReturnPct.toFixed(1)}%</span></div>
                  <div className="flex justify-between text-[11px] font-mono"><span className="text-txt2">5th–95th pct final equity</span><span className="text-txt0">{mcData.finalEquityPct.p5.toFixed(0)}% to {mcData.finalEquityPct.p95.toFixed(0)}%</span></div>
                  <div className="flex justify-between text-[11px] font-mono"><span className="text-txt2">Worst simulated drawdown</span><span className="text-red">{mcData.maxDrawdownPct.worst.toFixed(1)}%</span></div>
                  <div className="flex justify-between text-[11px] font-mono"><span className="text-txt2">Median simulated drawdown</span><span className="text-txt0">{mcData.maxDrawdownPct.p50.toFixed(1)}%</span></div>
                  <div className="flex justify-between text-[11px] font-mono"><span className="text-txt2">Historical path's outcome</span><span className="text-txt0">{mcData.historicalFinalEquityPct >= 0 ? '+' : ''}{mcData.historicalFinalEquityPct.toFixed(1)}%</span></div>
                </div>
                {mcData.warnings.map((w, i) => (
                  <p key={i} className="text-[10px] font-mono text-amber">⚠ {w}</p>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
