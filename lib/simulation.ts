// ---------------------------------------------------------------------
// Pre-trade Simulation / Stress Test (Level 18)
//
// Distinct from lib/backtest/monteCarlo.ts, which resamples REAL closed
// trades from history. This module has no trade history to draw on —
// it's asking a different question: "given this ONE proposed entry,
// stop-loss and take-profit, and the asset's recent realized volatility
// (ATR), what's the probability TP gets hit before SL?"
//
// That means a real random-walk simulation forward from entry, not a
// resample. Explicitly documented approximations, so nothing here reads
// as more certain than it is:
//   - ATR is used as a per-bar volatility proxy (a "one-sigma-ish" bar
//     move), which is the standard practical use of ATR for this kind
//     of stress test — it is NOT a literal standard deviation, and this
//     says so rather than pretending otherwise.
//   - The walk assumes ZERO directional drift — deliberately neutral,
//     not a price prediction. This is a stress test of the SL/TP
//     placement given realistic noise, not a forecast of where price is
//     "really" headed.
//   - Feeds into, never bypasses, the Commit 13 risk gate — this is
//     informational only.
// ---------------------------------------------------------------------

export type SimulationParams = {
  side: 'buy' | 'sell';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  atrValue: number; // per-bar volatility proxy, same timeframe the SL/TP were computed on
  maxBars?: number; // default 200 — simulation horizon before calling it "neither hit"
  simulations?: number; // default 4000
  seed?: number; // default 12345, for reproducibility
};

export type SimulationResult = {
  simulations: number;
  maxBars: number;
  probTakeProfitFirstPct: number;
  probStopLossFirstPct: number;
  probNeitherWithinHorizonPct: number;
  expectedBarsToOutcome: number | null; // mean bars-to-resolution among sims that hit either level; null if none resolved
  rewardRiskRatio: number; // |takeProfit - entry| / |entry - stopLoss|
  expectedValueR: number; // probTP * rewardRiskRatio - probSL * 1, in units of R (risk = 1R by definition)
  // Potential drawdown — the deepest adverse move AGAINST the position
  // seen along each simulated path before it resolves (or through the
  // horizon, for paths that never resolve), in units of R (risk). This
  // answers "how much pain might I sit through," which is a different
  // question from "does TP or SL get hit first" — a path can still hit
  // TP while having dipped deep into adverse territory first.
  avgMaxAdverseExcursionR: number;
  worstMaxAdverseExcursionR: number; // 95th percentile across all simulated paths, not the single worst outlier
  warnings: string[];
};

const MIN_SIMULATIONS = 100;
const MAX_SIMULATIONS = 20000;
const MIN_MAX_BARS = 5;
const MAX_MAX_BARS = 2000;

// Same mulberry32-style seeded PRNG pattern already used in
// lib/backtest/monteCarlo.ts, but a fresh instance every call — this
// module's randomness should never be entangled with backtest Monte
// Carlo state.
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

// Box-Muller transform: turns two independent uniform(0,1) draws from
// the seeded RNG above into one standard-normal draw, so the simulated
// per-bar move is a realistic bell-curve-shaped random shock scaled by
// ATR, not a uniform (unrealistically flat) one.
function makeGaussian(rng: () => number): () => number {
  let spare: number | null = null;
  return function () {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    const mag = Math.sqrt(-2.0 * Math.log(u));
    const z0 = mag * Math.cos(2.0 * Math.PI * v);
    const z1 = mag * Math.sin(2.0 * Math.PI * v);
    spare = z1;
    return z0;
  };
}

export function runTradeSimulation(params: SimulationParams): SimulationResult | { error: string } {
  const { side, entryPrice, stopLoss, takeProfit, atrValue, maxBars = 200, simulations = 4000, seed = 12345 } = params;

  if (!isFinite(entryPrice) || entryPrice <= 0) return { error: 'entryPrice must be a positive number.' };
  if (!isFinite(atrValue) || atrValue <= 0) return { error: 'atrValue must be a positive number — no volatility read available to stress-test against.' };
  if (!isFinite(stopLoss) || !isFinite(takeProfit)) return { error: 'stopLoss and takeProfit must both be finite numbers.' };
  if (simulations < MIN_SIMULATIONS || simulations > MAX_SIMULATIONS) return { error: `simulations must be between ${MIN_SIMULATIONS} and ${MAX_SIMULATIONS}.` };
  if (maxBars < MIN_MAX_BARS || maxBars > MAX_MAX_BARS) return { error: `maxBars must be between ${MIN_MAX_BARS} and ${MAX_MAX_BARS}.` };

  if (side === 'buy') {
    if (!(stopLoss < entryPrice && takeProfit > entryPrice)) {
      return { error: 'For a buy, stopLoss must be below entry and takeProfit must be above entry.' };
    }
  } else {
    if (!(stopLoss > entryPrice && takeProfit < entryPrice)) {
      return { error: 'For a sell, stopLoss must be above entry and takeProfit must be below entry.' };
    }
  }

  const riskDistance = Math.abs(entryPrice - stopLoss);
  const rewardDistance = Math.abs(takeProfit - entryPrice);
  if (riskDistance <= 0) return { error: 'stopLoss cannot equal entryPrice — zero risk distance.' };
  const rewardRiskRatio = rewardDistance / riskDistance;

  const rng = seededRng(seed);
  const gaussian = makeGaussian(rng);

  let tpFirst = 0;
  let slFirst = 0;
  let neither = 0;
  let totalBarsToResolution = 0;
  let resolvedCount = 0;
  const maeValues: number[] = []; // max adverse excursion per path, in R units

  for (let sim = 0; sim < simulations; sim++) {
    let price = entryPrice;
    let resolved = false;
    let worstAdverse = 0; // in raw price units, against the position
    for (let bar = 1; bar <= maxBars; bar++) {
      price += gaussian() * atrValue;
      const adverse = side === 'buy' ? entryPrice - price : price - entryPrice;
      if (adverse > worstAdverse) worstAdverse = adverse;
      const hitTp = side === 'buy' ? price >= takeProfit : price <= takeProfit;
      const hitSl = side === 'buy' ? price <= stopLoss : price >= stopLoss;
      // If a single simulated bar-step overshoots past BOTH levels in
      // one jump (large ATR relative to the distances), treat it as a
      // tie broken in favor of the stop — the conservative assumption,
      // since real intrabar path order is unknown from a single close-
      // to-close step.
      if (hitTp && hitSl) {
        slFirst++;
        totalBarsToResolution += bar;
        resolvedCount++;
        resolved = true;
        break;
      }
      if (hitTp) {
        tpFirst++;
        totalBarsToResolution += bar;
        resolvedCount++;
        resolved = true;
        break;
      }
      if (hitSl) {
        slFirst++;
        totalBarsToResolution += bar;
        resolvedCount++;
        resolved = true;
        break;
      }
    }
    if (!resolved) neither++;
    // Capped at 1R — the stop itself defines the worst adverse move this
    // position is meant to sustain; a path that overshot past the stop
    // in one jump (the tie-break case above) still reads as "hit its 1R
    // limit," not more, since the position closed there.
    maeValues.push(Math.min(worstAdverse, riskDistance) / riskDistance);
  }

  const probTakeProfitFirstPct = (tpFirst / simulations) * 100;
  const probStopLossFirstPct = (slFirst / simulations) * 100;
  const probNeitherWithinHorizonPct = (neither / simulations) * 100;

  const sortedMae = [...maeValues].sort((a, b) => a - b);
  const avgMaxAdverseExcursionR = sortedMae.reduce((s, v) => s + v, 0) / sortedMae.length;
  const p95Index = Math.min(sortedMae.length - 1, Math.floor(sortedMae.length * 0.95));
  const worstMaxAdverseExcursionR = sortedMae[p95Index];

  const warnings: string[] = [];
  if (rewardDistance / atrValue > maxBars * 0.5 || riskDistance / atrValue > maxBars * 0.5) {
    warnings.push(`TP/SL distance is large relative to per-bar volatility (ATR) and the ${maxBars}-bar horizon — a meaningful share of runs may show "neither hit," meaning the horizon is too short to resolve this trade, not that the trade is safe.`);
  }
  if (probNeitherWithinHorizonPct > 30) {
    warnings.push(`${probNeitherWithinHorizonPct.toFixed(1)}% of simulated paths hit neither level within ${maxBars} bars — consider this a lower-confidence read; the true outcome distribution beyond the horizon isn't captured here.`);
  }

  return {
    simulations,
    maxBars,
    probTakeProfitFirstPct,
    probStopLossFirstPct,
    probNeitherWithinHorizonPct,
    expectedBarsToOutcome: resolvedCount > 0 ? totalBarsToResolution / resolvedCount : null,
    rewardRiskRatio,
    expectedValueR: (probTakeProfitFirstPct / 100) * rewardRiskRatio - probStopLossFirstPct / 100,
    avgMaxAdverseExcursionR,
    worstMaxAdverseExcursionR,
    warnings,
  };
}
