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

# Agent Specifications

Registry: `lib/agentDescriptors.ts` (`AGENT_DESCRIPTORS`). Types and
coverage reporting: `lib/agentOS.ts`.

## 1. The contract template (spec Section 5)

Every agent is supposed to be specified with all of these fields before it's
built:

```markdown
### Agent: <name>

**Purpose:** one sentence — what this agent exists to do.
**Responsibilities:** bullet list of what it owns.
**Inputs:** what data/events it consumes.
**Outputs:** what data/events/decisions it produces.
**Dependencies:** which other agents/services it relies on.
**Permissions:** exactly what it is and isn't allowed to do or touch.
**Memory:** what it remembers and for how long.
**Knowledge Sources:** what parts of the Knowledge Graph / DB it reads.
**Prompt:** link to its prompt file in 15_PROMPT_LIBRARY.md.
**APIs:** which internal/external APIs it calls.
**Database:** which tables/collections it reads and writes.
**Metrics:** what it reports for evaluation.
**Failure Recovery:** what happens if it crashes, times out, or returns
  garbage — must degrade safely, never fail silently.
**Events Published:** what it announces to the event bus.
**Events Consumed:** what it listens for.
**Health Status:** how the system checks if this agent is alive and sane.

**Every agent must be able to explain every decision it makes** — this is
non-negotiable and applies even to agents that seem purely mechanical.
```

### How the code's `AgentContract` differs — deliberately

`AgentContract` in `lib/agentOS.ts` implements: `purpose`, `inputs`,
`outputs`, `permissions`, `memory`, `metrics`, `failureRecovery`,
`healthCheck`, `explainability`. `dependencies` lives on the descriptor
itself rather than inside the contract.

**`eventsPublished` / `eventsConsumed` are intentionally absent.** There is
no event bus in this codebase (see `docs/03_AI_OPERATING_SYSTEM.md` §0), so
those fields would document a mechanism that does not exist.
`knowledgeSources`, `prompt`, `apis`, and `database` are also not modelled as
separate fields — that information is folded into `inputs`/`outputs`/`memory`
prose where it applies.

## 2. Every registered agent

31 descriptors. `tickIntervalMs: 0` means on-demand only — the scheduler
never auto-schedules it. "Contract" = whether the descriptor has a filled-in
`contract` field.

### Market intelligence

| id | name | category | pri | tickIntervalMs | dependencies | Contract |
|---|---|---|---|---|---|---|
| `market-data` | Market Data | market-intelligence | 0 | 0 (WebSocket-driven) | — | ✗ |
| `candle-feed` | Candle Feed | market-intelligence | 1 | 60 000 | `market-data` | ✗ |
| `market-structure` | Market Structure | market-intelligence | 2 | 5 000 | `candle-feed` | ✗ |
| `liquidity` | Liquidity Agent | market-intelligence | 2 | 10 000 | `candle-feed` | ✗ |
| `volume-profile` | Volume Profile | market-intelligence | 2 | 10 000 | `candle-feed` | ✗ |
| `order-flow` | Order Flow | market-intelligence | 2 | 5 000 | `market-data` | ✗ |
| `sentiment` | Sentiment Agent | market-intelligence | 3 | 30 000 | `market-data` | ✗ |
| `event-detection` | Event Detection | market-intelligence | 3 | 15 000 | `candle-feed`, `order-flow` | ✗ |

### Strategy

| id | name | category | pri | tickIntervalMs | dependencies | Contract |
|---|---|---|---|---|---|---|
| `trend-following` | Trend Following | strategy | 5 | 5 000 | `candle-feed`, `market-structure` | ✗ |
| `momentum` | Momentum | strategy | 5 | 5 000 | `candle-feed` | ✗ |
| `scalping` | Scalping | strategy | 5 | 3 000 | `candle-feed` | ✗ |
| `swing-trading` | Swing Trading | strategy | 5 | 10 000 | `candle-feed`, `market-structure` | ✗ |
| `mean-reversion` | Mean Reversion | strategy | 5 | 5 000 | `candle-feed` | ✗ |
| `breakout` | Breakout | strategy | 5 | 5 000 | `candle-feed`, `market-structure` | ✗ |
| `range-trading` | Range Trading | strategy | 5 | 5 000 | `candle-feed` | ✗ |
| `grid` | Grid Strategy | strategy | 6 | 10 000 | `candle-feed` | ✗ |
| `arbitrage` | Arbitrage | strategy | 6 | 10 000 | `order-flow` | ✗ |

`grid` and `arbitrage` are versioned **v0.9.0**: they vote in the ensemble but
**cannot execute** their own strategy style. That limitation is stated in
their own `description`/`changelog`, not hidden.

### Risk

| id | name | category | pri | tickIntervalMs | dependencies | Contract |
|---|---|---|---|---|---|---|
| `risk-manager` | Risk Manager | risk | 4 | 0 (per trade request) | `candle-feed`, `market-structure` | ✓ |
| `portfolio-intelligence` | Portfolio Intelligence | risk | 4 | 30 000 | `candle-feed` | ✗ |

### Execution

| id | name | category | pri | tickIntervalMs | dependencies | Contract |
|---|---|---|---|---|---|---|
| `planner` | Planner Agent | execution | 5 | 0 (per agent-task tick) | `candle-feed` | ✗ |
| `autonomous-trader` | Autonomous Trader | execution | 5 | 60 000 | `strategy-ensemble`, `debate`, `mission-planner`, `supervisor`, `event-detection` | ✓ |

### Orchestration

| id | name | category | pri | tickIntervalMs | dependencies | Contract |
|---|---|---|---|---|---|---|
| `strategy-ensemble` | Strategy Ensemble | orchestration | 7 | 5 000 | all 9 strategy agents | ✗ |
| `debate` | Debate System | orchestration | 8 | 0 (on demand) | `strategy-ensemble`, `sentiment` | ✗ |
| `supervisor` | Supervisor AI | orchestration | 9 | 0 (per trade request) | `risk-manager`, `strategy-ensemble`, `debate` | ✓ |
| `mission-planner` | Mission Planner | orchestration | 3 | 30 000 | `supervisor` | ✓ |
| `collaboration` | Collaboration Protocol | orchestration | 9 | 0 (on low confidence/conflict) | `supervisor` | ✓ |

### Learning

| id | name | category | pri | tickIntervalMs | dependencies | Contract |
|---|---|---|---|---|---|---|
| `reflection` | Reflection Agent | learning | 10 | 0 (on trade close) | `candle-feed` | ✓ |
| `memory` | AI Memory | learning | 10 | 0 (on preference change) | — | ✗ |
| `autonomous-research` | Autonomous Research | learning | 10 | 300 000 | `candle-feed`, `sentiment` | ✗ |
| `hypothesis` | Hypothesis Agent | learning | 10 | 0 (once a lesson exists) | `reflection` | ✓ |
| `curiosity` | Curiosity Engine | learning | 10 | 900 000 | `strategy-ensemble`, `market-structure` | ✓ |

## 3. Contract coverage — what `contractCoverage()` reports

| Metric | Value |
|---|---|
| `total` | **31** |
| `withContract` | **8** |
| `missing` | **23** |
| `unexpectedExecutionAuthority` | **[] (empty)** |

**Has a contract (8):** `risk-manager`, `supervisor`, `mission-planner`,
`reflection`, `autonomous-trader`, `hypothesis`, `curiosity`,
`collaboration`.

**Missing a contract (23):** `market-data`, `candle-feed`,
`market-structure`, `liquidity`, `volume-profile`, `order-flow`, `sentiment`,
`event-detection`, `trend-following`, `momentum`, `scalping`,
`swing-trading`, `mean-reversion`, `breakout`, `range-trading`, `grid`,
`arbitrage`, `strategy-ensemble`, `debate`, `portfolio-intelligence`,
`planner`, `memory`, `autonomous-research`.

**Status: contract coverage is incomplete (8/31).** The spec requires a full
contract for every agent before it's built; that is not true here.
`contract` is optional on `AgentDescriptor` so it can be backfilled
incrementally, and `contractCoverage()` exists specifically so the gap shows
up in the Agent OS panel instead of being quietly assumed closed. The eight
that do have one are the safety-relevant and newest agents — the execution
gate, the risk veto, the autonomous loop, and the whole learning pipeline.

## 4. Only `supervisor` may hold `execute-trades`

`lib/agentOS.ts` declares:

```ts
export const SOLE_EXECUTION_AUTHORITY: AgentId = 'supervisor';
```

and `contractCoverage()` collects any agent whose contract claims
`'execute-trades'` while its id is not `'supervisor'` into
`unexpectedExecutionAuthority`. The module comment is explicit: *"Only one
execution authority is allowed to exist (see CLAUDE.md's safety invariants),
so a second one appearing is a review-stopping finding, not a warning."*

The permission boundaries the eight contracts actually declare:

| Agent | Permissions | Boundary |
|---|---|---|
| `supervisor` | read-market-data, read-trade-log, read-portfolio, veto-trade, **execute-trades**, write-store | The only holder of `execute-trades` |
| `risk-manager` | read-market-data, read-trade-log, read-portfolio, **veto-trade** | Notably no `execute-trades`: "can only ever say no; it has no path to an exchange" |
| `autonomous-trader` | read-market-data, read-portfolio, read-trade-log, **propose-trade**, write-store, human-gated | Proposes only — it calls `startAgent()`, and that task's tick routes through the Supervisor |
| `mission-planner` | read-portfolio, read-trade-log, emit-signal, write-store | Advisory; `scoreMissionAlignment` explicitly does not block |
| `reflection` | read-market-data, read-trade-log, call-llm, write-store | "explicitly NOT propose-trade or execute-trades. There is no code path from a reflection's text to a trade action, by design" |
| `hypothesis` | read-trade-log, call-llm, write-store, **human-gated** | No write access to any production strategy or risk config (spec Section 12) |
| `curiosity` | read-market-data, read-trade-log, read-portfolio, emit-signal | Pure computation; no store, no LLM |
| `collaboration` | call-llm, write-store | Fire-and-forget second opinion; can never delay or override a decision |

Review rule: **any new descriptor claiming `execute-trades` is a blocking
finding.** Route it through `components/Supervisor.tsx`'s
`reviewAndExecute()` instead.

## 5. Backfilling a contract

1. Add a `contract: { … }` object to the descriptor in
   `lib/agentDescriptors.ts` — all nine fields are required by the type.
2. Be honest in `failureRecovery` and `healthCheck`: they must describe safe
   degradation and a real liveness signal, not aspirations. `memory: 'none'`
   is a valid and common answer.
3. `permissions` must be the *minimum* set the agent actually uses. Do not
   add `execute-trades`.
4. `explainability` is non-negotiable, including for purely mechanical
   agents — state how the agent's output is traceable to real inputs.
5. `npx tsc --noEmit` then `npm run test`; `contractCoverage()`'s numbers
   move on their own.
