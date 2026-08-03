import type { BacktestTrade } from './engine';

// The single historical equity curve is ONE path through randomness —
// the actual sequence of wins/losses that happened to occur. Monte
// Carlo simulation asks: if the same set of trades (same win rate, same
// win/loss sizes) had happened in a DIFFERENT order, or with the same
// per-trade statistics resampled with replacement, how much would the
// outcome vary? A strategy whose backtest looked great only because of
// favorable trade ORDERING is fragile in exactly the way this reveals.
//
// Two resampling modes are offered:
// - 'shuffle': permute the existing trades' order (same trades, no
//   trade is ever duplicated or dropped) — tests order-dependency only.
// - 'bootstrap': resample trades WITH replacement to the same count —
//   also tests sensitivity to which trades occurred at all, a stronger
//   (and standard) form of the technique.

export type MonteCarloMode = 'shuffle' | 'bootstrap';

export type MonteCarloParams = {
  trades: BacktestTrade[];
  initialCapitalUsd: number;
  simulations?: number; // default 5000
  mode?: MonteCarloMode; // default 'bootstrap'
  ruinThresholdPct?: number; // default 50 — "ruin" = equity ever falls to this % of initial capital or below
  seed?: number; // for reproducibility
};

export type MonteCarloResult = {
  simulations: number;
  mode: MonteCarloMode;
  finalEquityFractions: number[]; // sorted, raw distribution (equity / initialCapital) — for plotting a histogram client-side
  finalEquityPct: { p5: number; p25: number; p50: number; p75: number; p95: number; mean: number };
  maxDrawdownPct: { p5: number; p25: number; p50: number; p75: number; p95: number; worst: number; best: number };
  riskOfRuinPct: number;
  expectedReturnPct: number;
  historicalFinalEquityPct: number;
  warnings: string[];
};

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// Separate seeded RNG instance from executionModel.ts's mulberry32 so
// Monte Carlo runs don't share state with backtest execution-mode
// randomness.
function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

const MIN_TRADES_FOR_MONTE_CARLO = 10;
const MAX_SIMULATIONS = 20000;

export function runMonteCarlo(params: MonteCarloParams): MonteCarloResult | { error: string } {
  const { trades, initialCapitalUsd, simulations = 5000, mode = 'bootstrap', ruinThresholdPct = 50, seed = 12345 } = params;

  if (trades.length < MIN_TRADES_FOR_MONTE_CARLO) {
    return { error: `Need at least ${MIN_TRADES_FOR_MONTE_CARLO} closed trades to run a meaningful Monte Carlo simulation (got ${trades.length}) — fewer than that and every resample is nearly identical to the original, telling you nothing new.` };
  }
  if (simulations < 100 || simulations > MAX_SIMULATIONS) {
    return { error: `simulations must be between 100 and ${MAX_SIMULATIONS}.` };
  }

  const rng = seededRng(seed);
  const pnlPctSeries = trades.map((t) => t.pnlPct / 100); // fractional per-trade return on capital-at-risk for that trade

  const finalEquityFractions: number[] = [];
  const maxDrawdownFractions: number[] = [];
  let ruinCount = 0;
  const ruinFraction = ruinThresholdPct / 100;

  for (let sim = 0; sim < simulations; sim++) {
    let sequence: number[];
    if (mode === 'shuffle') {
      sequence = [...pnlPctSeries];
      for (let i = sequence.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [sequence[i], sequence[j]] = [sequence[j], sequence[i]];
      }
    } else {
      sequence = [];
      for (let i = 0; i < pnlPctSeries.length; i++) {
        sequence.push(pnlPctSeries[Math.floor(rng() * pnlPctSeries.length)]);
      }
    }

    // Each trade's pnlPct is a return on THAT trade's own capital-at-risk,
    // not the whole account — compounding sequentially against a running
    // equity value (same convention the backtest engine itself uses:
    // position sizing is a fraction of current equity) gives a realistic
    // simulated equity path rather than just summing percentages.
    let equity = initialCapitalUsd;
    let peak = equity;
    let maxDd = 0;
    let touchedRuin = false;
    for (const r of sequence) {
      equity *= 1 + r;
      peak = Math.max(peak, equity);
      const dd = peak > 0 ? (peak - equity) / peak : 0;
      maxDd = Math.max(maxDd, dd);
      if (equity <= initialCapitalUsd * ruinFraction) touchedRuin = true;
    }
    finalEquityFractions.push(equity / initialCapitalUsd);
    maxDrawdownFractions.push(maxDd);
    if (touchedRuin) ruinCount++;
  }

  finalEquityFractions.sort((a, b) => a - b);
  maxDrawdownFractions.sort((a, b) => a - b);

  const historicalFinalEquity = trades.reduce((equity, t) => equity * (1 + t.pnlPct / 100), initialCapitalUsd);

  const warnings: string[] = [];
  if (trades.length < 30) {
    warnings.push(`Only ${trades.length} historical trades to resample from — Monte Carlo output here is a real statistical exercise, but with a small underlying sample its confidence bands are wide. Treat this as directional, not precise.`);
  }

  return {
    simulations,
    mode,
    finalEquityFractions,
    finalEquityPct: {
      p5: (percentile(finalEquityFractions, 5) - 1) * 100,
      p25: (percentile(finalEquityFractions, 25) - 1) * 100,
      p50: (percentile(finalEquityFractions, 50) - 1) * 100,
      p75: (percentile(finalEquityFractions, 75) - 1) * 100,
      p95: (percentile(finalEquityFractions, 95) - 1) * 100,
      mean: (finalEquityFractions.reduce((a, b) => a + b, 0) / finalEquityFractions.length - 1) * 100,
    },
    maxDrawdownPct: {
      p5: percentile(maxDrawdownFractions, 5) * 100,
      p25: percentile(maxDrawdownFractions, 25) * 100,
      p50: percentile(maxDrawdownFractions, 50) * 100,
      p75: percentile(maxDrawdownFractions, 75) * 100,
      p95: percentile(maxDrawdownFractions, 95) * 100,
      worst: maxDrawdownFractions[maxDrawdownFractions.length - 1] * 100,
      best: maxDrawdownFractions[0] * 100,
    },
    riskOfRuinPct: (ruinCount / simulations) * 100,
    expectedReturnPct: (finalEquityFractions.reduce((a, b) => a + b, 0) / finalEquityFractions.length - 1) * 100,
    historicalFinalEquityPct: (historicalFinalEquity / initialCapitalUsd - 1) * 100,
    warnings,
  };
}
