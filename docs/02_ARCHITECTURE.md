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

# Architecture — what this codebase actually is

## 1. One process, one framework

A **single-process Next.js 14 app** (App Router, React 18.3, TypeScript 5.4,
Tailwind 3.4). Runtime dependencies are exactly four:
`next`, `react`, `react-dom`, `lightweight-charts`. Tests run on `vitest`.

**Not** microservices. **Not** an event bus. **No** message broker, no
worker pool, no database driver.

| Layer | Location | Nature |
|---|---|---|
| Pages + API | `app/` | App Router pages (`/`, `/dashboard`, `/audit`, `/log`, `/log/[id]`, `/backtest`) and 26 route handlers under `app/api/` |
| Pure logic | `lib/` | Decision functions, indicators, scoring, validation. No I/O, no React |
| Server-only I/O | `lib/*.server.ts` | JSON file stores, exchange clients, candle sources |
| Side effects + state | `components/` | 21 React context providers plus ~45 panels/UI components |
| Future DB | `db/schema.sql` | Postgres migration target — **unwired** |
| Persistence | `.data/*.json` | The live datastore today |

The spec (`TradingOS-Engineering-Spec-and-Prompts.md` Section 4) describes an
event-driven org chart: CEO AI → CIO AI → CRO AI → Research → Supervisor → …
**That is a description of responsibilities, not a deployment topology to
build.** Those responsibilities already exist as modules here. Do not rebuild
them as separate services — the spec's own Master Prompt says "Do NOT rebuild
existing systems. Reuse existing modules."

## 2. `lib/` = pure logic, `components/` = side effects

This split is load-bearing, not stylistic. The decision functions are pure
and unit-tested; the providers own everything impure.

| Pure (`lib/`) | Impure (`components/`) |
|---|---|
| `agentTick()` — what should this task do right now | `Agent.tsx` — the `setInterval`, `buyPaper`, `pushEvent`, `localStorage` |
| `validateTrade()` — approve/reject + stop/target/size | `Supervisor.tsx` — gathers context, calls the ledger, POSTs audit records |
| `reviewTradeRequest()` — the gate decision | `Supervisor.tsx` — executes the decision |
| `scoreOpportunity()` / `rankOpportunities()` | `AutonomousTrader.tsx` — runs the 60s cycle, starts tasks |
| `moderate()` (`lib/debate/`) | `Debate.tsx` — caching, freshness, persistence |
| `evaluateMission()` / `scoreMissionAlignment()` | `MissionPlanner.tsx` — store I/O, 30s evaluation |

Rules that follow from it, both from `CLAUDE.md`:

- **Pass computed context in; never reach for I/O inside a `lib/` decision
  function.** `agentTick()` takes a pre-computed `PlanSnapshot`,
  `VolatilityContext`, and `ThesisContext` precisely because it has no
  candle access of its own.
- **Deterministic over LLM where the math is real.** The Debate moderator,
  opportunity scanner, and curiosity engine are pure computation *on
  purpose* — asking a model to "reason over" numbers already on hand adds
  hallucination risk to a financial decision for no benefit and isn't
  reproducible. LLM calls are reserved for genuine judgment: chat,
  reflection, hypothesis, second opinion.

## 3. The provider tree in `app/layout.tsx`, and why order matters

React context only flows **downward**. A provider can only call hooks from
providers mounted **above** it. The actual nesting, outermost first:

| # | Provider | Notes |
|---|---|---|
| 1 | `AgentRuntimeProvider` | Outermost — wraps the Agent OS singleton; depends on nothing |
| 2 | `MarketDataProvider` | Live ticks + watchlist; almost everything below reads it |
| 3 | `PortfolioProvider` | The ledger (`buyPaper`, `sellPaper`, `addRealPosition`, …) |
| 4 | `McpProvider` | |
| 5 | `CandlesProvider` | OHLC cache |
| 6 | `OrderFlowProvider` | |
| 7 | `MultiExchangeProvider` | |
| 8 | `EventDetectionProvider` | |
| 9 | `AutonomousResearchProvider` | |
| 10 | `MarketIntelProvider` | News, Fear & Greed, derivatives |
| 11 | `DebateProvider` | |
| 12 | `TradingControlsProvider` | Mounted **above** the Supervisor on purpose — see below |
| 13 | `ExchangeAccountsProvider` | Real-order placement + connection state |
| 14 | `MissionPlannerProvider` | Must be above the Supervisor, which reads `getMissionAlignment()` |
| 15 | `SupervisorProvider` | The single execution gate; consumes 2–14 |
| 16 | `AgentProvider` | Calls `useSupervisor()`, so it must sit below 15 |
| 17 | `AutonomousTraderProvider` | Below `AgentProvider` because it calls `startAgent()` — stated in an inline comment in `layout.tsx` |
| 18 | `MemoryProvider` | |
| 19 | `AppStateProvider` | Chat/UI state — **below** the Supervisor |
| 20 | `ReflectionProvider` | |
| 21 | `HypothesisProvider` | Innermost, wraps `{children}` |

### The Supervisor-above-AppState constraint

`components/Supervisor.tsx` sits at position 15, **above**
`AppStateProvider` at 19. Consequences, all real and already encountered:

- **The Supervisor cannot call `useAppState()`.** Config it needs — risk
  limits, real starting capital, second-opinion model, pause state,
  manual-approval threshold — lives in `components/TradingControls.tsx`
  (position 12), which is mounted above the Supervisor *precisely for this
  reason*.
- **Memory/Reflection data cannot currently reach `Supervisor.tsx`** for the
  same structural reason (both are below it). That is a known, documented
  gap — see `docs/07_MEMORY_SYSTEM.md`. **Do not "fix" it by restructuring
  the tree** without checking every provider's dependencies first.
- Before adding a provider, work out where it must sit and **say so in a
  comment** in `layout.tsx`, as the existing `AutonomousTraderProvider`
  comment does.

## 4. The ref-in-interval pattern

Any provider running a `setInterval` created once — e.g.
`useEffect(..., [hydrated])` — must read live values through **refs
refreshed every render**, never by closing over state directly. Otherwise it
permanently reads mount-time values.

The reference implementation is `components/Agent.tsx`:

```ts
const ticksRef = useRef(ticks);
ticksRef.current = ticks;              // refreshed every render
const getCandlesRef = useRef(getCandles);
getCandlesRef.current = getCandles;
const reviewAndExecuteRef = useRef(reviewAndExecute);
reviewAndExecuteRef.current = reviewAndExecute;
```

The file's own comment explains the distinction that matters: `buyPaper` /
`sellPaper` call `setPortfolio` with a *functional updater*, so a stale
reference to them is still always correct. `getCandles` / `getOrderFlow` are
plain reads over each provider's local `cache` state — a stale reference
there permanently reads the mount-time cache. Refs fix both cases uniformly.

`components/AutonomousTrader.tsx` copies the pattern wholesale as a single
`depsRef` object holding all 18 values its cycle reads, plus a
`runCycleRef` so the interval always invokes the latest closure.

**Related pattern, same file:** `Agent.tsx`'s tick reads tasks from
`tasksRef` and calls `setTasks(plainArray)` — **never** `setTasks(fn)`.
React 18 Strict Mode double-invokes updater functions, and `buyPaper()`
really deducts cash; called twice for one tick, the second call fails as
"insufficient cash". The documented fix is: decide from a ref, run side
effects exactly once in normal code, then commit a plain array.

## 5. Persistence

### `.data/` JSON stores (the live datastore)

Every store follows one pattern (`CLAUDE.md`): `lib/<name>Store.server.ts`,
JSON under `.data/`, lazy file creation, and a `serialize()` promise queue
guarding against write races. Copy an existing one.

13 server modules exist. Files currently present in `.data/`:
`trades.json`, `decisions.json`, `reflections.json`, `debate-records.json`,
`strategy-versions.json`, `missions.json`, `memory-prefs.json`,
`news-usage.json`. Others (`hypotheses.json`, `collaboration.json`,
`autonomous-cycles.json`) are created lazily on first write.

Client-side state uses `localStorage` via `lib/storage.ts` (`loadLS`/`saveLS`) —
agent tasks (`qt_agents_v1`), autonomous config (`qt_autonomous_v1`),
conversations, watchlist, trading controls.

Notable store semantics:

- `lib/decisionStore.server.ts` is **append-only**. A real order that
  resolves after submission appends a *second* record rather than editing the
  first (see `docs/05`).
- `lib/autonomousCycleStore.server.ts` is capped at 500 cycle records.

### `db/schema.sql` — an UNWIRED future Postgres target

**Status: not implemented as a runtime dependency.** Verified: there is no
`pg` (or any DB driver) in `package.json`, and nothing in `lib/` or `app/`
references `schema.sql` or a Postgres connection.

Its own header states what it is: *"This schema is NOT wired into the app
yet. It is a 1:1 mapping of what already exists in `.data/*.json`
file-backed stores and client-side `localStorage` to real tables, so a
future migration off file/localStorage storage has an exact target instead
of being designed from scratch."*

It defines tables for `trades`, `decisions`, `reflections`, `memory_prefs`,
`debate_records`, `strategy_versions`, `conversations`, `messages`,
`positions`, `paper_account`, `agent_tasks`, `agent_events`, `watchlist`,
`config`, `mcp_servers`, `trading_controls`, `pending_approvals` — with
`COMMENT ON TABLE` lines naming which JSON file or localStorage key each one
replaces. Conventions: text ids matching `lib/storage.ts`'s `uid()`, `CHECK`
constraints instead of native enums, `jsonb` for already-nested structures.

Treat it as documentation of the data model plus a migration plan. Nothing
reads it today.

## 6. Safety invariants (do not break — `CLAUDE.md`)

1. **No AI-initiated trade may bypass the Supervisor gate.**
   `Supervisor.tsx`'s `reviewAndExecute()` is the single execution path for
   chat trade-actions, agent-plan ticks, Debate "Act on this", and the
   autonomous loop. *Manual human clicks are deliberately out of scope.*
2. **The leverage ceiling is not overridable.** `ABSOLUTE_MAX_LEVERAGE`
   (3x real / 10x paper) is deliberately **not** part of `RiskConfig`. Do
   not move it in.
3. **Every position requires a computed stop-loss.** No ATR ⇒
   `validateTrade()` hard-rejects.
4. **Closes/exits are never blocked.** Not by pause, not by risk checks, not
   by a Debate veto. Holds more for real money, not less.
5. **Learning never auto-deploys.** A hypothesis reaching production
   requires an explicit human click. Nothing in `lib/hypothesis*` or
   `lib/curiosityEngine.ts` may write to production risk config or strategy
   selection.
6. **Never fabricate market data.** Return `null` / `'unavailable'` rather
   than a plausible number.
