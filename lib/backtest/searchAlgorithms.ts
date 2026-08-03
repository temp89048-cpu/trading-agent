import type { ParamGrid } from './optimizer';
import type { TunableParams } from './tunableStrategy';

// Optuna/Hyperopt themselves are Python libraries and can't be embedded
// in this Next.js/TypeScript app — rather than shell out to Python (a
// much bigger, fragile addition) this implements the same CLASSES of
// algorithm natively: exhaustive grid (existing), random search,
// a genetic algorithm, and a real (if deliberately simplified)
// Bayesian optimizer using a fixed-hyperparameter Gaussian Process with
// Expected Improvement. "Simplified" specifically means: the GP kernel
// hyperparameters (lengthscale, signal variance, noise variance) are
// fixed constants rather than fit by marginal-likelihood optimization —
// a real GP library would tune those; this one doesn't, and says so.

export type SearchAlgorithmName = 'grid' | 'random' | 'genetic' | 'bayesian';

export type EvaluationResult = { params: TunableParams; score: number } | null; // null = combo was unviable (e.g. too few trades) — see evaluate() contract below

export type SearchResult = {
  best: TunableParams | null;
  bestScore: number;
  evaluatedCount: number;
  history: { params: TunableParams; score: number | null }[]; // every combo actually tried, in order — useful for showing convergence
};

type Bounds = { min: number; max: number; integer: boolean };
type ParamBounds = Record<keyof TunableParams, Bounds>;

const PARAM_KEYS: (keyof TunableParams)[] = ['emaFast', 'emaSlow', 'rsiThreshold', 'atrMultiplier', 'rewardRiskRatio'];
const INTEGER_PARAMS = new Set<keyof TunableParams>(['emaFast', 'emaSlow']);

export function gridToBounds(grid: ParamGrid): ParamBounds {
  const out = {} as ParamBounds;
  for (const key of PARAM_KEYS) {
    const values = grid[key];
    out[key] = { min: Math.min(...values), max: Math.max(...values), integer: INTEGER_PARAMS.has(key) };
  }
  return out;
}

function sampleUniform(b: Bounds, rng: () => number): number {
  const v = b.min + rng() * (b.max - b.min);
  return b.integer ? Math.round(v) : Math.round(v * 100) / 100;
}

function clampToBounds(v: number, b: Bounds): number {
  const clamped = Math.min(b.max, Math.max(b.min, v));
  return b.integer ? Math.round(clamped) : Math.round(clamped * 100) / 100;
}

function randomParams(bounds: ParamBounds, rng: () => number): TunableParams {
  let emaFast = sampleUniform(bounds.emaFast, rng);
  let emaSlow = sampleUniform(bounds.emaSlow, rng);
  if (emaFast >= emaSlow) {
    const lo = Math.min(emaFast, emaSlow);
    emaFast = lo;
    emaSlow = Math.max(lo + 1, clampToBounds(lo + 1, bounds.emaSlow));
  }
  return {
    emaFast,
    emaSlow,
    rsiThreshold: sampleUniform(bounds.rsiThreshold, rng),
    atrMultiplier: sampleUniform(bounds.atrMultiplier, rng),
    rewardRiskRatio: sampleUniform(bounds.rewardRiskRatio, rng),
  };
}

// evaluate() contract: returns a finite score for a viable combo, or
// null if the combo should be treated as unviable (e.g. too few trades
// on the training window to trust) — same "don't score noise" rule the
// grid search already used.
export type EvaluateFn = (params: TunableParams) => number | null;

// -----------------------------------------------------------------
// Grid search — exhaustive, deterministic. Extracted here so all four
// algorithms share one call signature; optimizer.ts's cartesianProduct
// still does the actual enumeration since it also validates emaFast <
// emaSlow per-pair before this ever runs.
// -----------------------------------------------------------------
export function searchGrid(combos: TunableParams[], evaluate: EvaluateFn): SearchResult {
  const history: SearchResult['history'] = [];
  let best: TunableParams | null = null;
  let bestScore = -Infinity;
  for (const combo of combos) {
    const score = evaluate(combo);
    history.push({ params: combo, score });
    if (score !== null && score > bestScore) {
      bestScore = score;
      best = combo;
    }
  }
  return { best, bestScore, evaluatedCount: combos.length, history };
}

// -----------------------------------------------------------------
// Random search — uniform sampling within the grid's min/max bounds per
// dimension, rather than only the discrete literal values listed. Simple,
// and a well-known strong baseline: it often matches grid search with
// far fewer evaluations, especially when few of the dimensions actually
// matter.
// -----------------------------------------------------------------
export function searchRandom(grid: ParamGrid, evaluate: EvaluateFn, maxEvaluations: number, rng: () => number): SearchResult {
  const bounds = gridToBounds(grid);
  const history: SearchResult['history'] = [];
  let best: TunableParams | null = null;
  let bestScore = -Infinity;
  for (let i = 0; i < maxEvaluations; i++) {
    const params = randomParams(bounds, rng);
    const score = evaluate(params);
    history.push({ params, score });
    if (score !== null && score > bestScore) {
      bestScore = score;
      best = params;
    }
  }
  return { best, bestScore, evaluatedCount: maxEvaluations, history };
}

// -----------------------------------------------------------------
// Genetic algorithm — small, real GA: elitism + uniform crossover +
// gaussian mutation. Unviable individuals (evaluate() returns null) are
// scored as -Infinity for selection purposes so they never get bred
// from, but are still recorded in history for transparency.
// -----------------------------------------------------------------
const GA_POPULATION_SIZE = 12;
const GA_ELITE_FRACTION = 0.34; // top ~4 of 12 survive as parents each generation
const GA_MUTATION_RATE = 0.25;
const GA_MUTATION_STRENGTH = 0.15; // fraction of the dimension's range used as mutation stddev

function mutateParam(value: number, b: Bounds, rng: () => number): number {
  if (rng() > GA_MUTATION_RATE) return value;
  const range = b.max - b.min;
  // Box-Muller for a roughly-gaussian perturbation from two uniform draws.
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  const gaussian = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return clampToBounds(value + gaussian * range * GA_MUTATION_STRENGTH, b);
}

function crossover(a: TunableParams, b: TunableParams, bounds: ParamBounds, rng: () => number): TunableParams {
  const child: Partial<TunableParams> = {};
  for (const key of PARAM_KEYS) {
    const picked = rng() < 0.5 ? a[key] : b[key];
    child[key] = mutateParam(picked, bounds[key], rng);
  }
  let result = child as TunableParams;
  if (result.emaFast >= result.emaSlow) {
    const lo = Math.min(result.emaFast, result.emaSlow);
    result = { ...result, emaFast: lo, emaSlow: Math.max(lo + 1, clampToBounds(lo + 1, bounds.emaSlow)) };
  }
  return result;
}

export function searchGenetic(grid: ParamGrid, evaluate: EvaluateFn, maxEvaluations: number, rng: () => number): SearchResult {
  const bounds = gridToBounds(grid);
  const history: SearchResult['history'] = [];
  let best: TunableParams | null = null;
  let bestScore = -Infinity;
  let evaluated = 0;

  function evalAndRecord(p: TunableParams): number {
    const score = evaluate(p);
    history.push({ params: p, score });
    evaluated++;
    if (score !== null && score > bestScore) {
      bestScore = score;
      best = p;
    }
    return score ?? -Infinity;
  }

  let population: { params: TunableParams; fitness: number }[] = [];
  for (let i = 0; i < GA_POPULATION_SIZE && evaluated < maxEvaluations; i++) {
    const p = randomParams(bounds, rng);
    population.push({ params: p, fitness: evalAndRecord(p) });
  }

  const eliteCount = Math.max(2, Math.round(GA_POPULATION_SIZE * GA_ELITE_FRACTION));
  while (evaluated < maxEvaluations) {
    population.sort((a, b) => b.fitness - a.fitness);
    const elites = population.slice(0, eliteCount);
    const nextPopulation: { params: TunableParams; fitness: number }[] = [...elites];
    while (nextPopulation.length < GA_POPULATION_SIZE && evaluated < maxEvaluations) {
      const parentA = elites[Math.floor(rng() * elites.length)];
      const parentB = elites[Math.floor(rng() * elites.length)];
      const child = crossover(parentA.params, parentB.params, bounds, rng);
      nextPopulation.push({ params: child, fitness: evalAndRecord(child) });
    }
    population = nextPopulation;
  }

  return { best, bestScore, evaluatedCount: evaluated, history };
}

// -----------------------------------------------------------------
// Simplified Bayesian optimization — fixed-hyperparameter RBF-kernel GP
// + Expected Improvement acquisition. Each dimension is normalized to
// [0,1] using the grid bounds so one lengthscale is comparable across
// very differently-scaled params (emaFast ~10-50 vs rsiThreshold ~5-25).
// -----------------------------------------------------------------
const GP_LENGTHSCALE = 0.3; // in normalized [0,1] space
const GP_SIGNAL_VARIANCE = 1.0;
const GP_NOISE_VARIANCE = 1e-3; // small "nugget" for numerical stability, also models that repeated evals of the same combo could differ slightly
const BAYES_INITIAL_RANDOM = 5; // pure random exploration before the GP has enough points to be worth fitting
const BAYES_CANDIDATE_POOL = 300; // candidates considered per iteration when maximizing EI

function normalize(params: TunableParams, bounds: ParamBounds): number[] {
  return PARAM_KEYS.map((key) => {
    const b = bounds[key];
    return b.max > b.min ? (params[key] - b.min) / (b.max - b.min) : 0.5;
  });
}

function rbfKernel(a: number[], b: number[]): number {
  let sumSq = 0;
  for (let i = 0; i < a.length; i++) sumSq += (a[i] - b[i]) ** 2;
  return GP_SIGNAL_VARIANCE * Math.exp(-sumSq / (2 * GP_LENGTHSCALE * GP_LENGTHSCALE));
}

// Gauss-Jordan inversion — fine at the small N (<=~60) this optimizer
// ever accumulates observations to; not meant for large matrices.
function invertMatrix(matrix: number[][]): number[][] {
  const n = matrix.length;
  const aug = matrix.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(aug[r][col]) > Math.abs(aug[pivotRow][col])) pivotRow = r;
    [aug[col], aug[pivotRow]] = [aug[pivotRow], aug[col]];
    const pivot = aug[col][col] || 1e-9;
    for (let c = 0; c < 2 * n; c++) aug[col][c] /= pivot;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = aug[r][col];
      for (let c = 0; c < 2 * n; c++) aug[r][c] -= factor * aug[col][c];
    }
  }
  return aug.map((row) => row.slice(n));
}

function matVec(mat: number[][], vec: number[]): number[] {
  return mat.map((row) => row.reduce((s, v, i) => s + v * vec[i], 0));
}

// Standard normal CDF/PDF via Abramowitz-Stegun approximation — good
// enough for an acquisition function's ranking purposes.
function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.sqrt(2)));
}
function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function expectedImprovement(mean: number, variance: number, bestScore: number): number {
  const std = Math.sqrt(Math.max(variance, 1e-9));
  const improvement = mean - bestScore;
  const z = improvement / std;
  return improvement * normalCdf(z) + std * normalPdf(z);
}

export function searchBayesian(grid: ParamGrid, evaluate: EvaluateFn, maxEvaluations: number, rng: () => number): SearchResult {
  const bounds = gridToBounds(grid);
  const history: SearchResult['history'] = [];
  const observedX: number[][] = [];
  const observedY: number[] = [];
  let best: TunableParams | null = null;
  let bestScore = -Infinity;

  function evalAndRecord(p: TunableParams): void {
    const score = evaluate(p);
    history.push({ params: p, score });
    if (score !== null) {
      observedX.push(normalize(p, bounds));
      observedY.push(score);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
  }

  const initialCount = Math.min(BAYES_INITIAL_RANDOM, maxEvaluations);
  for (let i = 0; i < initialCount; i++) evalAndRecord(randomParams(bounds, rng));

  for (let iter = initialCount; iter < maxEvaluations; iter++) {
    if (observedX.length < 2) {
      // Not enough real observations yet to fit a GP meaningfully (e.g.
      // every initial random draw was unviable) — keep exploring randomly.
      evalAndRecord(randomParams(bounds, rng));
      continue;
    }

    // Fit GP posterior against all observations so far.
    const n = observedX.length;
    const K = observedX.map((xi, i) => observedX.map((xj, j) => rbfKernel(xi, xj) + (i === j ? GP_NOISE_VARIANCE : 0)));
    const Kinv = invertMatrix(K);
    const KinvY = matVec(Kinv, observedY);

    // Propose a candidate pool, score each by Expected Improvement using
    // the GP posterior, take the best-looking one as the next real
    // evaluation. Also mix in a couple of pure-random candidates each
    // round so the search doesn't get stuck only refining near past points.
    let bestCandidate: TunableParams | null = null;
    let bestEi = -Infinity;
    for (let c = 0; c < BAYES_CANDIDATE_POOL; c++) {
      const candidateParams = randomParams(bounds, rng);
      const x = normalize(candidateParams, bounds);
      const kStar = observedX.map((xi) => rbfKernel(x, xi));
      const mean = kStar.reduce((s, k, i) => s + k * KinvY[i], 0);
      let varianceReduction = 0;
      for (let i = 0; i < n; i++) varianceReduction += kStar[i] * (Kinv[i].reduce((s, v, j) => s + v * kStar[j], 0));
      const variance = Math.max(GP_SIGNAL_VARIANCE - varianceReduction, 1e-6);
      const ei = expectedImprovement(mean, variance, bestScore);
      if (ei > bestEi) {
        bestEi = ei;
        bestCandidate = candidateParams;
      }
    }

    evalAndRecord(bestCandidate ?? randomParams(bounds, rng));
  }

  return { best, bestScore, evaluatedCount: history.length, history };
}
