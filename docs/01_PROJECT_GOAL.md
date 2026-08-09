# TradingOS AI
Version 3.0

## Mission
Build the world's most advanced autonomous AI trading platform capable of
continuously analyzing cryptocurrency futures markets, making explainable
decisions, preserving capital through rigorous risk management, learning
from validated experience, and operating safely 24/7 under human-defined
governance.

## Core Principles
1. Capital Preservation
2. Explainability
3. Reliability
4. Continuous Learning
5. Safety
6. Modularity
7. Scalability
8. Research Driven
9. Risk First
10. Evidence Based

---

# Project Goal — vision and engineering objective

## 1. The vision

An autonomous AI trading platform that continuously analyzes markets, makes
explainable decisions, preserves capital through rigorous risk management,
learns from validated experience, and operates under human-defined
governance. (`CLAUDE.md`, "Mission")

Concretely, in this repo that means:

- **Never sleeps.** `components/AutonomousTrader.tsx` runs a 60s cycle;
  `components/Agent.tsx` runs a 3s tick loop against the real wall clock.
- **Analyzes every movement.** Live ticks, OHLC across timeframes, market
  structure, liquidity, volume profile, order flow, sentiment, and anomaly
  detection all feed a `StrategyContext` per symbol.
- **Learns from every outcome.** Every closed trade can produce a Reflection,
  which can produce a falsifiable Hypothesis — and a hypothesis only reaches
  production on an explicit human click.
- **Explains everything.** Every Supervisor decision carries an
  `ExplainableRecommendation` with sourced reason bullets, and is written to
  an append-only decision store — whether it executed or not.

## 2. The engineering objective

> **Seek long-term, risk-adjusted capital growth through disciplined
> trading.** (`CLAUDE.md`, "Primary objective")

Equivalently, in the spec's words: *maximize long-term, risk-adjusted
capital growth while preserving capital and continuously improving through
validated learning.*

## 3. Why "turn $X into $Y" is deliberately NOT a hard requirement

The original ask was to turn $2 into $20 by compounding. That number is a
**desired financial outcome, not a software requirement**, and the codebase
refuses to encode it as one. The reasoning, verbatim from `CLAUDE.md`:

> **Do NOT optimize for a guaranteed return multiple** (e.g. "turn $X into
> $Y"). That is a financial outcome, not an engineering requirement, and
> encoding it as a hard objective pushes the system toward unsafe
> risk-taking.

Three concrete failure modes this avoids:

1. **It forces risk-taking on demand.** A hard target with a fixed size means
   the only lever left is leverage and position size. `lib/riskManager.ts`'s
   `ABSOLUTE_MAX_LEVERAGE` exists precisely so no goal, setting, agent, or
   confidence level can raise that lever.
2. **It rewards overfitting.** A system scored on "did you hit 10x" will
   select whichever strategy happened to hit it in the sample, which is the
   opposite of the walk-forward, evidence-based discipline the rest of the
   pipeline is built around.
3. **It makes honest failure impossible to report.** Every module in this
   repo is written to return `null` / `'unavailable'` rather than a
   plausible number (`CLAUDE.md` safety invariant 6). A hard outcome target
   creates pressure to do the exact opposite.

You can still evaluate the system against a 10x goal — paper-test or
small-stake-test toward it. The architecture just never *assumes* or
*optimizes for* the outcome.

## 4. How you state such a goal anyway: the `capital-target` Mission

`lib/missionPlanner.ts` provides a first-class way to state a dollar goal
**advisorily**:

```ts
export type CapitalTargetTarget = {
  type: 'capital-target';
  startEquityUsd: number;
  targetEquityUsd: number;
};
```

Its properties, all verified in the source:

| Property | Behavior in code |
|---|---|
| **No deadline** | The type has no `timeframeDays` and no `deadline` field — unlike `growth`, `capital-preservation`, `event-reduction`, and `cash-allocation`, which all carry one. The type's own comment states why: "A hard deadline on a financial outcome pushes toward unsafe risk-taking to hit the number in time." |
| **Progress, not pressure** | `evaluateMission()`'s `capital-target` branch computes `currentPct` from `(equity − start) / (target − start)`. With no deadline to be late against, `status` is derived from **drawdown from peak equity** instead: ≥20% off peak → `at-risk`, ≥8% → `behind`, gains → `ahead`, otherwise `on-track`. |
| **Advisory only, never a sizing override** | `scoreMissionAlignment()`'s `capital-target` branch returns `aligned` / `misaligned` **with reasons** and nothing else. Its own comment: "Advisory only, same as every other case here — never blocks." |
| **It cautions toward *less* risk, not more** | The only `misaligned` verdict it produces fires when the mission is already ≥50% complete and the proposed buy is >25% of equity: "a … %-of-equity buy risks giving back hard-won progress. Sizing down preserves what's already been achieved." A goal-driven mission therefore pushes sizing **down** as it succeeds. |
| **Consumed as a caution note only** | `lib/supervisorAgent.ts` reads `request.missionAlignment` and pushes `cautionNotes` — under a comment reading "Mission alignment — add caution notes, never hard-reject." There is no code path from a mission to `approved`, to `RiskConfig`, or to position size. |
| **Completion is observed, not enforced** | `checkMissionExpiry()` marks a `capital-target` mission `completed` only once `progress.currentPct >= 100`; it has "neither timeframeDays nor a deadline (by design)". |

The one place a mission *does* constrain behavior is via
`MissionConstraint`s (`max-position-size-pct`, `max-leverage`, …), which
`components/AutonomousTrader.tsx` applies as a **ceiling**: it takes
`Math.min(config.positionSizePct, missionMaxPositionPct)` and
`Math.min(missionMaxLeverage, maxLeverageCeiling(tab))`. Constraints can
only make the system more conservative, never less.

## 5. The five other mission types

`growth`, `capital-preservation`, `event-reduction`, `accumulation`,
`cash-allocation` — plus `capital-target`. All six are defined in
`lib/missionPlanner.ts`, persisted via `lib/missionStore.server.ts` to
`.data/missions.json`, and surfaced through
`components/MissionPlanner.tsx` / `MissionPlannerPanel.tsx`.

An active mission is a **precondition** for autonomous trading:
`components/AutonomousTrader.tsx` stands down and journals the reason when
none exists — "the loop needs a stated goal before it will open anything on
its own."

## 6. What "success" is measured by instead

Verified metric surfaces in the repo (no invented numbers — these are the
computations that exist, not results):

- `lib/learningDashboard.ts` — win rate and expectancy grouped by trade
  origin, market condition, volatility regime, weekday, and hour of day.
- `lib/backtest/riskMetrics.ts`, `monteCarlo.ts`, `stabilityScore.ts` —
  walk-forward and distributional evaluation of tunable strategies.
- `lib/memoryStats.ts` — live-computed stats over the trade log (never
  duplicated into the memory store).
- Per-agent `contract.metrics` for the 8 agents that declare a contract
  (see `docs/04_AGENT_SPECIFICATIONS.md`).
