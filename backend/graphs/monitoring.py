"""Graph 4 — Position Monitoring (spec Section 13 / Phase 30).

    Market State -> Portfolio -> Position Snapshot
                 -> [Price Levels, Market Conditions, Portfolio Risk]  (parallel)
                 -> Decision: HOLD | REDUCE | MODIFY | EXIT

THIS IS THE FIRST GRAPH THAT CHECKPOINTS, AND THAT IS THE POINT
--------------------------------------------------------------
Graphs 1 and 2 pass `checkpointer=None` deliberately: their runs are seconds long
and there is nothing to resume. Writing a checkpoint row per trigger for state no
one reads is cost without benefit.

A POSITION is different. It exists across restarts, and the reasoning about it is
the record of why it is still open — every trailing decision, every deferred exit.
`thread_id` is keyed on the POSITION, not the run, so one thread accumulates the
whole history of one position and a restart resumes it rather than starting a fresh
opinion.

That is also why `AsyncSqliteSaver` and not `MemorySaver`: an in-memory
checkpointer for durability across restarts is a contradiction, and
`build_checkpointer` returns None rather than silently falling back to one.

WHY IT REUSES THE PHASE 24 AND 26 NODES
---------------------------------------
Section 13's nine dimensions need a regime, volatility, funding and a portfolio —
all of which already have nodes. Re-deriving them here would mean two definitions
of "what regime is BTC in", and a monitoring graph that disagreed with the entry
graph about that would be worse than one that could not tell.

`specialist_portfolio` is included solely because it is the only writer of
`portfolio_state`. It also emits a `specialist_findings` entry, which is harmless:
that key is separate from `monitor_findings`, so an entry-panel finding cannot be
mistaken for a monitoring one.

THE GRAPH DECIDES. THE RUNNER ACTS.
-----------------------------------
Nodes are pure. An EXIT or REDUCE becomes an `EXECUTION_PLAN_READY` with
`intent='close'`, published by the runner down the same ungated close path Phase 29
built. A MODIFY becomes a `tighten_stop` call on the monitor agent, which is the
authority and refuses anything that is not tighter.

Neither happens inside a node. A node that closed positions would make acting a
side effect of reasoning, and the import ban means it could not reach the
chokepoint anyway.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from langgraph.graph import END

from backend.graphs.builder import ConditionalEdge, GraphConfig, build_graph
from backend.graphs.nodes.market import register_market_nodes
from backend.graphs.nodes.memory_loader import (
    MEMORY_LOADER_NODE,
    register_memory_node,
)
from backend.graphs.nodes.monitoring import (
    MONITOR_DIMENSIONS,
    MONITOR_NODES,
    POSITION_DECISION_NODE,
    POSITION_SNAPSHOT_NODE,
    register_monitoring_nodes,
)
from backend.graphs.nodes.specialists import register_specialist_nodes
from backend.graphs.runtime import finish_run, start_run, thread_id_for
from backend.graphs.state import MonitoredPosition, TradingState, TriggerReason
from backend.llm.budget import RunBudget

logger = logging.getLogger(__name__)

GRAPH_NAME = "position_monitoring"
PORTFOLIO_NODE = "specialist_portfolio"

_nodes_registered = False


def _ensure_nodes() -> None:
    global _nodes_registered
    if _nodes_registered:
        return
    from backend.graphs.registry import get_contract

    if get_contract("data_validation") is None:
        register_market_nodes()
    if get_contract(PORTFOLIO_NODE) is None:
        register_specialist_nodes()
    if get_contract(POSITION_SNAPSHOT_NODE) is None:
        register_monitoring_nodes()
    if get_contract(MEMORY_LOADER_NODE) is None:
        register_memory_node()
    _nodes_registered = True


def _after_snapshot(state: TradingState) -> str:
    """Fan out only when the position could actually be measured.

    `load_position` returns no enriched position when there is no live price, and
    every one of the nine dimensions is a function of current price. Running them
    against an unmeasurable position would produce nine "unavailable" findings and
    a HOLD that looked like a considered decision.
    """
    position = state.get("monitored_position")
    return "monitor" if position is not None and position.current_price else "cannot_monitor"


def monitoring_config() -> GraphConfig:
    _ensure_nodes()
    return GraphConfig(
        name=GRAPH_NAME,
        nodes=[
            # Phase 32 / Section 15. This graph decides EXIT, so past risk events
            # and lessons are as relevant here as at entry.
            MEMORY_LOADER_NODE,
            # Phase 24 — one market fetch for the whole run (Section 39.4).
            "data_validation",
            "feature_generation",
            "market_analysis",
            "regime_detection",
            "market_state",
            # Phase 26 — the only writer of `portfolio_state`.
            PORTFOLIO_NODE,
            # Phase 30.
            POSITION_SNAPSHOT_NODE,
            *MONITOR_NODES,
            POSITION_DECISION_NODE,
        ],
        entry=MEMORY_LOADER_NODE,
        edges=[
            (MEMORY_LOADER_NODE, "data_validation"),
            ("data_validation", "feature_generation"),
            ("feature_generation", "market_analysis"),
            ("market_analysis", "regime_detection"),
            ("regime_detection", "market_state"),
            ("market_state", PORTFOLIO_NODE),
            (PORTFOLIO_NODE, POSITION_SNAPSHOT_NODE),
            *[(node, POSITION_DECISION_NODE) for node in MONITOR_NODES],
            (POSITION_DECISION_NODE, END),
        ],
        conditional_edges=[
            ConditionalEdge(
                source=POSITION_SNAPSHOT_NODE,
                router=_after_snapshot,
                # A tuple: all three monitor nodes run in one superstep.
                destinations={"monitor": MONITOR_NODES, "cannot_monitor": END},
            ),
        ],
    )


async def run_monitoring_graph(
    position: MonitoredPosition,
    trigger: TriggerReason,
    checkpointer: Any = None,
    budget: Optional[RunBudget] = None,
) -> Dict[str, Any]:
    """Run one monitoring cycle for one position. Never raises.

    `thread_scope` is the POSITION, not the run. One thread per position means the
    checkpointer accumulates that position's whole reasoning history, and a restart
    resumes it instead of forming a fresh opinion with no memory of the trailing
    decisions already made.
    """
    _ensure_nodes()

    state, ctx, _ = start_run(
        graph=GRAPH_NAME,
        symbol=position.symbol,
        trigger=trigger,
        thread_scope=f"position:{position.tar_id}",
        budget=budget,
    )
    # The position identity is injected here rather than loaded by a node, so the
    # graph has exactly one source of truth for what it is monitoring and cannot
    # pick a different position mid-run.
    state["monitored_position"] = position
    thread_id = thread_id_for(GRAPH_NAME, f"position:{position.tar_id}")

    try:
        graph = build_graph(monitoring_config(), ctx, checkpointer=checkpointer)
        config = {"configurable": {"thread_id": thread_id}} if checkpointer else None
        final: TradingState = await (
            graph.ainvoke(state, config=config) if config else graph.ainvoke(state)
        )
    except Exception as e:
        logger.error("Monitoring graph failed for %s: %s", position.symbol, e)
        finish_run(ctx, None, outcome="failed",
                   no_decision_reason=f"graph error: {e}", produces_decision=False)
        return {"ok": False, "symbol": position.symbol, "error": str(e),
                "runId": ctx.run_id}

    # produces_decision=False: this graph writes `position_decision`, not `decision`.
    # `finish_run` looks for the latter, so leaving the default True would label
    # every successful monitoring run "no decision produced".
    trace = finish_run(ctx, final, produces_decision=False)
    return {
        "ok": True, "runId": ctx.run_id, "threadId": thread_id,
        **summarise_monitoring(final),
        "traceOutcome": trace.outcome,
    }


def summarise_monitoring(state: TradingState) -> Dict[str, Any]:
    """Section 13's output shape.

    Reports all nine dimensions including the ones that could not run, and names
    which. A HOLD from four measurable dimensions and a HOLD from nine are
    different statements, and only one of them is reassuring.
    """
    position = state.get("monitored_position")
    decision = state.get("position_decision")
    findings = state.get("monitor_findings") or []
    by_name = {f.specialist: f for f in findings}

    return {
        "symbol": state.get("symbol"),
        "position": None if position is None else {
            "tarId": position.tar_id,
            "side": position.side,
            "tab": position.tab,
            "qty": position.qty,
            "entryPrice": position.entry_price,
            "currentPrice": position.current_price,
            "stopLoss": position.stop_loss,
            "takeProfit": position.take_profit,
            "unrealisedPnl": position.unrealised_pnl,
            "unrealisedPct": position.unrealised_pct,
            "rMultiple": position.r_multiple,
            "heldHours": (position.held_seconds / 3600.0
                          if position.held_seconds is not None else None),
        },
        # Every one of Section 13's nine, in the spec's order, present or not.
        "dimensions": [
            {
                "name": name,
                "reported": name in by_name,
                "available": by_name[name].available if name in by_name else False,
                "role": by_name[name].role if name in by_name else None,
                "stance": by_name[name].stance if name in by_name else None,
                "confidence": by_name[name].confidence if name in by_name else None,
                "concern": by_name[name].concern if name in by_name else None,
                "evidence": by_name[name].evidence if name in by_name else [],
                "reasonUnavailable": (
                    by_name[name].reason_unavailable if name in by_name
                    else "dimension did not report at all"
                ),
            }
            for name in MONITOR_DIMENSIONS
        ],
        "dimensionsAvailable": sum(
            1 for n in MONITOR_DIMENSIONS if n in by_name and by_name[n].available
        ),
        "dimensionsTotal": len(MONITOR_DIMENSIONS),
        "decision": None if decision is None else {
            "action": decision.action,
            "reason": decision.reason,
            "reduceQty": decision.reduce_qty,
            "newStopLoss": decision.new_stop_loss,
            "evidence": decision.evidence,
            "unavailable": decision.unavailable,
        },
        "unavailable": list(state.get("unavailable") or []),
        "rMultipleMeaning": (
            "profit in units of the INITIAL risk (the entry-to-stop distance). 1R "
            "means the position has made as much as it was prepared to lose, which "
            "is the point the stop is moved to break-even. Dollars alone say nothing "
            "without the risk that bought them"
        ),
        "stopMeaning": (
            "a MODIFY only ever proposes a TIGHTER stop. PositionMonitorAgent."
            "tighten_stop is the authority and refuses to widen one, because widening "
            "increases risk beyond what the Risk Gateway approved and sized against — "
            "the per-trade limit was computed from the entry-to-stop distance"
        ),
        "notASecondStopMeaning": (
            "this graph never fires a stop. position_monitor.py enforces levels on "
            "every tick and remains the only thing that does; when price is already "
            "through a level this graph returns HOLD and defers, because racing a "
            "faster component to a close it is already performing would double-submit"
        ),
        "exitMeaning": (
            "EXIT here means the THESIS is invalidated, not that price went against "
            "us — that is what the stop is for, and duplicating it would give the "
            "position two stops at different distances"
        ),
    }


# ---------------------------------------------------------------------------
# Acting on the decision — the runner, not a node
# ---------------------------------------------------------------------------

async def apply_decision(
    result: Dict[str, Any],
    position: MonitoredPosition,
    monitor_agent: Any = None,
) -> Dict[str, Any]:
    """Turn a decision into the one action it implies. Never raises.

    Separate from `run_monitoring_graph` so a caller can inspect a decision without
    acting on it — which is what the tests and any dry-run mode need.

    HOLD does nothing, deliberately and visibly: returning an explicit
    `{"applied": False, "action": "HOLD"}` rather than None means "we looked and
    chose not to act" is distinguishable from "nothing ran".
    """
    decision = (result or {}).get("decision")
    if not decision or not decision.get("action"):
        return {"applied": False, "action": None,
                "reason": "no decision was produced"}

    action = decision["action"]

    if action == "HOLD":
        return {"applied": False, "action": "HOLD", "reason": decision.get("reason")}

    if action == "MODIFY":
        return await _apply_modify(decision, position, monitor_agent)

    if action in ("EXIT", "REDUCE"):
        return await _apply_close(decision, position, action)

    return {"applied": False, "action": action,
            "reason": f"unrecognised action '{action}'"}


async def _apply_modify(
    decision: Dict[str, Any], position: MonitoredPosition, monitor_agent: Any
) -> Dict[str, Any]:
    """Ask the monitor agent to tighten the stop. It may refuse, and that is fine.

    A refusal is not an error: a trailing rule proposing a stop that is already
    worse than the current one is ordinary, and the agent is the authority on which
    is tighter precisely so a bug here cannot widen one.
    """
    new_stop = decision.get("newStopLoss")
    if new_stop is None:
        return {"applied": False, "action": "MODIFY",
                "reason": "MODIFY carried no proposed stop"}

    if monitor_agent is None:
        return {"applied": False, "action": "MODIFY",
                "reason": ("no monitor agent attached, so the stop could not be "
                           "tightened. The existing stop still stands — this is a "
                           "wiring failure, not a loss of protection.")}

    applied, reason = monitor_agent.tighten_stop(position.tar_id, new_stop)
    logger.info(
        "MODIFY on %s: %s (%s)", position.symbol,
        "applied" if applied else "refused", reason,
    )
    return {"applied": applied, "action": "MODIFY", "reason": reason,
            "newStopLoss": new_stop if applied else None}


async def _apply_close(
    decision: Dict[str, Any], position: MonitoredPosition, action: str
) -> Dict[str, Any]:
    """Publish a close request down Phase 29's ungated path.

    A REDUCE closes part of the position and an EXIT closes all of it; both are
    closes, so both take the path that no risk check, kill switch or CRO can block
    (invariant 4). The `intent='close'` field is what routes them.

    The idempotency basis includes the ACTION and the QUANTITY, so a later EXIT on
    a position that was previously REDUCEd is a genuinely new request rather than a
    duplicate of the partial close.
    """
    import hashlib

    qty = decision.get("reduceQty") if action == "REDUCE" else (
        abs(position.qty) if position.qty else None
    )
    if not qty or qty <= 0:
        return {"applied": False, "action": action,
                "reason": ("no quantity to close could be determined; refusing to "
                           "guess a size")}

    # Closing a long is a sell.
    side = "sell" if position.side == "buy" else "buy"
    basis = hashlib.sha256(
        f"monitor|{position.tar_id}|{action}|{qty:.10g}".encode("utf-8")
    ).hexdigest()[:32]

    try:
        from backend.core.message_bus import get_message_bus
        from backend.models.events import ExecutionPlanReadyEvent

        await get_message_bus().publish("EXECUTION_PLAN_READY", ExecutionPlanReadyEvent(
            symbol=position.symbol,
            intent="close",
            side=side,
            tab=position.tab,
            idempotency_basis=basis,
            size=qty,
            leverage=1,
            # No stop or target on a close — the close IS the exit.
            stop_loss=None,
            take_profit=None,
            rationale=decision.get("reason"),
        ))
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "Could not publish the %s for %s: %s. The position is still open.",
            action, position.symbol, exc,
        )
        return {"applied": False, "action": action,
                "reason": f"could not publish the close request: {exc}"}

    logger.info(
        "%s on %s: published a close for %.10g (%s)",
        action, position.symbol, qty, side,
    )
    return {"applied": True, "action": action, "closeQty": qty,
            "idempotencyBasis": basis, "reason": decision.get("reason")}


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------

def positions_from_agent(monitor_agent: Any) -> List[MonitoredPosition]:
    """Read the monitor agent's book into graph state objects.

    Goes through `snapshot_open()`, which returns copies. Holding a `_Tracked`
    reference would let a caller assign `stop_loss` directly and bypass
    `tighten_stop`'s widen-refusal — the one rule in this phase that must not be
    bypassable.
    """
    out: List[MonitoredPosition] = []
    for row in monitor_agent.snapshot_open():
        out.append(MonitoredPosition(
            tar_id=row["tarId"],
            symbol=row["symbol"],
            side=row["side"],
            tab=row.get("tab") or "paper",
            qty=row.get("qty"),
            entry_price=row.get("entryPrice"),
            stop_loss=row.get("stopLoss"),
            take_profit=row.get("takeProfit"),
            opened_at_ts=row.get("openedAtTs"),
            peak_price=row.get("peakPrice"),
        ))
    return out


async def monitor_all_positions(
    monitor_agent: Any,
    trigger: TriggerReason,
    checkpointer: Any = None,
) -> List[Dict[str, Any]]:
    """Run one monitoring cycle for every open position, and act on each.

    Sequential rather than concurrent. Three reasons, and the third is the real
    one: each run does market I/O for its own symbol so there is little to overlap;
    a shared checkpointer would see concurrent writes; and an EXIT on one position
    changes the portfolio exposure the next position's `portfolio_risk` dimension
    reads. Running them at once would have each decide against a book that was
    already stale.
    """
    results: List[Dict[str, Any]] = []
    for position in positions_from_agent(monitor_agent):
        result = await run_monitoring_graph(position, trigger, checkpointer=checkpointer)
        outcome = await apply_decision(result, position, monitor_agent)
        results.append({**result, "applied": outcome})
    return results


def reset_registration() -> None:
    """For tests."""
    global _nodes_registered
    _nodes_registered = False
