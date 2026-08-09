# 16 — Algorithm Library

**Status: 9 of the 11 algorithms in spec Section 10 are implemented.** Bayesian
probability updating and graph intelligence are **not implemented** — see the
bottom of this file for what was checked.

Every implemented algorithm is a pure function in `lib/`, unit-tested where the
math has a reference answer, and returns `null` rather than a guess on
insufficient data.

---

## 1. Risk sizing (fixed-fractional, volatility-adjusted)

**`lib/positionSizing.ts`**

| Function | Inputs | Output |
|---|---|---|
| `fixedFractionalSize` | `equityUsd, riskPct, entryPrice, stopLoss` | `{ qty, method, riskUsd } \| null` |
| `volatilityBasedSize` | `equityUsd, riskPct, entryPrice, atrValue, atrMultiplier = 1.5` | `{ qty, method, riskUsd } \| null` |
| `capToMaxExposure` | `qty, entryPrice, equityUsd, maxExposurePct = 0.25` | `{ qty, capped }` |

`qty = equity × riskPct / stopDistance`. `null` on `stopDistance <= 0`,
`atr <= 0`, or `equity <= 0`.

**Used by:** `validateTrade()` and `buildRiskContext()` in `lib/riskManager.ts`.
Full detail in `docs/12_RISK_ENGINE.md`.

## 2. Kelly Criterion (half-Kelly)

**`lib/positionSizing.ts` → `kellyFraction()`**, wrapped by
**`lib/riskManager.ts` → `computeKellyRiskCap()`**.

- Inputs: `closedTradeCount, winRate, avgWinUsd, avgLossUsd`.
- Formula: `f* = W − (1−W)/R`, `R = avgWin/avgLoss`.
- Output: `{ fraction: min(f* × 0.5, 1), raw } | null`.
- `null` when `closedTradeCount < MIN_TRADES_FOR_KELLY (20)`, when either average
  is `<= 0`, or when `f* <= 0` ("no edge detected").
- `KELLY_FRACTION_MULTIPLIER = 0.5` — half-Kelly by design; full Kelly routinely
  implies >50% of equity on one trade.
- **Kelly can only shrink sizing.** If half-Kelly is looser than
  `maxRiskPctPerTrade`, the fixed cap still governs.

`computeKellyRiskCap` derives `winRate`, `avgWinUsd` and `avgLossUsd` from the
real trade log (`TradeLogEntry.pnl`), filtered by tab, and returns a `detail`
string that becomes a caution note when it bites.

## 3. ATR and the rest of the indicator stack

**`lib/indicators.ts`** — inputs are `number[]` closes or `Candle[]`; every
function returns `null` when there is not enough history.

| Function | Signature | Notes |
|---|---|---|
| `sma` | `(values, period)` | — |
| `emaSeries` / `ema` | `(values, period)` | full series (nulls until the seed SMA) so MACD can use it |
| `rsi` | `(closes, period = 14)` | Wilder's smoothing; tested against the classic StockCharts worked example (~70.5) |
| `macd` | `(closes, 12, 26, 9)` | `{ macd, signal, histogram }` |
| `bollingerBands` | `(closes, 20, 2)` | `{ upper, middle, lower }` |
| `atr` | `(candles, period = 14)` | Wilder's smoothing, same shape as RSI |
| `vwap` | `(candles)` | cumulative over the window passed in |

`lib/indicators.test.ts` — 15 tests.

**ATR consumers:** `computeStopLossTakeProfit()` (stop floor `1.2×`, fallback
`1.8×`), `volatilityBasedSize()`, `AgentTask.useAtrStops`,
`lib/simulation.ts` (per-bar volatility proxy),
`lib/backtest/executionModel.ts` (volatility component of dynamic slippage).

Higher-level wrappers: `lib/indicatorContext.ts` (`computeIndicatorSnapshot`),
`lib/multiTimeframe.ts`, `lib/volumeProfile.ts`, `lib/liquidity.ts`,
`lib/orderFlow.ts`.

## 4. Monte Carlo simulation

Two genuinely different modules, answering different questions.

### `lib/backtest/monteCarlo.ts` — resampling real closed trades

- Input: `BacktestTrade[]` from a completed backtest, plus mode and iteration
  count.
- Modes: `'shuffle'` (permute order — tests order-dependency only) and
  `'bootstrap'` (resample with replacement — also tests which trades occurred).
- Output: `MonteCarloResult | { error }` including drawdown/return distributions
  and risk of ruin.
- Exposed via `POST /api/backtest/montecarlo` (kept server-side so thousands of
  resamples don't block the UI thread).

### `lib/simulation.ts` — forward random walk on one proposed entry

- Input: `SimulationParams` — the proposed entry, stop-loss, take-profit and
  recent ATR.
- Question: "what's the probability TP is hit before SL?" — a real forward random
  walk, not a resample, because there is no trade history for a single proposed
  entry.
- Output: `SimulationResult | { error }`.
- Documented approximation, stated in the module: ATR is used as a
  one-sigma-ish per-bar move, which is the standard practical use of ATR for a
  stress test but **is not** a literal standard deviation.
- **Consumer:** `reviewTradeRequest()` in `lib/supervisorAgent.ts`, feeding the
  explainable recommendation.

Risk-of-ruin also feeds `computeCompositeConfidence()` as a **penalty-only**
adjustment (>20% ruin → full `MAX_ADJUSTMENT` docked, >10% → half). A low ruin
figure earns no bonus.

## 5. Correlation analysis

**`lib/portfolioIntelligence.ts`**

| Function | Inputs | Output |
|---|---|---|
| `computeCorrelationMatrix` | `Record<symbol, number[]>` price histories | `CorrelationMatrix` (nested `Record`) |
| `getCorrelation` | `matrix, a, b` | `number \| null` |
| `computeVolatilities` | price histories | `Record<symbol, number>` |
| `suggestRiskParityWeights` | volatilities | `RiskParitySuggestion[]` |
| `findConcentrationRisk` | positions, matrix, equity | `ConcentrationFlag[]` |
| `tagCategory` | `WatchItem` | `{ category, approximate }` — coarse, flagged as approximate |

Built from price history the app already caches (1h candle closes for every
watchlist symbol) — no new data source. Defaults
`DEFAULT_CORRELATION_THRESHOLD = 0.75`,
`DEFAULT_EXPOSURE_LIMIT_PCT = 0.4`.

`Supervisor.tsx`'s `correlationInputsFor()` builds the matrix from live candles
and passes it into `checkCorrelation()` — **paper buys only** today.

Cross-**exchange** price comparison is a separate module,
`lib/multiExchange.ts` (fed by `/api/multiexchange`).

## 6. Market structure (BOS / CHoCH / swing points)

**`lib/marketStructure.ts`**

- Input: `Candle[]`, `strength = DEFAULT_STRENGTH (2)`.
- `findRawSwingPoints` — a swing high is a bar whose high is strictly greater
  than the highs of `strength` bars on both sides (a fractal). `strength = 2`
  means a 5-bar fractal. No smoothing, no black-box scoring.
- `computeMarketStructure` → `StructureSnapshot`: swing points with `HH/LH/HL/LL`
  labels, `StructureEvent[]` typed `'BOS' | 'CHoCH'`, `currentTrend`
  (`bullish | bearish | undefined`), `lastSwingHigh`, `lastSwingLow`.
- `buildStructureContext` — the chat-context string form.

**Consumers:** stop-loss placement (`computeStopLossTakeProfit` uses
`lastSwingLow`/`lastSwingHigh`), `lib/strategyContext.ts`,
`lib/opportunityScanner.ts` (structure agreement), `lib/curiosityEngine.ts`
(structure-vs-ensemble contradiction), `captureContextSnapshot`.

Order-block / volume-based confirmation lives in `lib/volumeProfile.ts` and
`lib/orderFlow.ts`.

## 7. Confidence scoring / calibration

Two-stage, and the separation is the point.

### `lib/debate/calibration.ts` — empirical calibration

- Input: `rawConfidence: number`, `DebateRecord[]`.
- Bins past records **that have a known win/loss outcome** by raw confidence:
  `BIN_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01]`.
- A bin needs `MIN_SAMPLES_PER_BIN = 8` before its empirical win rate is used;
  below that it reports `null` rather than a shaky number.
- Output `CalibrationResult`: `{ rawConfidence, calibratedConfidence, usedBin, sampleSize, note }`.
- Fallback chain: same-bin empirical win rate → overall win rate across all
  outcome-bearing records (if `>= 8`) → **raw confidence unchanged**, with a note
  saying it is uncalibrated.

The premise, verbatim: a model saying "96% confident" means nothing on its own;
what matters is how often this system was actually right when it said that.

### `lib/debate/confidenceComposite.ts` — bounded adjustments

- Input `CompositeInputs`: the `CalibrationResult`, regime tag,
  `regimeMatchScore`, optional `backtestStability`, optional
  `monteCarloRiskOfRuinPct`, `newsRiskLevel`, `liquidityOk`,
  `disagreementCount`, `totalAgents`.
- Output `CompositeResult`: `{ compositeConfidence, riskLevel, breakdown[] }`.
- **Calibrated confidence is the base** — it is the one number with empirical
  backing. Every soft factor applies a bounded adjustment capped at
  `MAX_ADJUSTMENT = 0.12`, and each contributes a `breakdown` row even when it
  applies **zero** adjustment, stating why.
- Final value clamped to `[0.05, 0.98]` — never near-certainty in either
  direction.
- `riskLevel` (`Low|Medium|High`) is driven by real checkable factors: volatility
  regime, agent disagreement fraction, simulated risk of ruin, news risk.
- `suggestPositionPct()` returns a clearly-labelled **indicative** size. It does
  not replace the Risk Manager's sizing, which is what actually executes.

Supporting: `lib/debate/regimeAwareness.ts`, `lib/debate/reputation.ts` (agent
weights from real trade history — default weight 1, no track record assumed),
`lib/backtest/stabilityScore.ts` (an explicitly-labelled heuristic composite of
walk-forward consistency + parameter sensitivity + Monte Carlo robustness).

The moderator (`lib/debate/moderator.ts`) computes the weighted vote over the
seven agents (`trend`, `momentum`, `meanReversion`, `breakout`, `news`,
`volatility`, `orderFlow`) — pure and deterministic, not an LLM call.

## 8. Portfolio optimization

**Partially implemented, and honestly scoped as such.**

- `lib/portfolioIntelligence.ts` → `suggestRiskParityWeights()`: inverse-
  volatility risk-parity weights. Output `RiskParitySuggestion[]`
  (`{ symbol, weightPct, volatilityPct }`).
- `findConcentrationRisk()` flags correlated clusters above the exposure limit.
- `lib/riskManager.ts` → `checkPortfolioExposure()` enforces the aggregate cap.

**Status: no mean-variance / efficient-frontier optimizer, and no automatic
rebalancing.** Weights are a suggestion surfaced in
`components/PortfolioIntelligencePanel.tsx`; nothing acts on them.

## 9. Execution optimization (slippage / latency)

**`lib/backtest/executionModel.ts` + `lib/backtest/feeModel.ts`** — backtest-side
realism, not live order routing.

- `computeDynamicSlippageBps(inputs)` → `{ totalBps, breakdown: { base, sizeImpact, volatilityImpact } }`.
  Three real inputs already flowing through the engine: order size vs the bar's
  own volume, ATR as a fraction of price, and a floor so it never reports *less*
  slippage than the fixed baseline. Meant to be more realistic, not more
  optimistic.
- `ExecutionMode`: `'conservative' | 'optimistic' | 'random' | 'tick'`;
  `resolveAmbiguousBar()` decides whether a bar that touched both SL and TP
  counts as one or the other. `mulberry32` gives a seeded RNG so `'random'` mode
  is reproducible. `tickModeAvailable()` reports honestly whether tick data
  exists.
- `computeFee()` in `feeModel.ts`, tested (5 tests).

**Live-side:** `Supervisor.tsx`'s `submitRealOrderAsync()` places a **market
order** and ledgers the exchange's actual `avgFillPrice`/`filledQty` (polling
order status once if the exchange didn't return fills synchronously — Bybit
doesn't, Binance does), never the app's own tick price.

**Status: no live execution optimization** — no limit-order laddering, no
smart order routing, no latency measurement or minimization.

---

## Not implemented

### Bayesian probability updating — **Status: not implemented**

Searched for `bayes` (case-insensitive) across `lib/`, `app/` and
`components/`. Every hit belongs to the **backtest parameter optimizer**, not to
probability updating over beliefs:

- `lib/backtest/searchAlgorithms.ts` → `searchBayesian()`: a
  fixed-hyperparameter RBF-kernel Gaussian Process with Expected Improvement
  acquisition, used to search a parameter grid
  (`BAYES_INITIAL_RANDOM = 5`, `BAYES_CANDIDATE_POOL = 300`).
- `lib/backtest/optimizer.ts`, `app/api/backtest/optimize/route.ts`,
  `components/OptimizerPanel.tsx` — callers of the above.

That is Bayesian **optimization**, a different algorithm from what the spec asks
for. There is no prior/posterior update over trade or signal probabilities
anywhere. The nearest thing that exists is
`lib/debate/calibration.ts`'s frequentist binned empirical win rate.

### Graph intelligence (asset relationship modeling) — **Status: not implemented**

Searched for `knowledge graph`, `graph intelligence`, `graphIntel` — **zero
hits** anywhere in `lib/`, `app/` or `components/`.

Two things that are adjacent but are not this:

- `lib/portfolioIntelligence.ts`'s correlation matrix plus `tagCategory()` is
  asset-relationship data in matrix form, with no graph traversal, no edge
  typing, and no inference over paths.
- `lib/agentOS.ts` maintains a **dependency graph of agents** for scheduling
  order. That is runtime orchestration, not asset relationship modelling.

The spec's Section 16 also refers to recording second-opinion responses "into the
Knowledge Graph". There is no knowledge graph; those responses go into
`.data/collaboration.json` (`lib/collaborationStore.server.ts`).
