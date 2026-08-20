# TradingOS — Operator Guide

How to start the system, how the pieces fit, what happens when you give it a goal,
and — in Part 6 — **every known bug and limitation**, stated plainly.

Written against the code as it stands. Every command and behaviour below was
verified by running it, not recalled.

---

## Read this first: what the system will and will not do today

Two flags gate autonomy, and **both default to off**:

| Flag | Default | Off means |
|---|---|---|
| `GRAPH_EXECUTION_ENABLED` | `false` | reasoning runs and decides, but **submits no orders** |
| `POSITION_MONITORING_ENABLED` | `false` | positions are analysed, but no exit/trail is **applied** |

Below those sits `LIVE_TRADING` (default `false`), which puts the execution agent in
simulation mode and makes no exchange calls at all.

**So out of the box: the agent thinks, decides, logs, and trades nothing.** That is
deliberate. Part 5 covers turning each gate on, in order, and what each one exposes.

Three more things worth knowing before you start:

1. **No LLM is configured.** `LLM_PROVIDER` supports only `null`. The single
   LLM-permitted node degrades honestly and every number in the system is
   deterministic anyway. See §6.1.
2. **A "target" does not currently steer trading.** You can create a
   `capital-target` mission and track progress, but no code in the decision path
   reads it. See §6.2 — this is the gap most likely to surprise you.
3. **Postgres is optional and not running by default.** Several features degrade to
   "unavailable" without it, and say so rather than pretending. See §6.3.

---

## Part 1 — Starting it

### 1.1 One-time setup

```bash
# Python backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1          # PowerShell
pip install -r requirements.txt

# Frontend
npm install
```

Copy `.env.example` to `.env` if you have not already. The safe defaults apply even
with no `.env` at all — an absent file gives you paper trading, no live orders.

### 1.2 Start the backend (FastAPI + agents + LangGraph)

```powershell
.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Use `127.0.0.1`, not `0.0.0.0`. On Windows, binding `0.0.0.0` without a firewall rule
raises `[WinError 10013] An attempt was made to access a socket in a way forbidden by
its access permissions`.

Healthy startup logs, in order:

```
Registered 12 event-driven agents with the AgentOS kernel
Trade analysis graph subscribed to TRIGGER_FIRED
Execution service wired. GRAPH_EXECUTION_ENABLED=False — graph runs CANNOT submit TARs
Monitoring checkpointer ready (AsyncSqliteSaver).
Position monitoring wired. POSITION_MONITORING_ENABLED=False — decisions will NOT be applied
Continuous Monitoring Loop started (every 60s).
Position monitoring worker started (every 300s, ...)
```

Confirm it is up:

```bash
curl http://127.0.0.1:8000/api/graphs        # the seven graphs and their nodes
curl http://127.0.0.1:8000/docs              # interactive API browser
```

### 1.3 Start the frontend

```bash
npm run dev        # http://localhost:3000
```

The dashboard runs **without the backend** for most panels — Next.js route handlers
under `app/api/` read JSON stores in `.data/`. Only the agent-event WebSocket and
everything under `/api/graphs` require the Python process.

### 1.4 Stopping

`Ctrl+C` in each terminal. If a port stays held on Windows:

```powershell
Get-NetTCPConnection -LocalPort 8000 | Select-Object OwningProcess
Stop-Process -Id <pid>
```

---

## Part 2 — How it fits together

```
  Next.js dashboard  ── WebSocket ─────────────┐
   (localhost:3000)   └── /api/graphs/* ───────┤
                                               ▼
                                     FastAPI (localhost:8000)
                                       50 endpoints
                                               │
                    ┌──────────────────────────┼──────────────────────────┐
                    ▼                          ▼                          ▼
             Python agents            LangGraph (7 graphs)         Workers
             12 event-driven          20-node decision graph       triggers / monitor
                    │                          │                          │
                    └────────── in-process message bus ────────────────────┘
                                               │
                                   Risk Gateway (deterministic)
                                               │
                                        APPROVED ONLY
                                               ▼
                                    Execution agent → exchange
```

**The one rule:** the reasoning layer can recommend a trade; it can never place one.
No module under `backend/graphs/` can even *import* an order call — that is enforced
by an AST test, not a convention.

### The seven graphs

| # | Graph | What it does |
|---|---|---|
| 1 | Market Intelligence | validate → features → analysis → regime → market state |
| 2 | **Trade Decision** | the 20-node main graph: memory → market → strategy → opportunity → 7 specialists → debate → supervisor → risk gateway |
| 3 | Execution | deterministic, **outside LangGraph** by design |
| 4 | Position Monitoring | 9 dimensions → HOLD / REDUCE / MODIFY / EXIT |
| 5 | Reflection | closed trade → context → outcome → lesson → memory |
| 6 | Research | hypothesis → validation (see §6.4) |
| 7 | Learning | six meta-learning questions |

Only Graph 2 is subscribed to triggers. It contains all of Graph 1's stages, so
subscribing both would run them twice per trigger.

---

## Part 3 — What happens automatically

### 3.1 The autonomous loop

```
Live WebSocket feed (BTC/USDT, ETH/USDT, SOL/USDT)
        │  every tick
        ▼
Trigger evaluator ── did anything actually change?
        │  price move ≥2% · funding shift · OI spike · position risk · regime change
        │  (debounced, rate-limited to 6 runs/min, 2/symbol/min)
        ▼
TRIGGER_FIRED  ──►  Graph 2 runs (20 nodes)
        │
        ├─ memory (7 stores) → market data → regime → strategy scoring
        ├─ no opportunity?  → END. This is the common case.
        ├─ 7 specialists in parallel → debate → Supervisor decides
        │      TRADE · WAIT · EXIT · DO_NOT_TRADE
        └─ Risk Gateway: 9 checks → approve or reject
                │  approved
                ▼
        EXECUTION_PLAN_READY  (inert — a dataclass, not an order)
                ▼
        Execution service: re-validate → round to lot size → dedupe
                ▼
        [GRAPH_EXECUTION_ENABLED?]  no → logged, nothing submitted
                │ yes
                ▼
        TAR_SUBMITTED → CRO reviews → TAR_APPROVED → Execution agent
                ▼
        [LIVE_TRADING?]  no → simulated fill
```

Separately, every 5 minutes, each open position goes through Graph 4 and gets a
HOLD / REDUCE / MODIFY / EXIT decision — applied only if
`POSITION_MONITORING_ENABLED=true`.

### 3.2 Why most runs do nothing

That is the system working. A run ends early when no regime could be classified,
every strategy is muted for the regime, the best strategy score is below the minimum,
or no ATR exists so no stop can be computed. Each exit records **why** in the trace.

### 3.3 The one thing that is never blocked

Closing a position. Not by pause, not by emergency stop, not by a risk check, not by
the CRO, and not by `GRAPH_EXECUTION_ENABLED`. A gate that traps you in a losing
position when a limit has already been breached is worse than no gate.

---

## Part 4 — Using it

### 4.1 Watching the reasoning

```bash
curl http://127.0.0.1:8000/api/graphs/runs        # recent runs + why each stopped
curl http://127.0.0.1:8000/api/graphs/nodes       # every node, what it may write, may it call a model
curl http://127.0.0.1:8000/api/graphs/positions   # what the monitor is watching
curl http://127.0.0.1:8000/api/graphs/meta-learning
```

`/api/graphs/nodes` is the explainability surface: it shows per node what it is
*permitted* to write. Exactly one node in the whole system may call a model.

### 4.2 Running a decision on demand

```bash
curl -X POST http://127.0.0.1:8000/api/graphs/run/BTC/USDT
```

Returns the full reasoning: candidates and scores, all seven specialists (including
the three that cannot run and why), the debate verdict, the Supervisor's ten answers,
and the risk verdict with all nine checks. It **cannot** trade — the plan it produces
is inert and still gated.

If `TRADES_API_KEY` is set, add `-H "X-API-Key: <key>"`.

### 4.3 Live progress (WebSocket)

`ws://127.0.0.1:8000/api/graphs/stream` — send `{"symbol": "BTC/USDT"}`, receive one
message per node:

```json
{"type":"node","node":"debate","progress":14,"total":20,"unavailableCount":3}
```

### 4.4 Kill switch

```bash
curl -X POST http://127.0.0.1:8000/api/admin/pause
curl -X POST http://127.0.0.1:8000/api/admin/emergency-stop
curl -X POST http://127.0.0.1:8000/api/admin/resume
curl      http://127.0.0.1:8000/api/admin/status
```

All halt **new** positions. None blocks an exit.

### 4.5 Giving it a goal

```bash
curl -X POST http://127.0.0.1:8000/api/missions \
  -H "Content-Type: application/json" \
  -d '{
    "id": "grow-500",
    "type": "capital-target",
    "name": "Grow $500 to $5000",
    "description": "Experimental capital-target mission",
    "status": "active",
    "createdAt": 0, "updatedAt": 0,
    "target": {"kind": "capital-target", "startEquityUsd": 500, "targetEquityUsd": 5000},
    "progress": {"currentPct": 0, "status": "on-track", "lastEvaluatedAt": 0, "detail": "created"},
    "constraints": [], "checkpoints": []
  }'
```

**Read §6.2 before relying on this.** The mission is stored and its progress is
tracked. It does **not** currently influence any trading decision in the Python
backend.

`capital-target` deliberately has **no deadline**, and that is a safety property, not
an oversight: a hard deadline on a financial target pushes a system toward taking
more risk as time runs out.

---

## Part 5 — Turning on autonomy, in order

Do these one at a time and watch between each.

**Step 1 — watch it decide (no risk).** Start with all defaults. Run for a day.
Read `/api/graphs/runs`. Confirm the decisions look sane and the rejections have
sensible reasons.

**Step 2 — let it manage open positions.**

```bash
POSITION_MONITORING_ENABLED=true
```

Now stop-tightening, REDUCE and EXIT are applied. Every one of these **reduces**
risk — the stop is a one-way ratchet that can never be widened. This is the safest
gate to open first.

**Step 3 — let it submit entries.**

```bash
GRAPH_EXECUTION_ENABLED=true
```

Graph runs now publish TARs. The CRO still reviews every one and can reject.
`LIVE_TRADING=false` still means simulated fills — you get the full chain with no
money at risk. Sit here for a while.

**Step 4 — real money.**

```bash
LIVE_TRADING=true
BINANCE_API_KEY=...
BINANCE_SECRET=...
```

Before this: read Part 6 in full, set `TRADES_API_KEY`, and understand §6.5 — the
stop-loss only exists while the process is alive.

The hard limits that apply regardless: **3× leverage** on real money (10× paper,
un-overridable), 3% risk per trade, 5% daily loss, 100% total exposure, and a
mandatory computed stop on every position.

---

## Part 6 — Known bugs, gaps and limitations

Everything here is real and currently true. Nothing is hidden to make the system look
finished.

### 6.1 No LLM provider adapter exists

`get_provider()` recognises only `'null'`. Setting `LLM_PROVIDER=openai` logs a
warning and falls back to `NullProvider`.

**Effect:** `trade_thesis_narrative` — the one node permitted to call a model —
always reports unavailable. You get every number and no prose explanation.

**Not a correctness problem.** Every decision-critical value is deterministic by
design. Eighteen prompts exist in `backend/prompts/registry.py`; twelve are named
`*_DETERMINISTIC_V1` because those components deliberately use code, not a model.

**To fix:** add an adapter class in `backend/llm/provider.py` implementing
`complete()` and register it in `get_provider()`.

### 6.2 A capital target does not steer trading ⚠️

**The gap most likely to surprise you.** Nothing under `backend/graphs/` or
`backend/agents/` reads `mission_store`. A `capital-target` mission is stored,
returned by the API, and never consulted when deciding a trade.

Per `CLAUDE.md` it is *supposed* to produce advisory caution notes only — never a
hard rule, never a sizing override. In the Python backend it currently produces
nothing at all.

**What actually drives trading:** the trigger thresholds, strategy scoring, the
specialist panel, the Supervisor's confidence threshold, and the nine risk checks.
Not your target.

**To fix:** read the active mission in the Supervisor node and add its progress as a
caution note on the decision. Keep it advisory — that constraint is deliberate.

### 6.3 Postgres is not running, so several stores report unavailable

Affected: Risk Memory (`risk_events`), the execution-quality lookup used by
reflection, and the CRO's persisted decisions.

These degrade **honestly** — `RiskMemory` returns `None` for "could not read", never
`[]`, because an empty list would read as "this system has never had a trade
blocked", which is the most reassuring possible wrong answer.

Six of seven memory stores work without Postgres.

### 6.4 The research graph cannot produce a real backtest score — PARTLY FIXED

**Fixed:** `HistoricalBacktestEngine.__init__` used to call
`self.bus._subscribers.clear()` on the global bus, so running it inside the live
process unsubscribed the trigger worker, the CRO, the execution agent and the position
monitor — a validation run silently disabled trading. It now builds its own private
`MessageBus`, so it cannot touch live subscribers.

Bus isolation alone was not enough, and shipping only that would have been worse than
the original bug: `BaseAgent.__init__` captures the bus, so `publish()` goes to
whichever bus an agent was *constructed* with. Subscribing the agents to a private bus
without rebinding them would have had them consume simulated ticks and publish the
resulting orders and analyses onto the **live** bus. The engine therefore calls
`agent.rebind_bus(...)` and restores every agent in a `finally`.

That fix in turn introduced a second bug, now also fixed: restoring re-subscribed the
agent on the global bus, taking one handler to two, so the supervisor would evaluate
every signal twice and could submit two trade requests for one decision.
`MessageBus.subscribe` is now idempotent — which is where that hazard belongs, since
this codebase already guarded against double-subscription by hand in `analysis`,
`execution_service` and `trigger_worker`.

**Still open, and why the engine is still not called inline:** two of the three agents
it drives are process singletons, so *while a simulation runs* the live
market-intelligence agent and supervisor are pointed at the simulation bus. A
concurrent live analysis run would find them publishing into it. Fixing that means
giving the engine its own agent instances rather than the singletons — a larger change
than the bus isolation was.

So `research_graph` still records the request and reports honestly that no backtest
ran. A hypothesis **cannot** reach VALIDATED without a measured score; there is no
parameter through which one could arrive.

**Run it out of band** (a separate process) until the singleton sharing is addressed.
`tests/test_sections_14_to_41.py` holds both halves of this: that the clearing is gone,
and that `research_graph` still does not instantiate the engine.

### 6.5 The stop-loss only exists while the process is alive ⚠️

**The highest-value reliability gap in the system.** Stops are enforced by
`PositionMonitorAgent` comparing price against a level in memory. There is **no
resting stop order on the exchange.**

If the process dies, the machine sleeps, or the network drops, an open position has
no protection until it restarts.

Every decision says so — `_downside` on every `TradeDecision` states that slippage
beyond the stop is unbounded because the stop is not a resting exchange order.

**To fix:** place a real stop order via ccxt when a position opens. This is the
single change with the biggest safety return.

### 6.6 Idempotency is in-process only

The execution service dedupes by key, but the store is a dict that dies with the
process. A plan whose TAR published immediately before a crash could be submitted
again after a restart.

It does prevent the common case: retried bus delivery, resumed checkpoint, two
subscribers on one event.

**To fix:** persist the key store.

### 6.7 Confidence is low by design, so TRADE is rare

Three of seven specialists have no data feed (orderflow, liquidity, news), which caps
directional coverage at **0.571**. Measured ceilings: **~0.239** with both directional
legs agreeing, **~0.153** on market evidence alone.

`MIN_CONFIDENCE_TO_TRADE = 0.18` sits between them — so **TRADE requires the funding
specialist to agree with the market read.** Market evidence alone will not clear the
bar.

This is deliberate and not tuned toward action. If you widen it, you are lowering the
evidence bar, and two tests pin both sides so the change is visible.

### 6.8 Cross-asset correlation is not checked synchronously

The Risk Gateway's `Correlation` check hard-rejects adding to an asset you already
hold. Cross-asset correlation is reported `delegated` to the CIO agent, which computes
real correlations from 180 4h candles per symbol — too slow for a synchronous check.

**To fix:** a correlation cache the CIO exposes.

### 6.9 Live price is never cross-checked against the candle close

`market_data.price` comes from the WebSocket cache and candles from REST. Nothing
compares them. A large divergence means one side is stale, and the thesis entry price
would come from the stale one.

**To fix:** compare in `validate_market_data` and reject on a large gap.

### 6.10 Reflection uses its own state, not `TradingState`

`reflection_graph` still defines `ReflectionState`, so it does not go through
`build_graph` and gets no contract validation, declared-write enforcement or run
tracing. Spec Section 4 wants one shared state.

The other six graphs are compliant.

### 6.11 Agent callers run the risk gateway in lenient mode

`supervisor_agent` and the CRO call `validate_trade()` without a portfolio snapshot or
ledger, so margin, daily-loss, exposure and correlation report `unavailable` and become
**cautions rather than rejections** on that path.

The graph path passes everything and runs `strict=True`, where an unavailable check
rejects.

**To fix:** pass the portfolio and ledger from the agent callers too.

### 6.12 Binance futures testnet is deprecated via ccxt

`USE_TESTNET=true` no longer gives a working paper venue — ccxt reports that Binance
dropped futures testnet support, and private calls fail rather than executing against
a test account.

It fails **closed**, which is the right direction. But do not treat `USE_TESTNET` as
your safety gate. **`LIVE_TRADING=false` is the gate that actually works.**

### 6.13 Watched symbols are hardcoded

`BTC/USDT`, `ETH/USDT`, `SOL/USDT` in `backend/services/live_market_data.py`; regime
watching covers BTC and ETH; funding and OI triggers are BTC-only.

**To fix:** move the list to settings.

### 6.14 Order sizes are not exchange-rounded outside the graph path

The execution service rounds to `stepSize`/`minQty` and refuses rather than rounding
up — rounding up would exceed the approved risk. The **agent** path
(`supervisor_agent` → CRO) does not go through that service and submits unrounded
sizes.

**To fix:** route the agent path through the execution service too.

---

## Part 7 — Quick reference

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `LIVE_TRADING` | `false` | **the real safety gate.** false = simulation, no exchange calls |
| `GRAPH_EXECUTION_ENABLED` | `false` | may graph runs submit TARs |
| `POSITION_MONITORING_ENABLED` | `false` | may monitoring decisions be applied |
| `TRADES_API_KEY` | unset | when set, guards every state-changing route |
| `USE_TESTNET` | `true` | ⚠️ deprecated by Binance — see §6.12 |
| `LLM_PROVIDER` | `null` | only `null` is implemented — see §6.1 |
| `RISK_PER_TRADE` | `0.02` | fraction of equity risked per trade |
| `GRAPH_CHECKPOINTER` | sqlite | durable state for position monitoring |
| `BINANCE_API_KEY` / `BINANCE_SECRET` | empty | required only for live trading |
| `DATABASE_URL` | localhost | optional — see §6.3 |

### Hard limits (not overridable by any setting or confidence level)

| Limit | Value |
|---|---|
| Leverage ceiling | 3× real, 10× paper |
| Risk per trade | 3% of equity |
| Daily loss | 5% of equity |
| Single position | 50% of equity notional |
| Total exposure | 100% of equity notional |
| Stop-loss | mandatory and computed, or the trade is refused |

### Verification

```bash
.\.venv\Scripts\python.exe -m pytest -q     # 1030 tests
npx tsc --noEmit -p tsconfig.json           # must be clean
npm run test                                # 281 tests
```

### Where things live

| | |
|---|---|
| Graphs | `backend/graphs/` |
| Nodes | `backend/graphs/nodes/` |
| Risk gateway | `backend/core/risk_manager.py` |
| Execution boundary | `backend/services/execution_service.py` |
| Safety invariants | `CLAUDE.md` |
| Build history + audits | `LANGGRAPH_IMPLEMENTATION_PLAN.md` |
