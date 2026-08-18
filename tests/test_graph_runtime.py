"""Phase 23's completion gate — a graph that actually runs, checkpoints, resumes.

Spec Section 6 lists eight deliverables for Phase 23 (Runtime, State Schema,
Node Registry, Graph Builder, Graph Configuration, Checkpointer, Tracing, Error
Handling). `test_graph_contracts.py` covers the schema and the safety contracts;
this file proves the runtime works end to end, which is the difference between
"the modules import" and "Phase 23 is done".

Section 39.1's requirement is specifically that state survives a restart. So the
resume test drops the graph object entirely and rebuilds it from a NEW
checkpointer connection, rather than resuming an object still in memory — the
latter would pass while proving nothing about durability.
"""

from __future__ import annotations

import os
import pathlib

import pytest
from langgraph.graph import END

from backend.graphs.builder import ConditionalEdge, GraphConfig, build_graph
from backend.graphs.contracts import NodeContract, NodeContractViolation
from backend.graphs.registry import clear_registry, register_node
from backend.graphs.runtime import finish_run, start_run
from backend.graphs.state import MarketSnapshot, TriggerReason
from backend.graphs.tracing import list_recent_runs
from backend.llm.budget import RunBudget

ROOT = pathlib.Path(__file__).resolve().parents[1]


@pytest.fixture(autouse=True)
def _clean():
    clear_registry()
    yield
    clear_registry()


@pytest.fixture
def sqlite_checkpointer(tmp_path, monkeypatch):
    """A real SQLite checkpointer in a temp dir, so tests never touch .data/."""
    import backend.graphs.runtime as rt

    monkeypatch.setattr(rt, "CHECKPOINT_DIR", str(tmp_path))
    monkeypatch.setattr(rt, "SQLITE_CHECKPOINT_PATH", str(tmp_path / "cp.sqlite"))
    return str(tmp_path / "cp.sqlite")


def _trigger(symbol="BTC/USDT"):
    return TriggerReason(
        kind="price_move", symbol=symbol, detail="2.1% move", observed_value=2.1, threshold=2.0
    )


# ---------------------------------------------------------------------------
# A minimal but honest two-node graph
# ---------------------------------------------------------------------------

def _register_market_and_analysis():
    """Two nodes shaped like the real Phase 24 pair: fetch, then analyse.

    The fetch node writes `market_data` (write-once) and the analysis node only
    READS it — which is the Section 39.4 pattern every real node must follow.
    """

    def fetch(state):
        return {
            "market_data": MarketSnapshot(
                symbol=state["symbol"],
                price=60_000.0,
                candles={"15m": [{"close": 60_000.0}] * 60},
                fetched_at=state["started_at"],
                source="test",
            )
        }

    def analyse(state):
        snapshot = state.get("market_data")
        if snapshot is None or snapshot.candle_count("15m") < 15:
            # The honest branch: report unavailability rather than a made-up
            # confidence.
            return {"unavailable": ["analysis (insufficient candles)"]}
        return {"confidence": 0.62}

    register_node(
        NodeContract(
            name="market_scan", reads=("symbol", "started_at"), writes=("market_data",),
            purpose="Fetch market data once per run", phase=24,
        ),
        fetch,
    )
    register_node(
        NodeContract(
            name="analysis", reads=("market_data",), writes=("confidence",),
            purpose="Score the snapshot", phase=24,
        ),
        analyse,
    )


def _linear_config():
    return GraphConfig(
        name="market_state",
        nodes=["market_scan", "analysis"],
        entry="market_scan",
        edges=[("market_scan", "analysis"), ("analysis", END)],
    )


# ---------------------------------------------------------------------------
# End-to-end run
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_two_node_graph_runs_end_to_end():
    _register_market_and_analysis()
    state, ctx, thread = start_run("market_state", "BTC/USDT", _trigger(), "cycle-1")
    graph = build_graph(_linear_config(), ctx)

    final = await graph.ainvoke(state)

    assert final["market_data"] is not None
    assert final["confidence"] == 0.62
    # The runtime appends this, not the nodes.
    assert final["nodes_visited"] == ["market_scan", "analysis"]
    assert final["errors"] == []


@pytest.mark.asyncio
async def test_state_flows_forward_rather_than_being_refetched():
    """Section 39.4: downstream nodes read market data from state.

    The analysis node never fetches; if `market_data` were absent it would report
    unavailable. Its confidence being set proves it read what fetch wrote.
    """
    _register_market_and_analysis()
    state, ctx, _ = start_run("market_state", "BTC/USDT", _trigger(), "cycle-1")
    final = await build_graph(_linear_config(), ctx).ainvoke(state)
    assert final["confidence"] is not None
    assert final["unavailable"] == []


# ---------------------------------------------------------------------------
# Error handling (Section 6 deliverable)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_failing_node_degrades_the_run_instead_of_aborting_it():
    """A broken sentiment node must not stop the risk checks running or a
    position being monitored."""

    def boom(state):
        raise RuntimeError("feed exploded")

    register_node(
        NodeContract(name="broken", reads=(), writes=("confidence",), purpose="x"), boom
    )
    register_node(
        NodeContract(name="after", reads=(), writes=("unavailable",), purpose="x"),
        lambda s: {"unavailable": ["after still ran"]},
    )

    cfg = GraphConfig(
        name="g", nodes=["broken", "after"], entry="broken",
        edges=[("broken", "after"), ("after", END)],
    )
    state, ctx, _ = start_run("g", "BTC/USDT", _trigger(), "c1")
    final = await build_graph(cfg, ctx).ainvoke(state)

    # The failure is recorded...
    assert len(final["errors"]) == 1
    assert "feed exploded" in final["errors"][0].error
    assert any("broken" in u for u in final["unavailable"])
    # ...and the downstream node still ran.
    assert "after still ran" in final["unavailable"]
    assert "after" in final["nodes_visited"]


@pytest.mark.asyncio
async def test_a_contract_violation_aborts_the_run_unlike_an_ordinary_failure():
    """A contract breach means the safety model was bypassed, not that data was
    bad. Continuing would trust state no longer known to be sound."""

    register_node(
        NodeContract(name="overreach", reads=(), writes=("confidence",), purpose="x"),
        lambda s: {"decision": "I am not allowed to write this"},
    )
    cfg = GraphConfig(name="g", nodes=["overreach"], entry="overreach", edges=[("overreach", END)])
    state, ctx, _ = start_run("g", "BTC/USDT", _trigger(), "c1")
    graph = build_graph(cfg, ctx)

    with pytest.raises(NodeContractViolation, match="undeclared state field"):
        await graph.ainvoke(state)


# ---------------------------------------------------------------------------
# Section 39.1 — durability across a simulated restart
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_graph_state_survives_a_simulated_restart(sqlite_checkpointer):
    """THE Phase 23 gate.

    The graph is paused mid-run via `interrupt_before`, then the graph object and
    checkpointer are DISCARDED and rebuilt from a fresh connection — simulating a
    process restart — before resuming. Resuming an object still held in memory
    would pass while proving nothing about durability.
    """
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    _register_market_and_analysis()
    cfg = GraphConfig(
        name="market_state",
        nodes=["market_scan", "analysis"],
        entry="market_scan",
        edges=[("market_scan", "analysis"), ("analysis", END)],
        # Pause before the second node.
        interrupt_before=["analysis"],
    )

    state, ctx, thread = start_run("market_state", "BTC/USDT", _trigger(), "restart-test")
    config = {"configurable": {"thread_id": thread}}

    # --- process 1: run until the interrupt, then "crash" ---------------
    async with AsyncSqliteSaver.from_conn_string(sqlite_checkpointer) as cp1:
        graph1 = build_graph(cfg, ctx, checkpointer=cp1)
        partial = await graph1.ainvoke(state, config=config)
        # Stopped before `analysis`, so market data exists but confidence does not.
        assert partial["market_data"] is not None
        assert partial.get("confidence") is None

    del graph1, cp1  # the process is gone

    # --- process 2: fresh connection, same thread_id --------------------
    async with AsyncSqliteSaver.from_conn_string(sqlite_checkpointer) as cp2:
        graph2 = build_graph(cfg, ctx, checkpointer=cp2)

        # State was recovered from disk, not from memory.
        recovered = await graph2.aget_state(config)
        assert recovered.values["market_data"] is not None, (
            "market data did not survive the restart — the checkpointer is not durable"
        )

        # Resume by invoking with None, which continues from the checkpoint.
        final = await graph2.ainvoke(None, config=config)
        assert final["confidence"] == 0.62
        assert final["nodes_visited"] == ["market_scan", "analysis"]


@pytest.mark.asyncio
async def test_two_threads_do_not_share_state(sqlite_checkpointer):
    """One giant thread would make every decision a continuation of the last, and
    two unrelated symbols would share reasoning history (Section 39.1)."""
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    _register_market_and_analysis()
    cfg = _linear_config()

    async with AsyncSqliteSaver.from_conn_string(sqlite_checkpointer) as cp:
        s1, c1, t1 = start_run("market_state", "BTC/USDT", _trigger("BTC/USDT"), "btc-cycle")
        s2, c2, t2 = start_run("market_state", "ETH/USDT", _trigger("ETH/USDT"), "eth-cycle")
        assert t1 != t2

        g = build_graph(cfg, c1, checkpointer=cp)
        f1 = await g.ainvoke(s1, config={"configurable": {"thread_id": t1}})

        g2 = build_graph(cfg, c2, checkpointer=cp)
        f2 = await g2.ainvoke(s2, config={"configurable": {"thread_id": t2}})

        assert f1["symbol"] == "BTC/USDT"
        assert f2["symbol"] == "ETH/USDT"


# ---------------------------------------------------------------------------
# Section 39.2 — interrupt() as the human-approval path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_interrupt_before_pauses_the_graph_for_human_approval(sqlite_checkpointer):
    """Section 39.2: use LangGraph's native interrupt for approvals rather than a
    bespoke polling loop. This is the mechanism the "require approval above $X"
    control will hang off."""
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    _register_market_and_analysis()
    cfg = GraphConfig(
        name="market_state", nodes=["market_scan", "analysis"], entry="market_scan",
        edges=[("market_scan", "analysis"), ("analysis", END)],
        interrupt_before=["analysis"],
    )
    state, ctx, thread = start_run("market_state", "BTC/USDT", _trigger(), "approval-test")
    config = {"configurable": {"thread_id": thread}}

    async with AsyncSqliteSaver.from_conn_string(sqlite_checkpointer) as cp:
        graph = build_graph(cfg, ctx, checkpointer=cp)
        await graph.ainvoke(state, config=config)

        snap = await graph.aget_state(config)
        # Paused, with the pending node named.
        assert snap.next == ("analysis",), f"expected to be paused before 'analysis', got {snap.next}"


# ---------------------------------------------------------------------------
# Section 39.7 — tracing
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_run_trace_records_every_node(tmp_path, monkeypatch):
    import backend.graphs.tracing as tracing

    monkeypatch.setattr(tracing, "TRACE_DIR", str(tmp_path))

    _register_market_and_analysis()
    state, ctx, _ = start_run("market_state", "BTC/USDT", _trigger(), "trace-test")
    final = await build_graph(_linear_config(), ctx).ainvoke(state)
    trace = finish_run(ctx, final)

    assert trace.node_names() == ["market_scan", "analysis"]
    assert trace.outcome == "completed"
    assert trace.duration_ms is not None
    # The trace names what each node wrote, for debugging contract issues.
    assert "market_data" in trace.nodes[0].wrote


@pytest.mark.asyncio
async def test_a_run_that_produced_no_decision_records_why(tmp_path, monkeypatch):
    """This is the field that answers "why did nothing trade?" — the question
    this system's operator asks most often."""
    import backend.graphs.tracing as tracing

    monkeypatch.setattr(tracing, "TRACE_DIR", str(tmp_path))

    register_node(
        NodeContract(name="declines", reads=(), writes=("unavailable",), purpose="x"),
        lambda s: {"unavailable": ["no stop-loss computable"]},
    )
    cfg = GraphConfig(name="g", nodes=["declines"], entry="declines", edges=[("declines", END)])
    state, ctx, _ = start_run("g", "BTC/USDT", _trigger(), "c1")
    final = await build_graph(cfg, ctx).ainvoke(state)
    trace = finish_run(ctx, final)

    assert trace.no_decision_reason is not None
    assert "no stop-loss computable" in trace.no_decision_reason


@pytest.mark.asyncio
async def test_failed_runs_are_traced_too(tmp_path, monkeypatch):
    """A trace store of only successful runs cannot explain a quiet system."""
    import backend.graphs.tracing as tracing

    monkeypatch.setattr(tracing, "TRACE_DIR", str(tmp_path))

    register_node(
        NodeContract(name="boom", reads=(), writes=(), purpose="x"),
        lambda s: (_ for _ in ()).throw(RuntimeError("nope")),
    )
    cfg = GraphConfig(name="g", nodes=["boom"], entry="boom", edges=[("boom", END)])
    state, ctx, _ = start_run("g", "BTC/USDT", _trigger(), "c1")
    final = await build_graph(cfg, ctx).ainvoke(state)
    finish_run(ctx, final, outcome="failed")

    runs = list_recent_runs()
    assert len(runs) == 1
    assert runs[0]["outcome"] == "failed"
    assert any("nope" in e for e in runs[0]["errors"])


@pytest.mark.asyncio
async def test_the_trigger_reason_is_carried_into_the_trace():
    """"Why did the system think about this now?" must be answerable."""
    _register_market_and_analysis()
    state, ctx, _ = start_run("market_state", "BTC/USDT", _trigger(), "c1")
    assert state["trigger"].kind == "price_move"
    assert state["trigger"].observed_value == 2.1
    assert "price_move" in ctx.trace.trigger


@pytest.mark.asyncio
async def test_budget_summary_is_attached_to_the_trace(tmp_path, monkeypatch):
    """Section 39.6: token cost per run is a first-class metric alongside
    latency and confidence."""
    import backend.graphs.tracing as tracing

    monkeypatch.setattr(tracing, "TRACE_DIR", str(tmp_path))

    _register_market_and_analysis()
    state, ctx, _ = start_run(
        "market_state", "BTC/USDT", _trigger(), "c1", budget=RunBudget(max_calls=3)
    )
    final = await build_graph(_linear_config(), ctx).ainvoke(state)
    trace = finish_run(ctx, final)

    assert trace.llm_budget["maxCalls"] == 3
    assert trace.llm_budget["callsMade"] == 0  # no LLM nodes in this graph
