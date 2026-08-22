'use client';

// ---------------------------------------------------------------------
// /backtesting — hosts the REAL backtest and optimizer panels.
//
// An earlier draft of this page called `/api/backtest` with a symbol and an
// interval and drew the equity curve. That was a REGRESSION dressed as a rewrite:
// the route it replaces (`/backtest`) mounts `BacktestPanel` and `OptimizerPanel`,
// which between them expose strategy selection, multi-timeframe confirmation, a
// regime breakdown, Monte Carlo, walk-forward folds, four search algorithms and a
// stability score. Shipping the thin version would have deleted all of it while
// looking like progress.
//
// Both panels are framework-native components already wired to `lib/backtest/` and
// the live providers, so they are mounted, not reimplemented. A second
// implementation of a backtester could disagree with the first about a result, and
// two disagreeing Sharpe ratios are worse than one.
//
// This uses the TypeScript engine, not the Python `HistoricalBacktestEngine` — that
// one rebinds shared agent singletons for the duration of a run and is unsafe to
// call from a live process.
// ---------------------------------------------------------------------

import { useState } from 'react';

import { BacktestPanel } from '@/components/BacktestPanel';
import { OptimizerPanel } from '@/components/OptimizerPanel';
import { OperatorSection } from '@/components/operator/OperatorSection';

const TABS = [
  { key: 'backtest' as const, label: 'Backtest' },
  { key: 'optimize' as const, label: 'Optimize' },
];

export default function BacktestingPage() {
  const [tab, setTab] = useState<'backtest' | 'optimize'>('backtest');

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap">
        <h1 className="text-[17px] font-semibold">Backtesting Lab</h1>
        <span className="flex gap-1.5">
          {TABS.map((t) => (
            <button key={t.key} type="button" className={`chip${tab === t.key ? ' on' : ''}`} onClick={() => setTab(t.key)}>
              {t.label}
            </button>
          ))}
        </span>
      </div>

      {tab === 'backtest' ? (
        <OperatorSection
          title="Historical backtest"
          note="Runs the TypeScript engine in lib/backtest/ over candles fetched for the chosen symbol and interval. Fills are modelled, not simulated against a real book — the result is an estimate and the engine's own comments say where it is optimistic."
        >
          <BacktestPanel />
        </OperatorSection>
      ) : (
        <OperatorSection
          title="Parameter optimizer"
          note="Walk-forward folds with a train/test split, so a parameter set is scored on data it was not fitted to. The stability score is the guard against a result that only holds on one fold; a high in-sample return with a low stability score is overfitting, not an edge."
        >
          <OptimizerPanel />
        </OperatorSection>
      )}

      <div className="text-[10.5px] leading-relaxed" style={{ color: 'var(--text-muted)' }}>
        A backtest result never changes live configuration on its own. Applying anything
        learned here is an explicit human action on the Risk page — there is no path from a
        good backtest to a live risk limit.
      </div>
    </div>
  );
}
