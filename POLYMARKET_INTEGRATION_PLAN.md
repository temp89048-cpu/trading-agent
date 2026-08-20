# Polymarket Integration — Plan (no code yet)

Source document: `polymarket.md` (13 sections).
Target architecture: this repo as it actually exists today.
Status: **Phases 32-34 implemented and verified** (see BUILD LOG at the end).
Phases 35-38 are still plan only. Nothing is enabled: `POLYMARKET_ENABLED`
defaults `false` and no graph reads any of it yet.

This plan follows the same discipline as `LANGGRAPH_IMPLEMENTATION_PLAN.md`:
analyse what exists → name the exact seam → state the consequence →
then build. Where `polymarket.md` describes something this codebase
cannot or should not do, that is called out as a **deviation** with the
reason, rather than silently dropped.

---

## 0. What was verified before planning

### 0.1 The finding that reshaped this plan

**`ccxt` — already a declared dependency of this project — ships a
native-async Polymarket prediction-market adapter.** Verified locally:

```
ccxt 4.5.73
from ccxt.prediction import polymarket          # a CLASS, not a module (see §5, risk 6)
fetch_ticker  is coroutine: True
fetch_markets is coroutine: True
watch_order_book is coroutine: True             # implemented IN the polymarket module
mro: polymarket -> PredictionExchange -> BaseExchange -> ImplicitAPI
```

`polymarket.md` was written on the assumption that a REST client, a
WebSocket client, rate-limit handling, reconnect logic, and a raw-JSON
field mapping all have to be hand-written (§1, §3, §10). **They do not.**
The adapter provides, all async and all already installed:

| Need from `polymarket.md` | ccxt method | Returns |
|---|---|---|
| §1 market/metadata discovery | `fetch_markets()` | `MarketInterface[]`, outcomes nested |
| §1 event discovery + search | `fetch_events({query, queries, tags, sort, status, searchIn, slug})` | `PredictionEvent[]` |
| §1 best bid/ask, mid, last | `fetch_ticker(outcome)` | `PredictionTicker` |
| §1 full CLOB book | `fetch_order_book(outcome)` | `PredictionOrderBook` |
| §1 open interest | `fetch_open_interest(outcome)` | `PredictionOpenInterest` |
| §3 historical backfill | `fetch_ohlcv(outcome, timeframe, since, limit)` | OHLCV list, client-side bucketed from `prices-history` |
| §3 live push feed | `watch_order_book(outcome)`, `watch_ticker(outcome)`, `watch_trades` | same unified types |
| §3 WS keepalive / PING-PONG | `describe()['streaming'] = {'ping': self.ping, 'keepAlive': 10000}` | handled by ccxt |
| §3 rate limits | `'rateLimit': 100` + `enableRateLimit=True` | handled by ccxt |

And the **unified typed structures already exist**, so §2's "schema
mapping" is largely solved rather than to-be-invented:

```python
PredictionOutcome:  price: Num        # "probability 0..1"  <- THE ΔP source
                    bid, ask, label, outcome, outcomeId, winner, settleFraction, active
PredictionMarket:   marketType: 'binary' | 'categorical' | 'scalar'
                    underlying, floorStrike, capStrike, strikeType   # scalar only
                    resolved, resolvedOutcome, settlementValue, end, endDatetime
PredictionEvent:    tags, markets, mutuallyExclusive, active, resolved, volume, liquidity, end
PredictionTicker:   bid, ask, last, openInterest, quoteVolume, baseVolume, timestamp
```

Two consequences worth stating plainly:

- **`marketType == 'scalar'` with `underlying` / `floorStrike` /
  `capStrike` is a typed field.** §1's hardest problem — deciding whether
  a market is a directional view on the traded asset — does not need a
  hand-curated threshold table parsed out of question text. ccxt already
  classifies it.
- **`fetch_ohlcv` returns the same OHLCV shape `market_data.fetch_klines`
  already normalises.** Probability history slots into the existing candle
  convention rather than a new one.

### 0.2 The rest

| Fact | How established |
|---|---|
| Polymarket appears **nowhere** in `backend/` or the TS side | `Grep` over `backend/`; repo-wide grep hit only `.venv/` ccxt |
| `specialist_news` is `available=False`, weight **1.5 / 7.0** | `backend/graphs/nodes/specialists.py:116`, `:316`, `:323` |
| `news_event` trigger is a **stub** that never fires | `backend/graphs/triggers.py:80` `UNAVAILABLE_TRIGGERS`, `:459` `evaluate_news` returns `acted=False` |
| Directional coverage is capped at **4.0/7.0 = 0.571** today | `DIRECTIONAL_WEIGHTS` = market 3.0 + funding 1.0 available; orderflow 1.5 + news 1.5 unavailable |
| `coverage = available_weight / TOTAL_DIRECTIONAL_WEIGHT` | `specialists.py:~786` |
| `MIN_CONFIDENCE_TO_TRADE = 0.18`, `MIN_CONFIDENCE_TO_EXIT = 0.15` | `backend/graphs/nodes/supervisor.py:151`, `:156` |
| Constraint specialists combine with `max()`, not a product | `specialists.py:~800` `CONSTRAINT_SPECIALISTS` loop |
| `analysis_config()` fans out via `[(n, DEBATE_NODE) for n in SPECIALIST_NODES]` | `backend/graphs/analysis.py:141` — extending the tuple needs no edge surgery |
| Nothing under `graphs/` may import an order call | `backend/graphs/contracts.py:211` `FORBIDDEN_IMPORTS`, AST-enforced |
| Stores are JSON files under `.data/` with a serialize queue | `backend/services/research_store.py` |
| A new API router must be mounted **and** mirrored in `lib/backendConfig.ts` | `tests/test_stack_integration.py:28`, `:189` |
| `ccxt.pro` does **not** expose polymarket; `ccxt.async_support.prediction` does not exist | `python -c "import ccxt.pro; 'polymarket' in dir(...)"` → `False` |

**This environment has no network route to external APIs** (CLAUDE.md).
The adapter's *existence and shape* are verified above by introspection;
**no live call has been made and none can be from here.** §8 is the
operator's one-command reachability probe, and it comes before Phase 32.

---

## 1. The single most important design decision

`polymarket.md` §2 and §5 propose feeding Polymarket into the graph as a
predictive signal. Before wiring anything, one question has to be
answered honestly:

> **Is a Polymarket price a directional view on the traded symbol, or is
> it event-risk context?**

It is **both, and they are not interchangeable.** ccxt's `marketType`
happens to draw almost exactly the right line:

| `marketType` | Example | Honest role here |
|---|---|---|
| **`scalar`** with `underlying` ≈ the traded asset | a dated BTC price range, `floorStrike`/`capStrike` | Genuinely **directional** — the implied distribution is a view on BTC |
| **`binary`** on a dated price threshold for the asset | "Will BTC close above $130k on 2026-09-30?" | **Not usable as implemented** — see BUILD LOG correction 2. One strike means an unbounded bucket, so there is no midpoint for `expected_price`, and `delta_stance` refuses to guess the above/below sense |
| **`binary` / `categorical`** macro, regulatory, venue | "Fed cut in September?", "ETH ETF approved?", "Will exchange X be hacked?" | **Constraint / event risk** — a reason to reduce conviction, *not* a reason to go long or short |

Collapsing these into one "sentiment score" is exactly the fabrication
class this codebase already refuses (`CLAUDE.md` invariant 6). "The Fed
market moved 8%" says nothing about BTC direction, and a signed
directional vote derived from it would be an invented number that then
drives real sizing.

**So the plan adds two specialists, not one:**

- `specialist_prediction` — **directional**, populated only from scalar /
  price-threshold markets whose `underlying` resolves to the traded
  symbol. `available=False` with a named blocker for every symbol with no
  such market.
- `specialist_event_risk` — **constraint**, populated from macro /
  regulatory / venue-risk markets. Contributes `concern`, never `stance`.

This mirrors the directional-vs-constraint split the panel already has,
so no new aggregation logic is needed: `run_debate` already handles both
roles (`DIRECTIONAL_WEIGHTS` for one, `max()` over
`CONSTRAINT_SPECIALISTS` for the other).

### Deliberate non-goal: never trade *on* Polymarket

This integration is **read-only market data**, and the ccxt finding makes
that harder to guarantee, not easier: the same adapter class exposes
`create_order`, `cancel_order`, `fetch_balance`, `fetch_positions`. A
Polymarket order would add a second execution venue, breaking `CLAUDE.md`
invariant 1 (`components/Supervisor.tsx`'s `reviewAndExecute()` is the
single execution path) and sitting entirely outside `ABSOLUTE_MAX_LEVERAGE`,
the mandatory-stop rule, and the Risk Gateway.

Enforcement, not documentation (Phase 34):

- the read-only wrapper **never returns or stores the raw ccxt object** —
  callers get only the narrow read methods;
- **no API credentials are ever passed** to the constructor, so the
  private endpoints fail closed;
- extend the AST import ban to cover Polymarket order symbols, with a
  test — the same mechanism that already keeps `graphs/` away from
  `create_market_order`.

---

## 2. The consequence nobody would notice until confidence dropped

This must be settled **before** any code, because it changes every
confidence number the system produces — the same class of knock-on as the
regime-vocabulary bug in `LANGGRAPH_IMPLEMENTATION_PLAN.md`.

`coverage = available_weight / TOTAL_DIRECTIONAL_WEIGHT`. Adding a
directional specialist **raises the denominator for every run**,
including runs where it has nothing to say:

| Scenario | available | total | coverage | max confidence |
|---|---|---|---|---|
| Today | 4.0 | 7.0 | 0.571 | 0.571 |
| + `specialist_prediction` (w=1.0), market found | 5.0 | 8.0 | **0.625** | 0.625 ↑ |
| + `specialist_prediction` (w=1.0), **no market for symbol** | 4.0 | 8.0 | **0.500** | 0.500 ↓ |

Polymarket has deep BTC and ETH markets and effectively nothing for most
alts. So the *common* case is the third row: **a ~12.5% relative
confidence cut on every symbol Polymarket does not cover.** A run sitting
at exactly the `0.18` floor today lands at `0.18 × 0.500/0.571 = 0.158`
and flips from TRADE to WAIT.

Three options, with a recommendation:

1. **Accept the drop, retune the floor.** Honest — coverage genuinely is
   lower once we admit a feed exists and is missing. Requires re-deriving
   `MIN_CONFIDENCE_TO_TRADE` from a real run distribution, exactly as
   `0.25 → 0.18` was re-derived when the regime fix landed.
2. **Renormalise over reachable specialists.** Rejected. `specialists.py:110`
   explicitly refuses this: *"News and Orderflow carry the weight they
   WOULD have, so `coverage` reports the true fraction of the panel that
   is missing rather than flattering itself by renormalising."*
3. ✅ **Recommended: weight 1.0, accept the drop, and gate the whole
   feature behind `POLYMARKET_ENABLED` (default `false`).** When the flag
   is off, the two nodes are **not registered at all**,
   `DIRECTIONAL_WEIGHTS` is untouched, and every confidence number is
   byte-identical to today. Turning the flag on is an explicit operator
   decision to change the panel's denominator — documented alongside the
   existing `GRAPH_EXECUTION_ENABLED` / `POSITION_MONITORING_ENABLED`
   gates in `OPERATOR_GUIDE.md` §5's staged-enablement path.

Weight **1.0** (equal to funding, one third of market) because a
prediction market on a dated threshold is a real but indirect observation
of spot: it prices a *terminal distribution*, not the next 15-minute
candle. Claiming more would assert a track record this system has never
measured — the same reasoning the existing weights document.

---

## 3. Integration points — the complete map

Seven phases, in dependency order. Phase numbering continues the project
log (Phase 31 = triggers, per `triggers.py`'s docstring).

### Phase 32 — Read-only client (`backend/services/polymarket_client.py`)

**Much smaller than `polymarket.md` §3 implies.** A thin async wrapper
around `ccxt.prediction.polymarket`, following `exchange_client.py`'s
singleton-wrapper pattern — the abstraction this project already uses for
Binance, so there is one exchange-client convention rather than two.

- `enableRateLimit=True`; **no credentials passed**, ever.
- Exposes only: `fetch_events`, `fetch_markets`, `fetch_ticker`,
  `fetch_order_book`, `fetch_ohlcv`, `fetch_open_interest`. Never the raw
  ccxt object (§1).
- **Returns `None` on failure, never a stale-but-plausible number.** This
  is what makes the specialist's `available=False` meaningful, and it is
  the discipline `exchange_client.create_market_order` documents at
  length after it once fabricated a $60,000 fill.
- Retry/backoff mirroring `market_data.fetch_klines`'s `2 ** attempt`
  loop rather than inventing a second retry style.
- WS (`watch_order_book` / `watch_ticker`) is **Phase 32b**, deferred —
  but no longer a dependency problem: ccxt implements it, including the
  Polymarket-specific 10s text-PING keepalive. **`websockets` does not
  need to be declared**; the earlier draft of this plan was wrong about
  that.

**Deviation from `polymarket.md` §3:** the doc recommends
InfluxDB/TimescaleDB. This is a single-process app whose every store is a
JSON file under `.data/` with a serialize queue (`CLAUDE.md`, "Stores
follow one pattern"). A TSDB would be the only infrastructure dependency
in the project and the only store that breaks the pattern. Plan: JSON
store with a bounded retention window (Phase 33), with a note that a TSDB
becomes justified only if per-tick book depth is ever ingested — which
this plan does not do.

### Phase 33 — Market resolution + store (`polymarket_registry.py`, `polymarket_store.py`)

The part most likely to produce a wrong number, even with ccxt's typing.

- **`resolve_markets_for_symbol(symbol)`** — uses `fetch_events` with
  `tags` / `query` for discovery, then classifies each returned market by
  `marketType` and `underlying` per §1's table. The result is
  **cached to disk and requires human confirmation before it can feed the
  directional specialist.** Discovery is automatic; *attribution* is not.
  A keyword search that decides "Will ETH flip BTC?" is a BTC-long signal
  would attribute a probability to the wrong instrument, and no
  downstream check could catch it.
- **`POLYMARKET_EVENT_TAGS`** — the non-directional set (Fed, ETF,
  regulatory, venue risk), tagged with which symbols they plausibly
  affect and how severely. Hand-written, because "which symbols does an
  SEC action affect" is a judgement, not a lookup.
- **`polymarket_store.py`** — `.data/polymarket_series.json`, copying
  `research_store.py`'s lazy-create + serialize-queue pattern. Holds a
  bounded rolling window per outcome (recommend 7 days at 5-minute
  resolution) of `PredictionOutcome.price` so ΔP survives a process
  restart. **Bounded** is not optional: `_append_bounded` exists in
  `state.py` precisely because an unbounded accumulator on a long-lived
  thread grew to ~8,000 entries/week.
- Also cached: `end` / `endDatetime` / `resolved` / `resolvedOutcome`,
  which Phase 34 needs for the resolution-decay problem (§5, risk 7).

### Phase 34 — Signal computation (`backend/algorithms/prediction_market.py`)

**Deterministic, pure, unit-tested, in `algorithms/`** — matching
`debate.py`, `footprint.py`, `market_graph.py`. `CLAUDE.md`:
*"Deterministic over LLM where the math is real."* Every number in
`polymarket.md` §4 is arithmetic over data already fetched; routing it
through a model would add hallucination risk to a financial decision and
destroy reproducibility.

Functions:

- `delta_probability(series, window_seconds)` → ΔP, or `None` when the
  window has too few points. `None` means *not measured*; `0.0` means
  *measured as zero*. That distinction is load-bearing throughout this
  codebase.
- `probability_zscore(series)` — ΔP normalised by the outcome's own
  realised volatility, so a 3% move in a market that always moves 3% is
  not an event.
- `implied_drift(outcome_price, market, spot, now)` — the directional
  translation, reading `floorStrike` / `capStrike` / `underlying` /
  `end` off the typed `PredictionMarket`. **Returns `None` unless every
  input is real and the market is `active` and not `resolved`.** This is
  the one function that converts a probability into a stance, so it is
  the one most able to fabricate.
- `confidence_from_liquidity(delta, ticker)` — §4's confidence formula
  from `quoteVolume` / `openInterest` / `bid`-`ask` spread. A 5% move on
  $100 of volume is noise and the formula must say so; `None` when volume
  is unavailable, never an assumption that it is large.
- `PREDICTION_SIGNALS` — a named tuple of every signal with, for each,
  either a computation or a stated blocker. Same shape as
  `footprint.FOOTPRINT_SIGNALS`, which already reports 3 of 6 as
  unavailable, so the convention exists.

**Also in Phase 34:** extend the AST import ban to Polymarket order
symbols (`create_order`, `cancel_order`, `cancel_all_orders`) and add the
test. Read-only must be enforced, not asserted — and this adapter can
trade.

### Phase 35 — The two specialists (`backend/graphs/nodes/specialists.py`)

Extends the existing file rather than adding a new one, so
`SPECIALIST_NODES`, `DIRECTIONAL_WEIGHTS` and `run_debate` stay in one
place and cannot drift.

- `specialist_prediction` — `role="directional"`, contract
  `reads=("market_data", "symbol")`, `writes=("specialist_findings",)`,
  `deterministic=True`, `phase=35`. Reads the store; does **not** fetch
  (same rule as `specialist_funding`, which reads `sentiment_analysis`
  fetched upstream). The blocker string must make the distinction the
  news blocker makes: *"no Polymarket market resolves to this symbol"* ≠
  *"the crowd has no view"*.
- `specialist_event_risk` — `role="constraint"`, contributes `concern`
  only, added to `CONSTRAINT_SPECIALISTS`. Safe to add in the sense that
  constraints combine with `max()` so it cannot compound the other three
  — but `max()` cuts the other way too: it can only ever *raise* the
  binding concern, so a miscalibrated event score quietly suppresses
  trading system-wide. Needs an explicit ceiling and a calibration note.
- `DIRECTIONAL_WEIGHTS["prediction"] = 1.0` — **conditional on
  `POLYMARKET_ENABLED`**, per §2 option 3.
- `analysis_config()` picks both up automatically via `SPECIALIST_NODES`
  (`analysis.py:141`), so **no edge surgery** — which is why extending
  the existing tuple is the right move.
- `analysis.py`'s `_ensure_nodes()` presence check needs an entry for the
  new nodes, or a full-suite run hits the duplicate-registration raise.
  No new entry is needed in `registry.clear_registry()`'s module tuple
  (no new graph module).

### Phase 36 — Trigger source (`backend/graphs/triggers.py`)

A ΔP spike is genuinely new information and is exactly what the trigger
layer is for. `polymarket.md` §5's "Event Detection Node" maps onto this
layer, not onto a new graph node — detection is cheap here by design
("cheap detection, expensive reasoning", `triggers.py` docstring).

- Add `"prediction_market_shift"` to the `TriggerKind` Literal
  (`state.py:61`). **Not** a reuse of `news_event`: a prediction-market
  move is not a headline, and conflating them would make
  `UNAVAILABLE_TRIGGERS["news_event"]`'s blocker a lie while leaving the
  actual news gap invisible.
- `TriggerEvaluator.evaluate_prediction_market(...)` alongside
  `evaluate_macro`, going through the same `_admit()` gate so it inherits
  the per-(symbol, kind) cooldown, the baseline reset on fire, and the
  global/per-symbol rate ceilings. `polymarket.md` §13's alert rule
  *">3 events/minute on same market → possible loop"* is already handled
  by that gate; implementing it again would create two answers to "why
  did this not fire".
- Recommended cooldown: **900s**. Prediction markets reprice on discrete
  news, not continuously, so a shorter cooldown buys noise. To be
  re-derived from a real distribution once data exists.
- A poller in `backend/workers/` (following `trigger_worker.py`) drives
  the REST path; Phase 32b's WS path publishes onto the bus instead.
  **`MessageBus.publish` takes `(topic, payload)`** — two args. A one-arg
  call once passed 43 tests because every test double also took one arg,
  so any new publisher needs a **real-bus** test.

### Phase 37 — API + frontend surface

`tests/test_stack_integration.py` encodes the lesson that layer 4 was
invisible to layer 1 for the entire build. Do not repeat it.

- `backend/api/polymarket.py`, mounted in `main.py` at `/api/polymarket`.
  Read-only: resolved markets and their confirmation status, current
  probabilities with timestamps, detected shifts, per-symbol availability
  with the blocker string.
- Add the prefix to `test_every_api_router_is_actually_mounted`'s list
  and bump the `>= 45` endpoint floor.
- `lib/backendConfig.ts` — declare every path. The path-parity test
  exists because six components had localhost hardcoded and several
  pointed at routes FastAPI does not serve.
- `components/PolymarketPanel.tsx`, following `NewsPanel.tsx` /
  `MarketIntelPanel.tsx`. It must **show unavailability**, not hide it: an
  operator looking at a 0.50 confidence needs to see "prediction: no
  market resolves to SOL", the same way the specialist list already
  surfaces the three blocked specialists.

### Phase 38 — Validation, and where it is *allowed* to land

`polymarket.md` §7 asks for Sharpe / AUC / Granger causality. Two things
constrain where its output may go:

- `backend/core/backtest_engine.py` is the engine to use. Note the
  documented bug (`OPERATOR_GUIDE.md` §6.4): **the backtest engine clears
  the message bus.** Running a Polymarket backtest inside a live process
  would silently unsubscribe the live graph. Either run the harness
  out-of-process or **fix that bug first** — recommend fixing it, since it
  will otherwise bite whoever runs the study.
- **A validated Polymarket signal may not auto-deploy.** `CLAUDE.md`
  invariant 5 and `research_store.py`'s `HUMAN_ONLY_STATUSES`. The
  study's output is a **hypothesis record** (`proposed`); a human moves it
  to `validated` and then `applied` after changing the weight themselves.
  Concretely: a backtest showing weight 2.0 beats 1.0 must **not** write
  `DIRECTIONAL_WEIGHTS`. `tests/test_learning_pipeline.py` asserts no
  learning module imports anything that can write trading config, and it
  must keep passing.

Ablations worth running, narrowed from §7's matrix to what this system
can actually vary: ΔP threshold, window length, directional weight, and
whether `specialist_event_risk` is on — with the null model being
**today's panel**, so the question answered is "did adding Polymarket
help *this system*?" rather than "is Polymarket predictive in the
abstract?"

---

## 4. What is deliberately dropped from `polymarket.md`

| Doc section | Proposal | Decision |
|---|---|---|
| §1, §3, §10 | Hand-written REST + WS clients, custom rate limiting, raw field mapping (`lastTradePrice` / `bestBid` / …) | **Superseded** by `ccxt.prediction.polymarket` and its unified `Prediction*` types. Hand-rolling against raw JSON would mean maintaining a second exchange abstraction and re-deriving field names ccxt already normalises. |
| §3 | InfluxDB / TimescaleDB | **Dropped.** JSON store with bounded retention; a TSDB would be the only store breaking the one-store pattern. Revisit only if per-tick depth is ingested. |
| §6 | An LLM node prompting a model to explain a Polymarket shift | **Dropped from the decision path.** The panel and Supervisor stay deterministic. The existing `trade_thesis_narrative` — the only LLM node in the system — can *narrate* the shift, and the `trade_thesis` / `thesis_narrative` split already makes "a model may narrate a computed value, it may not replace it" structurally enforced. A new LLM node inside the fan-out is the drift `registry.coverage()` was built to watch for. |
| §8 | LangSmith deployment / tracing | **Dropped.** `backend/graphs/tracing.py` already traces every run and `/api/graphs/runs` serves it. Two tracing systems means two answers to "what did this run do". |
| §9 | 20-week / 7-milestone roadmap, 4 GPUs / 16 CPUs | **Rescoped.** No GPUs are involved; nothing here trains a model. The ccxt finding removes most of Milestone 1. The seven phases above are the same dependency order at this project's actual scale. |
| §10 | `from langgraph import LangGraph, Command` | **Not usable as written** — not this project's API (or current LangGraph's). Nodes here register through `registry.register_node` with a `NodeContract`; graphs are assembled by `builder.build_graph` from a `GraphConfig`. The snippets are illustrative of intent only. |
| §12 | Separate ingestion / storage / agent service topology | **Dropped as topology, kept as responsibilities** — the same call `CLAUDE.md` already records for the spec's CEO/CIO/CRO org chart. |
| throughout | Trading on Polymarket | **Explicitly forbidden.** Read-only, enforced three ways (§1). |

---

## 5. Risks, ranked

1. **Confidence regression on uncovered symbols (§2).** Highest impact,
   silent, affects every run. Mitigated by `POLYMARKET_ENABLED` defaulting
   off, and by re-deriving the floor before it goes on.
2. **`implied_drift` fabricating a stance.** One function turns a
   probability into a direction; a plausible default inside it would drive
   real sizing. Mitigated by `None` on any missing input, plus tests
   asserting that for every incomplete combination.
3. **The adapter can place orders.** `create_order` / `cancel_order` /
   `fetch_balance` sit on the same class we import for reads. Mitigated by
   the narrow wrapper, passing no credentials, and the AST ban — all three,
   because any one alone is a single point of failure.
4. **Wrong market → wrong symbol.** ccxt's `marketType` / `underlying`
   help a lot but do not decide "which symbols does an SEC ruling
   affect". Human confirmation of the resolved mapping is the mitigation;
   the failure mode of full automation is a confident signal about the
   wrong asset.
5. **Event-risk over-suppression.** A fourth `max()` constraint can only
   *raise* the binding concern, so a miscalibrated event score quietly
   stops all trading. Needs a ceiling and a calibration note.
6. **`from ccxt.prediction import polymarket` returns a CLASS, not a
   module.** The package `__init__` shadows the submodule name, so
   `import ccxt.prediction.polymarket as m; m.polymarket` raises
   `AttributeError` — this bit during planning. Worth one comment at the
   import site; also `ccxt.pro` has no polymarket and
   `ccxt.async_support.prediction` does not exist, so the async class is
   reached via `ccxt.prediction` despite that reading as the sync
   namespace.
7. **Resolution-date decay.** A market resolving tomorrow and one
   resolving in six months carry completely different information about
   the next hour. An expiring market's probability converges to 0 or 1
   regardless of spot, which would read as a huge directional signal.
   `end` / `resolved` / `active` are typed and available — they must be
   first-class inputs to `implied_drift`, not ignored.
8. **Backtest engine clearing the live bus** (`OPERATOR_GUIDE.md` §6.4).
   Fix before the Phase 38 study.
9. **Geo / regulatory.** `polymarket.md` §8: the CFTC treats these as
   derivatives, and Polymarket US vs International are different venues
   with different market sets — note ccxt's adapter declares
   `'countries': ['US']`. Read-only consumption is the conservative
   posture; the jurisdiction assumption gets stated in `OPERATOR_GUIDE.md`
   rather than left implicit.
10. **ccxt version coupling.** The `Prediction*` types are recent. Pinning
    a minimum ccxt version in `requirements.txt` is part of Phase 32 —
    `ccxt` is currently unpinned, and these methods would vanish on a
    downgrade.

---

## 6. Recommended build order

```
32  polymarket_client.py            read-only ccxt wrapper, honest None on failure
33  polymarket_registry + store     resolve+confirm mapping, bounded JSON series
34  algorithms/prediction_market.py pure math + import-ban extension
--- checkpoint: real probabilities in the store, signals computable, no graph touched
35  two specialists                 behind POLYMARKET_ENABLED (default false)
36  trigger kind + poller worker
--- checkpoint: re-derive MIN_CONFIDENCE_TO_TRADE from a real run distribution
37  api/polymarket.py + backendConfig + panel
38  validation study -> hypothesis record (human-approved only)
32b watch_order_book / watch_ticker feed
```

Phases 32–34 touch **no graph and no decision path**, so they can land and
be verified with `POLYMARKET_ENABLED` off and zero behavioural change. The
first behavioural change is Phase 35, and it is gated.

## 7. Verification per phase

```bash
npx tsc --noEmit -p tsconfig.json   # must be clean (Phase 37)
npm run test                        # vitest
python -m pytest tests/ -q          # all existing tests must still pass
npm run build
```

Plus, specific to this work:

- A test asserting confidence is **byte-identical to today** with
  `POLYMARKET_ENABLED=false` — that is the entire safety argument for the
  gate.
- A test asserting `implied_drift` returns `None` for every incomplete
  input combination, and for `resolved` / inactive markets.
- An AST test that no Polymarket module imports an order call, and that
  the client never returns the raw ccxt object.
- A **real-bus** publish test for the trigger worker (not a double).
- `tests/test_learning_pipeline.py` still passing after Phase 38.

## 8. First action for the operator (not me)

The adapter's shape is verified; **its reachability is not** — there is no
network route to external APIs from this environment. Before Phase 32 is
written, one probe from a machine with egress:

```python
import asyncio
from ccxt.prediction import polymarket   # NB: a class, not a module

async def main():
    ex = polymarket({'enableRateLimit': True})     # no credentials, deliberately
    try:
        print("status:", await ex.fetch_status())
        events = await ex.fetch_events({'query': 'Bitcoin', 'status': 'active',
                                        'sort': 'volume', 'limit': 5})
        for e in events:
            print(e['event'], '|', e['title'], '| tags:', e.get('tags'),
                  '| vol:', e.get('volume'), '| end:', e.get('endDatetime'))
            for m in e.get('markets') or []:
                print('   market:', m.get('market'), '| type:', m.get('marketType'),
                      '| underlying:', m.get('underlying'),
                      '| strikes:', m.get('floorStrike'), m.get('capStrike'))
                for o in m.get('outcomes') or []:
                    print('      outcome:', o.get('outcome'), '| p:', o.get('price'),
                          '| bid/ask:', o.get('bid'), o.get('ask'))
        if events:
            oc = events[0]['markets'][0]['outcomes'][0]['outcome']
            print("ticker:", await ex.fetch_ticker(oc))
            print("ohlcv rows:", len(await ex.fetch_ohlcv(oc, '5m', limit=50)))
    finally:
        await ex.close()

asyncio.run(main())
```

What the plan needs from that output, and why it comes first:

- **Are BTC/ETH price markets actually typed `scalar` (or binary with a
  readable threshold), and is `underlying` populated?** §1's whole
  directional/constraint split and Phase 34's `implied_drift` depend on
  it. If `underlying` comes back empty, Phase 33 needs a hand-curated
  threshold table after all and grows by a few days.
- **Does `fetch_ohlcv` return usable probability history, and how far
  back?** That sets the ΔP window in Phase 34 and the retention window in
  Phase 33.
- **Do read paths work with no credentials?** The read-only posture in §1
  assumes so.
- **What do `tags` actually look like?** Phase 33's `POLYMARKET_EVENT_TAGS`
  is written against real tag values, not guessed ones.

Writing Phases 32–34 against guessed answers is how three files get built
on a wrong assumption — which is exactly the failure mode this project has
already recorded more than once.

---

# BUILD LOG

## Phases 32-34 — landed

Files created:

| File | Lines | Role |
|---|---|---|
| `backend/services/polymarket_client.py` | ~330 | Read-only ccxt wrapper |
| `backend/services/polymarket_store.py` | ~380 | Bounded probability series + mappings |
| `backend/services/polymarket_registry.py` | ~470 | Classification + discovery |
| `backend/algorithms/prediction_market.py` | ~600 | Deterministic signal math |
| `tests/test_polymarket.py` | ~700 | 102 tests |

Modified: `backend/core/config.py` (`POLYMARKET_ENABLED`, default `false`),
`requirements.txt` (`ccxt>=4.5.73`, pinned with the reason).

### Verification (all run)

```
.venv/Scripts/python.exe -m pytest tests/ -q   1132 passed, 2 skipped
npx tsc --noEmit -p tsconfig.json              clean (exit 0)
npm run test                                   281 passed (16 files)
```

The 1132 includes the 1030 that passed before this work, unchanged. No graph, node,
weight or threshold was touched — `test_phases_32_to_34_have_not_touched_the_panel`
and `test_nothing_in_the_graphs_package_imports_the_polymarket_modules_yet` assert
that mechanically rather than by inspection.

Offline-verified by introspection (no network needed, none available):

```
adapter constructs with rateLimit=100, timeout=10000, apiKey empty, secret empty
all 7 allowlisted read methods exist on the adapter
_call("create_order", ...) raises ValueError
```

### Four corrections found while implementing

**1. `expected_price` read the strikes off the wrong ccxt type — the serious one.**

It took ccxt outcome dicts and read `floorStrike`/`capStrike` from each.
`PredictionOutcome` has no such fields; they are `PredictionMarket` fields, "scalar
only". A price-range event is nested:

```
PredictionEvent (mutuallyExclusive=True)
  +- PredictionMarket floor=120k cap=130k -> outcomes[YES].price = P(this bucket)
  +- PredictionMarket floor=130k cap=140k -> ...
```

so the buckets come from the event's **markets**, not one market's outcomes.

Why this one mattered more than the others: it would not have crashed and would not
have fabricated anything. It would have found no strikes on every real payload,
returned `None` every time, and left `expected_price_drift` permanently
`available=False` — **silent degradation masking a dead signal**, which is the exact
failure class this project has hit repeatedly. The honest-unavailable path would
have been the thing hiding it.

Fixed with an explicit `PriceBucket` type that the wrong dict cannot satisfy, a
`buckets_from_event()` builder, and `expected_price` raising `TypeError` (not
returning `None`) on a raw dict — because `None` is indistinguishable from "this
market has no buckets". `test_strikes_live_on_the_market_not_the_outcome` asserts
the ccxt type layout directly, so a future ccxt change surfaces as a failure.

**2. Phase 33 and Phase 34 disagreed about what "directional" means.**

The registry classified any market as directional when `underlying` matched and
*any* strike was present. But `algorithms/prediction_market.py` has exactly two
honest paths and a lone single-strike market feeds **neither**: `expected_price`
needs a bounded partition, `delta_stance` needs an explicit above/below sense that
no typed field supplies. A confirmed mapping producing no signal would read as a bug
in the specialist rather than an honest limit of the data.

Added `Classification.directional_basis`. `directional` now implies some function
can consume it; single-strike and non-partition markets are `unusable` with the
reason stated. `test_every_directional_classification_declares_a_computable_basis`
holds the invariant.

**3. The store accepted a `bool` as a probability.** `bool` subclasses `int`, so
`float(True)` is `1.0` and the range check passed it as a 100% probability — the
most extreme value the series can hold, from something that is not a measurement.
`prediction_market._series_prices` already skipped bools, so the value would have
been persisted and then permanently invisible. Rejected at the write boundary now,
so the two layers agree.

**4. Numeric strings are accepted, deliberately.** ccxt types these fields
`Num = Union[None, str, float, int]` and genuinely returns strings for some venues,
so refusing `"0.42"` would drop real observations. An initial test asserted the
opposite; the test was wrong, not the code.

### One plan claim corrected

**`websockets` does not need declaring.** §Phase 32 of the plan (and its first
draft) said it did. ccxt implements `watch_order_book`/`watch_ticker` for Polymarket
itself, including the venue-specific 10-second text-PING keepalive declared in
`describe()['streaming']`. Phase 32b needs no new dependency.

### One cost property worth knowing

`record_probability` reads, appends to and rewrites the **whole** JSON file per
observation, so writing N points costs O(N²). At the production cadence — one write
per outcome per 5 minutes — that is fine, but it means `RETENTION_SECONDS`,
`MAX_POINTS_PER_OUTCOME` and `MAX_TRACKED_OUTCOMES` bound **write cost**, not just
file size. Found by a test that looped 2,266 writes and hung; retention logic is now
tested against the pure `_prune` function, with one write-path test proving `_prune`
is actually called.

## Still open

Phases 35-38 as planned, unchanged. Nothing is enabled: `POLYMARKET_ENABLED`
defaults `false`, no specialist is registered, `TOTAL_DIRECTIONAL_WEIGHT` is still
7.0, and `graphs/` does not reference any module above.

### §8's probe now has a sharper primary question

The single most important thing to learn from the probe, because it is the only path
that yields a directional signal today:

> **Does a crypto price event come back with `mutuallyExclusive=True` and one market
> per price bucket, each carrying BOTH `floorStrike` and `capStrike`?**

If yes, `buckets_from_event` → `expected_price` works and Phase 35 proceeds as
planned. If crypto markets are instead single binary thresholds ("above $130k",
one market, one strike), then:

  * `expected_price` cannot run — unbounded bucket, no midpoint;
  * `delta_stance` needs an above/below sense, and Phase 34 refuses to guess it;
  * so **the directional specialist has no usable input at all**, and Phase 35 must
    either add an operator-declared threshold direction per confirmed mapping, or
    ship `specialist_prediction` as `available=False` with that as its blocker.

That is a fork in the plan, not a detail. It is worth running the probe before
starting Phase 35 rather than building against the assumption. The probe script in
§8 already prints `marketType`, `underlying` and both strikes per market; add
`e.get('mutuallyExclusive')` to its per-event line.

---

# §2 REVISED — "one extra layer of information", not a panel member

Operator direction, and it settles the question §2 left open:

> "polymarket is just one addition information to agent not fully use one extra
> layer information"

§2 offered three options and recommended option 3: weight 1.0, **accept** the
coverage drop on uncovered symbols, gate it behind `POLYMARKET_ENABLED`. Under
"one extra layer" that recommendation is wrong, and the reason is worth stating
because it is not merely a preference.

## Why accepting the drop was wrong

`coverage = available_weight / TOTAL_DIRECTIONAL_WEIGHT`. Adding `prediction` at
weight 1.0 raises the denominator on **every** run. For SOL, XRP, DOGE — where
Polymarket has no meaningful market and never will — that is a permanent ~12.5%
confidence penalty for the absence of a source that does not apply. A supplementary
input that makes the agent *less* willing to trade on every symbol it does not cover
is not supplementary; it is load-bearing in the wrong direction.

## The distinction that makes this honest rather than convenient

`specialists.py:110` explicitly refuses renormalising: *"News and Orderflow carry
the weight they WOULD have, so `coverage` reports the true fraction of the panel that
is missing rather than flattering itself by renormalising over what happens to be
**wired up**."*

That objection is about **engineering incompleteness**. Level-2 orderflow data exists
for BTC; we simply have not subscribed to it. The panel really is 4/7 complete and
hiding that would be flattery.

No Polymarket market existing for SOL is a different kind of fact: there is no feed
to wire up. Nothing is missing that could be there.

So the rule is a split by *cause*, not a blanket exemption:

| Situation | Counts against coverage? | Why |
|---|---|---|
| No confirmed market maps to this symbol | **No** — weight leaves the denominator | The source does not apply. Not an engineering gap. |
| A market IS mapped but the read failed, history is too short, or the probability has degenerated | **Yes** — coverage drops | This *is* an engineering gap, and hiding it would be exactly the flattery `specialists.py:110` forbids. |

This is the project's own established pattern, not a new one: `core/risk_manager.py`
already splits `'unavailable'` (a caller omitted an input — rejects) from
`'delegated'` (structurally uncomputable — reports), for precisely this reason. A
check that can never be computed must not be scored as a check that failed.

## Two guards that keep it one layer among several

**Guard A — it cannot speak alone.** Supplementary weight contributes only when at
least one CORE directional specialist (market, orderflow, news, funding) is
available. Without this, `prediction + funding` alone reaches coverage 2.0/8.0 =
0.25, above the 0.18 trade floor — so two weak indirect signals could authorise a
trade with **no price-based evidence at all**, which is a new capability this feature
has no business creating. Today funding alone reaches 1.0/7.0 = 0.14 and cannot.

**Guard B — it cannot outvote the core.** Weight 1.0 against market's 3.0. Checked
arithmetically rather than asserted:

```
market LONG (conviction 1.0)  +3.0     prediction SHORT (conviction 1.0)  -1.0
net = (3.0 - 1.0) / 4.0 = +0.50  -> still LONG
confidence = 0.50 * (4.0/8.0) = 0.25   (vs 0.43 for market alone)
```

A maximally contradicting prediction **dampens** conviction and cannot flip it. When
it agrees: `net = 1.0`, coverage `4.0/8.0 = 0.50`, confidence `0.50` — above market's
own 0.43, so it adds conviction. That asymmetry is what "extra information" should
look like.

And when it does not apply: denominator back to 7.0, coverage 3.0/7.0 = 0.43,
confidence **byte-identical to today**.

## `event_risk` concern is derived from UNCERTAINTY, not from a side

A second fabrication trap, avoided the same way. "Will exchange X be hacked?" has an
obviously adverse side; "Will the ETH ETF be approved?" does not, and deciding which
outcome is bad for a long BTC position would be guesswork dressed as analysis.

So concern is computed from how *undecided* the market is and how *soon* it resolves,
never from which way it leans:

```
concern = profile.weight x uncertainty(p) x proximity(time_to_resolution)
uncertainty(p) = 4p(1-p)      # normalised Bernoulli variance: 1.0 at p=0.5, 0 at 0/1
proximity(t)   = 1 - t/14d    # clamped to [0,1]
```

"The market genuinely does not know, and it settles in two days" is a real reason to
hold conviction lower on a technical thesis. "The market is 97% sure" is not — that
outcome is already in the price. Neither statement requires an opinion about which
resolution would be good for us.

---

# BUILD LOG — Phase 35 (supplementary tier)

Implements "§2 REVISED" above. Polymarket is a **third tier**, not a fifth
directional specialist.

## What changed

| File | Change |
|---|---|
| `backend/graphs/state.py` | `SpecialistFinding.not_applicable` flag; `signed_weight()` now counts the `supplementary` role |
| `backend/graphs/nodes/specialists.py` | `SUPPLEMENTARY_WEIGHTS`, `supplementary_weights()`, `constraint_specialists()`, `specialist_nodes()`, `specialist_prediction`, `specialist_event_risk`, `register_optional_specialist_nodes()`, three-way tally in `run_debate` |
| `backend/algorithms/prediction_market.py` | `event_uncertainty`, `event_proximity`, `event_concern` |
| `backend/services/polymarket_store.py` | `save_signal_snapshot` / `get_signal_snapshot` — the poller↔panel seam |
| `backend/graphs/analysis.py` | `active_specialists = specialist_nodes()` resolved once, used for nodes/edges/router; conditional registration |
| `tests/test_polymarket_panel.py` | 49 tests |

`SPECIALIST_NODES` is **still the same seven names**. The optional nodes live in a
separate `OPTIONAL_SPECIALIST_NODES` tuple, which is why every pre-existing test that
iterates `SPECIALIST_NODES` to build its own config is unaffected by the flag.

## The arithmetic, verified

| Case | available / total | coverage | vs today |
|---|---|---|---|
| Flag off | 3.0 / 7.0 | 0.429 | — |
| On, no market resolves to symbol (`not_applicable`) | 3.0 / **7.0** | 0.429 | **identical** |
| On, mapped market but stale/uncomputable | 3.0 / 8.0 | 0.375 | lower — an honest gap |
| On, available and agreeing | 4.0 / 8.0 | 0.500 | higher |
| On, available and opposing | 4.0 / 8.0 | 0.500 | direction held, confidence down |

## Verification (all run)

```
pytest tests/ -q                          1181 passed, 2 skipped
POLYMARKET_ENABLED=true pytest tests/ -q  1181 passed, 2 skipped   <- both flag states
LangGraph compile with flag on            9 specialists, llm nodes still ['trade_thesis_narrative']
npx tsc --noEmit                          clean
npm run test                              281 passed (16 files)
```

The suite passing **with the feature enabled** is the load-bearing result: it means
turning the flag on does not break any existing behaviour, only widens the panel when
there is something to widen it with.

## The bug this phase produced, and what made it visible

`SpecialistFinding.signed_weight()` returned `0.0` for any role other than
`directional`, so the new `supplementary` role **abstained while still being counted
in the denominator**. The symptom was the exact opposite of the intent: an
agreeing prediction market made confidence go *down* (0.429 → 0.375), because it
widened the panel and then declined to vote.

Nothing raised, and 0.375 is a perfectly plausible confidence. It was caught only
because `test_an_agreeing_prediction_adds_conviction` asserts the *direction of the
change* rather than a value — a test asserting `confidence == 0.375` would have
locked the bug in as the expected answer.

## One consequence recorded rather than hidden

`funding` + `prediction` (both available, nothing else) reaches coverage 2.0/8.0 =
0.25, which clears `MIN_CONFIDENCE_TO_TRADE` (0.18). Funding alone reaches 1.0/7.0 =
0.14 and cannot. So enabling this feature creates a genuinely new capability: **a
trade authorised by two indirect signals with no price-based evidence.**

Guard A does not catch it, because `funding` is a core specialist and the guard only
requires that at least one core specialist ran. Pinned by
`test_funding_plus_prediction_clears_the_trade_floor_and_that_is_recorded` so a
weight change that moves it is visible.

This is the strongest argument for leaving `POLYMARKET_ENABLED` off until the Phase 38
validation study has measured whether the prediction leg is worth anything. If it is
not, the fix is to require `market` specifically rather than any core specialist —
deliberately not done now, because that would change core panel behaviour to
accommodate a supplementary feed.

## Still open

Phase 36 (trigger kind + the poller that writes snapshots), Phase 37 (API + panel),
Phase 38 (validation), 32b (websocket). Until Phase 36's poller exists, no snapshot is
ever written, so `specialist_prediction` reports `not_applicable` for every symbol and
`specialist_event_risk` reports unavailable — which is correct and costs nothing.

§8's probe is still the gate on Phase 36 doing anything useful, and its primary
question is unchanged: does a crypto price event arrive as a `mutuallyExclusive`
partition of bounded buckets?

---

# BUILD LOG — Phase 36 (trigger kind + poller)

## What changed

| File | Change |
|---|---|
| `backend/graphs/state.py` | `TriggerKind` += `"prediction_market_shift"` |
| `backend/graphs/triggers.py` | `prediction_shift_abs`/`prediction_shift_zscore` thresholds, 900s cooldown, `SymbolBaseline.prediction_probabilities`, `evaluate_prediction_market()`, `implemented_kinds()` now flag-aware |
| `backend/workers/polymarket_worker.py` | **new** — the only component that fetches from Polymarket |
| `backend/services/polymarket_store.py` | persists `eventRiskKey` |
| `backend/services/polymarket_registry.py` | passes `event_risk_key` through discovery |
| `backend/main.py` | starts the poller only when enabled; closes the HTTP session on shutdown regardless |
| `tests/test_polymarket_worker.py` | 32 tests |

## Two thresholds, both required to fire

Either alone misfires, so both must be satisfied:

- **`prediction_shift_abs = 0.05`** — 5 probability points. Above `polymarket.md`'s
  "balanced" 3% band, because a supplementary source should not provoke expensive
  reasoning runs at price-move sensitivity.
- **`prediction_shift_zscore = 2.5`** — against the market's own step size. The
  absolute band alone fires constantly on a market that habitually moves 5 points,
  which §11's threshold table does not account for; the z-score alone fires on a
  0.4-point move in an unusually quiet market, which is notable and meaningless.

`zscore is None` (too little history for a baseline) **suppresses** rather than
falling back to the absolute band — otherwise the first hours of every
newly-discovered market would produce triggers. The baseline does not advance on a
suppression, so the move can still fire once history exists.

Cooldown 900s, matching `funding_change`: prediction markets reprice on discrete
news, so observing the same repricing twice is the same information.

## Baselines are per-outcome

`SymbolBaseline.prediction_probabilities` is a dict, not a scalar. Each price bucket
of a range event is one outcome; collapsing them would mean a move in one bucket
reset the reference for all of them, so the next genuine move elsewhere would measure
against the wrong baseline and under-report.

## The poller

One `fetch_events` call per symbol per cycle supplies everything: the probabilities
to record, the buckets for `expected_price`, and the event-risk markets. 5-minute
cadence matching `SERIES_RESOLUTION_SECONDS`, against a 30-minute snapshot staleness
limit — so five cycles can be missed before the panel goes dark.

Three decisions worth naming:

- **Every bucket of the partition is recorded, not only the confirmed one.** The
  z-score baseline needs each bucket's own history and `expected_price` reads the
  whole partition; recording a subset would leave the others without a baseline and
  their triggers permanently suppressed.
- **A failure writes NO snapshot.** Writing a failure record would refresh
  `computedAt` and make stale data look current. Letting the existing snapshot expire
  is the correct outcome.
- **A computable drift with unmeasurable trustworthiness is withheld.** If
  `confidence_from_liquidity` returns `None`, the signal is reported uncomputable
  rather than shipped at an assumed confidence — the specialist requires a real
  number and would otherwise be handed a default that looks measured.

## Verification (all run)

```
pytest tests/ -q                          1213 passed, 2 skipped   (47s)
POLYMARKET_ENABLED=true pytest tests/ -q  1213 passed, 2 skipped   (49s)
npx tsc --noEmit                          clean
npm run test                              281 passed (16 files)
```

## The bug this phase produced — and it is the most interesting one so far

`test_the_worker_publishes_on_the_REAL_bus` passed in isolation and **hung the whole
suite**, taking it from 110 seconds to a 500-second timeout.

Cause: publishing `TRIGGER_FIRED` with `acted=True` onto the **global** bus reached
`analysis.subscribe_to_triggers`'s handler, registered by an earlier test in the same
session. That started a full analysis graph run, which retried market-data fetches
against the blocked network with exponential backoff.

Three things make it worth recording:

1. **The production behaviour is correct.** A fired trigger is *supposed* to start a
   reasoning run — that is the entire point of the trigger layer. The 900s cooldown is
   what bounds how often. Nothing needed fixing in the worker.
2. **It is precisely the hazard `tests/conftest.py` was written about**, arriving
   through the bus instead of through a direct call. The network guard turns an
   accidental fetch into a named failure; it cannot turn an accidental *fan-out* into
   one, because the fetch happens inside a subscriber that catches its own exceptions.
3. **The test that found it was the one written specifically to avoid a doubles-based
   blind spot.** Using the real bus was the right call — a double would still pass
   today and would still hide the two-argument `publish` signature bug it exists to
   catch. The fix keeps the real `MessageBus` class and drops only the global
   *instance*: `isolated_bus` builds a fresh one, so the signature stays under test
   while the subscriber set is isolated.

## Still open

Phase 37 (API + `backendConfig.ts` + panel), Phase 38 (validation study), 32b
(websocket feed).

The §8 probe remains the gate on any of this producing a real number. Until it runs
and confirms that a crypto price event arrives as a `mutuallyExclusive` partition of
bounded buckets, the poller will fetch, find no usable partition, and write
`directional: None` — correct, honest, and not useful.

---

# BUILD LOG — Phase 37 (API + panel)

## What changed

| File | Change |
|---|---|
| `backend/api/polymarket.py` | **new** — 7 endpoints, 5 read + 2 auth-gated writes |
| `backend/main.py` | router mounted at `/api/polymarket` (57 endpoints total) |
| `lib/backendConfig.ts` | 6 Polymarket paths declared |
| `components/PolymarketPanel.tsx` | **new** — the first component that consumes `BACKEND_PATHS` |
| `components/TradingSidebar.tsx` | panel mounted under Market Intelligence |
| `tests/test_stack_integration.py` | prefix added, endpoint floor 45 → 55 |
| `tests/test_learning_pipeline.py` | one assertion widened (see below) |
| `tests/test_polymarket_api.py` | **new** — 30 tests |

## The finding that shaped this phase

**`lib/backendConfig.ts`'s `BACKEND_PATHS` was imported by nothing.**

`tests/test_stack_integration.py` records the audit finding that layer 4 (LangGraph)
had no API surface, so nothing the seven graphs computed could reach the dashboard.
That was fixed by building `/api/graphs` and declaring its paths in `backendConfig`,
with a test asserting the declared paths match what FastAPI serves.

But no component ever imported them. Only `agentEventsWsUrl` is consumed, by
`lib/agentEventStream.ts`. So the fix stopped one hop short of the UI it existed to
reach: reachable in principle, read by nobody.

Declaring five more paths with no consumer would have repeated exactly that. So
`PolymarketPanel.tsx` fetches through `backendUrl(BACKEND_PATHS.polymarket)`, is
mounted in `TradingSidebar`, and two tests assert both —
`test_a_component_actually_fetches_the_declared_paths` and
`test_the_panel_is_actually_rendered`. The graph paths are still unconsumed; that is
a separate, now-documented gap.

## The panel renders the negative answer in full

Three independent things must hold before one number reaches the reasoning panel —
`POLYMARKET_ENABLED`, a usable ccxt adapter, and a human-confirmed mapping — and for
now at least one will be missing. The panel shows them as a checklist because the
operator's next action differs for each.

Per symbol it distinguishes four states that a single "no data" would erase:

| State | What it costs the panel |
|---|---|
| no snapshot ever written | poller has not run |
| `applicable: false` | **nothing** — weight leaves the coverage denominator |
| stale | not read by the specialists; poller has stopped |
| `directional: null` | **does** count against coverage — a real gap |

## Two real bugs found by the tests

**1. `Query(...)` as a default value.** `symbol: Optional[str] = Query(None)` makes
the *default* a `Query` object, so the parameter only holds a real value when
FastAPI's dependency injection fills it in. Called directly — by a test or any other
Python caller — `symbol` was a `Query` instance, which is not `None`, so `/mappings`
silently filtered to zero rows. `/series` had it too and failed louder:
`points[-limit:]` raised `TypeError: bad operand type for unary -: 'Query'`.

Fixed by moving to `Annotated[Optional[str], Query()] = None`, which keeps the alias
and validation while leaving the default a genuine value. The silent-zero-rows
variant is the worse of the two, and only the noisy one would have been noticed in
manual use.

**2. My own AST test was too narrow, and so was a pre-existing one.** I asserted
`backend/api/polymarket.py` is the ONLY file passing `set_by_human=True`. It failed:
`backend/api/research.py` passes it too, for `research_store`'s hypothesis gate —
the same pattern for a different store, and entirely correct.

Then the mirror image happened: the pre-existing
`test_learning_pipeline.py::test_only_the_api_route_passes_set_by_human` asserted the
set was exactly `["backend/api/research.py"]` and failed on my addition.

Both had pinned the *filename* rather than the *rule*, which made each test a record
of which gate existed rather than of what the gate enforces — so a correct addition
read as a violation from both directions. Both now assert the layer: an `api/` module
may pass it, and a service, worker, graph node or algorithm may not, because that
would be automated code confirming its own guess.

## Verification (all run)

```
pytest tests/ -q                          1239 passed, 2 skipped
POLYMARKET_ENABLED=true pytest tests/ -q  1239 passed, 2 skipped
npx tsc --noEmit                          clean
npm run test                              281 passed (16 files)
npm run build                             Compiled successfully, 10/10 static pages
```

## Still open

Phase 38 (validation study), 32b (websocket feed).

And the §8 probe, unchanged in importance: everything above is now wired end to end
and will honestly report "not contributing" until a live call confirms that a crypto
price event arrives as a `mutuallyExclusive` partition of bounded buckets. The panel
is the fastest way to see which of the three gates is the one blocking.

---

# BUILD LOG — Phase 38 (validation study), and the §6.4 fix it required

## Part 1 — `OPERATOR_GUIDE.md` §6.4, fixed in three steps

The plan said to fix this before the study because it would "bite whoever runs it".
It turned out to be three nested bugs.

**1. The documented one.** `HistoricalBacktestEngine.__init__` called
`self.bus._subscribers.clear()` on the **global** bus, unsubscribing the trigger
worker, the CRO, the execution agent and the position monitor. A validation run
silently disabled trading. Fixed: the engine builds its own `MessageBus`.

**2. The one the obvious fix would have created — worse than the original.**
`BaseAgent.__init__` captures the bus, so `publish()` goes to whichever bus an agent
was *constructed* with. Giving the engine a private bus and merely *subscribing* the
agents there would have had them consume simulated ticks and publish the resulting
orders onto the **live** bus. Before, the clear at least meant nothing live was
listening. Fixed with `BaseAgent.rebind_bus()` plus `restore_agent_buses()` in a
`finally`.

**3. The one the fix itself introduced.** `rebind_bus` subscribes on the bus it moves
to, so restoring re-subscribed the agent on the global bus — `DEBATE_CONCLUDED` went
from one handler to two. The supervisor would evaluate every signal twice and could
submit **two trade requests for one decision**. Nothing raised. Fixed by making
`MessageBus.subscribe` idempotent, which is where the hazard belongs: this codebase
already guarded against double-subscription by hand in `analysis`,
`execution_service` and `trigger_worker`, so every new subscriber had to remember.

**Still open, and honestly scoped:** two of the three agents are process singletons,
so *while a simulation runs* the live market-intelligence agent and supervisor point
at the simulation bus. Fixing that means giving the engine its own agent instances —
larger than this change. So the rule "do not call the engine inline" survives with a
narrower justification, and `OPERATOR_GUIDE.md` §6.4 now says so.

A pre-existing test asserted the bug as expected state — and had written its own
escape hatch: *"the hazard this guard documents has gone — re-check whether
research_graph can now call the engine directly."* It is now two tests: one asserting
the clearing is gone, one asserting the inline ban survives for the narrower reason.

## Part 2 — the study: `backend/tools/polymarket_validation.py`

Measures one thing: **does a prediction-market move precede a same-direction crypto
move more often than chance?** Hit rate, an exact two-sided binomial p-value, and mean
forward return, over an 18-cell ablation grid (3 windows x 3 horizons x 2 thresholds).

### What it refuses to measure, and why

| §7 asks for | Decision |
|---|---|
| **Sharpe / equity curve / drawdown** | **Refused.** Those describe a STRATEGY. The prediction specialist contributes 1.0 of 8.0 panel weight to a decision that also passes the Supervisor, the Risk Gateway and a stop-loss requirement. A simulated "buy when ΔP > 3%" Sharpe would measure something this system never does — and would be quoted as if it described the agent. |
| **AUC** | **Refused.** Computable, but at these sample sizes it is a precise number over very few observations. Hit rate with an explicit `n` and p-value makes the sample size impossible to overlook. |
| **Walk-forward split** | **Deferred.** Splitting a tiny sample produces the appearance of rigour and none of the substance. `MIN_OBSERVATIONS` gates it. |
| **5-dimension ablation matrix** | **Narrowed to 18 cells,** and the Bonferroni-adjusted threshold (0.0028) travels with every report. Twenty cells over one dataset is a multiple-comparisons machine — one will look significant by construction. |

### Two lookahead-bias guards, because they inflate every metric silently

- `_price_at` returns the last candle **at or before** the timestamp, never the
  nearest — a nearest-match can return a candle from *after* it.
- `evaluate_cell` computes each signal from `series[: i + 1]`, never the whole series,
  so a later observation cannot set the ΔP for an earlier timestamp.

Both are asserted by tests, because neither shows up in the output.

### It reports "insufficient data", and will for a while

The study needs stored probability history → the poller → `POLYMARKET_ENABLED` + a
confirmed mapping + network access. None hold here. So it returns no metrics and says
why, rather than computing a hit rate over three observations and presenting 0.67 as a
finding. Unmeasurable observations are **skipped**, not scored as misses — a missing
price is not a failed prediction, and counting it as one would bias the hit rate by
data coverage rather than predictive power.

### It cannot deploy itself

Output is a `research_store` hypothesis with status `proposed`, and that is the only
write the module performs. Asserted by AST: it never names `DIRECTIONAL_WEIGHTS`,
`SUPPLEMENTARY_WEIGHTS`, `TOTAL_DIRECTIONAL_WEIGHT`, `MIN_CONFIDENCE_TO_TRADE` or
`MAX_EVENT_RISK_CONCERN`, never imports the specialists module, and calls only
`add_hypothesis`. `update_hypothesis_status` refuses `validated`/`applied` without
`set_by_human=True`, which only an HTTP route passes. So

    study -> weight change -> live trading

has no automated segment. CLAUDE.md invariant 5.

The validation plan it writes requires the **previously-best cell** to hold on
out-of-sample data — not whichever cell is best next time, which would re-select the
extreme every round.

## Verification (all run)

```
pytest tests/ -q                          1264 passed, 2 skipped
POLYMARKET_ENABLED=true pytest tests/ -q  1264 passed, 2 skipped
npx tsc --noEmit                          clean
npm run test                              281 passed (16 files)
```

## Still open

**32b — the websocket feed.** ccxt implements `watch_order_book` / `watch_ticker` for
Polymarket including the venue's 10-second text-PING keepalive, so this needs no new
dependency. It is a latency improvement over the 5-minute poller, not a capability
gain, which is why it stayed last.

**§8's probe.** Unchanged in importance and now the only thing between this
integration and a real number. Phases 32-38 are wired end to end and will honestly
report "not contributing" until a live call confirms that a crypto price event arrives
as a `mutuallyExclusive` partition of bounded buckets. If it arrives as single binary
thresholds instead, Phase 35 needs an operator-declared above/below sense per
confirmed mapping — that fork is documented and unresolved.

---

# BUILD LOG — Phase 32b (stream) + final verification

## Phase 32b — the streaming feed

`PolymarketStreamFeed` in `backend/workers/polymarket_worker.py`. One task per
confirmed outcome, looping ccxt's `watch_ticker`.

### What it buys, and three things it does not

| Claim | Reality |
|---|---|
| Trigger **latency** | **Real.** The poller notices a reprice up to 5 minutes late; the stream notices in seconds. Against a 900s cooldown that means reasoning starts 0-300s sooner — modest, and the only genuine gain. |
| Replaces the poller | **No.** `expected_price` needs every bucket of a mutually-exclusive event at once; `watch_ticker` is per-outcome. Snapshots still come from REST. |
| Improves the signal | **No.** Persisting every tick would burn `MAX_POINTS_PER_OUTCOME` (a week at 5-min resolution) in hours, shrinking the volatility baseline from a week to hours — worse, not better. Persistence is throttled to the store's resolution; only trigger *evaluation* is per-update. |
| Needs `websockets` | **No.** ccxt implements the CLOB market channel including the venue's text-PING-every-10s keepalive. The plan's first draft claimed otherwise and was wrong. |

The ticker is a quote **midpoint** (`mid = (bid+ask)/2`), not a trade, so it can move
on a one-sided quote change. The spread is recorded alongside and
`confidence_from_liquidity` discounts a wide one.

The symbol is re-read from the store per update rather than cached at subscribe time:
an operator can withdraw a confirmation while the stream runs, and a cached symbol
would keep firing triggers for a market whose attribution had been revoked.

## Two bugs the independent verification found that the tests did not

I wrote a standalone end-to-end verifier (54 checks) rather than trusting a green
suite. It found two things 1287 passing tests had missed.

**1. `rebind_bus` never unsubscribed from the old bus.**

The Phase 38 fix moved simulation agents onto a private bus but left them subscribed
to the global one. So during a backtest a live `TICK_RECEIVED` still reached the
market-intelligence agent, which then published its result to the **simulation** bus:
live analysis silently stopped working for the duration and the simulation was
polluted with live data. The same cross-contamination §6.4 was about, arriving from
the opposite direction.

The unit tests checked that the live bus's *subscribers survived*. They never checked
what the *rebound agent was still listening to*. Fixed by adding
`MessageBus.unsubscribe` and calling it from `rebind_bus`.

**2. `get_supervisor()` and `get_market_intelligence_agent()` were not memoised.**

Each call did `return SupervisorAgent()`, and `BaseAgent.__init__` subscribes on
construction with nothing ever unsubscribing. So every call added a **permanent
duplicate handler** to the global bus, and the agent then processed each matching
event once per call ever made.

Latent in production — `main.py` calls each exactly once. It became live the moment
`HistoricalBacktestEngine` also called one: running a backtest in-process left a
second supervisor handling every live `DEBATE_CONCLUDED` for the rest of the
process's life, meaning **two trade-authorization requests per debate**. Verified:
three engine constructions took the handler count 1 → 1 → 1 after the fix, and
1 → 2 → 3 before it.

Every other accessor of this shape already memoised — `cio_agent`,
`hypothesis_agent`, `get_exchange_client`, `get_polymarket_client`. These two were the
exceptions. Both now memoise, with a `reset_*` for tests.

## A note on one recurring mistake

Four times in this session a test grepped source text for a forbidden literal and
matched **the comment documenting the rule**. The last instance was
`test_watch_ticker_does_not_go_through_the_retry_path`, which matched the method's own
docstring beginning "NOT ROUTED THROUGH `_call`" — written despite two other tests in
the same file carrying a comment warning about exactly this. Every such check is now
AST-based. A text search cannot distinguish prose about a rule from a breach of it,
and the failure mode is that authors stop documenting the rule.

## FINAL VERIFICATION — all run

```
pytest tests/ -q                          1288 passed, 2 skipped
POLYMARKET_ENABLED=true pytest tests/ -q  1288 passed, 2 skipped
independent e2e verifier                  54/54 checks passed
npx tsc --noEmit -p tsconfig.json         clean
npm run test                              281 passed (16 files)
npm run build                             Compiled successfully
```

The verifier checks the behaviour rather than the tests: flag-off confidence is
0.428571 (3.0/7.0) and identical with a `not_applicable` prediction; a failed read
drops coverage to 0.375; an agreeing prediction raises confidence; an opposing one
lowers it without flipping direction; Guard A gives no direction from a supplementary
source alone; both graph shapes compile with `trade_thesis_narrative` still the only
LLM node; the order guard refuses; 57 endpoints served with every declared frontend
path among them; and the full chain — mapping → human confirm → snapshot → specialist
→ debate — produces an expected price of exactly 115,000 against a 110,000 spot,
LONG, at coverage 0.5.

## Status: Phases 32-38 and 32b complete

Nothing is enabled. `POLYMARKET_ENABLED` defaults false.

**The one thing still outstanding is not code.** §8's probe has never run, because this
environment has no route to Polymarket. Until it does, the integration will fetch,
find no usable partition, and report "not contributing" — correctly. If crypto price
markets turn out to arrive as single binary thresholds rather than a
`mutuallyExclusive` partition of bounded buckets, Phase 35 needs an operator-declared
above/below sense per confirmed mapping. That fork is documented in §8 and unresolved.

---

# ENABLED AND RUNNING — what actually happened

Gates set in `.env` (backup kept at `.env.backup-before-enable`):

```
POLYMARKET_ENABLED=true
GRAPH_EXECUTION_ENABLED=true
POSITION_MONITORING_ENABLED=true
LIVE_TRADING=false          <-- unchanged, NOT enabled
```

`LIVE_TRADING` is the flag that routes real orders with real funds. It was left
`false` deliberately and needs an explicit decision, so every fill below is simulated.

## Live, confirmed by querying the running server

```
uvicorn backend.main:app --host 127.0.0.1 --port 8000   -> Application startup complete
GET /api/monitoring        -> 200   overall: healthy, scheduler_running: true
57 endpoints served
7/7 graphs load            Graph 2 = 22 nodes (was 20)
27 registered nodes        26 deterministic, 1 LLM (trade_thesis_narrative)
9 specialists              including specialist_prediction and specialist_event_risk
Polymarket poller RAN      fresh snapshots for BTC/USDT and ETH/USDT, age 120s,
                           applicable=false with the honest "no CONFIRMED mapping" reason
```

The agent cannot trade from this environment: there is no route to Binance, so
`/api/market/prices` returns an empty cache and no trigger ever fires. That is the
documented network limitation, not a fault in the wiring.

Driving Graph 2 directly with injected candles and a confirmed mapping shows the full
reasoning path:

```
panel 6/9 available
  market      directional    supports_long  0.2577
  prediction  supplementary  supports_long  0.5500
  funding     directional    neutral        0.0
  event_risk  constraint     concern 0.18   <- binding
  orderflow / news / liquidity  blocked, with their real blockers

DEBATE   LONG  confidence 0.13561  coverage 0.625
DECISION WAIT  "the panel agrees with the LONG setup but only at 0.14, below the
                0.18 minimum. Cause: coverage is 0.62"
RISK     not approved — "nothing to validate: the Supervisor decided WAIT"
PLAN     none
```

The arithmetic is exactly as designed: `(3.0x0.2577 + 1.0x0.55) / 5.0 = 0.2646`,
`x 0.625 coverage = 0.16538`, `x (1 - 0.18) = 0.13561`. Coverage 0.625 is 5.0/8.0.

## Enabling it surfaced two real bugs that 1288 tests had not

**1. Every declined decision was silently dropped from the audit trail.**

`SupervisorAgent._refuse` wrote `outcome="declined"`. `db/schema.sql` constrains
`decisions.outcome` to six values and "declined" is not one, so every refusal violated
the check constraint. `_persist_decision` caught the error, logged it, and carried on —
so the system looked healthy while the decision log filled with only the trades that
HAPPENED. Most decisions are refusals, and the method's own docstring says exactly why
that must not happen:

> "A decision log that only contains the trades that happened cannot answer 'why
> didn't it act on that setup?', which is the question an operator asks most often."

The server log showed a steady stream of `violates check constraint
"decisions_outcome_check"` behind ordinary-looking "Supervisor declined to submit a
TAR" lines. Fixed to `"rejected"`. `tests/test_decision_audit.py` now parses the CHECK
constraints out of `db/schema.sql` and asserts every outcome literal the code writes is
one the schema accepts — a class of bug no mock can catch, because the mock always
accepts.

**2. The supervisor crashed on a supplementary finding — a bug Phase 35 introduced.**

`_why_from_specialists` branched `if role == "directional" / else constraint`. Phase 35
added a THIRD role, so a supplementary finding fell into the constraint branch and was
formatted as `(constraint, {concern:.2f})` — and a supplementary finding carries
`stance`, never `concern`, so `concern` was None:

```
unsupported format string passed to NoneType.__format__
```

The whole supervisor node failed and produced NO decision, where it should have
returned an explainable WAIT. `builder.py` degrades a failed node rather than aborting
the run, so the only symptom was one log line and a missing decision.

Two bugs in one line: the crash, and — had it not crashed — labelling the prediction
leg a "constraint", which inverts the role distinction the supplementary tier exists to
draw. All three roles are now matched explicitly, with no `else` fallback across them.

Every Phase 35 test drove `run_debate` directly. **None ran the supervisor with a
supplementary finding in state.** Four new tests do.

## And one test-isolation defect the enabling exposed

Putting `POLYMARKET_ENABLED` in `.env` broke every flag-off test. `monkeypatch.delenv`
removes the var, but `services/exchange_client` calls `load_dotenv()` at import time —
and `load_dotenv` will not override a present var but DOES set an absent one, so the
first lazy import silently restored `true` from `.env`. All flag-off fixtures now set
an explicit `"false"`, which survives it.

## Final verification — all run

```
pytest tests/ -q          (with the enabled .env)     1298 passed, 2 skipped
pytest tests/ -q          (with the original .env)    1298 passed, 2 skipped
independent e2e verifier                              54/54 checks
live server                                           healthy, 57 endpoints, 9 specialists
npx tsc --noEmit                                      clean
npm run test                                          281 passed
npm run build                                          Compiled successfully
```

## Still requires a decision from the operator

- **`LIVE_TRADING=true`** — not set. Real money.
- **§8's Polymarket probe** — still never run; the feed will keep reporting "not
  contributing" until a live call confirms the market shape.
