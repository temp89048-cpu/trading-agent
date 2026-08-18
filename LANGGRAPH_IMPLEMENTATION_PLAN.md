# TradingOS — LangGraph Implementation Plan

**Status: PLAN ONLY. No production code has been written for this.**
Companion to `TradingOS-LangGraph-Architecture-Spec.md`.
Written 2026-08-13, after the Phase 1–22 hardening pass.

This is the document to re-read before writing the first line of LangGraph code.
It exists because the spec's own Section 38 says to audit before building, and
because the audit produced a conclusion that changes the plan substantially.

---

## 0. Read this first — the headline finding

**Most of Phases 23–50 are already implemented, in deterministic Python, with
tests that specifically assert they are deterministic.**

The spec was written assuming Phase 1–22 exists as "loose agents" and that
23–50 are all greenfield. That is no longer true. The hardening pass built,
among others:

| Spec phase | Already built as |
|---|---|
| 28 Risk Gateway | `agents/cro_agent.py` + `core/risk_manager.py` |
| 29 Execution Graph | `agents/execution_agent.py` |
| 30 Position Monitoring | `agents/position_monitor.py` |
| 33 Reflection Graph | `agents/reflection_agent.py` |
| 34 Learning System | `agents/hypothesis_agent.py` + `services/research_store.py` |
| 37 Bayesian Engine | `algorithms/probability.py` wired into `confidence_agent` |
| 38 Regime Intelligence | `agents/regime_agent.py` |
| 39 Portfolio Intelligence | `agents/cio_agent.py` + `portfolio_agent.py` |
| 47 Multi-Agent Debate | `algorithms/debate.py` + `agents/debate_agent.py` |
| 49 Curiosity Engine | `workers/curiosity_worker.py` |

So the plan is **not** "build 28 phases". It is:

1. Build the LangGraph runtime (Phase 23) — genuinely new.
2. Wrap the *existing* deterministic components as graph nodes.
3. Add LLM reasoning **only** at the small number of points where genuine
   judgement applies and reproducibility is not required.

**The trap to avoid:** re-implementing the debate, the confidence calibration,
the stress test, or the risk checks as LLM nodes. Those were deliberately made
deterministic, and `tests/test_event_chain.py::test_debate_scoring_is_deterministic`
plus `test_prompt_library.py` assert it. Converting them to LLM calls would
delete the ability to backtest the decision rule — the same candles must always
produce the same verdict — and would re-introduce the exact fabrication class
this codebase spent a whole pass removing.

---

## 1. Architecture audit — what exists today
*(spec Section 38's `ARCHITECTURE_AUDIT.md`)*

### 1.1 The two-runtime reality

This is **not** the single Next.js app the older `CLAUDE.md` describes, nor the
`trading-os/` monorepo the LangGraph spec's Section 5 sketches. It is two
runtimes:

```
Next.js 14 (App Router)            FastAPI (backend/, 77 modules)
├── components/  React providers   ├── core/       kernel, bus, risk, auth
├── lib/         pure TS logic     ├── agents/     16 registered agents
├── app/api/     ~23 route         ├── algorithms/ deterministic math
│               handlers, .data/   ├── api/        12 routers, 38 routes
└── .data/       JSON stores       ├── services/   market/memory/research
                                   └── workers/    monitor + curiosity loops
```

Both are live. The frontend talks to its **own** `app/api/*` handlers for most
data (they read `.data/` and need no Postgres) and to FastAPI only for the
agent-event WebSocket. `lib/backendConfig.ts` is the single place that decides.

### 1.2 What plays the role LangGraph would take

| Spec concept | Current implementation | Verdict |
|---|---|---|
| Orchestrator | `core/message_bus.py` — in-process pub/sub, wildcard topic | **This is what LangGraph replaces** |
| Scheduler | `core/agent_os.py` — 3s tick loop, health, dependency gating | Keep; LangGraph is not a scheduler |
| Agent contract | `core/agent_base.py` — 18 abstract fields, permission-checked `publish()` | **Keep. This is the safety model to extend to nodes** |
| Shared state | *None* — each agent holds its own | **This is the real gap → `TradingState`** |
| Checkpointing | *None* | New |
| Tracing | *None* (only Python logging) | New |

### 1.3 The current reasoning chain

19 event types drive a linear chain through the bus:

```
TICK_RECEIVED
  → FEATURES_COMPUTED, MARKET_STRUCTURE_ANALYZED, MACRO_ANALYZED   (market_intelligence)
  → DEBATE_CONCLUDED                                               (debate_agent)
  → CONFIDENCE_CALIBRATED                                          (confidence_agent)
  → RISK_EVALUATED                                                 (portfolio_agent)
  → STRESS_TESTED                                                  (simulation_agent)
  → TAR_SUBMITTED                                                  (supervisor_agent)
  → TAR_APPROVED | TAR_REJECTED                                    (cro_agent)
  → ORDER_ROUTED, ORDER_FILLED                                     (execution_agent)
  → POSITION_CLOSED                                                (position_monitor)
  → REFLECTION_COMPLETED                                           (reflection_agent)
  → (hypothesis_agent consumes; terminal)
```

**This chain is already the graph in spec Section 3.** It maps node-for-node.
The migration is therefore mechanical in shape, not a redesign — which is the
single best piece of news in this audit.

### 1.4 Known gaps carried forward (do not silently inherit)

These are documented in-code and must not be assumed fixed by LangGraph:

- **Resting stop orders are not implemented.** `position_monitor` is a *soft*
  stop: it fires only while the process is alive. Highest-value reliability gap
  in the system.
- **TWAP plans slices but sends one order** — no scheduler for chunks.
- **Exchange selection does not exist** (single venue).
- **Order-level retry is not written** (idempotency makes it safe; the loop
  isn't there).
- **CEO high-water mark is not persisted** — a restart loses the drawdown
  baseline.
- `optimize_portfolio_weights_naive` is in `KNOWN_UNWIRED` on purpose.

---

## 2. Phase status
*(spec Section 38's `CURRENT_PHASE_STATUS.md`)*

Legend: **DONE** = built + tested · **PARTIAL** = exists, gaps named ·
**NEW** = nothing exists · **NEW-LG** = exists deterministically, LangGraph adds
orchestration only

| Phase | Title | Status | Where / what's missing |
|---|---|---|---|
| 23 | LangGraph Foundation | **NEW** | Everything. See §5. |
| 24 | Market State Graph | NEW-LG | `market_intelligence` + `regime_agent` exist; needs graph + validation node |
| 25 | Trading Opportunity Graph | NEW-LG | `strategy_profiles` scoring exists; needs thesis synthesis node |
| 26 | Multi-Agent Analysis | PARTIAL | 5 of 7 specialists exist. **Missing: Liquidity, Orderflow** as agents |
| 27 | Supervisor Graph | PARTIAL | `supervisor_agent` decides; cannot answer all 10 questions of §10 |
| 28 | Risk Gateway | **DONE** | 9 checks: 7 exist, **margin + daily-loss missing** (see §7) |
| 29 | Execution Graph | **DONE** | Stays outside LangGraph, per Rule 0 |
| 30 | Position Monitoring | PARTIAL | Price/stop/TP done. Missing funding, vol, liquidity, news, regime, portfolio-risk triggers; only HOLD/EXIT (no REDUCE/MODIFY) |
| 31 | Continuous Monitoring | PARTIAL | `monitor_worker` is a 60s **timer**. Spec requires **event triggers**. Must move earlier — see §4 |
| 32 | Trading Memory | PARTIAL | 3 of 7 stores. Missing Working, Semantic, Procedural, Risk memory |
| 33 | Reflection Graph | **DONE** | `reflection_agent` on `POSITION_CLOSED` |
| 34 | Learning System | **DONE** | `hypothesis_agent` + `research_store`, human-gated |
| 35 | Trading Style Intelligence | PARTIAL | 9 profiled + 16 planned. The 4 *timeframe styles* are not modelled as first-class |
| 36 | Strategy Selection | **DONE** | Regime gating + weighted ensemble |
| 37 | Bayesian Decision Engine | PARTIAL | `bayesian_update` wired. **Missing: explicit expected-value calc** |
| 38 | Regime Intelligence | PARTIAL | 4 regimes. Spec wants 10 (accumulation, distribution, panic, euphoria, liquidity crisis) |
| 39 | Portfolio Intelligence | **DONE** | `cio_agent` correlation clusters + caps |
| 40 | Adaptive Risk | PARTIAL | Kelly + vol sizing. **Missing: drawdown-responsive scaling** |
| 41 | Execution Intelligence | PARTIAL | Slippage + latency scored. TWAP/venue/retry gaps above |
| 42 | Cross-Exchange | PARTIAL | `exchange_agent` compares 4 venues; not used for routing |
| 43 | Market Graph Intelligence | PARTIAL | `build_asset_graph` wired into CIO clustering only |
| 44 | Institutional Footprint | **NEW** | Needs order-book + liquidation feeds |
| 45 | Research Agent | PARTIAL | `research_agent` + queue; no experiment runner |
| 46 | Simulation Lab | PARTIAL | `backtest_engine` + Monte Carlo. **No walk-forward** |
| 47 | Multi-Agent Debate | **DONE** | `algorithms/debate.py`, deterministic |
| 48 | External AI Consultation | PARTIAL | **TypeScript only** (`lib/collaborationAgent.ts`). No backend path |
| 49 | Curiosity Engine | **DONE** | `curiosity_worker` reads real ledger |
| 50 | Meta-Learning | **NEW** | Needs decision-quality scoring over history |

**Count: 8 DONE · 17 PARTIAL · 3 NEW.** The work is mostly *completion and
orchestration*, not construction.

---

## 3. The risk boundary — how Rule 0 gets enforced
*(spec Section 38's `RISK_BOUNDARY.md`. This is the most important section.)*

Spec Rule 0: *"LangGraph can recommend a trade; it can never place one."*
A comment saying so is not enforcement. Three mechanisms, all testable:

### 3.1 Nodes get a permission contract, like agents do

`BaseAgent.publish()` already raises `PermissionError` when an agent emits an
event it never declared. Graph nodes get the same treatment:

```python
@dataclass(frozen=True)
class NodeContract:
    name: str
    reads: tuple[str, ...]        # TradingState fields it may read
    writes: tuple[str, ...]       # TradingState fields it may write
    may_call_llm: bool
    deterministic: bool
```

A node writing a field outside `writes` raises. A node with
`deterministic=True` that reaches an LLM raises.

### 3.2 Three symbols no graph node may import

Enforced by an AST test, the same technique as
`tests/test_learning_pipeline.py::test_no_learning_module_imports_anything_that_can_change_trading`:

- `ExecutionAgent` / `execution_agent`
- `create_market_order`
- `TarApprovedEvent` (only the CRO may construct one)

A test walks every module under `graphs/` and fails on any of these imports.
This is stronger than review: a node *cannot* place an order because the symbol
that places orders is not reachable from it.

### 3.3 The graph terminates at a request, not an action

The graph's terminal node emits an `ExecutionRequest` — a plain dataclass, not
an event, not an order. A separate deterministic service converts an approved
request into a `TarSubmittedEvent`. That boundary means the LangGraph half can
be entirely wrong and still cannot move money.

```
LangGraph  →  ExecutionRequest (inert data)
                    │
              Risk Gateway (existing cro_agent, deterministic)
                    │  APPROVED only
                    ▼
              ExecutionAgent (existing, outside the graph)
```

### 3.4 What must stay deterministic — non-negotiable list

Carried from CLAUDE.md's invariants plus this pass's decisions. Each already
has tests:

| Component | Why it cannot be an LLM node |
|---|---|
| `risk_manager.check_leverage` | Ceiling must be un-overridable (invariant 2) |
| `risk_manager.compute_stop_loss_take_profit` | Every position needs a computed stop (invariant 3) |
| `cro_agent` veto | A veto a model could argue with is not a veto |
| `position_monitor` stop check | Latency and non-determinism both unacceptable in an exit path |
| `algorithms/debate.score_debate` | Same candles must yield the same verdict, or no backtest |
| `simulation_agent` Monte Carlo | Seeded specifically so a verdict is reproducible |
| `system_state` kill switch | Threshold comparison, never judgement |

---

## 4. Two ordering changes to the spec's phase sequence

I am deviating from the spec's numbering in exactly two places, and this is the
reasoning:

### 4.1 Phase 31 (event triggers) must move to immediately after Phase 23

The spec places continuous monitoring at 31. That is too late. The current
`AgentOS` scheduler ticks **every 3 seconds**. If graph runs are wired to that
tick and any node calls an LLM, the system makes ~28,800 model calls a day per
symbol. That is not a cost concern to optimise later — it makes Phases 24–30
untestable, because every iteration burns budget and every run takes seconds.

The spec itself says event triggers are *"far more efficient than 'every 5
minutes → run LLM'"*. Build that **before** the first LLM node exists, not six
phases after.

### 4.2 An LLM provider is an unlisted prerequisite of Phase 23

There is **no LLM client anywhere in `backend/`**. `api/ai.py::/reason`
deliberately returns 501 with the reason stated. `OPENAI_API_KEY` is read in
`core/config.py` and used by nothing. So Phase 23 cannot be "LangGraph runtime"
alone — it must first introduce a model provider abstraction, or every
subsequent phase blocks on it.

That provider must be swappable (the TS side already supports a configurable
provider + a separate second-opinion model), and must fail closed: an
unavailable model returns `None`, never a plausible-looking answer.

---

## 5. Phase 23 in detail — the only phase to build first

**Deliverable: a graph runtime that can run one trivial graph end-to-end, with
persistence and tracing, and zero ability to trade.**

### 5.1 New dependencies

```
langgraph
langchain-core
langgraph-checkpoint-sqlite     # dev checkpointer
langgraph-checkpoint-postgres   # prod checkpointer (schema.sql already targets PG)
```

**Verify before installing:** the venv is Python **3.13.15**. Confirm LangGraph
supports 3.13 at the pinned version; if not, this becomes a Python-version
decision, not a library decision. Do not discover this halfway through.

### 5.2 Layout — additive, not the spec's Section 5 restructure

The spec's `trading-os/` monorepo layout would mean moving all 77 backend
modules. That is a large, risky, zero-functional-benefit change, and the spec
itself says *"don't force your existing project into this structure blindly."*
So: add alongside.

```
backend/
├── graphs/
│   ├── __init__.py
│   ├── state.py          TradingState + all field models
│   ├── contracts.py      NodeContract + enforcement
│   ├── registry.py       node name → callable + contract
│   ├── builder.py        assemble a StateGraph from a config
│   ├── runtime.py        run/resume, checkpointer wiring
│   ├── tracing.py        per-run trace records
│   └── nodes/            one module per node, thin wrappers
│       └── ...           over EXISTING agents
└── llm/
    ├── provider.py       swappable client, fails closed
    └── budget.py         per-run call + token ceiling
```

`graphs/nodes/*` are **thin wrappers**. A node reads `TradingState`, calls the
existing agent or algorithm, writes back named fields. If a node contains
trading logic, that logic is in the wrong place.

### 5.3 `TradingState` — with one correction to the spec

The spec's Section 4 schema is adopted with additions. The correction:
`confidence: float` should be `confidence: float | None`.

A missing confidence and a zero confidence are different facts, and this
codebase has now been bitten by that exact class of bug repeatedly — slippage
hardcoded to `0.0`, `prob_of_ruin: 0.0` with no data, `fng: 50` on a failed
fetch. `0.0` reads as "measured no confidence"; `None` reads as "not measured".

Additions beyond the spec:

```python
run_id: str
trigger: TriggerReason          # what caused this run (Phase 31)
symbol: str
errors: list[NodeError]         # per-node failures; a run continues degraded
unavailable: list[str]          # checks that could NOT be evaluated
llm_calls_made: int             # budget accounting
started_at: float
```

`unavailable` matters as much as the analysis fields. Every component in this
system now distinguishes "evaluated and found nothing" from "could not
evaluate", and the graph state must carry that distinction or it is lost at the
first node.

### 5.4 Checkpointer

SQLite for dev, Postgres for prod. `db/schema.sql` already targets Postgres
with 26 tables, so the prod checkpointer shares that database.

**Decision to make explicitly:** graph state will contain market data and
decision rationale. It will **not** contain API keys, and the checkpointer
tables must be covered by the same secrets rule as everything else — exchange
keys are deliberately absent from `schema.sql` and must stay absent here.

### 5.5 Definition of done for Phase 23

- [ ] A two-node graph runs, checkpoints, and resumes from checkpoint.
- [ ] `NodeContract` violations raise, with a test proving it.
- [ ] AST test: no module under `graphs/` imports the three forbidden symbols.
- [ ] LLM provider returns `None` on failure; a test asserts no fabricated text.
- [ ] Per-run LLM budget enforced; exceeding it aborts the run, not the process.
- [ ] A trace record is written for every run, including failed ones.
- [ ] `pytest` still green (currently **473 passed**), `tsc` clean,
      `npm run build` succeeds, 77/77 backend modules import.

---

## 6. Phase-by-phase plan, 24 → 50

Each entry: what to build, what to reuse, and the one thing most likely to go
wrong.

### Graph 1 — Market Intelligence (Phases 24, 31, 38, 43, 44)

| Phase | Build | Reuse | Risk |
|---|---|---|---|
| 24 | `market_state_graph`: validate → features → analyse → regime | `market_intelligence`, `regime_agent` | A validation node that "fixes" bad data instead of rejecting it. Reject. |
| 31 | Event triggers replacing the 3s tick | `event_agent` anomaly detection | Trigger storms. Needs debounce per symbol + a max-runs-per-minute ceiling. |
| 38 | Extend 4 regimes → 10 | `regime_agent` | Adding regimes silently changes every `active_regimes` gate in `strategy_profiles`. Must update all 9 profiles in the same change. |
| 43 | Asset-relationship graph as a first-class node | `build_asset_graph` | Correlation ≠ causation. Keep it evidence, never a signal. |
| 44 | Institutional footprint | *nothing* | **Blocked**: needs order-book + liquidation feeds. Do not approximate from klines. |

### Graph 2 — Trade Decision (Phases 25, 26, 27, 35, 36, 37, 40)

| Phase | Build | Reuse | Risk |
|---|---|---|---|
| 25 | Thesis synthesis node | `strategy_profiles` scoring | The thesis is the **first genuine LLM node** — narration over computed evidence. It must not be able to change the score. |
| 26 | Add Liquidity + Orderflow specialists | 5 existing specialists | Both need real depth data. Ship as `unavailable` until the feed exists rather than faking. |
| 27 | Supervisor answers all 10 questions | `supervisor_agent` | Two of the ten ("what could happen next", "what contradicts it") are genuinely LLM work. The other eight are already computed — do not re-derive them in prose. |
| 35 | Model the 4 timeframe styles | `strategy_profiles` | Style must constrain hold time and stop distance, or it is decoration. |
| 36 | *(done)* | regime gating | — |
| 37 | Add explicit expected-value calc | `bayesian_update` | EV from an LLM-supplied probability is laundered guesswork. Probability must come from calibrated history. |
| 40 | Drawdown-responsive risk scaling | `kelly_risk_fraction`, CEO HWM | Must only ever scale **down** through the existing ceiling. Never widen a limit. |

### Graph 3 — Execution (Phases 29, 41, 42) — *stays outside LangGraph*

| Phase | Build | Reuse | Risk |
|---|---|---|---|
| 29 | `ExecutionRequest` boundary type | `execution_agent` | Any convenience shortcut from graph → executor destroys Rule 0. |
| 41 | TWAP scheduler, order retry | `twap_order_slicer`, idempotency key | Retry without the existing idempotent client-order-id double-fills. |
| 42 | Venue selection | `exchange_agent` | A stale quote looks like a better venue. Freshness check first. |

### Graph 4 — Position Monitoring (Phase 30)

Extend `position_monitor` with the 6 missing triggers and REDUCE/MODIFY
actions. **Risk:** the stop check must stay on the fast deterministic path. If
an LLM node is added to this graph, a model timeout must never delay an exit —
the exit path and the reasoning path must be separate code paths.

### Graph 5 — Reflection (Phase 33) · Graph 7 — Learning (34, 50)

Mostly done. Phase 50 (meta-learning) is new and is the natural consumer of the
`execution_quality` table and the confidence-calibration deltas already being
recorded.

**Risk:** meta-learning is the phase most likely to acquire a path to
production config. The AST import test from §3.2 must cover it.

### Graph 6 — Research (Phases 45, 46, 48, 49)

| Phase | Build | Reuse | Risk |
|---|---|---|---|
| 45 | Experiment runner | `research_store`, `backtest_engine` | Must write findings, never config. |
| 46 | **Walk-forward validation** | `backtest_engine` | This is the missing gate that makes Phase 34's pipeline real. Highest research priority. |
| 48 | Backend consultation service | `lib/collaborationAgent.ts` as the reference | External model output is *evidence*. Must be recorded, attributed, and unable to override risk. |
| 49 | *(done)* | `curiosity_worker` | — |

### Phase 32 — Memory (4 of 7 stores missing)

| Store | Status |
|---|---|
| Episodic | `ai_memory` trade ledger ✓ |
| Strategy | per-strategy stats in learning report ✓ |
| Research | `research_store` ✓ |
| Working | **new** — becomes `TradingState` + checkpointer |
| Semantic | **new** — `knowledge_graph` is the seed |
| Procedural | **new** — closest thing is `prompts/registry.py` |
| Risk | **new** — `risk_events` table exists, unused |

---

## 7. Risk Gateway gap — Phase 28's two missing checks

Spec Section 11 lists 9 checks. Current state:

| Check | Status |
|---|---|
| Max Position | ✓ `validate_trade` (50% of equity) |
| Max Leverage | ✓ un-overridable ceiling |
| Max Drawdown | ✓ CEO killswitch (10% from monthly HWM) |
| Correlation | ✓ CIO cluster caps |
| Exposure | ✓ CIO group limit |
| Liquidity | ✓ volume check |
| Kill Switch | ✓ `system_state` |
| **Margin** | **MISSING** |
| **Daily Loss** | **MISSING** |

Both must be added **before** any LangGraph node can propose a trade, because
the Risk Gateway is the boundary that makes the cognitive plane safe to be
wrong. `schema.sql`'s `trading_controls` already has the columns to configure
them.

---

## 8. The $2 → $20 Goal Engine (spec Section 37)

Already half-built: `MissionType` includes `'capital-target'` and there is a
live mission — *"Grow $2 to $5 — no fixed deadline"*.

The rule to preserve, from `CLAUDE.md`: a capital-target mission has **no
deadline** and produces **advisory caution notes only** — never a hard rule,
never a sizing override. The spec agrees: the system must be willing to answer
**DO NOT TRADE** even when that delays the goal.

What Phase 23+ adds: the goal becomes a *read-only input* to the
thesis/decision nodes, so the reasoning can mention progress without the goal
being able to widen a limit. **Test to write:** a mission far behind target must
not increase position size.

---

## 9. Event schema changes needed
*(spec Section 38's `EVENT_SCHEMA.md`)*

19 event types exist. Additions required:

| Event | Needed by | Note |
|---|---|---|
| `GRAPH_RUN_STARTED` / `GRAPH_RUN_COMPLETED` | 23 | Observability; the WS bridge picks these up free |
| `TRIGGER_FIRED` | 31 | Carries the trigger reason and debounce state |
| `EXECUTION_REQUESTED` | 29 | The inert graph→control boundary |
| `POSITION_MODIFIED` | 30 | REDUCE/MODIFY, distinct from `POSITION_CLOSED` |
| `CONSULTATION_COMPLETED` | 48 | External-model evidence, attributed |

**Constraint:** `TAR_APPROVED` stays exclusive to the CRO.
`tests/test_agent_contracts.py::test_only_the_cro_may_approve_a_tar` enforces
it and must keep passing.

---

## 10. Build order, with gates

Each step ends with: `pytest` green · `tsc` clean · `npm run build` · all
backend modules import. No step starts before the previous one is stable.

| # | Step | Phases | Gate |
|---|---|---|---|
| 1 | LLM provider + budget | prereq | Fails closed; no fabricated output |
| 2 | Graph runtime + state + contracts | 23 | Two-node graph resumes from checkpoint |
| 3 | Event triggers | 31 | Debounced; tick-driven LLM runs impossible |
| 4 | Risk Gateway completion | 28 | Margin + daily-loss checks tested |
| 5 | Market Intelligence graph | 24, 38 | Regime extension updates all 9 profiles |
| 6 | Trade Decision graph | 25, 26, 27 | First LLM node; cannot alter scores |
| 7 | ExecutionRequest boundary | 29 | AST test: no order symbol reachable from `graphs/` |
| 8 | Position Monitoring graph | 30 | Exit path independent of any LLM |
| 9 | Memory stores | 32 | 4 new stores |
| 10 | Research + walk-forward | 45, 46 | Walk-forward gate real |
| 11 | Consultation service | 48 | Advisory only, recorded, attributed |
| 12 | Adaptive risk, EV, styles | 35, 37, 40 | Can only scale down |
| 13 | Meta-learning | 50 | Cannot write config |
| 14 | Remaining intelligence | 41–44 | Feed-blocked items stay `unavailable` |

**Phases 51–100 are explicitly out of scope for this plan.** Re-plan after 50.

---

## 11. Decisions I am deliberately making, and why

Recorded so future-me doesn't relitigate them:

1. **One plan file, not the spec's 7 docs.** `docs/` has 24 files: 7 are
   byte-identical stubs and 3 were overwritten with wrong content. Seven files
   nobody updates is how that happened.
2. **No monorepo restructure.** Moving 77 modules for zero functional gain, on
   a system that now works, is the highest-risk lowest-value action available.
   The spec permits skipping it.
3. **Deterministic components stay deterministic.** LangGraph orchestrates
   them. LLM nodes are added only for thesis narration, reflection prose,
   research questions, and external consultation.
4. **`confidence: float | None`, not `float`.** Correcting the spec. This
   codebase has been bitten repeatedly by a zero standing in for "unknown".
5. **Phase 31 moves before Phase 24.** Cost and testability, not preference.
6. **The graph terminates at inert data.** `ExecutionRequest` is a dataclass,
   not an event. Rule 0 becomes structural rather than procedural.

---

## 12. Honest risks

- **Determinism erosion.** The likeliest failure is LLM nodes gradually
  absorbing decisions the deterministic layer owns. Mitigation: `NodeContract`
  `deterministic` flag, plus the existing prompt-registry tests that assert
  which stages take no model input.
- **Cost.** Un-debounced triggers on a 24/7 system can be worse than the 3s
  tick. Hard per-run and per-hour ceilings, enforced in code.
- **State bloat.** `TradingState` carrying full kline arrays through a
  checkpointer will be slow and large. Carry references/summaries, not raw
  series.
- **Two orchestrators coexisting.** During migration both the MessageBus chain
  and the graph will exist. Both must not act on the same tick — the graph
  consumes triggers, the bus keeps carrying execution/monitoring events.
- **The soft-stop gap is unchanged by any of this.** LangGraph does not make a
  position safer. Resting exchange stops remain the single highest-value
  reliability change available, and it is not a LangGraph phase.

---

## 13. Build log — what is actually done

Updated as phases land. Everything above is the plan; this is the record.

### Phase 23 — LangGraph Foundation ✅ (spec Sections 0-6, 39)

`langgraph 1.2.11` on Python 3.13.15. Built:

| File | Purpose |
|---|---|
| `backend/graphs/state.py` | `TradingState` + 14 payload models |
| `backend/graphs/contracts.py` | `NodeContract`, 4-layer Rule 0 enforcement |
| `backend/graphs/registry.py` | node → callable + contract |
| `backend/graphs/builder.py` | `GraphConfig` → compiled `StateGraph` |
| `backend/graphs/runtime.py` | checkpointer, thread ids, node wrapping, errors |
| `backend/graphs/tracing.py` | per-run traces incl. failures |
| `backend/llm/provider.py` | swappable provider, fails closed |
| `backend/llm/budget.py` | per-run call + token ceiling |

**Bug found by the tests:** the synchronous `SqliteSaver` raises
`NotImplementedError` under `ainvoke`, and this whole backend is async — so it
would have passed a sync unit test and failed on the first real run. Switched to
`AsyncSqliteSaver` + `aiosqlite`, pinned with the reasoning in
`requirements.txt`.

**Deviation from 39.7:** local trace records, not LangSmith. LangSmith would ship
market data, position sizes and decision rationale to a third party — an
operator decision, not a side effect of adding tracing. Shape kept
exporter-friendly.

### Phase 31 — Event Triggers ✅ (spec Section 14) — built out of order

Built before Phase 24 deliberately: the scheduler ticks every 3s, so wiring
graph runs to it without a trigger layer means ~28,800 model calls/day/symbol,
which makes Phases 24-30 untestable rather than merely expensive.

- `backend/graphs/triggers.py` — 6 of Section 14's 8 triggers implemented
- `backend/workers/trigger_worker.py` — push path on `TICK_RECEIVED`, poll path
  for funding/OI/exchange/position
- `TRIGGER_FIRED` event added; **suppressions are published too**, because
  "detected and debounced" must be distinguishable from "never detected"

Three storm controls, all tested: per-(symbol, kind) cooldown; baseline advances
**only on a fire** (otherwise a sustained trend re-fires every tick); global and
per-symbol rate ceilings.

Trigger coverage:

| Trigger | Status |
|---|---|
| price_move | ✅ push, via websocket ticks |
| volatility_regime_change | ✅ poll |
| funding_change | ✅ poll — **BTC only** (endpoint is BTCUSDT-specific) |
| oi_spike | ✅ poll — **BTC only** |
| position_risk_change | ✅ poll |
| exchange_event | ✅ poll, fires on recovery as well as failure |
| liquidation_spike | ❌ no liquidation websocket subscribed |
| news_event | ❌ no backend news feed (TS side only) |

The worker publishes and starts no graph runs — a test asserts it cannot import
`build_graph`. Phase 24 subscribes to `TRIGGER_FIRED`.

### Production finding: Binance futures testnet is deprecated

The trigger worker's exchange-health check surfaced this on its first cycle:

```
binance testnet/sandbox mode is not supported for futures anymore
```

`USE_TESTNET=true` with `defaultType: 'future'` no longer gives a working paper
venue — private calls fail. It fails **closed** (ccxt raises rather than routing
to mainnet), so nothing unsafe happens, **but the safe default I previously
described does not function.**

**The real gate is `LIVE_TRADING=false`**, which puts the ExecutionAgent in
simulation mode and makes no exchange calls at all. Warning added at client
construction so this is not rediscovered during an incident.

---

### Phase 24 — Market State Graph ✅ (spec Section 7, Section 35 Graph 1)

Five deterministic nodes, no model calls — every field in the spec's example
output is a computed number.

`backend/graphs/nodes/market.py` + `backend/graphs/market_state.py`:

    data_validation -> feature_generation -> market_analysis
                    -> regime_detection -> market_state

Wired to `TRIGGER_FIRED`, **not** to the 3s tick. Suppressed triggers are
ignored (the trigger layer already decided). Exchange-health triggers start no
symbol run — an exchange event is not about one instrument.

Definitions the spec left open, pinned down so they are checkable:

| Field | Definition chosen | Why |
|---|---|---|
| `confidence` | fraction of the 4 regime fields that could be computed | Verifiable. A model's belief about being right would not be. |
| `liquidity` | volume-based **proxy**, labelled as such | True liquidity is order-book depth; no depth feed is subscribed. `LiquidityAnalysis.available` stays False — reserved for real depth. |
| `trend_strength` | EMA separation / price, unsigned | Price-normalised, or every high-priced asset looks strongly trending. Unsigned because direction lives in `technical_analysis.trend`; a second signed field could disagree with it. |

The result payload carries `confidenceMeaning` and `liquidityMeaning` strings, so
a consumer cannot mistake data coverage for a probability or a volume proxy for
measured depth.

**Validation rejects, never repairs.** Malformed candles (non-positive price,
high below low, negative volume) are discarded and counted; a forward-fill would
produce a snapshot that looks complete and is not. A 20% candle is *not* treated
as an outlier — that is a 20% move, and discarding it would hide the event worth
reasoning about.

`run_multi_timeframe_analysis` is deliberately NOT called from a node: it fetches
its own klines, which would violate Section 39.4. `data_validation` fetches all
three timeframes once into state.

**Verified end-to-end against the running app:** a `+4%` tick produced
`TRIGGER price_move`, which built and ran all five nodes. On a fake symbol the run
returned `regime=None` with the reason `no live price ...; 15m klines returned
empty` — honest degradation rather than a fabricated `TRENDING_BULL`.

**Bug found by that run:** `finish_run` auto-filled `no_decision_reason` for every
graph, so a fully successful market-state run was labelled *"no decision
produced"*. Phase 24's job is market state, not decisions. Added
`produces_decision=False` — a misleading trace is how an operator learns to
distrust the trace store.

Also confirmed live: Postgres **is** connected and `db/schema.sql` is applied
("Database schema already exists"), and 13 event-driven agents register with the
kernel.

---

### Phase 25 — Trading Opportunity Graph ✅ (spec Section 8, Section 35 Graph 2 pt 1)

`backend/graphs/nodes/opportunity.py` + `backend/graphs/opportunity.py`.
**9 nodes: 8 deterministic, 1 LLM.** The graph contains the Phase 24 nodes rather
than chaining to a second graph — passing state between two invocations means
serialising out and back, and the moment that happens the second graph is free to
re-fetch, which is the Section 39.4 hazard `market_data`'s write-once rule exists
to prevent.

**The first LLM node, and the state change it forced.**
`thesis_narrative` is now its own state key, separate from `trade_thesis`.
Reason: state writes are enforced per KEY, so a narrative living *inside*
`TradeThesis` would mean the model writes the whole object — and could change the
stop-loss it was asked to describe. `trade_thesis`, `selected_strategy` and
`candidate_strategies` were added to `DETERMINISTIC_ONLY_FIELDS`, so
`NodeContract` now **refuses to construct** an LLM node that writes them.
`test_the_narrative_contract_cannot_declare_a_write_to_the_thesis` asserts the
refusal.

Three properties make the model call safe: it writes only prose; it is given the
computed evidence rather than the market (no raw candles in the prompt, so there
is nothing to derive); and its absence is harmless — no provider, exhausted
budget or failed call leaves `thesis_narrative=None` and a stated reason, because
the numbers were never the model's to produce.

**Scoring cannot use track record, and says so on every run.** All nine profiles
carry `historical_success_rate=None`. `HISTORICAL_UNAVAILABLE` is always reported
rather than a neutral 0.5 being substituted — a score that silently included an
invented win rate would be the most persuasive fabrication in the system, because
it would look like evidence.

Other decisions worth remembering:

- **A weak best score selects nothing.** The highest of several weak scores is
  still a weak setup; proposing it turns "nothing is happening" into a trade.
- **HOLD scores zero on the signal component** — it is a strategy declining to
  act, not a weak buy.
- **Gated-out candidates keep `score=None`, not 0.0.** Zero reads as "scored and
  found worthless" when it was never scored.
- **An unmeasurable input contributes its midpoint, not zero** — scoring a
  missing measurement as a failure would penalise every strategy whenever
  higher-timeframe data was thin.
- **Volatility fit is derived from each profile's own `active_regimes`**, so it
  cannot disagree with the regime gate.
- **No ATR ⇒ no opportunity** (invariant 3 at the cognitive layer). Catching it
  here means it appears in traces as a setup that was never viable, rather than a
  trade the Risk Gateway rejected.
- **The LLM node is skipped by a router, not by an early return inside it** — an
  entered-then-returned node still costs a superstep and a checkpoint write and
  appears in the trace as though it ran.

**Bug found: a wrong reducer in the Phase 23 state schema.**
`candidate_strategies` carried `Annotated[..., operator.add]`, so when
`strategy_scoring` rewrote the list LangGraph *appended* it — leaving 18 entries,
nine unscored then nine scored. Worse than a wrong count: any consumer doing
`next(c for c in candidates if c.name == "Trend")` would find the **unscored**
copy and read `score=None`, concluding the strategy was never evaluated.
Accumulating reducers belong only on fields several writers genuinely contribute
to (`errors`, `unavailable`, `nodes_visited`).

**Verified live:** a `+4%` trigger ran the graph through 7 nodes and exited at
`strategy_scoring` with *"no regime determined; no market data"* — **the LLM node
was never entered**, so no tokens were spent on a run with no opportunity.

---

### Phase 26 — Multi-Agent Analysis ✅ (spec Section 9, Section 35 Graph 2 complete)

**Files:** `graphs/nodes/specialists.py` (7 specialists + debate),
`graphs/analysis.py` (Graph 2 complete), `tests/test_analysis_graph.py` (49 tests).
`graphs/builder.py` gained fan-out support; `graphs/state.py` gained
`SpecialistFinding`, `DebateVerdict`, `specialist_findings`, `debate_verdict`.

**Verified live** against real Binance klines: 17 nodes, panel **4 of 7**
available, `SHORT @ 0.164` confidence, coverage **0.571** (= 4.0/7.0 panel
weight, exactly as designed), **0 LLM tokens** (no provider configured — the
thesis numbers were unaffected).

#### The five decisions that mattered

**1. `role`: directional vs constraint.** Four specialists vote on direction
(market, orderflow, news, funding); three cannot (liquidity, portfolio, risk).
A portfolio book is not a market signal — a specialist reporting *"you already
hold three correlated longs"* is not evidence for shorting, and a
directional-only model has nowhere to put that except as a short vote, which
would be a fabricated bearish signal derived from your own positions.
Constraints cap conviction instead.

**2. Confidence is reduced twice, for reasons reported separately.**
`coverage` (fraction of directional panel weight measurable) and
`constraint_applied` (the *binding* constraint). Low confidence from coverage
means *"we could not see enough"*; from a constraint it means *"we saw plenty
and it says don't"*. Those lead an operator to do different things, so they are
not collapsed into one number.

**3. Constraints combine with `max()`, not a product.** Three concerns of 0.30
must reduce confidence by 30%, not by 66%. The binding constraint binds;
multiplying would misreport three small doubts as one large one.

**4. Panel weights are NOT renormalised over what happens to be wired up.**
Orderflow and News keep the weight they *would* have, so coverage reports the
true fraction missing. Today's panel therefore **cannot reach 1.0 confidence**,
and that is the correct report, not a defect.

**5. `score_debate` IS the market specialist.** The obvious alternative — the
debate node calling it as a separate leg alongside the panel — would have
counted the same candle evidence twice under two names, raising confidence
precisely where it should not.

#### Bugs found and fixed

| Bug | How it was caught | Why it mattered |
|---|---|---|
| `system_state.snapshot()` read with guessed camelCase keys (`"paused"`, `"observationMode"`); real keys are `is_paused`, `observation_mode` | a test asserting concern escalates when paused | `dict.get()` returned `None` for every one, so the risk specialist reported **"no governance block active" while the system was paused** — the most dangerous possible direction for that failure. Switched to the public predicates, where a rename is an ImportError rather than a confident wrong answer. |
| `analysis_config()` restated the `strategy_scoring` conditional edge it had already inherited | **the live run**, not a test | LangGraph rejects two branches on one node only at *compile* time, so it surfaced as a failed analysis run rather than a misconfigured graph. `GraphConfig.validate()` now owns the check. |
| `writes=("specialist_findings")` — a string, not a tuple | `NodeContract.__post_init__` | Introduced by my own bulk edit removing the redundant `"unavailable"` declaration. `set("...")` iterated the characters, so the contract reported writes to fields `'a'`, `'c'`, `'d'`… The construction-time check worked. |
| `specialist_risk` originally read `portfolio_state` | reasoning about the fan-out, before running it | Written by a **sibling in the same superstep**, so it would reliably find `None` and default to `"paper"` — a confident claim about the leverage limit on an account it never looked at. It now reports both ceilings. In a sequential graph reading a sibling's output is ordinary; in a fan-out it is always stale. |

#### Reducers, decided rather than assumed

`specialist_findings` is the one field in the whole state genuinely written by
several concurrent nodes. It uses `_merge_findings` (dedupe by name, last write
wins), **not** `operator.add`: a retried node would otherwise appear twice and
inflate `coverage` above the truth. This is the same class of bug as the
`candidate_strategies` 18-entry incident, guarded at the reducer.

`orderflow_analysis`, `liquidity_analysis` and `portfolio_state` each have
exactly one writer, so no reducer.

**A constraint discovered, not yet a problem:** `llm_calls_made` /
`llm_tokens_used` are plain ints computed as `(state.get(...) or 0) + 1`. Two
concurrent LLM nodes would raise, and an `operator.add` reducer would
double-count the base. It does not bite because all seven specialists are
deterministic — but **Phase 27+ must not put two LLM nodes in one superstep**
without fixing this first.

#### Builder change

`ConditionalEdge.destinations` values may now be a **tuple** of node names,
which fans out to all of them in one superstep. LangGraph's `path_map` values
must be single hashable names (a list raises `TypeError: unhashable type`), so
the fan-out case is wired via a list-returning router with no `path_map` —
which drops LangGraph's own destination check, so `_fan_out_router` re-adds it
and `validate()` verifies targets up front.

#### The narrative moved to the end

`trade_thesis_narrative` now runs **after** the debate and its prompt includes
the verdict. Its own system prompt requires it to state contradicting evidence,
and the panel's disagreement is the strongest contradiction in the run — a
rationale written before the debate would be a confident explanation of a trade
four specialists had not yet weighed in on.

---

### Phase 27 — Supervisor Graph ✅ (spec Section 10)

**Files:** `graphs/nodes/supervisor.py`, `tests/test_supervisor_graph.py`
(70 tests). `algorithms/probability.py` gained shared calibration helpers;
`graphs/state.py` gained `DebateVerdict.directional_confidence` and put
`decision` in `DETERMINISTIC_ONLY_FIELDS`.

**Graph 2 is now 18 nodes** and ends in a `TradeDecision`. Verified live against
real Binance klines (`DO_NOT_TRADE — panel says SHORT, setup says LONG`) and
across four branches with controlled candles.

#### All ten questions, answered deterministically

Every one of Section 10's ten answers is computable from state, so the node is
deterministic and `_assert_all_ten_answered` **raises** if any is blank — a
decision with three of ten questions filled would pass every other check in the
system and be unexplainable exactly when someone needed to audit it.

`decision` is deterministic-only. The narrative node moved again, to run *after*
the Supervisor, and its prompt now forbids arguing for a trade the Supervisor
declined.

#### The two boundaries that were held

**Sizing.** `size` and `leverage` are `None` on every branch, with a
parametrised test across all four. The Risk Gateway's margin and daily-loss
checks *still don't exist* — filling `size` here would have made the pipeline
look complete while the checks bounding it were missing.

**Probability.** Populated **only** when ≥20 resolved trades exist to measure a
hit rate from. Panel confidence measures how much of the panel agreed, not how
often such agreement has been right; reporting it as a probability would be the
most persuasive fabrication available to this system, because it looks like a
calibrated forecast and feeds sizing. Today that means **every decision reports
`probability=None`**, and the live run confirms it: *"only 0 resolved trade(s),
need 20 … a probability would be a prior, not a measurement"*.

#### 🔴 A real invariant-4 violation, found by the E2E run

**The bug.** `specialist_risk` reports `concern=1.0` when the system is paused
or emergency-stopped. The debate multiplies confidence by `(1 - concern)`, so
`confidence` became exactly **0.0**. The Supervisor's exit check gated on that
number — so **firing a kill switch made an exit recommendation structurally
impossible**, the precise inverse of what a kill switch is for.

**Why the unit tests missed it.** They built verdicts with `confidence` set
directly and never went through the constraint dampening. Only the end-to-end
run through the real debate node produced `confidence == 0.0`.

**Why it happened.** Both halves were individually correct — a constraint
*should* stop new risk, an exit *should* need evidence. The bug was one number
answering two different questions.

**The fix.** `DebateVerdict.directional_confidence` — coverage-scaled agreement
*before* constraint dampening.

| Question | Field | Emergency-stopped |
|---|---|---|
| Should we **open**? | `confidence` | 0.0 — correct, opening is forbidden |
| Should we **close**? | `directional_confidence` | 0.132 — the evidence survives |

A stale verdict lacking the field falls back to `confidence` **only when no
constraint was applied**; falling back when one was would restore the bug.
Three regression tests, one of which goes through the real `run_debate`.

#### ⚠️ A calibration finding, measured rather than assumed

`MIN_CONFIDENCE_TO_TRADE = 0.25`. The *arithmetic* ceiling is 0.571, but the
**observed** ceiling is much lower:

| Case | Observed | vs. 0.25 bar |
|---|---|---|
| Arithmetic maximum (4.0/7.0 weight) | 0.571 | — |
| Market + funding **agreeing** | **~0.31** | clears it |
| Market alone, funding neutral | **~0.23** | **below it** |

`score_debate` tops out near 0.53 on real-shaped candles, and an
available-but-neutral funding leg still counts in the denominator (correctly — a
specialist that looked and found nothing *is* weaker conviction).

**So TRADE is only reachable when the funding specialist agrees with the market
read.** With three of seven specialists blind and zero validated track record,
requiring two independent legs to agree is the bar this system has earned — and
I did **not** lower the threshold to make trades happen, because that is
optimising for activity. Two tests pin both sides of the bar so a future change
that makes TRADE *unreachable* fails loudly.

A perfectly linear ramp scores NEUTRAL, incidentally: RSI saturates and the
momentum check flips bearish. The test fixture uses a trend with pullbacks.

#### Other decisions

- **Exits are checked FIRST**, before the governance gate, with an AST test on
  the branch *order* — asserting only the outcome would still pass if someone
  hoisted the governance check and the test happened to use an unpaused system.
- **A thesis with no stop is `DO_NOT_TRADE`, not a crash.** Found by a test
  passing `stop_loss=None`, which produced a `TypeError` from the TRADE branch
  formatting the missing number. `detect_opportunity` already refuses without
  ATR, but a crash is the wrong failure mode for invariant 3 — the wrapper
  degrades a node error into "no decision produced" and the *reason* would have
  been lost.
- **`WAIT` and `DO_NOT_TRADE` are separate actions.** WAIT means "not yet";
  DO_NOT_TRADE means something actively contradicts or forbids it. Collapsing
  them loses the difference between "not now" and "not this".
- **Ledger reading was extracted to `algorithms/probability`**, shared with
  `ConfidenceAgent`. Two components computing a hit rate from one ledger is how
  they come to report different accuracies for the same history, and both feed
  sizing. `MIN_TRADES_FOR_ACCURACY` was defined twice; now once. The behavioural
  split stays at the call site: the shared helper returns `None`, the agent
  substitutes its 0.55 prior because it must always emit a number.
- **`produces_decision=True`** now, so an early exit records *why nothing
  traded* instead of the field being suppressed.
- **`_why_from_specialists` attributes every claim** to the specialist that
  produced it. An unattributed "why" cannot be checked against its source, which
  is exactly where `DebateVisualizer` used to invent "EMA 9 crossed above EMA 21".

---

### Phase 28 — Risk Gateway ✅ (spec Section 11)

**Files:** `graphs/nodes/risk_gateway.py`, `tests/test_risk_gateway.py` (69 tests).
`core/risk_manager.py` gained five checks, two statuses and a close bypass.
Graph 2 is now **19 nodes** and ends in an inert `ExecutionPlan`.

#### The audit: five of nine checks were missing, one was misnamed

| Spec check | Before | Now |
|---|---|---|
| Max Position | ✅ `PositionSize` | unchanged |
| Max Leverage | ✅ `Leverage` | unchanged |
| Max Drawdown | ❌ **misnamed** — `DrawdownExposure` was per-trade stop exposure | `PerTradeRisk` (renamed) + a real `MaxDrawdown` |
| Margin | ❌ absent | `check_margin` |
| Correlation | ⚠️ in `CIOAgent` only, not in the gateway | `check_correlation` |
| Daily Loss | ❌ absent | `check_daily_loss` |
| Exposure | ⚠️ conflated with Max Position | `check_portfolio_exposure` (TOTAL) |
| Liquidity | ✅ but the detail overclaimed | now says it is a volume proxy |
| Kill Switch | ❌ absent from the gateway | `check_kill_switch` |

The rename matters: `DrawdownExposure` implied portfolio drawdown and measured
this trade's stop loss. Two differently-scoped limits sharing one name in a
safety-critical module is how a reviewer concludes a limit is enforced when a
different one is.

**Extended `validate_trade` rather than writing a second gateway.** It is on the
live path (`supervisor_agent` → CRO → execution), so a new better gateway used
only by the graph would have left real trades on the weak path — exactly the
"two things that look like the risk gate" problem Phase 27 avoided. Every
existing caller now gets the four checks that need no new input.

#### 🔴 Strict mode initially rejected *every* trade

`MaxDrawdown` is **always** unmeasurable per-request — no per-request function has
memory of a previous equity peak. I marked it `'unavailable'`, and made strict
mode reject `'unavailable'`. Combined, the graph's gateway could never approve
anything.

Fixed with a real distinction rather than an exemption list:

| Status | Means | Strict mode |
|---|---|---|
| `unavailable` | an **input was not supplied**; the caller could fix it | **rejects** |
| `delegated` | **structurally** not computable here, a **named** owner has not objected | reports, never blocks |

`MaxDrawdown` (CEO owns the HWM) and cross-asset `Correlation` (CIO owns the
Pearson matrix over 180 4h candles) are `delegated`. `DailyLoss`, `Margin` and
`PortfolioExposure` are `unavailable` when their data is missing — and those are
exactly the ones a caller can fix. Strict mode now bites on caller omissions
without biting on facts about the architecture.

#### Invariant 4 is enforced at the gateway, verified live

`intent='close'` short-circuits **before any check runs**, recorded as a
`CloseBypass` check so an exit is distinguishable in the trace from a gateway
that crashed. The gateway is the one component whose whole job is saying no, which
makes it the one most likely to say no to an exit — and most likely to do so
precisely when a limit has been breached.

Live, through the real 19-node graph with an emergency stop active:

```
decision : EXIT SHORT
gateway  : APPROVED
    CloseBypass  pass  intent='close' — approved without evaluation per invariant 4
plan     : buy 2.0 @ 1x  stop=None tp=None  id=8eaa22400ca2ae56
```

Six tests cover it, including a close with the daily-loss limit already breached
and a close with no market data at all.

#### Live: all nine checks, on real thesis numbers

```
PositionSize       pass       Position size acceptable
Leverage           pass       1x is within the 10x ceiling
MaxDrawdown        delegated  tracked by the CEO agent, which has not fired its mandate
Margin             pass       $50,000 required at 1x against $100,000 free (2.00x cover, 1.2x min)
Correlation        pass       No existing BTC exposure and no other positions
DailyLoss          pass       No trades closed today (2026-08-14), so no realised loss
PortfolioExposure  pass       $50,000 (50.0% of equity) within the 100% limit
Liquidity          pass       5-candle volume 6,340 — a TRADED-VOLUME proxy only
KillSwitch         pass       No governance block active
plan: buy 367.4 @ 1x  stop=134.91  tp=138.43
```

A second run holding 1 BTC rejected on `Correlation` and produced **no plan**.
(`MIN_CONFIDENCE_TO_TRADE` was lowered to 0.05 for that demonstration only — the
Phase 27 finding means the real 0.25 threshold would have stopped at WAIT.)

#### Decisions

- **This is the only node that sizes.** Phase 27 named it as the owner and left
  `decision.size` None. Sizing runs **before** validation, because margin,
  exposure and per-trade risk are all functions of size — a gateway validating an
  unsized request checks nothing. The sizer proposes, the checks dispose.
- **Kelly is fed `decision.probability`, never the panel confidence.** That
  probability is None until 20 trades resolve, so `kelly_risk_fraction` falls
  back to fixed-fractional and says which rule applied. Feeding it panel
  confidence would be sizing on a number that is not a win rate.
- **A rejection produces no `ExecutionPlan` at all.** An unapproved plan is an
  object shaped exactly like an approved one, and the only thing stopping a
  downstream reader acting on it is that reader remembering to check a separate
  field. Not producing it removes the question.
- **The graph requests 1x, not the ceiling.** The ceiling is the maximum a human
  may configure, not a target for an autonomous system to aim at — nothing here
  has a validated track record to justify amplifying anything. Still passed
  through `max_leverage_ceiling` so a careless edit cannot exceed the hard limit.
- **The gateway does not write `decision`.** It writes `risk_assessment` and
  `execution_plan`. The Supervisor owns the decision record; a second node
  mutating it would leave an auditor unable to tell which node produced which
  field.
- **`idempotency_basis` is derived from decision identity, never `thread_id`**
  (Section 39.3). A thread id changes every run, so a basis built from it would
  let one decision be submitted twice after a restart — for an order, that means
  opening the position twice. `run_id` is included deliberately: a later run
  reaching the same conclusion is a real second decision.
- **Margin needs a buffer** (1.2x). Using the last dollar of margin means an
  adverse tick triggers a margin call *before* the stop is reached — liquidation
  at the exchange's price rather than exit at ours, which makes the computed stop
  meaningless. A stop that cannot be honoured is worse than no stop, because
  sizing was done against it.
- **Limits are derived, not tuned.** Daily loss 5% (above the 3% per-trade limit,
  or one in-rules loss would halt trading); portfolio exposure 100% (two
  maximum-size positions at the existing 50% single-trade limit); exposure stated
  in **notional** not margin, so leverage cannot hide it.

#### A test-writing pattern worth naming

Two tests broke across phase boundaries for the same reason: they asserted
**adjacency** (`(supervisor, narrative) in edges`) where the property was
**ordering**. Phase 27 broke a Phase 26 test; Phase 28 broke a Phase 27 one. Both
are now reachability checks. When a graph is built by extension, adjacency
assertions fail on changes that preserve exactly what they test.

---

### Phase 29 — Execution Service ✅ (spec Section 12)

**Files:** `services/execution_service.py`, `services/instrument_rules.py`,
`tests/test_execution_service.py` (44 tests). `models/events.py` gained
`EXECUTION_PLAN_READY` + `ExecutionPlanReadyEvent`; `graphs/analysis.py` publishes
it from the runner; `main.py` wires the service.

Section 12's chain is complete:

```
LangGraph -> ExecutionRequest -> Risk Gateway -> Execution Service
          -> [TAR_SUBMITTED] -> CRO -> ExecutionAgent -> Exchange
```

**Verified live on the real message bus** (ExecutionAgent replaced by a spy):

| Case | Result |
|---|---|
| Gate 1 unset (production default) | `EXECUTION_PLAN_READY` published, **no TAR** |
| `GRAPH_EXECUTION_ENABLED=true` | TAR submitted, `size=367.415` — **quantised** |
| Same plan redelivered | `duplicate`, refused |
| EMERGENCY STOP + gate 1 off + held SHORT | **close routed, no TAR** |

#### The three gaps Phase 28 flagged, closed

**1. Lot size.** Phase 28's live plan was `buy 367.41575011279235`. No exchange
accepts that. `services/instrument_rules.py` reads `stepSize`/`minQty`/`tickSize`/
`minNotional` from ccxt (`load_markets` is a **public** endpoint, so it works with
no API key and `LIVE_TRADING=false`), caches per process, and quantises.

Rounding is **always DOWN**, never up even when up is nearer. Up means the venue
fills a larger position than the risk checks approved — the per-trade limit was
computed against one number and filled at another. The consequence is deliberate:
a quantity that rounds to zero, below `minQty`, or below `minNotional` is a
**refusal**, not a bumped-up order. Sizing up to reach a venue minimum is the
exchange dictating risk.

Unknown rules **block real money and not paper**: the paper book has no lot size,
so an unknown step harms nothing there; for real money it means not knowing the
order will be accepted at the approved size. It fails closed exactly where the
consequence is real.

`floor(x/step)*step` is re-quantised to the step's decimal places — that
expression reintroduces binary-float noise (3 × 0.1 = 0.30000000000000004) and a
venue comparing against its own decimal step rejects it.

**2. Idempotency is now used**, not just carried. Checked **first, before any
validation** — checking it last would mean a valid plan delivered twice was
submitted twice. Stated limitation: the store is in-process, so a plan whose TAR
published immediately before a crash could resubmit after one. It does prevent the
common case (retried delivery, resumed checkpoint, two subscribers).

**3. It stays outside LangGraph.** `services/`, not `graphs/`, because it is the
one component here permitted to reach the execution chokepoint — and
`FORBIDDEN_IMPORTS` means no module under `graphs/` can. The plan is published
from the graph **runner**, not a node: a node that published would make emitting
an execution request part of reasoning, and a future node could emit one mid-graph
before the gateway ran. A test asserts no file under `graphs/nodes/` references
the event.

#### 🔴 A bug my own test doubles hid

`MessageBus.publish` takes `(topic, payload)`. Both new publishers were written as
`publish(event)` — and **every bus double in the test file accepted a single
argument**, so 43 tests passed while the real call raised `TypeError`.

It was invisible rather than loud because both call sites swallow exceptions *by
design* (a bus failure must not fail a reasoning run). The only symptom was
`bus: nothing published` in the end-to-end run.

Fixed in both places, doubles corrected, and
`test_both_publishers_call_the_real_bus_with_its_real_signature` now subscribes to
the **real** bus so a signature mismatch cannot hide again. The general lesson: a
hand-written double is an assertion about an interface, and an unverified one is a
place bugs live.

#### Opens and closes take different paths, and that is the point

```
open  -> TarSubmittedEvent -> CRO reviews -> TAR_APPROVED -> ExecutionAgent
close -> ExecutionAgent.close_position() directly, NO CRO
```

A close must **not** go through the TAR chain, because the CRO can publish
`TAR_REJECTED` — routing an exit through it would let a risk agent block a close,
invariant 4 violated by the exact component whose job is preventing losses.
`ExecutionAgent.close_position` already documents this and is ungated; the service
routes to it.

`GRAPH_EXECUTION_ENABLED` is deliberately **not** checked for closes. A flag
gating opens is a safety feature; the same flag gating exits would trap the
operator in positions while it was off. A failed or unroutable close is also **not
recorded** in the idempotency store, so it stays retryable — marking it handled
would make the retry look like a duplicate and the position would stay open
forever.

#### It submits. It never approves.

Publishes `TarSubmittedEvent` and never `TarApprovedEvent`. `cro_agent.py` remains
the sole publisher of approvals. An AST test asserts `TarApprovedEvent`,
`create_market_order` and `get_exchange_client` are all unimportable here.

#### Two independent gates, both default off

1. `GRAPH_EXECUTION_ENABLED` — off, the service validates, quantises, dedupes and
   writes a full receipt but publishes no TAR. The whole chain is observable
   without a graph run being able to submit anything. Read at **call time**, so
   flipping it does not need a restart.
2. `LIVE_TRADING` — off, `ExecutionAgent` is in simulation mode and makes no
   exchange calls at all.

Neither is checked as a substitute for the other.

#### Boundary re-validation

The service re-checks stop-loss presence (invariant 3), stop-on-the-correct-side-
of-entry, the leverage ceiling (invariant 2) and the kill switch. Not because the
gateway is suspected, but because *"the upstream check already did this"* is how a
downstream check gets deleted in a refactor.

Deliberately **not** a re-run of all nine gateway checks: that would need a
portfolio snapshot and a ledger, double the work, and could **disagree** with the
gateway on a moving market — and it is not obvious which answer should win. A test
asserts the portfolio checks are absent from the re-validation.

---

### Phase 30 — Position Monitoring ✅ (spec Section 13, Section 35 Graph 4)

**Files:** `graphs/nodes/monitoring.py`, `graphs/monitoring.py` (Graph 4),
`workers/position_worker.py`, `tests/test_monitoring_graph.py` (59 tests).
`agents/position_monitor.py` gained `snapshot_open()` + `tighten_stop()`;
`graphs/state.py` gained `MonitoredPosition`, `PositionDecision`, three keys and a
**bounded** accumulating reducer.

**Verified live with a real `AsyncSqliteSaver`** — all four decisions, the stop
ratchet, and persistence:

| Case | Result |
|---|---|
| +0.15R, quiet | `HOLD`, 7/9 dimensions available |
| +1.00R | `MODIFY` — stop tightened **98 → 100** |
| `tighten_stop(95.0)` | **refused** — stop stayed at 100 |
| Regime flipped to Bearish | `EXIT` → `EXECUTION_PLAN_READY intent=close side=sell` |
| Checkpoint after 3 sweeps | **FOUND**, keyed on the position, node history intact |

#### The stop is a one-way ratchet

`tighten_stop` is the most important thing in this phase. Widening a stop
invalidates the per-trade risk limit the position was **sized against** — the
position would risk more than 3% of equity while every record still said 3% — and
it is the specific mechanism by which "give it room to breathe" turns a small loss
into a large one.

So the graph only ever **proposes**; the agent decides. Eight tests cover it,
including: a stop already through price is refused with *"request an EXIT instead
of disguising one as a stop"*, and `snapshot_open()` returns **copies** so a caller
holding a `_Tracked` reference cannot assign `stop_loss` directly and bypass the
refusal.

Trailing: break-even at 1R, then 1R behind the peak beyond 2R. Nothing below 1R —
tightening earlier pulls the stop inside the noise the ATR distance was sized to
absorb, stopping the position out of a thesis that was still intact, which is the
failure a trailing stop should prevent rather than cause.

#### It is not a second stop-loss

`PositionMonitorAgent` fires levels on **every tick**; this graph runs every five
minutes. The division is by speed and by kind — the agent reacts to a price
crossing a level and protects capital; the graph asks whether the thesis still
holds.

So `monitor_price_levels` reports distance-to-stop as evidence and never fires one,
and when price is **already through** a level the decision node returns HOLD and
says so explicitly: racing a faster component to a close it is already performing
would double-submit. That is branch 1 of the decision, before anything else.

`EXIT` here means the **thesis** is invalidated, not that price went against us —
that is what the stop is for, and duplicating it would give the position two stops
at different distances.

#### 🔴 A double-counting bug in the REDUCE gate

The gate read `(adverse or stale) and concern >= 0.5`, intended as "underwater
**and** conditions have deteriorated". But the `stop` dimension's concern is
computed as `1 - r_multiple`, so a position at -0.55R **automatically** reported a
stop concern of 1.0 — the second condition was just restating the first, and
**every position drifting to -0.5R would have been halved.**

Turning an ordinary drawdown into forced selling at the worst point is precisely
what a REDUCE rule must not do. Fixed with `CONDITION_DIMENSIONS`, which restricts
which dimensions may bind the gate to ones independent of the position's own P&L
(volatility, funding, portfolio risk, liquidity).

Same trap as an orderflow specialist derived from candle direction in Phase 26: two
names for one piece of evidence, so a two-condition threshold fires on half the
evidence it appears to require.

#### 🔴 Unbounded state growth, found by reading the live checkpoint

The first live run showed `nodes_visited` holding **33 entries after three
sweeps** — because Phase 30 is the first graph to key a thread on something
long-lived. At a five-minute interval that is roughly **8,000 entries per week per
position**.

LangGraph serialises the *whole* state into the checkpoint on **every superstep**,
so an unbounded list is not merely a large row: it makes every write progressively
slower for the position's entire life. `operator.add` was correct while every
thread lived for one short run; keying on a position broke that assumption
silently.

`_append_bounded` now caps `nodes_visited` and `errors` at 200, keeping the recent
tail (the half with debugging value). `unavailable` was already naturally bounded —
`_merge_unique` dedupes. The full history still lives in the trace store, which is
append-only files rather than a re-serialised blob.

#### Checkpointing finally earns its cost

Graphs 1–3 pass `checkpointer=None` deliberately — seconds-long runs with nothing
to resume, and a checkpoint row per trigger would be cost without benefit. A
**position** exists across restarts, and the reasoning about it is the record of
why it is still open.

`thread_id` is keyed on the **position**, not the run, so one thread accumulates
that position's whole history and a restart resumes it rather than forming a fresh
opinion with no memory of the trailing decisions already made. The context manager
is entered once in `lifespan` and held for the app's lifetime — one SQLite
connection, not one per run — and closed **after** the workers stop, so an
in-flight run cannot write to a closed connection.

#### A separate worker, and why

`monitor_worker.py` documents itself as reporting-only: *"two loops that can both
act on the same position will eventually act twice on it."* Putting Graph 4 inside
it would break exactly that, so `position_worker.py` is a distinct worker and the
**only** driver.

Notably it is *not also* subscribed to `TRIGGER_FIRED`, even though
`TriggerEvaluator.evaluate_position` exists. Two paths would give one position two
concurrent runs — racing the shared checkpointer and, worse, both reaching an EXIT
and publishing two closes. The right way to add responsiveness is to make this
worker interruptible, not to add a second driver.

Five minutes is enough because this loop is not what protects capital.

`POSITION_MONITORING_ENABLED` defaults **false**: the graph still runs and every
decision is logged in full (a withheld EXIT logs at warning), only the action is
withheld. Stop-loss enforcement is never gated by it.

#### Reuse

Graph 4 is 11 nodes and reuses the five Phase 24 market nodes plus Phase 26's
`specialist_portfolio` — the only writer of `portfolio_state`. Re-deriving the
regime here would mean two definitions of "what regime is BTC in", and a monitoring
graph that disagreed with the entry graph about that would be worse than one that
could not tell.

---

## 13b. Sections 14–41 audit — verifying work implemented outside this log

You implemented Sections 14–41 and asked for verification. This section is the
audit. **931 → 934 tests pass, tsc clean, 111/111 modules import** after the fixes
below.

### Headline

A large amount of real work is present and correct: the four new graphs, the five
new memory stores, `bayesian_engine`, `dynamic_thresholding`, `trading_styles`, all
seven Section 38 docs, `replay_engine`, `benchmark`. Most of it is reachable from
something.

But **none of it had a single test**, and the 934 tests that were passing covered
none of these modules. That is how everything below survived: each fault was inside
a module nothing asserted anything about, and several were *invisible by design*
because the surrounding code degraded honestly.

### 🔴 The worst one: two regime vocabularies killed the strategy ensemble

`agents/regime_agent.detect_market_regime` was upgraded to spec Section 21's ten
names — **correctly**, that is a genuine requirement met. But
`algorithms/strategy_profiles`'s `active_regimes` field speaks a different
vocabulary, and only one name appears in both:

| `regime_agent` returns | `active_regimes` expects | overlap |
|---|---|---|
| Bull Trend, Bear Trend, Range, Low Volatility, Accumulation, Distribution, Panic, Euphoria, Liquidity Crisis | Trending Bullish, Trending Bearish, Ranging / Low Volatility | **none** |
| High Volatility | High Volatility | ✅ |

So `is_strategy_active_in_regime` returned **False for all nine strategies in nine
of the ten regimes**. Consequences, none of which raised:

- The strategy ensemble voted **nothing** whenever a regime was successfully
  classified.
- `algorithms/debate.score_debate` asks `regime_agent` and weights the ensemble at
  **4.0 — its heaviest single leg**. It therefore recorded *"strategy ensemble
  (every strategy gated out)"* on every run and scaled every debate's confidence
  down to 72% coverage.
- Which means **every confidence number in Phases 24–30 was measured on a crippled
  debate**, including the ceiling I reported in the Phase 27 log.

Fixed with `strategy_profiles.REGIME_ALIASES` + `canonical_regime()` — one
normaliser, so the two cannot drift again. Accumulation/Distribution map to the
ranging bucket (both are sideways price with positioning changing underneath);
Panic/Euphoria/Liquidity Crisis map to High Volatility rather than muting
everything, because an empty ensemble produces no votes and *"no strategy has an
opinion"* is not *"do not trade"* — shrinking the position is the risk layer's job,
and it already does it.

Every regime now has 4–6 of 9 strategies eligible; unknown stays permissive at 9/9.

**Knock-on I had to correct honestly:** with the ensemble leg restored, achievable
confidence *fell* (the ensemble often disagrees with the trend legs, and that
disagreement is real evidence). Re-measured ceilings: **0.239** both legs agreeing,
**0.153** market alone — so Phase 27's `MIN_CONFIDENCE_TO_TRADE = 0.25` had become
**unreachable** and the Supervisor could never return TRADE.
`test_the_trade_threshold_is_reachable_by_the_real_scorers` caught exactly that,
which is why it exists. Lowered to **0.18**, which sits between the two ceilings and
preserves the property the old value was picked for — TRADE still requires both
directional legs to agree.

### 🔴 Fabricated data driving real decisions

| Module | Fabrication | What it drove |
|---|---|---|
| `graphs/execution_graph` | `spread_bps: 2.5, volume_1m: 150000, depth_imbalance: -0.1` | a real slicing decision off `volume_1m` |
| `graphs/research_graph` | `backtest_score = 0.85`, `forward_test_score = 0.70`, *"yielded high sharpe"* | marked hypotheses **VALIDATED** |
| `graphs/reflection_graph` | `execution_quality = "Good"` unconditionally | the lesson and the calibration delta |
| `graphs/reflection_graph` | `market_context = {"note": "stubbed"}` | the reflection's context |
| `agents/strategy_ensemble` | `volatility: "MEDIUM", liquidity: "HIGH"` | strategy scoring |

The **research** one was the most dangerous. Both scores were hardcoded *above* the
threshold they were compared against, so `evaluate_results` could only ever return
VALIDATED — a function that appeared to test something and returned the same answer
for every input. It did not write to production, so invariant 5 held literally, but
it destroyed the meaning of the human approval click: an operator approving a
"validated" hypothesis would believe it had been backtested.

The **execution** one invented order-book depth, which is precisely the data the
Phase 26 liquidity specialist and the Phase 28 liquidity check both decline to
estimate because no depth feed exists anywhere in this system.

The **`liquidity: "HIGH"`** one is the same claim, asserted flatly.

All five now report `unavailable` with the reason, or use real data:
`execution_graph` plans from traded candle volume and says volume is not depth;
`research_graph` has **no parameter through which a score could arrive**, so
VALIDATED is unreachable without wiring a real backtester; `reflection_graph` reads
the persisted `execution_quality` row and distinguishes *unavailable* from *Poor*;
`strategy_ensemble` measures volatility with the same `_volatility_band` the market
graph uses and passes liquidity as `None`.

**Why `research_graph` does not just call the real backtester:**
`HistoricalBacktestEngine.__init__` calls `self.bus._subscribers.clear()`. Running
it inside a live process would unsubscribe the trigger worker, the CRO, the
execution agent and the position monitor — a validation run would silently disable
trading. It needs an isolated bus and an out-of-band runner. Named, not faked.

### 🔴 Section 15's memory layer read almost nothing

`memory_manager.fetch_memory_context` imported cleanly, never raised, and returned a
plausible context — while **four of its five store calls named methods that do not
exist**:

| Called | Reality |
|---|---|
| `get_working_memory` | module has `get_current_context` (async) |
| `SemanticMemory` class | module is functions, not a class |
| `sm.get_relevant_lessons` | never existed — semantic memory is an entity/relationship store |
| `get_validated_strategies` | module has `get_hypotheses` / `queue_summary` |
| `rm.get_recent_events` | class defines `get_recent_risk_events` |

Every call sat inside `except Exception: append("unavailable")`, so all five failed
silently. It was invisible **because** the degradation was honest — `unavailable` was
doing its job while nothing else was.

It also implemented **six** stores, not seven. Its own docstring said "all 6 memory
dimensions". Procedural Memory was absent, which is why
`services/procedural_memory.py` had **zero callers** — the store existed and had
nowhere to put its output. `MemoryContext` had no `procedural` field either.

And `services/risk_memory.py` was **unimportable**: it imported
`backend.core.database` (the module is `backend.core.db`), and both its queries
selected `created_at` where `db/schema.sql` has `timestamp`. Its bare
`except: return []` made a broken query indistinguishable from *"this system has
never had a trade blocked"* — the most reassuring possible wrong answer, produced by
a typo.

Now: **6 of 7 stores read**, the 7th (`risk_events`) honestly reports that Postgres
is not provisioned. `RiskMemory` returns `None` for unreadable and `[]` for
read-and-empty, because collapsing those was the bug.

**And the loader was in a graph that never runs.** `memory_loader` was wired as the
entry of `market_state_config` (Graph 1) — which `main.py` deliberately does not
subscribe, because Graph 2 contains all of Graph 1's stages. So no decision ever saw
memory. Now wired as the entry of **Graph 2** (20 nodes) and **Graph 4** (12 nodes),
which are the graphs that actually decide.

### 🔴 Two crashes in the new code

- `strategy_selection_graph` read `profile.optimal_conditions` — the field does not
  exist (`best_conditions` is prose; `active_regimes` is the list). It raised
  `AttributeError` on every scored strategy, **crashing the strategy ensemble that
  calls it**. Now uses `active_regimes`, agreeing with the gate on the line above it.
- `strategy_ensemble` did `selected_strategies.pop(...)` inside
  `for ... in selected_strategies.items()`. One misbehaving strategy raised
  `RuntimeError: dictionary changed size during iteration` and took down **all**
  strategy voting — the exact opposite of what the surrounding error handling is for.
- `select_strategies` also had a base score of `80.0` and a threshold of `>= 80.0`,
  so the filter could not reject anything and the +15 regime bonus was decorative.
  My first fix raised the threshold — which **gutted the ensemble**, because its
  values are consumed as vote *weights*. Scoring and activation are now separated:
  everything non-gated votes with its score as weight; Section 19's
  *"Activate: Trend + Momentum"* shortlist is reported as `activated_strategies` and
  never prunes the vote.
- `regime or "UNKNOWN"` inverted the permissive rule — `is_strategy_active_in_regime`
  treats `None` as permissive and the literal `"UNKNOWN"` as matching nothing.
- The ensemble's no-vote early return omitted `strategiesVoted`, which
  `score_debate` reads to decide whether its ensemble leg is available.

### ⚠️ Section-by-section coverage

| Section | Phase | Status |
|---|---|---|
| 14 | 31 Continuous Monitoring | ✅ triggers + worker (built in this log) |
| 15 | 32 Trading Memory | ✅ **fixed** — 7 stores, 6 readable, wired into Graphs 2 & 4 |
| 16 | 33 Reflection Graph | ✅ **fixed** — 2 fabrications removed |
| 17 | 34 Learning System | ⚠️ hypothesis→research exists; backtest/walk-forward not wired (see above) |
| 18 | 35 Trading Styles | ⚠️ 4 primary styles ✅; **~8 of 14 strategy styles absent** (SMC, ICT, Wyckoff, VWAP, Volume Profile, Funding, Basis, Event Driven, Volatility) |
| 19 | 36 Strategy Selection | ✅ **fixed** — crash, threshold, vocabulary |
| 20 | 37 Bayesian Engine | ✅ `bayesian_engine` + `probability`, used by `supervisor_agent` |
| 21 | 38 Regime Intelligence | ✅ all 10 regimes in `regime_agent` — **and now translatable** |
| 22 | 39 Portfolio Intelligence | ⚠️ correlation + drawdown ✅; leverage/margin/concentration thin |
| 23 | 40 Adaptive Risk | ✅ `dynamic_thresholding` + un-overridable ceilings |
| 24 | 41 Execution Intelligence | ⚠️ TWAP/slippage/latency ✅ in `algorithms/execution`; fees, order type, entry timing, exchange selection absent |
| 25 | 42 Cross-Exchange | ⚠️ `exchange_provider` + `exchange_agent`; OKX and funding comparison absent |
| 26 | 43 Market Graph | ❌ `knowledge_graph` has no asset relationships |
| 27 | 44 Institutional Footprint | ❌ absent |
| 28 | 45 Research Agent | ⚠️ `research_agent` + store ✅; experiment loop not wired |
| 29 | 46 Simulation Lab | ⚠️ replay + backtest + Monte Carlo ✅; walk-forward and paper stage absent |
| 30 | 47 Multi-Agent Debate | ✅ Phase 26 panel + `debate.py` |
| 31 | 48 External AI Consultation | ❌ no `AIConsultationService` |
| 32 | 49 Curiosity Engine | ✅ `curiosity_worker` |
| 33 | 50 Meta-Learning | ❌ absent |
| 35 | Seven graphs | ⚠️ 6 of 7; **Graph 7 (Learning) missing** |
| 36 | Three planes | ✅ enforced by `FORBIDDEN_IMPORTS` + the execution service boundary |
| 37 | Goal Engine | ⚠️ `capital-target` in `api/missions` only, not `mission_store` |
| 38 | Seven audit docs | ✅ all present (~1.5 KB each) |
| 39 | Hardening 39.1–39.7 | ✅ 6 of 7 — **39.5 streaming absent** |
| 40, 41 | Tables / renumbering | ✅ reference only |

### The tests that were missing

`tests/test_sections_14_to_41.py` — **32 tests**, one per fault above, each naming
the bug it guards. Total suite **966 passing** (was 934), tsc clean, 111/111 modules
import.

They assert the *property*, not the value: a score must be **measured**, a regime
vocabulary must **translate**, every store must be **attempted**, the ensemble leg
must **contribute**. A test asserting current behaviour would have caught none of
the original faults.

Two things worth recording about writing them:

- **I repeated a mistake I had already documented.** Several guards grepped
  `inspect.getsource(...)` for the old fabricated literal — and matched the
  *docstring documenting the fix*, failing on correct code. That is the third time in
  this project (the `60000.0` guard, the TWAP-log guard, a `set_by_human` guard). The
  fix is now a helper rather than a remembered discipline: `code_only()` strips
  docstrings via AST, `returned_strings()` reads return literals from the AST
  (`ast.unparse` normalises quotes, so text matching is doubly fragile), and
  `instantiated_names()` distinguishes a real call from a constant that merely names
  the class.
- **Writing the test found one more bug.** `strategy_ensemble` has *two* early
  returns; I had added `strategiesVoted` to the `not votes` one and missed the
  `not klines` one, so the debate's heaviest leg still dropped on empty candles.

### What I changed

`strategy_profiles` (regime aliases), `strategy_ensemble` (crash, vocabulary,
missing key, invented volatility/liquidity), `strategy_selection_graph` (crash,
scoring, activation split, state mutation), `execution_graph` (rewritten as an
honest planner, no longer a graph), `research_graph` (rewritten, VALIDATED
unreachable without measurement), `reflection_graph` (two fabrications, shared
calibration), `reflection_agent` (extracted `calibration_delta`), `risk_memory`
(rewritten), `memory_manager` (rewritten, 7 stores), `memory_loader` (7th store,
tuple contract), `state.py` (`MemoryContext.procedural`), `opportunity.py` +
`monitoring.py` (memory as entry), `supervisor.py` (threshold re-measured), and six
test files updated from exact-count to property assertions.

---

## 13c. Closing the Sections 14–41 gaps

**1014 tests pass** (from 934), tsc clean, 281 TS, 115/115 modules import.

### The four absent sections, built

| Section | Module | Tests |
|---|---|---|
| 26 — Market Graph | `algorithms/market_graph.py` | 8 |
| 27 — Institutional Footprint | `algorithms/footprint.py` | 8 |
| 31 — External AI Consultation | `services/ai_consultation.py` | 8 |
| 33 + 35's Graph 7 — Meta-Learning | `graphs/learning_graph.py` | 11 |
| 39.5 — Streaming | `graphs/runtime.stream_run` | 4 |

Each reuses rather than duplicates: the market graph calls the existing
`pearson_correlation` the CIO's exposure cap already uses (a second implementation
would let the cap and the reasoning disagree about whether BTC and ETH move
together), and each refuses the parts it cannot measure rather than approximating
them.

The constraints worth naming:

- **Section 27 attributes nothing.** Its own text: *"Don't claim to know exactly what
  an institution is doing."* Every signal returns what was measured and a **list** of
  things it is consistent with — a single interpretation would be a conclusion
  wearing a hedge. Three of six signals report unavailable (large trades needs a
  per-trade tape; order-book changes needs depth; absorption needs both). A test
  greps for `institution`/`smart money`/`whale` and fails if attribution language
  leaks in.
- **Section 31 has no field a gate can read.** No `approved`, `size`, `stop_loss` or
  aggregate confidence — so an external model cannot change anything even if every
  response agreed. Nothing in `graphs/` imports it, and `consultation` is not a
  `TradingState` field, so wiring it in must be a deliberate reviewed diff. It
  computes **no majority**: models trained on overlapping data agreeing is not
  independent confirmation, and collapsing the spread to one number would hide that.
  It also refuses to present one provider asked three times as a panel.
- **Section 33 writes to nothing and has no `apply()`, not even a disabled one**
  (invariant 5). Every one of its six questions can answer *"not enough data"* — a
  confident claim about the system's own reliability from four trades would be the
  most persuasive wrong answer it could produce. Two questions currently return that:
  calibration needs entry confidence recorded, and failing-conditions needs the regime
  at entry — both name the missing field rather than inferring it from P&L.

### ⚠️ A correction: my "~8 of 14 strategy styles missing" finding was wrong

I inspected `STRATEGY_PROFILES` and never looked at `PLANNED_STRATEGIES` — which
already held **16 entries, each with a specific reason** it was not implemented.
Section 18 was already covered.

Worse, I implemented six of them before noticing, and four contradicted objections
that were already recorded and **correct**: klines give volume per *time* bucket so a
value area is a guess; SMC needs sweep-then-break; ICT needs order blocks and
fair-value gaps; Wyckoff needs phase classification over a volume profile. I reverted
those four. Building them would have carried each concept's *name* without its
substance — the fabrication pattern this whole audit exists to remove, and here it
would also have silently overridden reasoning that was already right.

Two were kept, because their recorded objection genuinely does not apply:

| Kept | Recorded objection | Why it does not apply |
|---|---|---|
| `VWAP` | session-anchored VWAP has no session boundary in 24/7 crypto | this is a **rolling** 30-candle VWAP |
| `VolatilityBreakout` | volatility trading needs options/variance instruments | this is a **directional** breakout triggered by a volatility expansion; named distinctly so it cannot be mistaken for volatility-as-an-asset |

`test_spec_coverage_counts` now asserts the **total** across both buckets, so a
strategy moving from planned to implemented is progress rather than a failure, and
`test_every_planned_strategy_states_why_it_is_not_implemented` keeps the reasons from
decaying into TODOs.

### 🔴 78% of every `vote_strategies` call was LangGraph compilation

Measured while closing the "new graphs bypass the safety layer" item:

```
compile only            7.03 ms/call
vote_strategies total   8.97 ms/call   -> 78% was compile
```

`build_strategy_selection_graph()` was called on **every** invocation, and
`score_debate` calls `vote_strategies` on every graph run. None of what LangGraph
provides was used — synchronous, no branching, no parallelism, no LLM, no
checkpointer, nothing to resume. And because it was a raw `StateGraph` that never
went through `build_graph`, it had no contract validation, tracing or error capture
either: it paid the cost of a graph and got none of the safety.

Converted to four plain function calls. **8.97 ms → 0.19 ms, a 47× speedup** on a
function in the debate path. Same conclusion as `execution_graph`, reached the same
way — the question is not *"can this be a graph"* but *"does being one do anything"*.

`reflection_graph` keeps its graph: it is genuinely async, does real I/O across the
memory stores, and runs once per closed trade rather than inside a scoring loop. It
is now compiled once instead of per call, and a `thread_id` it passed with a comment
claiming it *"ensures we don't cross-contaminate state across trades"* was removed —
that is not what a thread_id does, the graph has no checkpointer so it was inert, and
a comment claiming a safety property the code does not provide stops the next reader
from checking.

---

## 13d. Final verification — every spec section, and the four-layer stack

**1030 tests pass** · tsc clean · 281 TS tests · 116/116 modules import ·
**112/112 spec checks pass**.

### Spec coverage, verified mechanically

`scratchpad/verify_spec.py` checks all 41 sections against the real code — not file
existence, but behaviour: the nine risk checks actually run, all ten Supervisor
questions are enforced fields, the eight trigger kinds exist in `TriggerKind`, the
seven memory stores are attempted, the ten regimes are returnable and translatable,
the six footprint signals report, the six meta questions answer, and no module under
`graphs/` can import an order call.

| Sections | Result |
|---|---|
| 0, 2 — Rule 0 / the critical boundary | ✅ enforced at import level |
| 3, 4 — cognitive chain, one `TradingState` | ✅ all 18 spec fields |
| 6–13 — Phases 23–30 | ✅ |
| 14–17 — Phases 31–34 | ✅ |
| 18–33 — Phases 35–50 | ✅ |
| 35 — seven graphs | ✅ 7/7 |
| 36 — three planes | ✅ |
| 37 — Goal Engine | ✅ DO-NOT-TRADE reachable, hard limits set |
| 38 — seven audit docs | ✅ |
| 39.1–39.7 — hardening | ✅ 7/7 |

### 🔴 The four-layer stack was NOT connected — layer 4 had no API at all

`Recommended_Technology_Stack.md` layers 1–4 each worked. The **seams** had never
been tested, and one was missing entirely:

| Seam | Before |
|---|---|
| L2 FastAPI ↔ L3 Agents | ✅ 43 endpoints |
| L3 Agents ↔ L4 LangGraph | ✅ shared bus + state |
| L1 Next.js ↔ L2 FastAPI | ⚠️ one WebSocket |
| **L4 LangGraph → L2 → L1** | ❌ **nothing** |

Every decision the seven graphs produced — the thesis, the specialist panel, the
Supervisor's ten answers, the risk verdict, the monitoring decision, the
meta-learning report — was computed, traced to disk, and **unreachable from the
dashboard whose job is showing it**. Spec Section 39.5 asks for exactly this
("*the AI is currently in `multi_agent_analysis`, 4 of 6 specialists reporting*")
and Section 1 puts the UI at the top of the Agent OS, not beside it.

No test caught it because every test verified a **layer**, never a **seam**.

**Fixed:** `backend/api/graphs.py` — 7 endpoints plus a WebSocket, mounted at
`/api/graphs` (50 endpoints total). `lib/backendConfig.ts` gained the matching paths
and `graphStreamWsUrl()`. `tests/test_stack_integration.py` — **16 tests, all on
seams**, including one asserting every path the frontend declares is a path FastAPI
actually serves (the exact 404 class that file was created to prevent).

Read-only except `POST /run/{symbol}`, which is auth-gated and still cannot trade: it
produces an inert plan that `GRAPH_EXECUTION_ENABLED` gates separately. An AST test
asserts the router cannot import an order call.

Live output:

```
Graph 1 Market Intelligence   6 nodes    Graph 5 Reflection     deterministic module
Graph 2 Trade Decision       20 nodes    Graph 6 Research       deterministic module
Graph 3 Execution      deterministic     Graph 7 Learning       deterministic module
Graph 4 Position Monitoring  12 nodes
25 nodes registered · LLM nodes: ['trade_thesis_narrative']
```

### Two latent bugs the verification itself surfaced

**1. Graph 1 and Graph 2 could not coexist in one process.**
`market_state._ensure_nodes()` registered unconditionally while the other three
modules check the registry first, so:

```
analysis_config()      # registers data_validation …
market_state_config()  # ValueError: node 'data_validation' is already registered
```

It never surfaced because `main.py` subscribes only Graph 2 — but any code touching
both crashed, which is precisely what the new `/api/graphs` inventory does.

**2. `clear_registry()` left the system unable to rebuild.**
It emptied the registry but not the modules' `_nodes_registered` flags, so every
later `_ensure_nodes()` returned early and the registry stayed empty — the next
config raised `KeyError` on its first node. It only bit under a full suite run; the
failing test passed in isolation. A cleanup helper that leaves the system unusable is
worse than one that does nothing, because the damage surfaces somewhere else.

---

## 14. Next

**One item remains from the Sections 14–41 audit:**

- **`reflection_graph` still uses its own `ReflectionState`** rather than
  `TradingState`, so it does not go through `build_graph` and gets no `NodeContract`
  validation, declared-write enforcement or run tracing. Spec Section 4 wants one
  shared state. Closing it means adding a `closed_trade` field to `TradingState` and
  mapping five nodes onto it — a real change to a working path, documented in the
  module rather than left implicit.

**Longer-standing, unchanged:**

- **Resting exchange stop orders** — still the highest-value reliability gap.
- **Section 17's backtest wiring**: `HistoricalBacktestEngine` needs an isolated bus
  before `research_graph` can produce a real score (its constructor calls
  `bus._subscribers.clear()`, which would unsubscribe every live agent).
- **Two flags are off**: `GRAPH_EXECUTION_ENABLED` and `POSITION_MONITORING_ENABLED`.
  Nothing a graph decides reaches an exchange until you turn them on.
- **The idempotency store is in-process** (Phase 29).
- **Existing agent callers still run the gateway in lenient mode.**
- **Live price is never cross-checked against the latest candle close** (Phase 24).
- **Nothing is committed.** The working tree holds Phases 23–30 plus this audit.

**Also outstanding, unrelated to the phase order:**

- **Resting exchange stop orders** — still the highest-value reliability gap, and
  now more visible: Phase 30's whole trailing mechanism operates on a stop that
  only exists while the process is alive.
- **`GRAPH_EXECUTION_ENABLED` and `POSITION_MONITORING_ENABLED` are both off.**
  Nothing a graph decides reaches an exchange until you turn them on.
- **The idempotency store is in-process** (Phase 29).
- **Existing agent callers still run the gateway in lenient mode.**
- **Cross-asset correlation has no synchronous path** (delegated to the CIO).
- **Live price is never cross-checked against the latest candle close** (Phase 24).
- **Nothing is committed.** The working tree holds all of Phases 23–30.

**Also outstanding, unrelated to the phase order:**

- **Resting exchange stop orders** — still the highest-value reliability gap.
  Phase 29 did not change it, and now the `_downside` text on every decision says
  so explicitly.
- **The idempotency store is in-process.** A persisted key store would close the
  crash window; it belongs with the execution-quality store.
- **Existing agent callers still run the gateway in lenient mode** (no portfolio,
  no ledger).
- **Cross-asset correlation has no synchronous path** (delegated to the CIO).
- **Live price is never cross-checked against the latest candle close** (Phase 24).
- **Nothing is committed.** The working tree holds all of Phases 23–29.

**Also outstanding, unrelated to the phase order:**

- **Resting exchange stop orders.** Still the single highest-value reliability
  gap. `position_monitor` is a soft stop that only fires while the process is
  alive, and the Supervisor's `_downside` now says so on every decision — visible,
  not closed.
- **Cross-asset correlation has no synchronous path.** The gateway reports it
  `delegated` to the CIO. Making it a hard check needs a correlation cache the CIO
  does not expose.
- **Existing agent callers still pass no portfolio or ledger**, so they run in
  lenient mode and get cautions rather than the full nine checks. Routing
  `supervisor_agent` through strict mode is a behaviour change to a working live
  path and was deliberately not done inside this phase.
- **Live price is never cross-checked against the latest candle close** (Phase 24
  `validate_market_data` concern).
- **Nothing is committed.** The working tree holds all of Phases 23–28.

**Also outstanding, unrelated to the phase order:**

- **Resting exchange stop orders.** Still the single highest-value reliability
  gap. `position_monitor` is a soft stop that only fires while the process is
  alive — and `_downside` now says so on every decision, which makes the gap
  visible but does not close it. Not a LangGraph phase.
- **Live price is never cross-checked against the latest candle close.**
  `market_data.price` comes from the WebSocket cache and the candles from REST,
  and nothing compares them. A large divergence means stale data on one side,
  and the thesis entry price would come from the stale one. A Phase 24
  `validate_market_data` concern.
- **Nothing is committed.** The working tree holds all of Phases 23–27.
