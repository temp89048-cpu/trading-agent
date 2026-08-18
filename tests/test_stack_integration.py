"""Recommended_Technology_Stack.md layers 1-4 — do they actually work together?

    Frontend         Next.js + React + Tailwind
    Backend APIs     FastAPI (Python)
    Agent Services   Python
    AI Orchestration LangGraph

Each layer existed and worked. The link that did not was **L4 -> L2 -> L1**: the
seven graphs computed decisions, traced them to disk, and had no API surface at all,
so nothing they produced could reach the dashboard. A final wiring audit found it —
no test did, because every test verified a layer rather than a seam.

So these tests are about SEAMS. Each asserts that one layer can actually reach the
next, using the real router and the real registry rather than checking a file exists.
"""

from __future__ import annotations

import asyncio

import pytest


# ===========================================================================
# L2 <-> L3 : FastAPI mounts the agent services
# ===========================================================================

def test_every_api_router_is_actually_mounted():
    """A router that exists but is not included serves nothing.

    `components/Agent.tsx` once targeted `/api/agents/tasks` with no router mounted
    at all, so every call 404'd while the module looked present.
    """
    from backend.main import app

    paths = set(app.openapi()["paths"])
    for prefix in ("/api/market", "/api/exchange", "/api/ai", "/api/knowledge",
                   "/api/memory", "/api/research", "/api/execution",
                   "/api/monitoring", "/api/dashboard", "/api/agents",
                   "/api/admin", "/api/missions", "/api/graphs"):
        assert any(p.startswith(prefix) for p in paths), (
            f"no endpoint is mounted under {prefix} — the router exists but serves nothing"
        )


def test_the_api_surface_is_not_empty():
    from backend.main import app

    assert len(app.openapi()["paths"]) >= 45


# ===========================================================================
# L4 -> L2 : the reasoning layer has an API surface AT ALL
# ===========================================================================

def test_the_langgraph_layer_is_reachable_from_fastapi():
    """THE seam that was missing.

    Layers 1-3 were connected and layer 4 had nothing. Every decision the seven
    graphs produced was computed, written to the trace store, and unreachable from
    the UI whose job is showing it — spec Section 39.5 asks for exactly this.
    """
    from backend.main import app

    paths = set(app.openapi()["paths"])
    for route in ("/api/graphs", "/api/graphs/nodes", "/api/graphs/runs",
                  "/api/graphs/meta-learning", "/api/graphs/positions"):
        assert route in paths, f"{route} is not exposed — layer 4 is invisible to layer 2"


def test_the_graph_inventory_reports_all_seven_section_35_graphs():
    from backend.api.graphs import list_graphs

    result = asyncio.run(list_graphs())
    assert len(result["graphs"]) == 7

    unavailable = [g["name"] for g in result["graphs"] if not g["available"]]
    assert not unavailable, f"graphs failed to load: {unavailable}"

    # Graph 2 is the big one and must report its real node list, not a placeholder.
    trade = next(g for g in result["graphs"] if g["graph"] == "2")
    assert trade["isLangGraph"] is True
    assert trade["nodeCount"] >= 18
    assert "risk_gateway" in trade["nodes"]
    assert "supervisor" in trade["nodes"]


def test_the_inventory_is_honest_about_what_is_not_a_graph():
    """Two of the seven deliberately are not LangGraph graphs. Reporting seven
    compiled graphs would be a nicer number and a false one."""
    from backend.api.graphs import list_graphs

    result = asyncio.run(list_graphs())
    execution = next(g for g in result["graphs"] if g["name"] == "Execution")
    assert execution["isLangGraph"] is False
    assert "outside LangGraph" in execution["note"]


def test_the_node_endpoint_exposes_the_contracts_that_enforce_rule_0():
    """This is the explainability surface for the one rule everything else follows:
    per node, what it may WRITE and whether it may call a model."""
    from backend.api.graphs import list_nodes

    result = asyncio.run(list_nodes())
    assert result["total"] >= 20

    # Exactly one node in the whole system may reach a model.
    assert result["llmNodes"] == ["trade_thesis_narrative"], result["llmNodes"]

    by_name = {n["name"]: n for n in result["nodes"]}
    gateway = by_name["risk_gateway"]
    assert gateway["deterministic"] is True
    assert gateway["mayCallLlm"] is False
    assert set(gateway["writes"]) == {"risk_assessment", "execution_plan"}


def test_the_runs_endpoint_reads_the_real_trace_store():
    from backend.api.graphs import list_runs

    result = asyncio.run(list_runs(limit=5))
    assert "runs" in result and isinstance(result["runs"], list)
    assert result["count"] == len(result["runs"])
    assert "not a substitute for the checkpointer" in result["tracingMeaning"]


def test_the_meta_learning_endpoint_answers_all_six_questions():
    from backend.api.graphs import meta_learning

    result = asyncio.run(meta_learning())
    assert result["questionsTotal"] == 6
    assert len(result["findings"]) == 6
    assert "writes to nothing" in result["deploymentMeaning"]


def test_the_positions_endpoint_returns_copies_not_live_objects():
    """A caller holding a live `_Tracked` could assign `stop_loss` directly and
    bypass `tighten_stop`'s refusal to widen a stop — over an HTTP boundary that
    would be a serialisation error, but the endpoint reads through `snapshot_open()`
    for the same reason every other caller does."""
    from backend.api.graphs import monitored_positions

    result = asyncio.run(monitored_positions())
    assert isinstance(result["positions"], list)
    assert result["count"] == len(result["positions"])
    assert "only ever be TIGHTENED" in result["stopMeaning"]


def test_starting_a_run_is_the_only_write_route_and_is_auth_gated():
    """It costs market data and possibly tokens. It still cannot trade: it produces
    an inert plan that GRAPH_EXECUTION_ENABLED gates separately."""
    import inspect

    from backend.api import graphs as g

    sig = inspect.signature(g.run_analysis)
    assert "_auth" in sig.parameters, "POST /run must be auth-gated"

    for name, fn in [("list_graphs", g.list_graphs), ("list_nodes", g.list_nodes),
                     ("list_runs", g.list_runs), ("meta_learning", g.meta_learning),
                     ("monitored_positions", g.monitored_positions)]:
        assert "_auth" not in inspect.signature(fn).parameters, (
            f"{name} is read-only and should not require auth"
        )


def test_the_graph_api_cannot_reach_an_order_call():
    """This module sits in `api/`, so the graphs/ import ban does not apply to it by
    location. It must still not be able to place an order."""
    import ast
    import pathlib

    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    tree = ast.parse(pathlib.Path("backend/api/graphs.py").read_text(encoding="utf-8"))
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)

    assert not (imported & FORBIDDEN_IMPORTS), sorted(imported & FORBIDDEN_IMPORTS)


# ===========================================================================
# L2 -> L1 : the frontend knows where these live
# ===========================================================================

def test_the_frontend_config_names_every_langgraph_path_the_backend_serves():
    """The paths must match EXACTLY. `lib/backendConfig.ts` exists because six
    components had localhost hardcoded and several pointed at paths FastAPI does not
    serve — `/api/health` and `/api/trades` are real routes of the NEXT.JS app, so
    the calls 404'd against the Python host while looking correct."""
    import pathlib
    import re

    from backend.main import app

    config = pathlib.Path("lib/backendConfig.ts").read_text(encoding="utf-8")
    served = set(app.openapi()["paths"])

    declared = set(re.findall(r"'(/api/graphs[a-z/-]*)'", config))
    assert declared, "backendConfig declares no LangGraph paths"

    for path in declared:
        assert path in served, (
            f"backendConfig points at {path}, which FastAPI does not serve — this is "
            f"the exact 404 class that file was created to prevent"
        )


def test_the_websocket_urls_derive_from_one_base():
    """Written out separately, the host drifts between HTTP and WS config — and an
    https deployment opening an insecure socket is blocked outright by browsers."""
    import pathlib

    config = pathlib.Path("lib/backendConfig.ts").read_text(encoding="utf-8")
    for fn in ("agentEventsWsUrl", "graphStreamWsUrl"):
        assert fn in config, f"{fn} is missing"
    assert config.count("BACKEND_BASE.replace(/^http/, 'ws')") >= 2, (
        "each WS url must derive from BACKEND_BASE rather than hardcoding a host"
    )


def test_the_stream_endpoint_exists_for_section_39_5():
    """39.5's "4 of 6 specialists reporting" needs a live channel, not polling."""
    from backend.api import graphs as g
    from backend.main import app

    assert hasattr(g, "stream_graph_progress")
    ws_routes = [
        r for r in app.routes
        if type(r).__name__ == "_IncludedRouter" or "WebSocket" in type(r).__name__
    ]
    assert ws_routes, "no websocket routes are mounted"


# ===========================================================================
# L4 internals still hold once exposed
# ===========================================================================

def test_exposing_the_graphs_did_not_break_the_registry_guard():
    """`/nodes` warms every graph config in one process. `market_state` used a module
    flag rather than a registry check, so building Graph 1 after Graph 2 raised
    "node 'data_validation' is already registered" — found by the final wiring audit,
    not by a test."""
    from backend.graphs.analysis import analysis_config
    from backend.graphs.market_state import market_state_config
    from backend.graphs.monitoring import monitoring_config

    # In this order specifically: Graph 2 registers the market nodes first.
    analysis_config()
    market_state_config()
    monitoring_config()
    market_state_config()


def test_the_run_endpoint_produces_a_decision_without_executing():
    """Layer 4 reachable from layer 2 must not mean layer 2 can trade."""
    import inspect

    from backend.api import graphs as g

    src = inspect.getsource(g.run_analysis)
    assert "run_analysis_graph" in src
    for forbidden in ("create_market_order", "TarApprovedEvent", "close_position"):
        assert forbidden not in src
