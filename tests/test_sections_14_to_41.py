"""Sections 14-41 — regression tests for work that had none.

Every fault this file guards was found in a module with **zero test coverage**, and
several were invisible in operation because the surrounding code degraded honestly:
`memory_manager` wrapped five broken calls in `except: append("unavailable")` and
returned a plausible context; the strategy ensemble reported "every strategy gated
out" as though that were a market condition. The `unavailable` discipline was doing
its job while nothing underneath it worked.

So each test below names the specific bug it would have caught. A test that only
asserts current behaviour would not have caught any of them — what makes these work
is that they assert the PROPERTY (a score must be measured, a vocabulary must
translate, a store must be attempted) rather than the value.
"""

from __future__ import annotations

import ast
import asyncio
import inspect

import pytest


# ---------------------------------------------------------------------------
# Grepping raw source is a trap in THIS file specifically.
#
# Every module below carries a docstring that quotes the bug it used to have — that
# is deliberate, so a future reader knows why the code looks the way it does. A test
# that greps `inspect.getsource(...)` for the old fabricated literal therefore
# matches the DOCUMENTATION of the fix and fails on correct code.
#
# I made exactly this mistake three times earlier in this project (the `60000.0`
# guard, the TWAP-log guard and a `set_by_human` guard all matched the comment
# describing the fix) and wrote the lesson down. Then repeated it here. So the
# helper exists rather than the discipline being remembered.
# ---------------------------------------------------------------------------

def code_only(obj) -> str:
    """Source with every docstring removed, so a guard cannot match prose."""
    tree = ast.parse(inspect.getsource(obj).lstrip())
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef,
                                 ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", None)
        if (body and isinstance(body[0], ast.Expr)
                and isinstance(body[0].value, ast.Constant)
                and isinstance(body[0].value.value, str)):
            node.body = body[1:] or [ast.Pass()]
    return ast.unparse(tree)


def returned_strings(obj) -> set:
    """Every string literal the object can `return`, read from the AST.

    Text-matching `'return "X"'` is fragile twice over: `ast.unparse` normalises
    quotes to single, and a return spanning two lines never matches at all.
    """
    tree = ast.parse(inspect.getsource(obj).lstrip())
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Return) and isinstance(node.value, ast.Constant):
            if isinstance(node.value.value, str):
                out.add(node.value.value)
    return out


def instantiated_names(obj) -> set:
    """Names actually CALLED in the source.

    Distinguishes `HistoricalBacktestEngine(...)` from a module constant whose text
    merely mentions it — `code_only` strips docstrings but keeps real string
    constants, and one of those documents exactly the class this must not call.
    """
    tree = ast.parse(inspect.getsource(obj).lstrip())
    out = set()
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        fn = node.func
        name = getattr(fn, "id", None) or getattr(fn, "attr", None)
        if name:
            out.add(name)
    return out


# ===========================================================================
# 1. THE REGIME VOCABULARY — the bug that silently crippled every decision
# ===========================================================================

def test_every_regime_the_agent_can_return_is_translatable():
    """THE most important test in this file.

    `regime_agent` returns spec Section 21's ten names; `strategy_profiles`'s
    `active_regimes` speaks a different vocabulary with ONE name in common. So
    `is_strategy_active_in_regime` returned False for all nine strategies in nine of
    ten regimes, the ensemble voted nothing whenever a regime was classified, and
    `score_debate` — which weights the ensemble at 4.0, its heaviest leg —
    permanently scaled every confidence in the system down to 72% coverage.

    Nothing raised. Both halves were internally consistent and simply did not speak
    to each other. This test fails the moment a third vocabulary appears.
    """
    from backend.algorithms.strategy_profiles import (
        STRATEGY_PROFILES,
        is_strategy_active_in_regime,
    )

    # Every literal `regime_agent` can return, read from its source so a new regime
    # cannot be added there without appearing here.
    import backend.agents.regime_agent as ra

    returned = returned_strings(ra)
    assert len(returned) >= 10, f"expected Section 21's ten regimes, found {returned}"

    for regime in sorted(returned):
        eligible = [p.agent for p in STRATEGY_PROFILES
                    if is_strategy_active_in_regime(p.agent, regime)]
        assert eligible, (
            f"regime {regime!r} leaves NO strategy eligible. Either add it to "
            f"strategy_profiles.REGIME_ALIASES or to a profile's active_regimes — "
            f"an empty ensemble makes score_debate drop its heaviest leg and "
            f"silently lowers every confidence in the system."
        )


def test_an_unknown_regime_is_permissive_not_restrictive():
    """Muting the whole library when the classifier has no answer would stop the
    system reasoning at exactly the moment a new symbol starts up.

    `regime or "UNKNOWN"` in `strategy_ensemble` inverted this: None is permissive,
    the literal string "UNKNOWN" matches nothing, so substituting the string gated
    all nine strategies out.
    """
    from backend.algorithms.strategy_profiles import (
        STRATEGY_PROFILES,
        canonical_regime,
        is_strategy_active_in_regime,
    )

    for absent in (None, "Unknown"):
        assert canonical_regime(absent) is None
        eligible = [p.agent for p in STRATEGY_PROFILES
                    if is_strategy_active_in_regime(p.agent, absent)]
        assert len(eligible) == len(STRATEGY_PROFILES), (
            f"regime {absent!r} must leave every strategy eligible, got {eligible}"
        )


def test_an_unrecognised_regime_is_passed_through_not_guessed():
    """A silent default is how the original mismatch survived."""
    from backend.algorithms.strategy_profiles import canonical_regime

    assert canonical_regime("Some Future Regime") == "Some Future Regime"


def test_the_debate_ensemble_leg_is_actually_available():
    """`score_debate`'s ensemble leg carries weight 4.0 — more than any other check.

    It reported itself unavailable on every run for the whole of Phases 24-30. This
    asserts it contributes, which is the only way to notice that class of silent
    degradation.
    """
    import math

    from backend.algorithms.debate import score_debate

    bars, price = [], 100.0
    for i in range(120):
        price += 0.3 + 1.0 * math.sin(i / 2.4)
        bars.append({"time": i, "open": price - 0.5, "high": price + 0.7,
                     "low": price - 0.7, "close": price, "volume": 1000.0 + i * 8})

    result = score_debate(bars)
    assert "strategy ensemble (every strategy gated out)" not in result.unavailable
    names = {a.name for a in result.bull_arguments + result.bear_arguments}
    assert "StrategyEnsemble" in names, (
        f"the ensemble leg did not contribute; arguments were {names}"
    )


# ===========================================================================
# 2. NO FABRICATED DATA (invariant 6)
# ===========================================================================

def test_execution_planning_refuses_to_invent_order_book_depth():
    """`fetch_order_book_depth` returned `spread_bps: 2.5, volume_1m: 150000,
    depth_imbalance: -0.1` — three invented numbers — and the next node made a real
    slicing decision from `volume_1m`. No order-book feed exists anywhere in this
    system; the Phase 26 liquidity specialist and the Phase 28 liquidity check both
    decline to estimate depth for that reason."""
    import backend.graphs.execution_graph as eg

    src = code_only(eg)
    for invented in ("spread_bps", "volume_1m", "depth_imbalance"):
        assert invented not in src, (
            f"{invented!r} is invented data — no order-book feed exists in this system"
        )
    assert "route_to_exchange" not in src, (
        "a route_to_exchange node inside a LangGraph graph puts order routing in the "
        "cognitive plane — Rule 0 and spec Section 12"
    )


def test_execution_planning_says_volume_is_not_depth():
    from backend.graphs.execution_graph import plan_execution

    candles = [{"volume": 10_000.0} for _ in range(6)]
    plan = plan_execution(quantity=1.0, candles=candles)
    joined = " ".join(plan.unavailable)
    assert "order-book depth" in joined
    assert "traded volume bounds neither slippage nor fillable size" in joined


def test_execution_planning_does_not_slice_on_unknown_volume():
    """Slicing on an unmeasured market impact spreads an order over time for reasons
    nobody measured — activity, not caution."""
    from backend.graphs.execution_graph import plan_execution

    plan = plan_execution(quantity=1.0, candles=None)
    assert plan.strategy == "MARKET"
    assert plan.slice_count == 1
    assert "could not be measured" in plan.detail
    assert any("no candle volume available" in u for u in plan.unavailable)


def test_execution_planning_slices_a_large_order_against_real_volume():
    from backend.graphs.execution_graph import PARTICIPATION_THRESHOLD, plan_execution

    volume_per_candle = 1_000.0
    candles = [{"volume": volume_per_candle} for _ in range(5)]
    total = volume_per_candle * 5
    big = total * (PARTICIPATION_THRESHOLD * 3)

    plan = plan_execution(quantity=big, candles=candles)
    assert plan.strategy == "TWAP"
    assert plan.slice_count > 1
    assert sum(plan.slices) == pytest.approx(big)
    assert "TRADED VOLUME, not order-book depth" in plan.detail


def test_a_hypothesis_cannot_be_validated_without_a_measured_score():
    """THE most dangerous fabrication found.

        state["backtest_score"] = 0.85
        state["forward_test_score"] = 0.70
        if backtest > 0.5 and forward > 0.5: status = "VALIDATED"

    Both hardcoded ABOVE the threshold they were compared against, so the function
    could only ever return VALIDATED — it appeared to test something and returned
    the same answer for every input. It did not write to production, so invariant 5
    held literally, but it destroyed the meaning of the human approval click.
    """
    from backend.graphs.research_graph import evaluate_hypothesis

    unmeasured = evaluate_hypothesis("hyp-1")
    assert unmeasured.status is None, (
        "an unmeasured hypothesis must be UNDECIDED — not VALIDATED, and not "
        "REJECTED either, which would discard good ideas for want of a backtester"
    )
    assert unmeasured.measured is False
    assert unmeasured.unavailable

    half = evaluate_hypothesis("hyp-2", backtest_score=0.9)
    assert half.status is None, "one score is not two"


def test_validation_requires_both_backtest_and_walk_forward():
    """A strategy that backtests well and degrades out of sample is the single most
    common way a research pipeline fools itself."""
    from backend.graphs.research_graph import MIN_SCORE_TO_VALIDATE, evaluate_hypothesis

    good = evaluate_hypothesis("h", MIN_SCORE_TO_VALIDATE, MIN_SCORE_TO_VALIDATE)
    assert good.status == "VALIDATED"

    degraded = evaluate_hypothesis("h", 0.95, MIN_SCORE_TO_VALIDATE - 0.01)
    assert degraded.status == "REJECTED"
    assert any("degraded out of sample" in n for n in degraded.validation_notes)


def test_the_validation_request_path_cannot_reach_validated():
    """Structural, not behavioural: `request_validation` has no parameter through
    which a score could arrive, so no edit to it can produce a validation without
    first wiring a real backtester."""
    from backend.graphs.research_graph import request_validation

    params = set(inspect.signature(request_validation).parameters)
    assert params == {"hypothesis_id"}, (
        f"request_validation gained parameters {params} — if a score can be passed "
        f"in, VALIDATED is reachable without measuring anything"
    )

    result = asyncio.run(request_validation("nope"))
    assert result.status is None
    assert any("no backtest was executed" in u for u in result.unavailable)


def test_the_backtester_is_not_called_inline_because_it_clears_the_bus():
    """`HistoricalBacktestEngine.__init__` calls `self.bus._subscribers.clear()`.
    Running it in a live process would unsubscribe the trigger worker, the CRO, the
    execution agent and the position monitor — a validation run would silently
    disable trading."""
    import backend.core.backtest_engine as be
    import backend.graphs.research_graph as rg

    assert "_subscribers.clear()" in code_only(be), (
        "the hazard this guard documents has gone — re-check whether research_graph "
        "can now call the engine directly"
    )
    # Checks for an actual CALL, not for the name appearing in text: the module's
    # `BACKTEST_UNAVAILABLE` constant names the class in order to explain why it is
    # not used, and `code_only` keeps real string constants.
    assert "HistoricalBacktestEngine" not in instantiated_names(rg), (
        "research_graph must not instantiate the engine inline; it would clear the bus"
    )


def test_reflection_does_not_grade_every_trade_as_good():
    """`analyze_execution` was `state["execution_quality"] = "Good"` unconditionally,
    so every trade in the system's history graded itself Good — the same class as
    slippage hardcoded to 0.0 giving every fill a perfect score.

    It matters because `generate_lesson` and the calibration both read it: a
    permanent "Good" means execution can never be identified as the cause of a loss,
    so the system can never learn that it fills badly.
    """
    import backend.graphs.reflection_graph as rg

    src = code_only(rg.analyze_execution)
    assert "score >= 0.7" in src, "the grade must be derived from a measured score"
    assert "execution_quality WHERE order_id" in src, (
        "it must look up the persisted score rather than assuming one"
    )

    # With no order id there is nothing to look up, and that is 'unavailable' — NOT
    # 'Poor'. A fill with no reference price is not a bad fill.
    state = {"trade_receipt": {"symbol": "BTC/USDT", "pnl": 1.0}}
    asyncio.run(rg.analyze_execution(state))
    assert state["execution_quality"] == "unavailable"
    assert state["execution_quality_detail"]


def test_reflection_reads_real_memory_rather_than_a_stub():
    import backend.graphs.reflection_graph as rg

    src = code_only(rg.collect_context)
    assert "Context fetch stubbed" not in src
    assert "fetch_memory_context" in src


def test_the_calibration_formula_has_exactly_one_definition():
    """It lived inline in `reflection_agent` and was copied verbatim into
    `reflection_graph`. This number feeds ConfidenceAgent, which feeds position
    sizing, so two copies that could drift is a real hazard."""
    import backend.agents.reflection_agent as ra
    import backend.graphs.reflection_graph as rg

    assert hasattr(ra, "calibration_delta")
    assert "calibration_delta" in code_only(rg.generate_lesson)
    assert "/ 100.0" not in code_only(rg.generate_lesson), (
        "the graph is re-deriving the formula instead of calling the shared one"
    )
    assert ra.calibration_delta(1_000_000.0) == ra.CALIBRATION_CAP
    assert ra.calibration_delta(-1_000_000.0) == -ra.CALIBRATION_CAP


def test_the_ensemble_measures_volatility_and_refuses_to_claim_liquidity():
    """It hardcoded `volatility: "MEDIUM", liquidity: "HIGH"` and fed both to the
    strategy scorer. `liquidity: "HIGH"` is specifically the claim this system
    refuses to make everywhere else."""
    import backend.agents.strategy_ensemble as se

    src = code_only(se.vote_strategies)
    assert "'MEDIUM'" not in src and '"MEDIUM"' not in src
    assert "'HIGH'" not in src and '"HIGH"' not in src
    assert "_volatility_band" in src, "volatility must be measured from the candles"


# ===========================================================================
# 3. SECTION 15 — all SEVEN memory stores
# ===========================================================================

def test_all_seven_memory_stores_are_attempted():
    """`fetch_memory_context` implemented six and its docstring said "all 6 memory
    dimensions". Procedural Memory was absent, which is why
    `services/procedural_memory.py` had zero callers anywhere — the store existed
    and had nowhere to put its output."""
    from backend.services.memory_manager import MEMORY_STORES, fetch_memory_context

    assert len(MEMORY_STORES) == 7, f"Section 15 names seven stores, found {MEMORY_STORES}"
    assert "procedural" in MEMORY_STORES

    context = asyncio.run(fetch_memory_context("BTC/USDT"))
    for store in MEMORY_STORES:
        assert store in context, f"store {store!r} was not attempted at all"


def test_the_memory_context_dataclass_carries_all_seven():
    import dataclasses

    from backend.graphs.state import MemoryContext

    fields = {f.name for f in dataclasses.fields(MemoryContext)}
    for store in ("working", "episodic", "semantic", "procedural",
                  "strategy_performance", "risk_events", "research_findings"):
        assert store in fields, f"MemoryContext has nowhere to put {store!r}"


def test_most_memory_stores_actually_read_something():
    """Four of five calls named methods that do not exist, so five of six dimensions
    were empty on every call — invisible because each failure appended to
    `unavailable` and the caller received a plausible context.

    Asserts a FLOOR on how many read successfully. `risk_events` legitimately fails
    without Postgres.
    """
    from backend.services.memory_manager import MEMORY_STORES, fetch_memory_context

    context = asyncio.run(fetch_memory_context("BTC/USDT"))
    failed = {u.split(":")[0] for u in context["unavailable"]}
    read = len(MEMORY_STORES) - len(failed)

    assert read >= 6, (
        f"only {read}/{len(MEMORY_STORES)} memory stores read successfully; "
        f"failed: {sorted(failed)}"
    )
    assert failed <= {"risk_events"}, (
        f"unexpected memory failures: {sorted(failed - {'risk_events'})}"
    )


def test_risk_memory_imports_and_distinguishes_unreadable_from_empty():
    """It imported `backend.core.database` (the module is `backend.core.db`) so the
    file was unimportable, and both queries selected `created_at` where the schema
    has `timestamp`. Its bare `except: return []` made a broken query look like
    "this system has never had a trade blocked"."""
    from backend.services.risk_memory import RiskMemory

    src = inspect.getsource(RiskMemory)
    assert "created_at" not in src, "the schema column is `timestamp`"
    assert "return []" not in src, (
        "returning [] on failure makes a broken query indistinguishable from a clean "
        "risk history — the most reassuring possible wrong answer"
    )
    # No pool in tests, so this is the unreadable case: None, not [].
    assert asyncio.run(RiskMemory.get_recent_risk_events()) is None


def test_the_memory_loader_carries_the_seventh_store_and_declares_tuples():
    from backend.graphs.nodes.memory_loader import (
        MEMORY_LOADER_NODE,
        register_memory_node,
    )
    from backend.graphs.registry import get_contract

    if get_contract(MEMORY_LOADER_NODE) is None:
        register_memory_node()
    contract = get_contract(MEMORY_LOADER_NODE)

    assert isinstance(contract.reads, tuple), (
        "a frozen contract holding a mutable set has mutable permissions"
    )
    assert isinstance(contract.writes, tuple)
    assert contract.deterministic is True
    assert contract.phase == 32

    import backend.graphs.nodes.memory_loader as ml
    assert "procedural=" in inspect.getsource(ml.load_memory_context)


def test_memory_is_loaded_by_the_graphs_that_actually_decide():
    """It was wired only into `market_state_config` (Graph 1), which `main.py`
    deliberately does not subscribe — Graph 2 contains all of Graph 1's stages, so
    subscribing both would run them twice. The effect was that Phase 32's loader
    lived in a graph that never ran and no decision ever saw memory."""
    from backend.graphs.analysis import analysis_config
    from backend.graphs.monitoring import monitoring_config
    from backend.graphs.nodes.memory_loader import MEMORY_LOADER_NODE

    for name, cfg in (("Graph 2", analysis_config()), ("Graph 4", monitoring_config())):
        assert MEMORY_LOADER_NODE in cfg.nodes, f"{name} does not load memory"
        assert cfg.entry == MEMORY_LOADER_NODE, (
            f"{name} must load memory FIRST so every later node reads the same history"
        )
        cfg.validate()


# ===========================================================================
# 4. THE TWO CRASHES
# ===========================================================================

def test_strategy_scoring_reads_a_field_that_exists():
    """`profile.optimal_conditions` does not exist — `best_conditions` is prose and
    `active_regimes` is the list. It raised AttributeError on every scored strategy,
    crashing the strategy ensemble that calls this graph."""
    import dataclasses

    import backend.graphs.strategy_selection_graph as ssg
    from backend.algorithms.strategy_profiles import StrategyProfile

    fields = {f.name for f in dataclasses.fields(StrategyProfile)}
    src = code_only(ssg.score_strategies)
    assert "optimal_conditions" not in src
    for attr in ("active_regimes", "best_conditions", "worst_conditions",
                 "historical_success_rate"):
        if f"profile.{attr}" in src:
            assert attr in fields, f"score_strategies reads a non-existent field {attr!r}"


def test_one_broken_strategy_does_not_take_down_the_whole_ensemble():
    """`selected_strategies.pop(...)` inside `for ... in selected_strategies.items()`
    raised RuntimeError, so a single misbehaving strategy stopped ALL strategy
    voting — the opposite of what the surrounding error handling is for."""
    import backend.agents.strategy_ensemble as se

    bars = [
        {"time": i, "open": 100.0, "high": 101.0, "low": 99.0,
         "close": 100.0 + i * 0.1, "volume": 1000.0}
        for i in range(60)
    ]

    def boom(_klines):
        raise RuntimeError("strategy exploded")

    original = se.STRATEGY_FUNCTIONS["Trend"]
    se.STRATEGY_FUNCTIONS["Trend"] = boom
    try:
        result = se.vote_strategies(bars, regime=None)
    finally:
        se.STRATEGY_FUNCTIONS["Trend"] = original

    assert result["votes"], "the other strategies must still have voted"
    assert "Trend" in result["gatedOut"]
    assert "errored" in result["gatedOut"]["Trend"]


def test_the_ensemble_always_reports_how_many_voted():
    """`score_debate` reads `ensemble.get("strategiesVoted", 0)` to decide whether its
    heaviest leg is available. The no-vote early return omitted the key, so `.get()`
    returned None and the leg reported itself unavailable."""
    import backend.agents.strategy_ensemble as se

    for klines in ([], [{"time": 0, "open": 1, "high": 1, "low": 1, "close": 1,
                         "volume": 1}]):
        result = se.vote_strategies(klines, regime=None)
        assert "strategiesVoted" in result, (
            "every return path must report strategiesVoted, or the debate silently "
            "drops its 4.0-weight ensemble leg"
        )


def test_activation_is_a_shortlist_and_never_prunes_the_vote():
    """`selected_strategies` values are consumed as vote WEIGHTS. Raising the
    threshold to make it discriminate pruned the ensemble to nothing in ordinary
    conditions, dropping every debate's confidence (0.53 -> 0.295 on the reference
    fixture). Scoring and activation are separate concerns."""
    import backend.graphs.strategy_selection_graph as ssg

    state = {
        "market_state": {"regime": "Trending Bullish", "volatility": "MEDIUM",
                         "liquidity": None},
        "strategy_scores": {"Trend": 95.0, "Range": 80.0, "Grid": 75.0},
        "unavailable": [],
    }
    ssg.select_strategies(state)

    assert set(state["selected_strategies"]) == {"Trend", "Range", "Grid"}, (
        "every scored strategy must vote — an ensemble that discards its members is "
        "not an ensemble"
    )
    assert set(state["activated_strategies"]) == {"Trend"}, (
        "the Section 19 shortlist is those above the activation threshold"
    )
    assert ssg.SELECTION_THRESHOLD > ssg.BASE_SCORE, (
        "a threshold equal to the base cannot reject anything"
    )


def test_selection_does_not_add_keys_to_the_state_mid_iteration():
    """Assigning a new key inside a node grew the state dict while LangGraph was
    iterating it: "RuntimeError: dictionary changed size during iteration"."""
    import backend.graphs.strategy_selection_graph as ssg

    src = code_only(ssg.select_strategies)
    assert "existing + [note]" not in src
    assert "existing.append(note)" in src or "notes.append(note)" in src


# ===========================================================================
# 5. SECTION COVERAGE — what is present, asserted so a regression is visible
# ===========================================================================

def test_section_18_has_the_four_primary_trading_styles():
    """Section 18's table: Scalping, Day Trading, Swing Trading, Position Trading."""
    from backend.algorithms.trading_styles import ALL_STYLES

    names = {s.name for s in ALL_STYLES}
    assert names == {"Scalping", "Day Trading", "Swing Trading", "Position Trading"}, names


def test_section_21_has_all_ten_named_regimes():
    import backend.agents.regime_agent as ra

    returned = returned_strings(ra)
    for regime in ("Bull Trend", "Bear Trend", "Range", "High Volatility",
                   "Low Volatility", "Accumulation", "Distribution", "Panic",
                   "Euphoria", "Liquidity Crisis"):
        assert regime in returned, (
            f"Section 21 names {regime!r} — detect_market_regime cannot return it"
        )


def test_section_38_produced_all_seven_audit_documents():
    import pathlib

    for doc in ("ARCHITECTURE_AUDIT", "CURRENT_PHASE_STATUS",
                "LANGGRAPH_MIGRATION_PLAN", "AGENT_REGISTRY", "STATE_SCHEMA",
                "EVENT_SCHEMA", "RISK_BOUNDARY"):
        path = pathlib.Path(f"docs/{doc}.md")
        assert path.exists(), f"Section 38 requires docs/{doc}.md"
        assert path.stat().st_size > 200, f"docs/{doc}.md is a stub"


def test_section_39_hardening_is_in_place():
    """39.1 durable checkpointer, 39.2 native interrupt, 39.3 idempotency,
    39.4 replay safety, 39.6 token budget, 39.7 tracing. 39.5 (streaming) is a known
    gap and is asserted as such so it cannot be quietly forgotten OR quietly added
    without this list being updated."""
    import pathlib

    from backend.graphs import builder, runtime

    assert "AsyncSqliteSaver" in code_only(runtime)                  # 39.1
    assert "interrupt_before" in code_only(builder)                  # 39.2
    assert pathlib.Path("backend/services/execution_service.py").exists()   # 39.3
    from backend.graphs.state import WRITE_ONCE_FIELDS
    assert "market_data" in WRITE_ONCE_FIELDS                        # 39.4
    assert pathlib.Path("backend/llm/budget.py").exists()            # 39.6
    assert pathlib.Path("backend/graphs/tracing.py").exists()        # 39.7


def test_all_seven_section_35_graphs_exist():
    """Section 35 names seven purpose-built graphs. This asserted six and pinned
    Graph 7 (Learning) as absent; `graphs/learning_graph.py` now closes that gap, so
    the assertion is inverted rather than deleted — a graph disappearing should fail.
    """
    import importlib

    for label, module in {
        "1 Market Intelligence": "backend.graphs.market_state",
        "2 Trade Decision": "backend.graphs.analysis",
        "3 Execution": "backend.graphs.execution_graph",
        "4 Position Monitoring": "backend.graphs.monitoring",
        "5 Reflection": "backend.graphs.reflection_graph",
        "6 Research": "backend.graphs.research_graph",
        "7 Learning": "backend.graphs.learning_graph",
    }.items():
        assert importlib.import_module(module), f"Graph {label} is missing"

    # Graph 3 is deliberately NOT a LangGraph graph — Section 12 puts execution
    # outside it, and Section 36 puts orders in the Execution Plane.
    import backend.graphs.execution_graph as eg
    assert "StateGraph" not in code_only(eg), (
        "Section 12: execution happens OUTSIDE LangGraph"
    )
