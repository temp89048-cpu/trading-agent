import logging
from typing import Dict, Any, TypedDict, Optional, List
from langgraph.graph import StateGraph, END
import time

logger = logging.getLogger(__name__)

class ReflectionState(TypedDict):
    # Inputs
    trade_receipt: Dict[str, Any]
    
    # Context
    market_context: Dict[str, Any]
    
    # Analysis
    execution_quality: str
    execution_quality_detail: str
    outcome_classification: str
    attribution: List[str]
    
    # Outputs
    lesson: str
    confidence_delta: float

async def collect_context(state: ReflectionState) -> ReflectionState:
    """Read the real memory context for this symbol.

    Previously returned `{"note": "Context fetch stubbed"}`. A stub is at least
    visible; what made it worth fixing is that Section 15's memory layer already
    exists and `fetch_memory_context` reads all seven stores, so the context was
    available and simply not asked for.
    """
    symbol = state["trade_receipt"].get("symbol")
    if not symbol:
        state["market_context"] = {
            "unavailable": ["no symbol on the trade receipt, so no memory to read"]
        }
        return state

    try:
        from backend.services.memory_manager import fetch_memory_context

        state["market_context"] = await fetch_memory_context(symbol)
    except Exception as exc:  # noqa: BLE001
        # Recorded, not substituted. A reflection written against invented context
        # produces a lesson about a market that did not happen.
        logger.error("Reflection could not read memory for %s: %s", symbol, exc)
        state["market_context"] = {"unavailable": [f"memory context: {exc}"]}
    return state


async def analyze_execution(state: ReflectionState) -> ReflectionState:
    """Read the MEASURED execution score, or report that there is none.

    This used to be `state["execution_quality"] = "Good"` unconditionally — every
    trade in the system's history graded itself Good, which is the same class of bug
    as slippage hardcoded to 0.0 giving every fill a perfect score.

    It matters more than it looks: `generate_lesson` and the confidence calibration
    both read this, so a permanent "Good" means execution is never identified as the
    cause of a loss, and the system can never learn that it is filling badly.

    `agents/execution_agent._persist_execution_quality` writes a real score to the
    `execution_quality` table, with a deliberately NULLABLE score — a fill with no
    reference price is not a bad fill. That distinction is preserved here:
    'unavailable' is not 'Poor'.
    """
    receipt = state["trade_receipt"]
    order_id = receipt.get("orderId") or receipt.get("order_id")

    if not order_id:
        state["execution_quality"] = "unavailable"
        state["execution_quality_detail"] = (
            "no order id on the trade receipt, so the persisted execution score "
            "cannot be looked up"
        )
        return state

    try:
        from backend.core.db import get_db_pool

        pool = get_db_pool()
        if pool is None:
            state["execution_quality"] = "unavailable"
            state["execution_quality_detail"] = (
                "no database pool — execution_quality lives in Postgres, which is "
                "not provisioned by default. This is NOT a good fill."
            )
            return state

        async with pool.acquire() as conn:
            row = await conn.fetchrow(
                "SELECT score, slippage_bps, latency_ms, fully_filled, notes "
                "FROM execution_quality WHERE order_id = $1",
                str(order_id),
            )
    except Exception as exc:  # noqa: BLE001
        logger.error("Execution quality lookup failed for %s: %s", order_id, exc)
        state["execution_quality"] = "unavailable"
        state["execution_quality_detail"] = f"lookup failed: {exc}"
        return state

    if row is None or row["score"] is None:
        # A NULL score means not measurable, which the Evaluation layer must exclude
        # from averages rather than treat as zero.
        state["execution_quality"] = "unavailable"
        state["execution_quality_detail"] = (
            f"no measurable score for order {order_id}"
            + ("" if row is None else " (score is NULL — no reference price)")
        )
        return state

    score = float(row["score"])
    state["execution_quality"] = (
        "Good" if score >= 0.7 else "Fair" if score >= 0.4 else "Poor"
    )
    state["execution_quality_detail"] = (
        f"score {score:.3f} (slippage {row['slippage_bps']} bps, "
        f"latency {row['latency_ms']} ms, fully filled={row['fully_filled']})"
    )
    return state

def outcome_analysis(state: ReflectionState) -> ReflectionState:
    """Classify the trade as success or failure and attribute it."""
    receipt = state["trade_receipt"]
    pnl = float(receipt.get("pnl", 0.0))
    won = pnl >= 0
    strategies = receipt.get("strategies", []) or []
    
    state["outcome_classification"] = "Success" if won else "Failure"
    
    attribution = []
    if not won:
        if "trend" in strategies and "mean_reversion" not in strategies:
            attribution.append("Trend entry failed, possible mean reversion or false breakout.")
        elif "breakout" in strategies:
            attribution.append("Breakout failed, possible false breakout.")
    
    state["attribution"] = attribution
    return state

def generate_lesson(state: ReflectionState) -> ReflectionState:
    """Generate a specific, testable lesson."""
    receipt = state["trade_receipt"]
    won = state["outcome_classification"] == "Success"
    attribution = state["attribution"]
    
    if won:
        lesson = "No strict recommendation from a single winning trade. Continue monitoring repeatability."
    else:
        if attribution:
            lesson = f"Check if {attribution[0]} correlates with this regime."
        else:
            lesson = "Check if losses cluster in this regime before changing weighting."
            
    state["lesson"] = lesson
    # Delegated, not re-derived. `reflection_agent` already owns this formula, and
    # two copies of a calibration rule that feeds position sizing would drift —
    # this file originally copied the expression verbatim.
    from backend.agents.reflection_agent import calibration_delta

    state["confidence_delta"] = calibration_delta(float(receipt.get("pnl", 0.0)))

    return state

async def store_memory(state: ReflectionState) -> ReflectionState:
    """Store the lesson into Semantic Memory (and log it)."""
    from backend.services.semantic_memory import upsert_entity, add_relationship
    
    lesson_id = f"lesson_{int(time.time())}"
    await upsert_entity(
        entity_id=lesson_id,
        entity_type="TradeLesson",
        properties={
            "lesson": state["lesson"],
            "outcome": state["outcome_classification"],
            "trade_symbol": state["trade_receipt"].get("symbol", "UNKNOWN")
        }
    )
    
    # Link to strategies
    strategies = state["trade_receipt"].get("strategies", []) or []
    for strat in strategies:
        await upsert_entity(strat, "Strategy", {"name": strat})
        await add_relationship(strat, lesson_id, "has_lesson", weight=1.0)
        
    return state


# Compiled lazily, once. See `reflection_agent.analyze_mistake` for why.
_compiled = None


def get_reflection_graph():
    """The compiled graph, built on first use and reused.

    WHY THIS ONE IS STILL A LANGGRAPH GRAPH, unlike `strategy_selection_graph` and
    `execution_graph` which were both converted to plain functions:

    it is genuinely asynchronous and does real I/O — reading the seven memory stores,
    looking up a persisted execution-quality row, writing lessons and relationships
    into semantic memory. Those are the conditions under which a graph's error
    capture and per-node structure earn their cost, and it runs once per CLOSED TRADE
    rather than inside a scoring loop.

    KNOWN GAP, stated rather than hidden: it still uses its own `ReflectionState`
    rather than `TradingState`, so it does NOT go through `build_graph` and gets no
    `NodeContract` validation, no declared-write enforcement and no run tracing. Spec
    Section 4 wants one shared state. Closing it means adding a `closed_trade` field to
    `TradingState` and mapping five nodes onto it — a real change to a working path,
    and the last remaining item of the Sections 14-41 audit.
    """
    global _compiled
    if _compiled is None:
        _compiled = build_reflection_graph()
    return _compiled


def build_reflection_graph() -> StateGraph:
    workflow = StateGraph(ReflectionState)

    workflow.add_node("collect_context", collect_context)
    workflow.add_node("analyze_execution", analyze_execution)
    workflow.add_node("outcome_analysis", outcome_analysis)
    workflow.add_node("generate_lesson", generate_lesson)
    workflow.add_node("store_memory", store_memory)

    workflow.set_entry_point("collect_context")
    workflow.add_edge("collect_context", "analyze_execution")
    workflow.add_edge("analyze_execution", "outcome_analysis")
    workflow.add_edge("outcome_analysis", "generate_lesson")
    workflow.add_edge("generate_lesson", "store_memory")
    workflow.add_edge("store_memory", END)

    return workflow.compile()
