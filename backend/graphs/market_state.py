"""Graph 1 — Market Intelligence (spec Section 7 / Phase 24, Section 35 Graph 1).

    Market Event -> Data Validation -> Feature Generation -> Market Analysis
                 -> Regime Detection -> Market State

This is the first real LangGraph workflow in the system, and it is deliberately
the *cheapest* one: five deterministic nodes, no model calls. Building the
expensive graphs on top of a cheap one that already exercises the runtime,
checkpointer and tracing means the first LLM node lands on a proven foundation
rather than debugging both at once.

WIRED TO TRIGGERS, NOT TO A TIMER
---------------------------------
Section 14's whole point. `subscribe_to_triggers()` attaches this graph to
`TRIGGER_FIRED`, so a run happens when a market condition actually changed —
and suppressed triggers are ignored here, because the trigger layer already
decided not to act.

It is NOT attached to the 3-second AgentOS tick. That is the mistake this
ordering exists to prevent.

ONE THREAD PER DECISION CYCLE (Section 39.1)
-------------------------------------------
Thread scope is `{symbol}-{trigger_kind}-{run_id}`, so every run is its own
thread. Market-state runs are not continuations of one another: reasoning about a
regime change should not resume from the state of an unrelated price-move run
twenty minutes earlier. The monitoring graph (Phase 30) will use one thread per
POSITION instead, where continuation genuinely is the point.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from langgraph.graph import END

from backend.graphs.builder import GraphConfig, build_graph
from backend.graphs.nodes.market import register_market_nodes
from backend.graphs.nodes.memory_loader import (
    MEMORY_LOADER_NODE,
    register_memory_node,
)
from backend.graphs.runtime import RunContext, finish_run, start_run
from backend.graphs.state import TradingState, TriggerReason
from backend.llm.budget import RunBudget

logger = logging.getLogger(__name__)

GRAPH_NAME = "market_state"

_nodes_registered = False


def _ensure_nodes() -> None:
    """Register the nodes once.

    Guarded rather than called at import: the registry raises on a duplicate
    name (deliberately — two implementations claiming one graph position would
    make behaviour depend on import order), and this module can legitimately be
    imported more than once across an app and its tests.

    THE MODULE FLAG IS NOT ENOUGH ON ITS OWN, and this was a real latent bug.
    `_nodes_registered` only knows whether THIS module registered them. Graphs 2 and
    4 register the same market nodes, so:

        analysis_config()      # registers data_validation ...
        market_state_config()  # -> ValueError: node 'data_validation' is already
                               #    registered

    It never surfaced because `main.py` subscribes only Graph 2 and therefore never
    calls this — but any code touching both graphs in one process crashed, which is
    exactly what a dashboard endpoint exposing market state on its own would do. It
    was found by the final spec verification, not by a test.

    `graphs/opportunity.py`, `graphs/analysis.py` and `graphs/monitoring.py` all
    already check the REGISTRY rather than a module flag. This now matches them.
    """
    global _nodes_registered
    if _nodes_registered:
        return
    from backend.graphs.registry import get_contract

    if get_contract("data_validation") is None:
        register_market_nodes()
    if get_contract(MEMORY_LOADER_NODE) is None:
        register_memory_node()
    _nodes_registered = True


def market_state_config() -> GraphConfig:
    """Spec Section 7's chain, as a linear graph.

    Linear on purpose. `market_analysis` (macro) and `feature_generation`
    (technical) are independent and could run in parallel, but parallelism here
    would buy milliseconds on a graph with no model calls, while introducing
    concurrent state writes — and a concurrent-write bug in the node that fetches
    market data is a much worse trade than the latency it saves. The fan-out
    pattern is introduced in Phase 26, where specialists genuinely each take
    seconds.
    """
    _ensure_nodes()
    return GraphConfig(
        name=GRAPH_NAME,
        nodes=[
            "memory_loader",
            "data_validation",
            "feature_generation",
            "market_analysis",
            "regime_detection",
            "market_state",
        ],
        entry="memory_loader",
        edges=[
            ("memory_loader", "data_validation"),
            ("data_validation", "feature_generation"),
            ("feature_generation", "market_analysis"),
            ("market_analysis", "regime_detection"),
            ("regime_detection", "market_state"),
            ("market_state", END),
        ],
    )


async def run_market_state_graph(
    symbol: str,
    trigger: TriggerReason,
    checkpointer: Any = None,
    budget: Optional[RunBudget] = None,
) -> Dict[str, Any]:
    """Run one market-state cycle and return the Section 7 result.

    Never raises. A graph failure returns a result with `ok=False` and the reason,
    because this is called from a bus subscriber — an exception here would
    propagate into the event bus and disturb agents handling live positions.
    """
    _ensure_nodes()

    thread_scope = f"{symbol}-{trigger.kind}"
    state, ctx, thread_id = start_run(
        graph=GRAPH_NAME,
        symbol=symbol,
        trigger=trigger,
        # run_id appended so each cycle is its own thread — see the module note.
        thread_scope=f"{thread_scope}-{{}}",
        budget=budget,
    )
    thread_id = f"{GRAPH_NAME}:{thread_scope}-{state['run_id'][:8]}"

    try:
        graph = build_graph(market_state_config(), ctx, checkpointer=checkpointer)
        config = {"configurable": {"thread_id": thread_id}} if checkpointer else None
        final: TradingState = await (
            graph.ainvoke(state, config=config) if config else graph.ainvoke(state)
        )
    except Exception as e:
        logger.error("Market state graph failed for %s: %s", symbol, e)
        finish_run(ctx, None, outcome="failed", no_decision_reason=f"graph error: {e}",
                   produces_decision=False)
        return {"ok": False, "symbol": symbol, "error": str(e), "runId": ctx.run_id}

    # produces_decision=False: this graph's output is market state, not a
    # trade decision. Without the flag a fully successful run is labelled
    # "no decision produced", which reads as a failure.
    trace = finish_run(ctx, final, produces_decision=False)
    return {"ok": True, "runId": ctx.run_id, "threadId": thread_id, **summarise(final), "traceOutcome": trace.outcome}


def summarise(state: TradingState) -> Dict[str, Any]:
    """The Section 7 output shape, plus what could not be computed.

    Fields are None rather than omitted when unavailable, so a consumer reading
    `result["regime"]` gets an explicit None instead of a KeyError — and the
    `unavailable` list says which of them are missing and why.
    """
    regime = state.get("market_regime")
    technical = state.get("technical_analysis")
    sentiment = state.get("sentiment_analysis")
    snapshot = state.get("market_data")

    return {
        "symbol": state.get("symbol"),
        # --- spec Section 7's example fields ---
        "regime": regime.regime if regime else None,
        "volatility": regime.volatility if regime else None,
        "liquidity": regime.liquidity if regime else None,
        "trend_strength": regime.trend_strength if regime else None,
        "confidence": regime.confidence if regime else None,
        # --- supporting detail ---
        "trend": technical.trend if technical else None,
        "multiTimeframeTrend": technical.multi_timeframe_trend if technical else None,
        "atr": technical.atr if technical else None,
        "rsi": technical.rsi if technical else None,
        "support": technical.support if technical else None,
        "resistance": technical.resistance if technical else None,
        "riskLevel": sentiment.risk_level if sentiment else None,
        "price": snapshot.price if snapshot else None,
        "candlesUsed": snapshot.candle_count() if snapshot else 0,
        # --- honesty fields ---
        "nodesVisited": list(state.get("nodes_visited") or []),
        "unavailable": list(state.get("unavailable") or []),
        "errors": [f"{e.node}: {e.error}" for e in (state.get("errors") or [])],
        # `confidence` above is DATA COVERAGE, not a prediction. Stated in the
        # payload so a consumer cannot mistake it for a probability.
        "confidenceMeaning": "fraction of regime fields that could be computed, not a forecast",
        "liquidityMeaning": "volume-based proxy — NOT order-book depth (no depth feed subscribed)",
    }


# ---------------------------------------------------------------------------
# Trigger subscription (Section 14 -> Section 7)
# ---------------------------------------------------------------------------

_subscribed = False


def subscribe_to_triggers(checkpointer: Any = None) -> None:
    """Run this graph when a trigger fires. Idempotent.

    Ignores suppressed triggers: the trigger layer already applied debounce and
    the rate ceilings, and re-deciding here would either duplicate that logic or
    contradict it.
    """
    global _subscribed
    if _subscribed:
        return

    from backend.core.message_bus import get_message_bus
    from backend.models.events import BaseEvent, TriggerFiredEvent

    async def on_trigger(event: BaseEvent) -> None:
        if not isinstance(event, TriggerFiredEvent):
            return
        if not event.acted:
            # Already suppressed upstream. Not an error, and not logged at info —
            # suppressions are common by design.
            return
        # The exchange-health trigger is not about one instrument, so there is no
        # symbol to analyse.
        if event.symbol.startswith("__"):
            return

        trigger = TriggerReason(
            kind=event.kind,
            symbol=event.symbol,
            detail=event.detail,
            observed_value=event.observed_value,
            threshold=event.threshold,
        )
        result = await run_market_state_graph(event.symbol, trigger, checkpointer=checkpointer)
        if result.get("ok"):
            logger.info(
                "Market state run %s for %s: regime=%s confidence=%s",
                result["runId"][:8], event.symbol, result.get("regime"), result.get("confidence"),
            )

    get_message_bus().subscribe("TRIGGER_FIRED", on_trigger)
    _subscribed = True
    logger.info("Market state graph subscribed to TRIGGER_FIRED")


def reset_subscription() -> None:
    """For tests."""
    global _subscribed, _nodes_registered
    _subscribed = False
    _nodes_registered = False
