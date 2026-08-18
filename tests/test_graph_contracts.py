"""Phase 23 — the LangGraph foundation, and the enforcement of Rule 0.

    Spec Section 0: "LangGraph is the agent's reasoning/orchestration layer — it
    is not the exchange execution engine, and it is not the risk-control boundary."

    Spec Section 2: "The LLM never gets direct permission to place an exchange
    order. This single sentence is the most important line in this whole document
    — everything else exists to enforce it."

These tests ARE that enforcement. The most important one is
`test_no_graph_module_imports_anything_that_can_trade`: it makes Rule 0
structural rather than procedural, because a node cannot place an order if the
symbol that places orders is not reachable from it.
"""

from __future__ import annotations

import ast
import pathlib

import pytest
from langgraph.graph import END

from backend.graphs.builder import ConditionalEdge, GraphConfig, build_graph
from backend.graphs.contracts import (
    FORBIDDEN_IMPORTS,
    IMPORT_BAN_EXEMPTIONS,
    NodeContract,
    NodeContractViolation,
    validate_node_output,
)
from backend.graphs.registry import (
    clear_registry,
    coverage,
    get_node,
    register_node,
    registered_nodes,
)
from backend.graphs.runtime import (
    build_checkpointer,
    finish_run,
    start_run,
    thread_id_for,
)
from backend.graphs.state import (
    DETERMINISTIC_ONLY_FIELDS,
    STATE_FIELDS,
    WRITE_ONCE_FIELDS,
    MarketSnapshot,
    TradingState,
    TriggerReason,
    new_state,
)
from backend.llm.budget import RunBudget
from backend.llm.provider import ModelTier, NullProvider, get_provider

ROOT = pathlib.Path(__file__).resolve().parents[1]
GRAPHS_DIR = ROOT / "backend" / "graphs"


@pytest.fixture(autouse=True)
def _clean_registry():
    clear_registry()
    yield
    clear_registry()


def _trigger(symbol="BTC/USDT"):
    return TriggerReason(kind="manual", symbol=symbol, detail="test")


# ===========================================================================
# RULE 0 — the import ban. The most important test in this file.
# ===========================================================================

def test_no_graph_module_imports_anything_that_can_trade():
    """No module under backend/graphs/ may import a symbol that can move money.

    This is stronger than a runtime check or a code review: a contract can be
    edited and a review can be skipped, but a symbol that is not imported cannot
    be called. Rule 0 becomes a property of the module graph.
    """
    violations = []

    for path in GRAPHS_DIR.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        rel = path.relative_to(ROOT).as_posix()
        if rel in IMPORT_BAN_EXEMPTIONS:
            continue

        tree = ast.parse(path.read_text(encoding="utf-8"))
        imported = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                imported.update(a.name for a in node.names)
                # A module-level import of the execution module itself counts.
                if node.module:
                    imported.add(node.module.split(".")[-1])
            elif isinstance(node, ast.Import):
                imported.update(a.name.split(".")[-1] for a in node.names)

        hit = imported & FORBIDDEN_IMPORTS
        if hit:
            violations.append(f"{rel}: {sorted(hit)}")

    assert not violations, (
        "graph module(s) import symbols that can place orders or grant "
        f"authorization: {violations}. The cognitive plane must not be able to "
        f"reach the execution plane (spec Sections 0 and 2)."
    )


def test_the_forbidden_list_covers_the_actual_dangerous_symbols():
    """Guard on the guard: the ban is only as good as its list."""
    for symbol in (
        "ExecutionAgent",
        "create_market_order",
        "TarApprovedEvent",
        "TarSubmittedEvent",
        "get_exchange_client",
        "close_position",
    ):
        assert symbol in FORBIDDEN_IMPORTS, f"{symbol} must be on the forbidden-import list"


def test_the_exemption_list_is_empty():
    """An exemption list that fills up is how the ban stops meaning anything."""
    assert IMPORT_BAN_EXEMPTIONS == {}, (
        f"import-ban exemptions exist: {IMPORT_BAN_EXEMPTIONS}. Each needs a stated "
        f"reason and a review."
    )


# ===========================================================================
# NodeContract
# ===========================================================================

def test_a_node_cannot_be_both_deterministic_and_llm():
    """A node that calls a model is not reproducible; reproducibility is what
    lets a decision rule be backtested."""
    with pytest.raises(ValueError, match="one or the other"):
        NodeContract(
            name="confused",
            reads=(),
            writes=(),
            purpose="x",
            deterministic=True,
            may_call_llm=True,
        )


def test_a_contract_declaring_an_unknown_state_field_fails_at_construction():
    """A typo'd field name would otherwise produce a state write LangGraph
    silently discards — the node would appear to work while writing nothing."""
    with pytest.raises(ValueError, match="unknown TradingState"):
        NodeContract(name="typo", reads=(), writes=("confidenc",), purpose="x")


def test_an_llm_node_cannot_declare_writes_to_deterministic_only_fields():
    """A model may narrate a computed value; it may not replace it."""
    with pytest.raises(ValueError, match="may not write"):
        NodeContract(
            name="overreach",
            reads=(),
            writes=("risk_assessment",),
            purpose="x",
            deterministic=False,
            may_call_llm=True,
        )


def test_risk_assessment_and_confidence_are_deterministic_only():
    for field_name in ("risk_assessment", "confidence", "market_data", "execution_plan"):
        assert field_name in DETERMINISTIC_ONLY_FIELDS


def test_writing_an_undeclared_field_raises():
    contract = NodeContract(name="n", reads=(), writes=("confidence",), purpose="x")
    state = new_state("r", "BTC/USDT", _trigger(), 0.0)
    with pytest.raises(NodeContractViolation, match="undeclared state field"):
        validate_node_output(contract, {"decision": object()}, state)


def test_writing_a_declared_field_is_allowed():
    contract = NodeContract(name="n", reads=(), writes=("confidence",), purpose="x")
    state = new_state("r", "BTC/USDT", _trigger(), 0.0)
    assert validate_node_output(contract, {"confidence": 0.5}, state) == {"confidence": 0.5}


def test_bookkeeping_fields_need_no_declaration():
    """A node must always be able to report that it failed or that an input was
    unavailable — requiring a declaration would let a node be forbidden from
    saying it broke."""
    contract = NodeContract(name="n", reads=(), writes=(), purpose="x")
    state = new_state("r", "BTC/USDT", _trigger(), 0.0)
    out = validate_node_output(contract, {"unavailable": ["feed down"], "errors": []}, state)
    assert out["unavailable"] == ["feed down"]


def test_returning_none_means_wrote_nothing():
    """A node that could not run should return None, not an empty-but-plausible
    payload."""
    contract = NodeContract(name="n", reads=(), writes=("confidence",), purpose="x")
    state = new_state("r", "BTC/USDT", _trigger(), 0.0)
    assert validate_node_output(contract, None, state) == {}


def test_returning_a_non_dict_raises():
    contract = NodeContract(name="n", reads=(), writes=(), purpose="x")
    state = new_state("r", "BTC/USDT", _trigger(), 0.0)
    with pytest.raises(NodeContractViolation, match="expected a dict"):
        validate_node_output(contract, "oops", state)


# ===========================================================================
# Section 39.4 — replay safety via write-once market data
# ===========================================================================

def test_market_data_is_write_once():
    assert "market_data" in WRITE_ONCE_FIELDS


def test_overwriting_market_data_raises():
    """A node re-fetching on replay would reason over a DIFFERENT market than
    the decision it is supposed to be resuming (spec Section 39.4)."""
    contract = NodeContract(name="fetch", reads=(), writes=("market_data",), purpose="x")
    state = new_state("r", "BTC/USDT", _trigger(), 0.0)
    first = MarketSnapshot(symbol="BTC/USDT", price=60_000.0)
    assert validate_node_output(contract, {"market_data": first}, state)

    state["market_data"] = first
    with pytest.raises(NodeContractViolation, match="write-once"):
        validate_node_output(
            contract, {"market_data": MarketSnapshot(symbol="BTC/USDT", price=61_000.0)}, state
        )


# ===========================================================================
# State schema
# ===========================================================================

def test_confidence_is_optional_not_zero_defaulted():
    """A missing confidence and a zero confidence are different facts. This
    codebase has been bitten by that class four separate times."""
    state = new_state("r", "BTC/USDT", _trigger(), 0.0)
    assert state["confidence"] is None
    assert "confidence" in TradingState.__annotations__
    assert "Optional" in str(TradingState.__annotations__["confidence"])


def test_new_state_pre_populates_nothing_plausible():
    """A default here is indistinguishable downstream from a measured value."""
    state = new_state("r", "BTC/USDT", _trigger(), 0.0)
    for key in (
        "market_data", "market_regime", "technical_analysis", "sentiment_analysis",
        "trade_thesis", "decision", "risk_assessment", "execution_plan", "confidence",
    ):
        assert state[key] is None, f"{key} should start None, got {state[key]!r}"


def test_risk_assessment_approved_is_not_defaulted_to_true():
    """An assessment that has not run must not read as an approval."""
    from backend.graphs.state import RiskAssessment

    assert RiskAssessment().approved is None


def test_approval_status_defaults_to_not_required_not_approved():
    from backend.graphs.state import ApprovalStatus

    assert ApprovalStatus().status == "not_required"


def test_unavailable_is_a_first_class_state_field():
    """Section-wide rule: "evaluated and found nothing" differs from "could not
    evaluate", and losing that at the first node destroys it for every later one."""
    assert "unavailable" in STATE_FIELDS
    state = new_state("r", "BTC/USDT", _trigger(), 0.0)
    assert state["unavailable"] == []


def test_feed_blocked_specialists_report_unavailable_rather_than_zero():
    """Orderflow and Liquidity have no feed. They must say so, not report 0."""
    from backend.graphs.state import LiquidityAnalysis, OrderflowAnalysis

    of, liq = OrderflowAnalysis(), LiquidityAnalysis()
    assert of.available is False and of.reason
    assert liq.available is False and liq.reason
    assert of.imbalance is None and liq.depth_score is None


# ===========================================================================
# Registry
# ===========================================================================

def test_duplicate_node_registration_raises():
    """Silently keeping the last one would make behaviour depend on import order."""
    c = NodeContract(name="dup", reads=(), writes=(), purpose="x")
    register_node(c, lambda s: None)
    with pytest.raises(ValueError, match="already registered"):
        register_node(NodeContract(name="dup", reads=(), writes=(), purpose="y"), lambda s: None)


def test_unregistered_node_lookup_raises_with_the_known_list():
    with pytest.raises(KeyError, match="no graph node named"):
        get_node("nope")


def test_coverage_reports_the_deterministic_to_llm_split():
    """That ratio is the number to watch: safety rests on decision-critical
    nodes staying deterministic."""
    register_node(NodeContract(name="d", reads=(), writes=(), purpose="x"), lambda s: None)
    # Writes `thesis_narrative`, not `trade_thesis`. Phase 25 moved
    # `trade_thesis` into DETERMINISTIC_ONLY_FIELDS — it holds the computed
    # direction, entry, stop and target — so this fixture had to change. The
    # contract system rejecting the old version is the rule working.
    register_node(
        NodeContract(name="l", reads=(), writes=("thesis_narrative",), purpose="x",
                     deterministic=False, may_call_llm=True),
        lambda s: None,
    )
    cov = coverage()
    assert cov["deterministicCount"] == 1
    assert cov["llmCount"] == 1


# ===========================================================================
# Builder — Section 35's "multiple graphs, not one giant graph"
# ===========================================================================

def _register_two_nodes():
    register_node(
        NodeContract(name="a", reads=(), writes=("confidence",), purpose="first", phase=23),
        lambda s: {"confidence": 0.5},
    )
    register_node(
        NodeContract(name="b", reads=("confidence",), writes=("unavailable",), purpose="second", phase=23),
        lambda s: {"unavailable": ["b ran"]},
    )


def test_a_node_with_no_outgoing_edge_is_rejected():
    """A node that just stops leaves a run looking incomplete with no reason."""
    _register_two_nodes()
    cfg = GraphConfig(name="g", nodes=["a", "b"], entry="a", edges=[("a", "b")])
    with pytest.raises(ValueError, match="no outgoing edge"):
        cfg.validate()


def test_an_entry_not_among_the_nodes_is_rejected():
    _register_two_nodes()
    cfg = GraphConfig(name="g", nodes=["a"], entry="b", edges=[("a", END)])
    with pytest.raises(ValueError, match="entry"):
        cfg.validate()


def test_a_conditional_edge_to_an_unknown_destination_is_rejected():
    """An unmapped router return would be a KeyError mid-decision."""
    _register_two_nodes()
    cfg = GraphConfig(
        name="g", nodes=["a", "b"], entry="a", edges=[("b", END)],
        conditional_edges=[ConditionalEdge("a", lambda s: "x", {"x": "ghost"})],
    )
    with pytest.raises(ValueError, match="not a node"):
        cfg.validate()


def test_a_valid_two_node_graph_builds():
    _register_two_nodes()
    cfg = GraphConfig(name="g", nodes=["a", "b"], entry="a", edges=[("a", "b"), ("b", END)])
    state, ctx, thread = start_run("g", "BTC/USDT", _trigger(), "cycle-1")
    graph = build_graph(cfg, ctx)
    assert graph is not None


# ===========================================================================
# Section 39.1 — thread ids
# ===========================================================================

def test_thread_id_scheme_is_scoped_not_global():
    """One giant thread would make every decision a continuation of the last."""
    a = thread_id_for("monitoring", "BTCUSDT-pos-1")
    b = thread_id_for("monitoring", "ETHUSDT-pos-2")
    assert a != b
    assert a.startswith("monitoring:")


def test_thread_id_requires_both_graph_and_scope():
    for graph, scope in (("", "x"), ("g", "")):
        with pytest.raises(ValueError):
            thread_id_for(graph, scope)


# ===========================================================================
# Section 39.1 — the checkpointer must be durable, never silently in-memory
# ===========================================================================

def test_checkpointer_none_returns_none_rather_than_an_in_memory_saver():
    """An in-memory checkpointer looks identical in tests and silently loses
    every graph's state on restart."""
    assert build_checkpointer("none") is None


def test_unknown_checkpointer_returns_none_rather_than_guessing():
    assert build_checkpointer("redis-maybe") is None


def test_sqlite_checkpointer_is_available():
    """Durable across a restart with no server to run — which is what makes
    "durable from day one" achievable rather than deferred."""
    cp = build_checkpointer("sqlite")
    assert cp is not None


# ===========================================================================
# LLM provider — fails closed
# ===========================================================================

@pytest.mark.asyncio
async def test_the_default_provider_refuses_rather_than_returning_placeholder_text():
    """A stub returning placeholder text would let every LLM node "work" in
    development and produce fiction — exactly how DebateVisualizer ended up
    showing invented reasoning as an agent's own."""
    result = await NullProvider().complete(
        system="s", user="u", tier=ModelTier.NARRATIVE
    )
    assert result.text is None
    assert result.ok is False
    assert result.error


def test_no_provider_is_configured_by_default():
    p = get_provider()
    assert p.available is False


def test_default_temperature_is_zero():
    """Non-zero temperature makes two runs over identical state produce
    different rationales, which destroys cross-run comparison."""
    from backend.llm.provider import DEFAULT_TEMPERATURE

    assert DEFAULT_TEMPERATURE == 0.0


# ===========================================================================
# Section 39.6 — budget
# ===========================================================================

def test_budget_denies_calls_once_the_call_ceiling_is_hit():
    b = RunBudget(max_calls=2, max_tokens=10_000)
    for _ in range(2):
        assert b.can_spend("n")[0] is True
        b.record("n", 100)
    allowed, reason = b.can_spend("n")
    assert allowed is False
    assert "call budget exhausted" in reason


def test_budget_denies_calls_once_the_token_ceiling_is_hit():
    b = RunBudget(max_calls=100, max_tokens=500)
    b.record("n", 600)
    allowed, reason = b.can_spend("n")
    assert allowed is False
    assert "token budget exhausted" in reason


def test_a_failed_call_still_consumes_budget():
    """Not counting failures would let a node retry indefinitely in one run."""
    b = RunBudget(max_calls=1)
    b.record("n", 0)
    assert b.can_spend("n")[0] is False


def test_budget_denial_reason_is_returned_for_the_state_not_just_logged():
    """The operator should see "no narrative because budget exhausted", not an
    unexplained gap."""
    b = RunBudget(max_calls=0)
    _, reason = b.can_spend("supervisor")
    assert reason and "supervisor" in reason
    assert reason in b.summary()["denied"]


def test_budget_tracks_spend_per_node():
    """An expensive node should be identifiable, not just an expensive run."""
    b = RunBudget()
    b.record("supervisor", 5_000)
    b.record("thesis", 1_000)
    assert b.summary()["byNode"] == {"supervisor": 5_000, "thesis": 1_000}
