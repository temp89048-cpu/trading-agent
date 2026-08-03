'use client';

import { useEffect, useState } from 'react';
import { useMarketData } from './MarketData';
import { MTF_TIMEFRAMES } from '@/lib/multiTimeframe';
import type { OptimizerResult, OptimizerObjective } from '@/lib/backtest/optimizer';
import type { TunableParams } from '@/lib/backtest/tunableStrategy';
import type { SearchAlgorithmName } from '@/lib/backtest/searchAlgorithms';
import { computeStabilityScore, type StabilityScore } from '@/lib/backtest/stabilityScore';
import type { MonteCarloResult } from '@/lib/backtest/monteCarlo';
import type { StrategyVersion } from '@/lib/strategyVersionStore.server';

type ApiResponse = { result: OptimizerResult; meta: { dataSource: string; barCount: number } };

function parseNumberList(s: string): number[] {
  return s.split(',').map((x) => parseFloat(x.trim())).filter((x) => !isNaN(x));
}

const PARAM_LABELS: Record<keyof TunableParams, string> = {
  emaFast: 'EMA Fast',
  emaSlow: 'EMA Slow',
  rsiThreshold: 'RSI Threshold',
  atrMultiplier: 'ATR Multiplier',
  rewardRiskRatio: 'Reward:Risk',
};

const ALGORITHM_LABELS: Record<SearchAlgorithmName, string> = {
  grid: 'Grid Search (exhaustive)',
  random: 'Random Search',
  genetic: 'Genetic Algorithm',
  bayesian: 'Bayesian Optimization (GP + EI)',
};

export function OptimizerPanel() {
  const { watchlist } = useMarketData();
  const [symbol, setSymbol] = useState(watchlist[0]?.symbol ?? 'BTC/USDT');
  const [type, setType] = useState<'crypto' | 'equity'>(watchlist[0]?.type ?? 'crypto');
  const [interval, setInterval_] = useState('1h');
  const [barCount, setBarCount] = useState(1500);
  const [folds, setFolds] = useState(3);
  const [trainRatio, setTrainRatio] = useState(70);
  const [objective, setObjective] = useState<OptimizerObjective>('profitFactor');
  const [algorithm, setAlgorithm] = useState<SearchAlgorithmName>('grid');
  const [evaluationBudget, setEvaluationBudget] = useState(60);

  const [emaFastStr, setEmaFastStr] = useState('10, 20, 30');
  const [emaSlowStr, setEmaSlowStr] = useState('50, 80');
  const [rsiThresholdStr, setRsiThresholdStr] = useState('10, 15, 20');
  const [atrMultiplierStr, setAtrMultiplierStr] = useState('1.5, 2');
  const [rewardRiskRatioStr, setRewardRiskRatioStr] = useState('1.5, 2, 2.5');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ApiResponse | null>(null);

  const [stabilityLoading, setStabilityLoading] = useState(false);
  const [stabilityError, setStabilityError] = useState<string | null>(null);
  const [stability, setStability] = useState<StabilityScore | null>(null);
  const [stabilityMc, setStabilityMc] = useState<MonteCarloResult | null>(null);
  const [stabilityParamsUsed, setStabilityParamsUsed] = useState<TunableParams | null>(null);

  // Strategy Versioning (Production Readiness Review #7) — see
  // lib/strategyVersionStore.server.ts's header for exactly what's
  // versioned (Optimizer TunableParams, not the live hardcoded ensemble)
  // and why it's append-only.
  const [versions, setVersions] = useState<StrategyVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [saveVersionError, setSaveVersionError] = useState<string | null>(null);
  const [showVersionHistory, setShowVersionHistory] = useState(false);

  useEffect(() => {
    if (!showVersionHistory) return;
    setVersionsLoading(true);
    fetch(`/api/strategy-versions?symbol=${encodeURIComponent(symbol)}`)
      .then((res) => res.json())
      .then((json) => setVersions(Array.isArray(json.versions) ? json.versions : []))
      .catch(() => setVersions([]))
      .finally(() => setVersionsLoading(false));
  }, [showVersionHistory, symbol]);

  async function saveAsVersion() {
    if (!data) return;
    const lastFoldWithParams = [...data.result.folds].reverse().find((f) => f.bestParams !== null);
    if (!lastFoldWithParams?.bestParams) {
      setSaveVersionError('No fold produced a winning parameter set to save.');
      return;
    }
    setSavingVersion(true);
    setSaveVersionError(null);
    try {
      const toMetrics = (m: typeof lastFoldWithParams.trainMetrics) =>
        m ? { tradeCount: m.tradeCount, winRate: m.winRate, profitFactor: m.profitFactor, maxDrawdownPct: m.maxDrawdownPct, totalReturnPct: m.totalReturnPct } : null;
      const res = await fetch('/api/strategy-versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          assetType: type,
          interval,
          objective: data.result.objective,
          algorithm: data.result.algorithm,
          params: lastFoldWithParams.bestParams,
          trainMetrics: toMetrics(lastFoldWithParams.trainMetrics),
          testMetrics: toMetrics(lastFoldWithParams.testMetrics),
          stabilityScore: stability?.overallScore ?? null,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setSaveVersionError(json.error ?? 'Save failed');
        return;
      }
      if (showVersionHistory) {
        const json = await res.json();
        setVersions((prev) => [json.version, ...prev]);
      }
    } catch {
      setSaveVersionError('Request failed — check your connection.');
    } finally {
      setSavingVersion(false);
    }
  }

  const combosPreview =
    parseNumberList(emaFastStr).length * parseNumberList(emaSlowStr).length * parseNumberList(rsiThresholdStr).length * parseNumberList(atrMultiplierStr).length * parseNumberList(rewardRiskRatioStr).length;

  const grid = {
    emaFast: parseNumberList(emaFastStr),
    emaSlow: parseNumberList(emaSlowStr),
    rsiThreshold: parseNumberList(rsiThresholdStr),
    atrMultiplier: parseNumberList(atrMultiplierStr),
    rewardRiskRatio: parseNumberList(rewardRiskRatioStr),
  };

  async function run() {
    setLoading(true);
    setError(null);
    setStability(null);
    setStabilityMc(null);
    try {
      const res = await fetch('/api/backtest/optimize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, type, interval, barCount, folds, trainRatio: trainRatio / 100, objective, algorithm, evaluationBudget, grid }),
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? 'Optimizer run failed');
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

  async function runStabilityCheck() {
    if (!data) return;
    const lastFoldWithParams = [...data.result.folds].reverse().find((f) => f.bestParams !== null);
    if (!lastFoldWithParams?.bestParams) {
      setStabilityError('No fold produced a winning parameter set to evaluate.');
      return;
    }
    const params = lastFoldWithParams.bestParams;
    setStabilityParamsUsed(params);
    setStabilityLoading(true);
    setStabilityError(null);
    try {
      const btRes = await fetch('/api/backtest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, type, interval, strategyName: 'tunable', tunableParams: params, barCount }),
      });
      const btJson = await btRes.json();
      if (!btRes.ok) {
        setStabilityError(btJson.error ?? 'Backtest of optimized params failed');
        return;
      }
      const trades = btJson.result.trades;
      if (trades.length < 10) {
        setStability(computeStabilityScore({ optimizer: data.result }));
        setStabilityMc(null);
        return;
      }
      const mcRes = await fetch('/api/backtest/montecarlo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trades, initialCapitalUsd: 10000, simulations: 5000, mode: 'bootstrap' }),
      });
      const mcJson = await mcRes.json();
      const mc: MonteCarloResult | undefined = mcRes.ok ? mcJson.result : undefined;
      setStabilityMc(mc ?? null);
      setStability(computeStabilityScore({ optimizer: data.result, monteCarlo: mc }));
    } catch {
      setStabilityError('Request failed — check your connection.');
    } finally {
      setStabilityLoading(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[10px] text-txt2">
        Grid-searches the Tunable EMA/RSI strategy across a walk-forward split — each fold&apos;s parameters are chosen
        on a training window, then scored on an unseen test window that follows it. A single &quot;best&quot; number
        from one split is how strategies get overfit; the range below across folds is the actual answer to trust.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Symbol
          <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Type
          <select value={type} onChange={(e) => setType(e.target.value as 'crypto' | 'equity')} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0">
            <option value="crypto">Crypto</option>
            <option value="equity">Equity</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Interval
          <select value={interval} onChange={(e) => setInterval_(e.target.value)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0">
            {MTF_TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>{tf}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Bars to fetch
          <input type="number" min={300} max={10000} value={barCount} onChange={(e) => setBarCount(parseInt(e.target.value, 10) || 1500)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Walk-forward folds
          <input type="number" min={1} max={6} value={folds} onChange={(e) => setFolds(parseInt(e.target.value, 10) || 3)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Train % per fold
          <input type="number" min={40} max={90} value={trainRatio} onChange={(e) => setTrainRatio(parseInt(e.target.value, 10) || 70)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Optimize for
          <select value={objective} onChange={(e) => setObjective(e.target.value as OptimizerObjective)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0">
            <option value="profitFactor">Profit Factor</option>
            <option value="totalReturnPct">Total Return %</option>
            <option value="sharpeApprox">Sharpe (per-trade, approx.)</option>
            <option value="expectancyUsd">Expectancy ($/trade)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
          Search algorithm
          <select value={algorithm} onChange={(e) => setAlgorithm(e.target.value as SearchAlgorithmName)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0">
            {(Object.keys(ALGORITHM_LABELS) as SearchAlgorithmName[]).map((a) => (
              <option key={a} value={a}>{ALGORITHM_LABELS[a]}</option>
            ))}
          </select>
        </label>
        {algorithm !== 'grid' && (
          <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2 col-span-2">
            Evaluation budget (backtests per fold)
            <input type="number" min={5} max={300} value={evaluationBudget} onChange={(e) => setEvaluationBudget(parseInt(e.target.value, 10) || 60)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
          </label>
        )}
      </div>

      <div className="border-t border-line pt-2 flex flex-col gap-2">
        <p className="text-[11px] font-mono uppercase tracking-wider text-txt2">
          Parameter grid ({algorithm === 'grid' ? 'literal values searched' : 'min/max used as bounds'})
        </p>
        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
            EMA Fast
            <input value={emaFastStr} onChange={(e) => setEmaFastStr(e.target.value)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
            EMA Slow
            <input value={emaSlowStr} onChange={(e) => setEmaSlowStr(e.target.value)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
            RSI Threshold
            <input value={rsiThresholdStr} onChange={(e) => setRsiThresholdStr(e.target.value)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2">
            ATR Multiplier
            <input value={atrMultiplierStr} onChange={(e) => setAtrMultiplierStr(e.target.value)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
          </label>
          <label className="flex flex-col gap-1 text-[11px] font-mono text-txt2 col-span-2">
            Reward:Risk Ratio
            <input value={rewardRiskRatioStr} onChange={(e) => setRewardRiskRatioStr(e.target.value)} className="bg-bg2 border border-line rounded-md px-2 py-1.5 text-txt0" />
          </label>
        </div>
        {algorithm === 'grid' ? (
          <p className="text-[10px] font-mono text-txt2">
            {combosPreview} combination(s) × {folds} fold(s) {combosPreview > 150 && <span className="text-red">— over the 150-combo cap, narrow the ranges or switch algorithm</span>}
          </p>
        ) : (
          <p className="text-[10px] font-mono text-txt2">{evaluationBudget} evaluations × {folds} fold(s), sampled within the above bounds</p>
        )}
      </div>

      <button onClick={run} disabled={loading || (algorithm === 'grid' && (combosPreview > 150 || combosPreview === 0))} className="px-3 py-2 rounded-md text-[11px] font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 transition disabled:opacity-50">
        {loading ? 'Running (this can take a while)…' : 'Run Optimizer'}
      </button>

      {error && <p className="text-[11px] font-mono text-red">{error}</p>}

      {data && (
        <div className="flex flex-col gap-3 border-t border-line pt-3">
          <p className="text-[10px] font-mono text-txt2">{data.meta.dataSource} · objective: {data.result.objective} · algorithm: {ALGORITHM_LABELS[data.result.algorithm]}</p>

          {data.result.warnings.length > 0 && (
            <div className="rounded-md bg-bg2 border border-line p-2 flex flex-col gap-1">
              {data.result.warnings.map((w, i) => (
                <p key={i} className="text-[10px] font-mono text-amber">⚠ {w}</p>
              ))}
            </div>
          )}

          <div className="rounded-md border border-line p-3 flex flex-col gap-1.5">
            <p className="text-[11px] font-mono uppercase tracking-wider text-txt2">Robust parameter range (across folds)</p>
            {data.result.robustRanges ? (
              (Object.keys(data.result.robustRanges) as (keyof TunableParams)[]).map((key) => {
                const r = data.result!.robustRanges![key];
                const tight = r.max - r.min < r.max * 0.15;
                return (
                  <div key={key} className="flex justify-between text-[11px] font-mono">
                    <span className="text-txt2">{PARAM_LABELS[key]}</span>
                    <span className={tight ? 'text-green' : 'text-amber'}>
                      {r.min === r.max ? r.min : `${r.min} – ${r.max}`} <span className="text-txt2">({r.values.join(', ')})</span>
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="text-[11px] text-txt2">Not enough folds produced a winner to assess robustness — see warnings above.</p>
            )}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-[11px] font-mono uppercase tracking-wider text-txt2">Per-fold detail</p>
            {data.result.folds.map((f) => (
              <div key={f.foldIndex} className="rounded-md border border-line p-2 flex flex-col gap-1 text-[10px] font-mono">
                <p className="text-txt2">
                  Fold {f.foldIndex + 1} · train {new Date(f.trainWindow.startTs).toLocaleDateString()}–{new Date(f.trainWindow.endTs).toLocaleDateString()} ({f.trainWindow.barCount} bars) · test {new Date(f.testWindow.startTs).toLocaleDateString()}–{new Date(f.testWindow.endTs).toLocaleDateString()} ({f.testWindow.barCount} bars) · {f.combosEvaluated} evaluated
                </p>
                {f.bestParams ? (
                  <>
                    <p className="text-txt1">
                      Winner: EMA {f.bestParams.emaFast}/{f.bestParams.emaSlow}, RSI±{f.bestParams.rsiThreshold}, ATR×{f.bestParams.atrMultiplier}, R:R {f.bestParams.rewardRiskRatio}
                    </p>
                    <div className="flex gap-4">
                      <span className="text-txt2">Train: {f.trainMetrics?.tradeCount} trades, {data.result.objective}={f.trainMetrics?.[data.result.objective]?.toFixed(2) ?? 'n/a'}</span>
                      <span className={(f.testMetrics?.[data.result.objective] ?? 0) >= (f.trainMetrics?.[data.result.objective] ?? 0) ? 'text-green' : 'text-amber'}>
                        Test (out-of-sample): {f.testMetrics?.tradeCount ?? 0} trades, {data.result.objective}={f.testMetrics?.[data.result.objective]?.toFixed(2) ?? 'n/a'}
                      </span>
                    </div>
                  </>
                ) : (
                  <p className="text-txt2">No viable combination for this fold.</p>
                )}
              </div>
            ))}
          </div>

          <div className="border-t border-line pt-3 flex flex-col gap-2">
            <div className="flex gap-2">
              <button onClick={runStabilityCheck} disabled={stabilityLoading} className="flex-1 px-3 py-2 rounded-md text-[11px] font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 transition disabled:opacity-50">
                {stabilityLoading ? 'Evaluating…' : "Run Stability Check (real backtest + Monte Carlo on the latest fold's params)"}
              </button>
              <button onClick={saveAsVersion} disabled={savingVersion} className="px-3 py-2 rounded-md text-[11px] font-mono border border-line bg-bg2 text-txt0 hover:bg-bg3 transition disabled:opacity-50 whitespace-nowrap">
                {savingVersion ? 'Saving…' : 'Save as version'}
              </button>
            </div>
            {saveVersionError && <p className="text-[11px] font-mono text-red">{saveVersionError}</p>}
            {stabilityError && <p className="text-[11px] font-mono text-red">{stabilityError}</p>}
            {stability && (
              <div className="rounded-md border border-line p-3 flex flex-col gap-2">
                {stabilityParamsUsed && (
                  <p className="text-[10px] font-mono text-txt2">
                    Evaluated: EMA {stabilityParamsUsed.emaFast}/{stabilityParamsUsed.emaSlow}, RSI±{stabilityParamsUsed.rsiThreshold}, ATR×{stabilityParamsUsed.atrMultiplier}, R:R {stabilityParamsUsed.rewardRiskRatio}
                  </p>
                )}
                <div className="flex items-center justify-between">
                  <span className="text-[12px] font-mono text-txt1">Stability Score</span>
                  <span className={`text-[14px] font-mono font-bold ${stability.overallScore !== null && stability.overallScore >= 65 ? 'text-green' : stability.overallScore !== null && stability.overallScore >= 40 ? 'text-amber' : 'text-red'}`}>
                    {stability.overallScore !== null ? `${stability.overallScore.toFixed(0)}/100` : 'n/a'}
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-2 text-[10px] font-mono">
                  <div><span className="text-txt2">Walk-forward</span><br /><span className="text-txt0">{stability.walkForwardBand}</span></div>
                  <div><span className="text-txt2">Param sensitivity</span><br /><span className="text-txt0">{stability.parameterSensitivityBand}</span></div>
                  <div><span className="text-txt2">Monte Carlo</span><br /><span className="text-txt0">{stability.monteCarloBand}</span></div>
                </div>
                <p className={`text-[12px] font-mono font-semibold ${stability.recommendation === 'Deploy' ? 'text-green' : stability.recommendation === 'Deploy with caution' ? 'text-amber' : 'text-red'}`}>
                  Recommendation: {stability.recommendation}
                </p>
                {stabilityMc && (
                  <p className="text-[10px] font-mono text-txt2">Monte Carlo: {stabilityMc.riskOfRuinPct.toFixed(1)}% risk of ruin, median outcome {stabilityMc.finalEquityPct.p50 >= 0 ? '+' : ''}{stabilityMc.finalEquityPct.p50.toFixed(0)}%</p>
                )}
                <div className="flex flex-col gap-0.5">
                  {stability.reasons.map((r, i) => (
                    <p key={i} className="text-[9.5px] text-txt2">• {r}</p>
                  ))}
                </div>
                <p className="text-[9px] text-txt2 italic">Heuristic composite, not a statistically validated single metric — a prompt to look closer, not a substitute for judgment.</p>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="border-t border-line pt-3">
        <button onClick={() => setShowVersionHistory(!showVersionHistory)} className="text-[10px] font-mono text-txt2 hover:text-txt0 flex items-center gap-1">
          {showVersionHistory ? '▾' : '▸'} Version history for {symbol}
        </button>
        {showVersionHistory && (
          <div className="mt-2 flex flex-col gap-2">
            {versionsLoading && <p className="text-[11px] text-txt2">Loading…</p>}
            {!versionsLoading && versions.length === 0 && <p className="text-[11px] text-txt2">No saved versions for this symbol yet.</p>}
            {versions.map((v) => (
              <div key={v.id} className="rounded-md border border-line p-2 flex flex-col gap-1 text-[10px] font-mono">
                <div className="flex items-center justify-between">
                  <span className="text-txt1">{new Date(v.ts).toLocaleString()}</span>
                  <span className="text-txt2">{v.algorithm} · {v.objective}</span>
                </div>
                <p className="text-txt2">
                  EMA {v.params.emaFast}/{v.params.emaSlow}, RSI±{v.params.rsiThreshold}, ATR×{v.params.atrMultiplier}, R:R {v.params.rewardRiskRatio}
                </p>
                {v.testMetrics && (
                  <p className="text-txt0">
                    Out-of-sample: {v.testMetrics.tradeCount} trades, win rate {v.testMetrics.winRate !== null ? `${(v.testMetrics.winRate * 100).toFixed(0)}%` : 'n/a'}, profit factor{' '}
                    {v.testMetrics.profitFactor !== null ? v.testMetrics.profitFactor.toFixed(2) : 'n/a'}, max drawdown {v.testMetrics.maxDrawdownPct.toFixed(1)}%
                  </p>
                )}
                {v.stabilityScore !== null && <p className="text-txt2">Stability score: {v.stabilityScore.toFixed(0)}/100</p>}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
