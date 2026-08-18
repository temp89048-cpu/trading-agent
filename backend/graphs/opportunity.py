"""Graph 2 (part 1) — Trading Opportunity (spec Section 8 / Phase 25).

    Market State -> Strategy Candidates -> Strategy Scoring
                 -> Opportunity Detection -> Trade Thesis

WHY THIS GRAPH INCLUDES THE MARKET-STATE NODES RATHER THAN CHAINING TO THEM
--------------------------------------------------------------------------
Section 8's input is "Market State", which Phase 24 produces. Two ways to
compose that: run the market-state graph, then hand its output to a second graph,
or run one graph containing both stages.

One graph, because `TradingState` is the whole point (Section 4). Passing state
between two graph invocations means serialising it out and back, and the moment
that happens the second graph is free to re-fetch — which is exactly the Section
39.4 replay hazard `market_data`'s write-once rule exists to prevent. Keeping it
one run keeps one snapshot.

Section 35's "multiple graphs, not one giant graph" is still respected: this is
Graph 2 of seven, and it stops at a thesis. It does not decide, size, or approve —
Phases 26-28 add those as their own stages.

EARLY EXIT IS THE COMMON CASE
-----------------------------
Most runs will not produce a thesis: no regime, every strategy gated out, the best
score below the minimum, or no ATR for a stop. The graph routes straight to END on
each, and the reason lands in `unavailable`.

That is not a failure path to minimise — it is the expected path. A market-state
run that ends with "Mean Reversion and Grid are muted in a trending regime and
nothing else signalled" is the system working.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Optional

from langgraph.graph import END

from backend.graphs.builder import ConditionalEdge, GraphConfig, build_graph
from backend.graphs.nodes.market import register_market_nodes
from backend.graphs.nodes.memory_loader import (
    MEMORY_LOADER_NODE,
    register_memory_node,
)
from backend.graphs.nodes.opportunity import register_opportunity_nodes
from backend.graphs.runtime import finish_run, start_run
from backend.graphs.state import TradingState, TriggerReason
from backend.llm.budget import RunBudget

logger = logging.getLogger(__name__)

GRAPH_NAME = "trading_opportunity"

_nodes_registered = False


def _ensure_nodes() -> None:
    """Register both node sets once. See market_state._ensure_nodes for why the
    guard exists (the registry raises on duplicate names, deliberately)."""
    global _nodes_registered
    if _nodes_registered:
        return
    from backend.graphs.registry import get_contract

    # Market nodes may already be registered by the market_state module. Checking
    # rather than catching keeps a genuine duplicate-name bug visible instead of
    # swallowing it.
    if get_contract("data_validation") is None:
        register_market_nodes()
    if get_contract("strategy_candidates") is None:
        register_opportunity_nodes()
    # Phase 32 / Section 15. Registered here so Graph 2 can begin with memory.
    if get_contract(MEMORY_LOADER_NODE) is None:
        register_memory_node()
    _nodes_registered = True


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

def _after_scoring(state: TradingState) -> str:
    """Continue only if a strategy was actually selected."""
    return "opportunity" if state.get("selected_strategy") is not None else "no_opportunity"


def _after_opportunity(state: TradingState) -> str:
    """Narrate only if there is a thesis to narrate.

    Checked here rather than inside the node so the LLM node is never entered
    without work — an entered-then-returned node still costs a superstep and a
    checkpoint write, and appears in the trace as though it ran.
    """
    return "narrate" if state.get("trade_thesis") is not None else "no_opportunity"


def opportunity_config() -> GraphConfig:
    """Section 7's chain, then Section 8's."""
    _ensure_nodes()
    return GraphConfig(
        name=GRAPH_NAME,
        nodes=[
            # Phase 32 / Section 15. FIRST, so every later node — the strategy
            # scorer, the specialists, the Supervisor — reasons over the same
            # history rather than each fetching its own or none at all.
            #
            # It was previously wired only into `market_state_config` (Graph 1),
            # which `main.py` deliberately does not subscribe: Graph 2 contains all
            # of Graph 1's stages, so subscribing both would run them twice. The
            # effect was that Phase 32's memory loader lived in a graph that never
            # ran in production, and no decision ever saw memory.
            MEMORY_LOADER_NODE,
            # Phase 24
            "data_validation",
            "feature_generation",
            "market_analysis",
            "regime_detection",
            "market_state",
            # Phase 25
            "strategy_candidates",
            "strategy_scoring",
            "opportunity_detection",
            "trade_thesis_narrative",
        ],
        entry=MEMORY_LOADER_NODE,
        edges=[
            (MEMORY_LOADER_NODE, "data_validation"),
            ("data_validation", "feature_generation"),
            ("feature_generation", "market_analysis"),
            ("market_analysis", "regime_detection"),
            ("regime_detection", "market_state"),
            ("market_state", "strategy_candidates"),
            ("strategy_candidates", "strategy_scoring"),
            ("trade_thesis_narrative", END),
        ],
        conditional_edges=[
            ConditionalEdge(
                source="strategy_scoring",
                router=_after_scoring,
                destinations={"opportunity": "opportunity_detection", "no_opportunity": END},
            ),
            ConditionalEdge(
                source="opportunity_detection",
                router=_after_opportunity,
                destinations={"narrate": "trade_thesis_narrative", "no_opportunity": END},
            ),
        ],
    )


async def run_opportunity_graph(
    symbol: str,
    trigger: TriggerReason,
    checkpointer: Any = None,
    budget: Optional[RunBudget] = None,
) -> Dict[str, Any]:
    """Run one opportunity cycle. Never raises — called from a bus subscriber."""
    _ensure_nodes()

    state, ctx, _ = start_run(
        graph=GRAPH_NAME,
        symbol=symbol,
        trigger=trigger,
        thread_scope=f"{symbol}-{trigger.kind}",
        budget=budget,
    )
    thread_id = f"{GRAPH_NAME}:{symbol}-{trigger.kind}-{state['run_id'][:8]}"

    try:
        graph = build_graph(opportunity_config(), ctx, checkpointer=checkpointer)
        config = {"configurable": {"thread_id": thread_id}} if checkpointer else None
        final: TradingState = await (
            graph.ainvoke(state, config=config) if config else graph.ainvoke(state)
        )
    except Exception as e:
        logger.error("Opportunity graph failed for %s: %s", symbol, e)
        finish_run(ctx, None, outcome="failed", no_decision_reason=f"graph error: {e}",
                   produces_decision=False)
        return {"ok": False, "symbol": symbol, "error": str(e), "runId": ctx.run_id}

    # produces_decision=False: Phase 25 ends at a THESIS. Deciding whether to act
    # on it is Phase 27's job, and labelling this run "no decision produced" would
    # report a successful thesis as a failure.
    trace = finish_run(ctx, final, produces_decision=False)
    return {"ok": True, "runId": ctx.run_id, "threadId": thread_id,
            **summarise_opportunity(final), "traceOutcome": trace.outcome}


def summarise_opportunity(state: TradingState) -> Dict[str, Any]:
    """Section 8's output shape.

    Includes the full scored candidate list, not just the winner. The spec's own
    example shows the losers with their scores (Mean Reversion 0.32), because
    "Trend Following was chosen over Breakout 0.84 and Mean Reversion 0.32" is a
    materially different statement from "Trend Following was chosen".
    """
    from backend.graphs.market_state import summarise as summarise_market

    thesis = state.get("trade_thesis")
    selected = state.get("selected_strategy")
    candidates = state.get("candidate_strategies") or []

    return {
        **summarise_market(state),
        # --- Section 8 fields ---
        "candidates": [
            {
                "name": c.name,
                "score": c.score,
                "eligible": c.eligible,
                "gatedOutReason": c.gated_out_reason,
            }
            for c in candidates
        ],
        "selectedStrategy": selected.name if selected else None,
        "selectedScore": selected.score if selected else None,
        "thesis": None if thesis is None else {
            "direction": thesis.direction,
            "strategy": thesis.strategy,
            "entryPrice": thesis.entry_price,
            "stopLoss": thesis.stop_loss,
            "takeProfit": thesis.take_profit,
            "supportingEvidence": thesis.supporting_evidence,
            "contradictingEvidence": thesis.contradicting_evidence,
            # Recombined from the separate state field. The model wrote only this
            # string; every number above is computed.
            "narrative": state.get("thesis_narrative"),
        },
        "hasOpportunity": thesis is not None,
        "llmCallsMade": state.get("llm_calls_made") or 0,
        "llmTokensUsed": state.get("llm_tokens_used") or 0,
        "narrativeMeaning": (
            "prose only — written by a model from the computed figures above, and "
            "structurally unable to alter them"
        ),
    }


# ---------------------------------------------------------------------------
# Trigger subscription
# ---------------------------------------------------------------------------

_subscribed = False


def subscribe_to_triggers(checkpointer: Any = None) -> None:
    """Run the opportunity graph when a trigger fires. Idempotent.

    This REPLACES the market-state subscription rather than adding to it: this
    graph already contains all five market-state nodes, so subscribing both would
    run the Phase 24 stages twice per trigger for one usable result.
    `main.py` wires this one only.
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
            return
        if event.symbol.startswith("__"):
            return

        trigger = TriggerReason(
            kind=event.kind,
            symbol=event.symbol,
            detail=event.detail,
            observed_value=event.observed_value,
            threshold=event.threshold,
        )
        result = await run_opportunity_graph(event.symbol, trigger, checkpointer=checkpointer)
        if result.get("ok"):
            if result.get("hasOpportunity"):
                logger.info(
                    "Opportunity run %s for %s: %s %s at %s (score %s)",
                    result["runId"][:8], event.symbol,
                    result["thesis"]["direction"], result["selectedStrategy"],
                    result["thesis"]["entryPrice"], result["selectedScore"],
                )
            else:
                # Logged at info, not warning: no opportunity is the expected
                # outcome of most runs.
                logger.info(
                    "Opportunity run %s for %s: no thesis. %s",
                    result["runId"][:8], event.symbol,
                    "; ".join(result["unavailable"][-2:]) or "no reason recorded",
                )

    get_message_bus().subscribe("TRIGGER_FIRED", on_trigger)
    _subscribed = True
    logger.info("Trading opportunity graph subscribed to TRIGGER_FIRED")


def reset_subscription() -> None:
    """For tests."""
    global _subscribed, _nodes_registered
    _subscribed = False
    _nodes_registered = False
