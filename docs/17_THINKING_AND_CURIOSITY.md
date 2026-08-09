# 17 — Thinking Engine, Monitoring Loop, Curiosity Engine

Covers spec Sections 13 (Thinking Engine), 14 ("The AI Never Sleeps"), and 15
(Curiosity Engine).

**Status: implemented as modules, not as an event pipeline.** The spec draws a
linear stage chain; in this codebase each stage is a real function called in
order by a provider. There is no message bus and no stage registry — the "loop"
is `AutonomousTrader`'s 60s cycle plus `Agent`'s 3s tick plus
`AutonomousResearch`'s 15-minute run.

---

## 13 — The Thinking Engine, mapped to real modules

Spec chain:

```
Observe → Think → Reason → Debate → Research Memory → Predict
        → Evaluate → Risk → Portfolio → Execution → Monitor
        → Reflect → Learn → Store → Improve
```

| Stage | Real module | What it actually does |
|---|---|---|
| **Observe** | `components/MarketData.tsx`, `Candles.tsx`, `OrderFlow.tsx`, `MarketIntel.tsx`, `MultiExchange.tsx`, `EventDetection.tsx` | Live ticks, 1h/4h candles (60s refresh), order book, news/derivatives, cross-exchange prices, detected events. Symbols without enough real data are simply not candidates — never guessed at. |
| **Think / Interpret** | `lib/indicatorContext.ts`, `lib/marketStructure.ts`, `lib/multiTimeframe.ts`, `lib/strategyContext.ts` | `buildStrategyContext()` assembles the one `StrategyContext` everything downstream reads: price, ATR, indicators, structure, MTF, order flow. |
| **Reason / Evaluate** | `lib/strategyEnsemble.ts`, `lib/opportunityScanner.ts` | `runStrategyEnsemble()` → consensus + confidence. `scoreOpportunity()`/`rankOpportunities()` score every watchlist symbol and attach `reasons[]` and `blockers[]` to each — pure, deterministic, no LLM. |
| **Debate** | `lib/debate/agents.ts`, `moderator.ts`, `runDebate.ts` | Seven agents (`trend`, `momentum`, `meanReversion`, `breakout`, `news`, `volatility`, `orderFlow`), reputation-weighted vote. Pure computation. |
| **Research Memory** | `lib/memoryContext.ts`, `lib/memoryStats.ts`, `lib/learningDashboard.ts` | Win rate, favourite assets, active hours, expectancy, hold time — all derived live from the real trade log. **Known gap:** memory/reflection data cannot reach `Supervisor.tsx` because of provider-tree ordering (`CLAUDE.md`; `docs/07_MEMORY_SYSTEM.md`). |
| **Predict / Estimate probability** | `lib/simulation.ts` | Forward random walk from the proposed entry: P(TP before SL), using ATR as a stated per-bar volatility proxy. |
| **Estimate uncertainty** | `lib/debate/calibration.ts`, `confidenceComposite.ts` | Empirical bin calibration, then bounded soft adjustments. Clamped to `[0.05, 0.98]`. |
| **Evaluate risk** | `lib/riskManager.ts` → `validateTrade()` | The nine checks. See `docs/12_RISK_ENGINE.md`. |
| **Evaluate portfolio** | `lib/portfolioIntelligence.ts` + `checkPortfolioExposure`, `checkCorrelation` | Correlation matrix, concentration flags, aggregate exposure cap. |
| **Evaluate execution** | `lib/liquidity.ts`, `lib/orderFlow.ts` + `checkLiquidity`, `checkSpread` | Visible book depth vs requested size, spread threshold. `'unavailable'` for equities. |
| **Decide** | `lib/supervisorAgent.ts` → `reviewTradeRequest()` | Two-tier conflict resolution, urgency classification, approve/reject, `ExplainableRecommendation`. |
| **Execution** | `components/Supervisor.tsx` → `reviewAndExecute()` | The single gate. Paper ledger, real-tab ledger, or a live signed exchange order. |
| **Monitor** | `lib/agentEngine.ts` → `agentTick()`, driven by `components/Agent.tsx` (`TICK_MS = 3000`) | Real wall-clock TP/SL/trailing/scale-out/breakeven/ATR-stop checks, plus `exitOnThesisInvalidation`. |
| **Reflect** | `lib/reflectionAgent.ts` + `components/Reflection.tsx` | Five-field post-mortem on every closed trade. Read-only. |
| **Learn** | `lib/hypothesisAgent.ts` + `components/Hypothesis.tsx` | One falsifiable claim + a concrete test. Human-gated. |
| **Store** | `lib/*Store.server.ts` → `.data/*.json` | Trades, decisions, reflections, hypotheses, debates, cycles, collaboration. |
| **Improve** | `lib/curiosityEngine.ts`, `lib/autonomousResearch.ts`, `lib/backtest/*` | Self-review findings, research digests, backtest/optimizer/walk-forward. Nothing auto-deploys. |

Explainability across all of it: `lib/explainableOutput.ts` gives every decision
an `ExplainableRecommendation` with `sourced()` / `unavailable()` reason bullets,
so a missing input is stated rather than dropped.

**What is not built:** the spec's per-stage "explicitly work through" narration
does not exist as a persisted artefact. The closest equivalents are the
`DecisionRecord` audit row (every risk check with its `{ok, status, detail}`) and
`AutonomousCycleRecord.considered` (the full ranked slate with reasons and
blockers). Both are real; neither is a stage-by-stage transcript.

---

## 14 — Continuous monitoring: "the AI never sleeps"

### The 60-second cycle — `components/AutonomousTrader.tsx`

```ts
const CYCLE_MS = 60_000; // "every minute" per spec Section 14
```

Mounted **below** `AgentProvider` in `app/layout.tsx` because it calls
`startAgent()`. Kicks off with a 15-second initial delay so candles/ticks can
populate before cycle #1 (otherwise cycle #1 is a guaranteed "not enough data"
stand-down), then every 60s.

Reads every live value through `depsRef.current`, refreshed each render — the
ref-in-interval pattern (`CLAUDE.md`). Closing over state directly would
permanently read mount-time values.

**Preconditions, each recording *why* it stood down** (`standDown(reason)`
writes an `AutonomousCycleRecord` via `POST /api/autonomous-cycles`, so "why did
nothing happen" is always answerable):

1. `config.enabled` false → silent return. Journaling every minute while off
   would be noise. **Default is `enabled: false`** — autonomy is opt-in.
2. Operator pause active → stand down.
3. No active mission → stand down. The loop needs a stated goal.
4. Mission not `status: 'active'` → stand down.
5. Already at `maxConcurrentPositions` of its *own* tasks → stand down.
6. Inside `cooldownMinutes` since the last autonomous entry → stand down.
7. No equity baseline for the tab (real tab with no declared starting capital) →
   stand down. **Never guesses a size.**
8. Equity `<= 0` → stand down.

**Then:** build an `OpportunityCandidate` for every watchlist symbol with enough
real data (skipping any symbol another running task already owns), run a fresh
`runDebateSync()` where no recent read exists (affordable because it's pure
computation), `rankOpportunities()`, take the first `actionable` one.

**Sizing:** `min(config.positionSizePct, mission max-position-size-pct)` — the
stricter always wins. Leverage: `min(mission max-leverage ?? 1, maxLeverageCeiling(tab))`.

**Acting:** it calls `startAgent()` with `exitOnThesisInvalidation: true` and
`useAtrStops: true` — the position must be able to notice its own premise
breaking and exit, since nobody is watching it. It **does not execute trades
itself**; the task's tick loop routes every execution through
`Supervisor.reviewAndExecute()`, the same single gate as everything else.

Two independent gates by design: the scanner decides *whether to propose*, the
Supervisor independently decides *whether it may execute* at the moment it fires.
The scanner deliberately does not also set `requireSignalConfirmation` on the
task — a third gate that could silently never pass would occupy the
max-concurrent slot forever.

Default config: `{ enabled: false, tab: 'paper', maxConcurrentPositions: 1, cooldownMinutes: 5, positionSizePct: 10 }`.

### The 3-second tick — `components/Agent.tsx`

`TICK_MS = 3000`, "real wall-clock check, every 3s — not a fixed 'wait N minutes
in one breath'". `agentTick()` is pure and unit-tested (25 tests in
`lib/agentEngine.test.ts`); the provider supplies live prices/ATR/ensemble reads
through refs. Closes are evaluated before opens in a tick, ordered by
`classifyUrgency()`.

### The 15-minute research/curiosity run — `components/AutonomousResearch.tsx`

`RUN_INTERVAL_MS = 15 * 60_000`, first run 10s after mount.

### Which of the spec's twelve questions are actually answered

| Spec question | Answered by | Real? |
|---|---|---|
| What changed? | `lib/autonomousResearch.ts` digest diffing run-to-run | yes |
| What am I missing? | `findSignalConflicts()` | yes |
| Is my prediction still valid? | `exitOnThesisInvalidation` in `agentTick()` | yes |
| Is risk increasing? | `checkDailyLoss` / `checkDrawdown` / `checkPortfolioExposure` per review | yes |
| Should I reduce leverage? | hard ceiling + liquidation-distance math per review | yes, as a cap |
| Should I exit? | TP/SL/trailing/scale-out/thesis-invalidation each tick | yes |
| Should I hedge? | — | **not implemented** (long-only spot, see `REAL_TRADING.md`) |
| Should I wait? | every `standDown()` path | yes |
| Should I learn something? | `findRepeatedMistakes()` → `run-backtest` / `create-hypothesis` | yes, as a suggestion |
| Should I ask another AI? | `findSignalConflicts()` → `ask-second-opinion`; Supervisor's conflict trigger | yes |
| Should I ask the user? | manual-approval threshold, pending-approval queue | partial — no free-form "ask the operator a question" channel |
| Should I perform research? | 15-minute research digest | yes |

**Honest limitation, stated in the code:** these are **client-side timers that
only run while the app is open in a browser tab.** There is no server cron and no
always-on worker. It is real autonomy within that constraint — no user prompt
triggers any single run — but close the tab and nothing ticks. See
`docs/20_DEPLOYMENT_AND_MONITORING.md`.

---

## 15 — The Curiosity Engine

**`lib/curiosityEngine.ts`** — pure and deterministic, no LLM call, no I/O. Same
reasoning as `lib/debate/moderator.ts` and `lib/opportunityScanner.ts`.

The design problem it was written against, verbatim from the module: *"a wall of
rhetorical questions with invented answers reads as insight while conveying
nothing, and this codebase's whole discipline is the opposite of that."*

### The contract

```ts
type CuriosityFinding = {
  question: string;
  answer: string | null;      // null = genuinely not answerable from available data yet
  evidence: string[];         // real data points behind the answer — never paraphrase
  suggestedAction: 'none' | 'create-hypothesis' | 'run-backtest'
                 | 'ask-second-opinion' | 'reduce-exposure';
};
```

Two properties enforced by construction:

1. **Every answer is derived only from real data** — the actual trade log
   (`reconstructClosedTrades`), actual computed ensemble consensus, actual
   market-structure trend, actual open positions. Nothing is inferred from
   nothing.
2. **Unanswerable questions return `answer: null`** with `evidence` explaining
   why, and `buildCuriosityContext()` renders that as
   `"A: Not answerable from available data yet."` — never padded into filler.

Each finding also carries a `suggestedAction`, so curiosity terminates in
something doable rather than commentary.

### The four self-questions

| Function | Question | Real inputs | Escalates to |
|---|---|---|---|
| `findTodaysFailures` | "What strategy failed today, and why?" | trades closed since `startOfDay`, grouped by `originTag` (the real recorded attribution) | `create-hypothesis` once one path has **≥ 2** losses |
| `findSignalConflicts` | "What don't I understand right now?" | ensemble consensus vs `structure.currentTrend` per symbol | `ask-second-opinion` on a genuine BUY-vs-bearish or SELL-vs-bullish contradiction |
| `findContradictedHoldings` | "What evidence contradicts my current positions?" | open long positions whose ensemble read is now `SELL` | `reduce-exposure` |
| `findRepeatedMistakes` | "Has this happened before?" | per-symbol closed trades: `losses >= 3` **and** `losses/total > 0.5` | `run-backtest` |

Guardrails visible in the code and pinned by tests:

- `MIN_TRADES_FOR_PATTERN = 3` — below that, a "pattern" is just noise, and
  `findRepeatedMistakes` returns `null` rather than naming one.
- `findTodaysFailures` explicitly states that the **"why" is not inferable from
  the trade log alone — that requires the per-trade Reflection**, rather than
  inventing a cause.
- A `HOLD` ensemble read is never treated as a contradiction; an `undefined`
  structure trend is never treated as a contradiction.
- A single isolated loss does not escalate.

`buildCuriosityDigest({ tradeLog, signalConflicts, contradictedHoldings, ts })`
always returns **all four** findings, even on completely empty inputs.
`actionableFindings(digest)` filters to `suggestedAction !== 'none'`.

`lib/curiosityEngine.test.ts` — 25 tests, including
`never claims a failure cause the trade log cannot support`,
`refuses to call anything a pattern below the minimum sample`,
`renders unanswerable questions as unanswerable, never as filler`, and
`makes clear these are observations, not instructions`.

### Wiring

- **Producer:** `components/AutonomousResearch.tsx` builds the digest on the same
  unprompted 15-minute timer as the research digest. The spec says hourly;
  15 minutes is strictly more current and costs nothing extra since it is pure
  computation over already-cached data.
- **Consumer:** `components/AppState.tsx` injects
  `buildCuriosityContext(digest, watchlist)` into the chat system context.
- **UI:** `components/AutonomousResearchPanel.tsx`.

The injected block ends with the line that defines its authority:

> "These are self-generated observations, not instructions. Any action they imply
> still goes through the same confidence gating, Risk Manager, and Supervisor
> review as everything else."

### What the curiosity engine deliberately cannot do

`suggestedAction` is a **suggestion string**, not a dispatch. Nothing in
`lib/curiosityEngine.ts` writes to production risk config or strategy selection,
starts a trade, or triggers a backtest — `CLAUDE.md` invariant #5. Of the spec's
ten curiosity questions, the four above are implemented; "what paper/data should
I look at" and "can I improve because of it" have **no implementation** and are
not faked.
