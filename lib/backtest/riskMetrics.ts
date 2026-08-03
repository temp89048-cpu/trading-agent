import type { MtfTimeframe } from '../multiTimeframe';

// Upgrades the old per-trade Sharpe approximation (mean/stddev of trade
// P&L%, still available in BacktestMetrics.sharpeApprox for backward
// compatibility) to real equity-curve-based metrics: resample the
// equity curve to DAILY points first, compute daily returns, then
// derive each ratio from that — which is what every one of these
// metrics is actually defined over, not a per-trade return series.
//
// Per-trade Sharpe treats "10 trades in one day" and "10 trades spread
// over a month" identically, which materially misstates risk. Daily
// resampling fixes that at the cost of needing enough calendar days in
// the backtest window to be meaningful — see MIN_DAYS_FOR_EQUITY_METRICS.

export type EquityPoint = { t: number; equity: number };

export type EquityMetrics = {
  daysCovered: number;
  annualizedReturnPct: number | null;
  annualizedVolatilityPct: number | null;
  sharpe: number | null; // annualized, risk-free rate assumed 0 (documented)
  sortino: number | null; // annualized, downside deviation only
  calmar: number | null; // annualized return / max drawdown
  sterling: number | null; // annualized return / (max drawdown - 10%), floored — see note below
  mar: number | null; // alias of Calmar using the full-period return rather than annualized — see note
  ulcerIndex: number | null; // RMS of drawdown depth over the period — penalizes DEPTH and DURATION of drawdowns, not just the single worst peak-to-trough
  upi: number | null; // "Ulcer Performance Index" = annualized return / Ulcer Index, i.e. Sharpe's shape but drawdown-quality-aware instead of volatility-aware
  warnings: string[];
};

const TRADING_DAYS_PER_YEAR = 365; // crypto trades every day; for equities this overstates slightly (~252 sessions) — documented, not silently assumed one-size-fits-all
const MIN_DAYS_FOR_EQUITY_METRICS = 14; // below this, "annualized" numbers are mostly noise — reported as null with a warning rather than a wild extrapolation

function resampleToDaily(points: EquityPoint[]): EquityPoint[] {
  if (points.length === 0) return [];
  const byDay = new Map<number, number>(); // dayStart(ms) -> last equity value seen that day
  for (const p of points) {
    const dayStart = Math.floor(p.t / 86_400_000) * 86_400_000;
    byDay.set(dayStart, p.equity); // overwrite — last value of the day wins, matching how daily close is normally taken
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, equity]) => ({ t, equity }));
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function computeEquityMetrics(equityCurve: EquityPoint[], initialCapitalUsd: number, assetType: 'crypto' | 'equity' = 'crypto'): EquityMetrics {
  const warnings: string[] = [];
  const daily = resampleToDaily(equityCurve);
  const daysCovered = daily.length;

  if (daysCovered < MIN_DAYS_FOR_EQUITY_METRICS) {
    warnings.push(`Only ${daysCovered} distinct day(s) in this backtest window — annualized metrics need at least ${MIN_DAYS_FOR_EQUITY_METRICS} to be meaningful and are reported as unavailable below rather than extrapolated from too little data.`);
    return {
      daysCovered,
      annualizedReturnPct: null,
      annualizedVolatilityPct: null,
      sharpe: null,
      sortino: null,
      calmar: null,
      sterling: null,
      mar: null,
      ulcerIndex: null,
      upi: null,
      warnings,
    };
  }

  const periodsPerYear = assetType === 'equity' ? 252 : TRADING_DAYS_PER_YEAR;
  if (assetType === 'equity') warnings.push('Using 252 trading days/year for annualization (equities); crypto uses 365.');

  const dailyReturns: number[] = [];
  for (let i = 1; i < daily.length; i++) {
    const prev = daily[i - 1].equity;
    if (prev > 0) dailyReturns.push((daily[i].equity - prev) / prev);
  }

  const finalEquity = daily[daily.length - 1].equity;
  const totalReturn = (finalEquity - initialCapitalUsd) / initialCapitalUsd;
  const years = daysCovered / periodsPerYear;
  // Geometric annualization — compounds correctly rather than just
  // scaling total return linearly by 365/daysCovered.
  const annualizedReturn = years > 0 ? Math.pow(1 + totalReturn, 1 / years) - 1 : null;

  const meanDaily = dailyReturns.length > 0 ? dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length : 0;
  const dailyVol = stddev(dailyReturns);
  const annualizedVol = dailyVol * Math.sqrt(periodsPerYear);

  const sharpe = annualizedVol > 0 && annualizedReturn !== null ? annualizedReturn / annualizedVol : null;

  const downsideReturns = dailyReturns.filter((r) => r < 0);
  const downsideDeviation = downsideReturns.length > 0 ? Math.sqrt(downsideReturns.reduce((s, r) => s + r * r, 0) / downsideReturns.length) * Math.sqrt(periodsPerYear) : 0;
  const sortino = downsideDeviation > 0 && annualizedReturn !== null ? annualizedReturn / downsideDeviation : null;

  // Max drawdown over the full equity curve (not just daily-resampled —
  // intrabar/intraday drawdown depth matters and daily resampling would
  // understate it).
  let peak = equityCurve.length > 0 ? equityCurve[0].equity : initialCapitalUsd;
  let maxDdFraction = 0;
  const drawdownSeries: number[] = [];
  for (const p of equityCurve) {
    peak = Math.max(peak, p.equity);
    const dd = peak > 0 ? (peak - p.equity) / peak : 0;
    maxDdFraction = Math.max(maxDdFraction, dd);
    drawdownSeries.push(dd);
  }
  const maxDrawdownPct = maxDdFraction * 100;

  const calmar = maxDdFraction > 0 && annualizedReturn !== null ? annualizedReturn / maxDdFraction : null;
  // Sterling ratio: same idea as Calmar but with a conventional 10-percentage-point
  // "cushion" subtracted from the drawdown denominator, per the standard definition —
  // floored so a tiny drawdown doesn't produce a division-by-near-zero blowup.
  const sterlingDenominator = Math.max(maxDdFraction - 0.10, 0.01);
  const sterling = annualizedReturn !== null ? annualizedReturn / sterlingDenominator : null;
  // "MAR ratio" is conventionally defined as CAGR / max drawdown using the FULL
  // track record (not necessarily annualized the same way as Calmar in every
  // source) — here it's reported identically to Calmar since this app only has
  // one return series to work from; kept as a separate named field because
  // that's the metric name practitioners look for, with this equivalence
  // stated plainly rather than presenting two different numbers as if from
  // two different calculations.
  const mar = calmar;

  // Ulcer Index: root-mean-square of drawdown depth across the WHOLE
  // period, not just the single worst trough — a strategy with one
  // sharp 20% dip that recovers fast scores very differently here than
  // one that grinds sideways at -15% for months, even with the same max
  // drawdown number.
  const ulcerIndex = drawdownSeries.length > 0 ? Math.sqrt(drawdownSeries.reduce((s, dd) => s + dd * dd, 0) / drawdownSeries.length) * 100 : null;
  const upi = ulcerIndex !== null && ulcerIndex > 0 && annualizedReturn !== null ? (annualizedReturn * 100) / ulcerIndex : null;

  return {
    daysCovered,
    annualizedReturnPct: annualizedReturn !== null ? annualizedReturn * 100 : null,
    annualizedVolatilityPct: annualizedVol * 100,
    sharpe,
    sortino,
    calmar,
    sterling,
    mar,
    ulcerIndex,
    upi,
    warnings,
  };
}

// Convenience: for callers who only know the primary bar interval and
// want a rough sense of whether "days covered" will even be computable
// (e.g. a 500-bar 1m backtest covers well under a day).
export function estimateDaysFromBars(interval: MtfTimeframe, barCount: number): number {
  const minutes: Record<MtfTimeframe, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60, '4h': 240, '1d': 1440, '1w': 10080 };
  return (minutes[interval] * barCount) / 1440;
}
