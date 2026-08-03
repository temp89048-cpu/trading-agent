import { buildRealizedEquityCurve, PAPER_STARTING_EQUITY } from './riskManager';
import { computeEquityMetrics, type EquityMetrics } from './backtest/riskMetrics';
import type { TradeLogEntry } from './types';

// Real-Time Performance Analytics (Production Readiness Review #12).
// Sharpe/Sortino/Calmar/Sterling/Ulcer already existed for BACKTEST
// equity curves (lib/backtest/riskMetrics.ts) — this reuses that exact,
// already-reviewed math against the LIVE realized trade log instead of
// re-deriving a second, possibly-inconsistent set of formulas.
//
// Paper tab only: buildRealizedEquityCurve anchors at a fixed starting
// cash figure that only means something for the paper account (same
// reason lib/riskManager.ts's checkDailyLoss/checkDrawdown are also
// paper-only) — the real tab has no tracked equity baseline in this app.

export type LiveEquityMetrics = EquityMetrics & { hasData: boolean };

const INSUFFICIENT_DATA: LiveEquityMetrics = {
  daysCovered: 0,
  annualizedReturnPct: null,
  annualizedVolatilityPct: null,
  sharpe: null,
  sortino: null,
  calmar: null,
  sterling: null,
  mar: null,
  ulcerIndex: null,
  upi: null,
  warnings: ['Not enough closed paper trades yet to compute live performance metrics.'],
  hasData: false,
};

export function computeLiveEquityMetrics(tradeLog: TradeLogEntry[]): LiveEquityMetrics {
  const curve = buildRealizedEquityCurve(tradeLog, 'paper');
  // Drop the synthetic ts=0 anchor point before handing this to
  // computeEquityMetrics. Real trade timestamps are Date.now() values —
  // decades after epoch — so keeping ts=0 in would create one fake "day"
  // back in 1970 and the very first daily-return sample would span that
  // entire multi-decade gap as if it were a single ordinary trading day,
  // badly corrupting the volatility/Sharpe/Sortino math. The starting
  // balance is still correctly represented: it's just the equity value
  // the first REAL trade's daily bucket started from, via initialCapital
  // below, not a data point on the curve itself.
  const realPoints = curve.filter((p) => p.ts > 0).map((p) => ({ t: p.ts, equity: p.equity }));
  if (realPoints.length < 2) return INSUFFICIENT_DATA;

  const metrics = computeEquityMetrics(realPoints, PAPER_STARTING_EQUITY, 'crypto');
  return { ...metrics, hasData: true };
}
