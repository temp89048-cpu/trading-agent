"""Graph 2 complete — Trade Analysis (spec Sections 7, 8 and 9 / Phases 24-26).

    Market State -> Strategy Selection -> Opportunity
                 -> 7 Specialists (parallel) -> Debate -> Thesis Narrative

WHY THIS IS A SEPARATE MODULE FROM `opportunity.py`
--------------------------------------------------
`opportunity_config()` is the Phase 25 milestone: the chain that ends at a thesis.
It has tests asserting its node list and its early-exit routing, and it remains
useful on its own for exercising that stage without the fan-out.

This module EXTENDS that config rather than copying it — `analysis_config()` reads
`opportunity_config()` and rewires only its tail. Copying the nine Phase 24/25
nodes here would mean the two graphs could silently diverge, and the one that
production runs would be the copy.

WHY THE SPECIALISTS RUN AFTER THE THESIS, NOT BEFORE
----------------------------------------------------
Section 35's Graph 2 orders it this way, and the reason holds up: the fan-out is
the most expensive stage (seven nodes, one of them doing portfolio I/O), and most
runs never reach it. A run where every strategy is muted or no ATR exists exits
at `strategy_scoring` or `opportunity_detection` and the panel never convenes.

It also gives the panel something specific to argue about. A specialist asked
"what do you think of BTC" is answering a vaguer question than one asked "here is
a LONG at 104,200 with a stop at 102,900 — what does your evidence say about
that". The debate can now CONTRADICT the strategy's chosen direction, which is
the point of having one.

WHY THE NARRATIVE MOVED TO THE END
----------------------------------
In Phase 25 `trade_thesis_narrative` ran straight after `opportunity_detection`.
It now runs after the debate, and its prompt includes the verdict.

That is a correctness fix, not a reshuffle. The node's own system prompt requires
it to state the contradicting evidence — and the panel's disagreement is the
strongest contradicting evidence in the run. A rationale written before the
debate would be a confident explanation of a trade that four specialists had not
yet weighed in on, which is precisely the kind of persuasive-but-incomplete prose
this system is built not to produce.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from langgraph.graph import END

from backend.algorithms.probability import MIN_TRADES_FOR_ACCURACY
from backend.graphs.builder import ConditionalEdge, GraphConfig, build_graph
from backend.graphs.nodes.specialists import (
    SPECIALIST_NODES,
    register_specialist_nodes,
)
from backend.graphs.nodes.risk_gateway import (
    RISK_GATEWAY_NODE,
    register_risk_gateway_node,
)
from backend.graphs.nodes.supervisor import SUPERVISOR_NODE, register_supervisor_node
from backend.graphs.opportunity import (
    _after_scoring,
    opportunity_config,
    summarise_opportunity,
)
from backend.graphs.runtime import finish_run, start_run
from backend.graphs.state import TradingState, TriggerReason
from backend.llm.budget import RunBudget

logger = logging.getLogger(__name__)

GRAPH_NAME = "trade_analysis"

# The stage the thesis narrative now waits for.
DEBATE_NODE = "debate"
NARRATIVE_NODE = "trade_thesis_narrative"

_nodes_registered = False


def _ensure_nodes() -> None:
    """Register the specialist nodes once, on top of Phase 24/25's.

    `opportunity_config()` registers its own; this only adds Phase 26's. The
    registry raises on a duplicate name deliberately, so the presence check keeps
    a genuine collision visible rather than swallowing it.
    """
    global _nodes_registered
    if _nodes_registered:
        return
    from backend.graphs.registry import get_contract

    if get_contract("specialist_market") is None:
        register_specialist_nodes()
    if get_contract(SUPERVISOR_NODE) is None:
        register_supervisor_node()
    if get_contract(RISK_GATEWAY_NODE) is None:
        register_risk_gateway_node()
    _nodes_registered = True


# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------

def _after_opportunity(state: TradingState) -> str:
    """Convene the panel only when there is a thesis to test.

    Replaces Phase 25's router of the same name, which routed to the narrative.
    Seven nodes and a portfolio read is real work; spending it on a run that
    produced nothing to analyse would be spending it on every run, since most
    runs produce nothing.
    """
    return "analyse" if state.get("trade_thesis") is not None else "no_opportunity"


def analysis_config() -> GraphConfig:
    """Graph 2 complete: Phase 24/25's chain, then Section 9's fan-out.

    Built by rewiring `opportunity_config()` rather than restating it. Only the
    tail differs, and the diff is explicit below so a reader can see exactly what
    Phase 26 changed.
    """
    _ensure_nodes()
    base = opportunity_config()

    # The Phase 25 edges being replaced:
    #   opportunity_detection --(conditional)--> trade_thesis_narrative | END
    #   trade_thesis_narrative -----------------> END
    #
    # Both are dropped and rebuilt so the narrative sits after the debate. Filtered
    # by content rather than by index — an index would silently pick the wrong edge
    # the first time Phase 25's edge order changed.
    edges: List[Tuple[str, str]] = [
        (src, dst) for src, dst in base.edges if src != NARRATIVE_NODE
    ]
    conditionals = [ce for ce in base.conditional_edges if ce.source != "opportunity_detection"]

    # Every specialist converges on the debate. LangGraph runs the fan-in exactly
    # once, after all seven have completed.
    edges += [(node, DEBATE_NODE) for node in SPECIALIST_NODES]
    edges += [
        # Phase 27. The Supervisor sits between the debate and the narrative: it
        # needs the verdict to decide, and the narrative needs the decision to
        # explain. Narrating before the decision would produce prose about a trade
        # whose outcome had not been determined.
        (DEBATE_NODE, SUPERVISOR_NODE),
        # Phase 28. The gateway runs AFTER the decision and BEFORE the narrative:
        # it needs an action to validate, and the narrative should explain the
        # approved-or-rejected outcome rather than the decision that preceded it.
        # Prose describing a trade the gateway then refused would be the same
        # failure as prose describing one the Supervisor refused.
        (SUPERVISOR_NODE, RISK_GATEWAY_NODE),
        (RISK_GATEWAY_NODE, NARRATIVE_NODE),
        (NARRATIVE_NODE, END),
    ]

    # `strategy_scoring`'s conditional edge is INHERITED from `opportunity_config()`,
    # not restated. Restating it was the first version of this function, and it
    # produced two branches on one node — LangGraph rejects that at compile time
    # with "Branch with name `_after_scoring` already exists", which surfaced as a
    # whole-run failure rather than a build error. `GraphConfig.validate()` now
    # catches a duplicate source itself.
    conditionals += [
        ConditionalEdge(
            source="opportunity_detection",
            router=_after_opportunity,
            # A TUPLE, so all seven run in one superstep. See `_fan_out_router`.
            destinations={"analyse": SPECIALIST_NODES, "no_opportunity": END},
        ),
    ]

    return GraphConfig(
        name=GRAPH_NAME,
        nodes=[*base.nodes, *SPECIALIST_NODES, DEBATE_NODE, SUPERVISOR_NODE,
               RISK_GATEWAY_NODE],
        entry=base.entry,
        edges=edges,
        conditional_edges=conditionals,
    )


async def run_analysis_graph(
    symbol: str,
    trigger: TriggerReason,
    checkpointer: Any = None,
    budget: Optional[RunBudget] = None,
) -> Dict[str, Any]:
    """Run one full analysis cycle. Never raises — called from a bus subscriber."""
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
        graph = build_graph(analysis_config(), ctx, checkpointer=checkpointer)
        config = {"configurable": {"thread_id": thread_id}} if checkpointer else None
        final: TradingState = await (
            graph.ainvoke(state, config=config) if config else graph.ainvoke(state)
        )
    except Exception as e:
        logger.error("Analysis graph failed for %s: %s", symbol, e)
        finish_run(ctx, None, outcome="failed", no_decision_reason=f"graph error: {e}",
                   produces_decision=False)
        return {"ok": False, "symbol": symbol, "error": str(e), "runId": ctx.run_id}

    # Phase 29 / spec Section 12. Publishes the INERT boundary object onto the bus
    # for `services/execution_service.py`, which lives outside `graphs/` precisely
    # because it may import the execution chokepoint and nothing here may.
    #
    # Published from the graph RUNNER rather than from a node, deliberately. A node
    # that published would make emitting an execution request part of reasoning, and
    # a future node could then emit one mid-graph before the gateway had run. Here
    # it can only happen after `ainvoke` returned, with the whole assessment
    # visible.
    await _publish_plan(final)

    # produces_decision=True as of Phase 27 — this graph now genuinely decides, so
    # a run that ends WITHOUT a `decision` gets "why did nothing trade?" filled in
    # from `unavailable`. That is the desired report for the common early exit
    # ("no regime determined", "best score below the minimum"), and it was
    # suppressed while this graph stopped at a thesis.
    #
    # It still does not size or execute: the decision is inert until the Risk
    # Gateway (Phase 28) validates it and the Supervisor component executes it.
    trace = finish_run(ctx, final, produces_decision=True)
    return {"ok": True, "runId": ctx.run_id, "threadId": thread_id,
            **summarise_analysis(final), "traceOutcome": trace.outcome}


async def _publish_plan(state: TradingState) -> None:
    """Emit `EXECUTION_PLAN_READY` when the gateway approved a plan. Never raises.

    Guarded on BOTH `execution_plan` being present AND `risk_assessment.approved`.
    The gateway does not produce a plan on rejection, so either condition alone
    would do — checking both means a future change that starts producing rejected
    plans cannot turn this into a submission path by accident.

    Never raises: a bus failure must not turn a completed analysis run into a
    failed one. The plan is already in the final state and the trace, so a failed
    publish loses the execution attempt, not the reasoning.
    """
    plan = state.get("execution_plan")
    assessment = state.get("risk_assessment")

    if plan is None:
        return
    if assessment is None or assessment.approved is not True:
        logger.error(
            "Execution plan present for %s but the risk assessment is %s — NOT "
            "publishing. A plan without an approval must never reach the execution "
            "boundary.",
            state.get("symbol"),
            "absent" if assessment is None else f"approved={assessment.approved!r}",
        )
        return

    decision = state.get("decision")
    thesis = state.get("trade_thesis")
    # A close carries no stop; that is how the two are told apart downstream, and
    # the event's `intent` field has no default for exactly this reason.
    intent = "close" if (decision is not None and decision.action == "EXIT") else "open"

    try:
        from backend.core.message_bus import get_message_bus
        from backend.models.events import ExecutionPlanReadyEvent

        await get_message_bus().publish("EXECUTION_PLAN_READY", ExecutionPlanReadyEvent(
            symbol=plan.symbol or state["symbol"],
            intent=intent,
            side=plan.side,
            tab=plan.tab,
            idempotency_basis=plan.idempotency_basis or "",
            size=plan.size,
            leverage=plan.leverage,
            stop_loss=plan.stop_loss,
            take_profit=plan.take_profit,
            run_id=state.get("run_id"),
            strategy=thesis.strategy if thesis else None,
            rationale=decision.rationale if decision else None,
            entry_price=thesis.entry_price if thesis else None,
        ))
        logger.info(
            "Published EXECUTION_PLAN_READY for %s (%s %s, intent=%s)",
            plan.symbol, plan.side, plan.size, intent,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "Could not publish the execution plan for %s: %s. The reasoning run "
            "completed; only the execution attempt was lost.",
            state.get("symbol"), exc,
        )


def summarise_analysis(state: TradingState) -> Dict[str, Any]:
    """Section 9's output shape, on top of Section 8's.

    Every specialist is listed, including the three that could not run and why.
    Reporting only the four that worked would make the panel look complete, and a
    reader deciding how much to trust a 0.31 confidence needs to know it came from
    four of seven voices rather than seven.
    """
    findings = state.get("specialist_findings") or []
    verdict = state.get("debate_verdict")

    return {
        **summarise_opportunity(state),
        "specialists": [
            {
                "name": f.specialist,
                "role": f.role,
                "available": f.available,
                "stance": f.stance,
                "confidence": f.confidence,
                "concern": f.concern,
                "evidence": f.evidence,
                "reasonUnavailable": f.reason_unavailable,
            }
            for f in sorted(findings, key=lambda f: (f.role, f.specialist))
        ],
        "panelSize": len(findings),
        "panelAvailable": sum(1 for f in findings if f.available),
        "debate": None if verdict is None else {
            "direction": verdict.direction,
            "confidence": verdict.confidence,
            "participants": verdict.participants,
            "absent": verdict.absent,
            "supporting": verdict.supporting,
            "contradicting": verdict.contradicting,
            "rationale": verdict.rationale,
            "coverage": verdict.coverage,
            "constraintApplied": verdict.constraint_applied,
            "bindingConstraint": verdict.binding_constraint,
            # Surfaced because the two numbers differ whenever a constraint binds,
            # and an operator seeing an EXIT recommended during a pause needs to see
            # WHY — otherwise one of them looks like a bug. See `directionalMeaning`.
            "directionalConfidence": verdict.directional_confidence,
        },
        # --- Section 10 fields ---
        "decision": None if state.get("decision") is None else _decision_dict(state["decision"]),
        # --- Section 11 fields ---
        "risk": None if state.get("risk_assessment") is None else {
            "approved": state["risk_assessment"].approved,
            "rejectionReasons": state["risk_assessment"].rejection_reasons,
            "cautionNotes": state["risk_assessment"].caution_notes,
            "checks": state["risk_assessment"].checks,
            "stopLoss": state["risk_assessment"].stop_loss,
            "takeProfit": state["risk_assessment"].take_profit,
        },
        # The inert boundary object. Present ONLY on approval — see the gateway's
        # note on why a rejected plan is not produced at all.
        "executionPlan": None if state.get("execution_plan") is None else {
            "symbol": state["execution_plan"].symbol,
            "side": state["execution_plan"].side,
            "size": state["execution_plan"].size,
            "leverage": state["execution_plan"].leverage,
            "stopLoss": state["execution_plan"].stop_loss,
            "takeProfit": state["execution_plan"].take_profit,
            "tab": state["execution_plan"].tab,
            "idempotencyBasis": state["execution_plan"].idempotency_basis,
        },
        # Two separate honesty strings because they answer two different questions
        # an operator will actually ask about a low number.
        "coverageMeaning": (
            "fraction of the directional panel's weight that could be measured. "
            "Three of seven specialists (orderflow, liquidity, news) have no data "
            "feed in this system, so directional coverage is capped at "
            "market+funding = 4.0 of 7.0 panel weight today. Confidence is scaled "
            "by this, so it can never reach 1.0 while those feeds are missing"
        ),
        "constraintMeaning": (
            "a further reduction applied by the single BINDING constraint "
            "(liquidity, portfolio or risk), not a product of all three. Low "
            "confidence from coverage means 'we could not see enough'; low "
            "confidence from a constraint means 'we saw plenty and it says do not'"
        ),
        "debateMeaning": (
            "deterministic weighted aggregation of the specialist findings, not a "
            "model call — identical findings always produce an identical verdict, "
            "which is what makes a past decision auditable and this graph "
            "backtestable"
        ),
        "directionalMeaning": (
            "two confidence numbers, because two different questions read them. "
            "`confidence` is constraint-dampened and gates OPENING a position. "
            "`directionalConfidence` is coverage-scaled only and gates CLOSING one, "
            "because a constraint against taking on new risk must never suppress a "
            "signal to shed risk — an emergency stop drives `confidence` to 0.0, and "
            "gating an exit on that made closing impossible exactly when it mattered "
            "most (CLAUDE.md invariant 4)"
        ),
        "probabilityMeaning": (
            "P(direction correct), populated ONLY when this system has at least "
            f"{MIN_TRADES_FOR_ACCURACY} resolved trades to measure its own hit rate "
            "from. null means unmeasurable, not zero. Panel confidence is NOT a "
            "probability — it measures how much of the panel agreed, not how often "
            "such agreement has been right, and reporting it here would be the most "
            "persuasive fabrication available to this system"
        ),
        "sizingMeaning": (
            "`decision.size` and `decision.leverage` are always null: the Supervisor "
            "decides, it does not size. Size lives on `executionPlan`, set by the "
            "Risk Gateway, which is the only place in the reasoning layer that sizes "
            "— so there is exactly one answer to who decided how big this was"
        ),
        "riskMeaning": (
            "spec Section 11's nine deterministic checks. Nothing here consults a "
            "model: an LLM can recommend, code enforces. A check reporting "
            "'unavailable' did NOT pass — it could not run, and inside the graph that "
            "rejects (strict mode), because the graph has every input so a missing "
            "one is a bug rather than a limitation"
        ),
        "exitMeaning": (
            "an EXIT decision is approved WITHOUT any risk check (the `CloseBypass` "
            "check records this). CLAUDE.md invariant 4: a close is never blocked — "
            "not by pause, emergency stop, a breached limit or a veto — and it is "
            "most important not to block one precisely when a limit has already been "
            "breached, which is when a gateway would otherwise refuse"
        ),
        "executionMeaning": (
            "the execution plan is INERT: a dataclass, not an event and not a call. "
            "Producing one is not placing an order — a separate deterministic service "
            "converts an approved plan into a TAR, and "
            "components/Supervisor.tsx's reviewAndExecute() remains the single "
            "execution path for every AI-originated trade. No module under graphs/ "
            "can import an order call at all"
        ),
    }


def _decision_dict(decision: Any) -> Dict[str, Any]:
    """Section 10's ten answers, in the order the spec asks them."""
    return {
        "action": decision.action,
        "direction": decision.direction,
        # Always null — see `sizingMeaning`. Surfaced rather than omitted so a
        # reader can see the field exists and is unset, not that it was forgotten.
        "size": decision.size,
        "leverage": decision.leverage,
        "rationale": decision.rationale,
        "whatHappened": decision.what_happened,
        "whatIsHappening": decision.what_is_happening,
        "why": decision.why,
        "whatCouldHappenNext": decision.what_could_happen_next,
        "evidenceFor": decision.evidence_for,
        "evidenceAgainst": decision.evidence_against,
        "probability": decision.probability,
        "downside": decision.downside,
        "portfolioImpact": decision.portfolio_impact,
        "tradeWaitOrExit": decision.trade_wait_or_exit,
    }


# ---------------------------------------------------------------------------
# Trigger subscription
# ---------------------------------------------------------------------------

_subscribed = False


def subscribe_to_triggers(checkpointer: Any = None) -> None:
    """Run the analysis graph when a trigger fires. Idempotent.

    REPLACES `opportunity.subscribe_to_triggers` in `main.py` for the same reason
    that one replaced the market-state subscription: this graph contains all nine
    of its nodes, so subscribing both would run Phases 24 and 25 twice per trigger
    for one usable result.
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
        result = await run_analysis_graph(event.symbol, trigger, checkpointer=checkpointer)
        if not result.get("ok"):
            return

        if result.get("decision") is not None:
            debate = result.get("debate") or {}
            decision = result["decision"]
            thesis = result.get("thesis") or {}
            logger.info(
                "Analysis %s for %s: %s. Thesis %s %s, panel %s @ %s (%s), "
                "%d/%d specialists, probability %s. %s",
                result["runId"][:8], event.symbol,
                decision["action"],
                thesis.get("direction"), result.get("selectedStrategy"),
                debate.get("direction"),
                None if debate.get("confidence") is None else round(debate["confidence"], 3),
                "agrees" if debate.get("direction") == thesis.get("direction")
                else "DISAGREES with the thesis",
                result["panelAvailable"], result["panelSize"],
                "unmeasurable" if decision["probability"] is None
                else round(decision["probability"], 3),
                decision["tradeWaitOrExit"],
            )
        else:
            # The expected outcome of most runs: no thesis, so no panel convened and
            # no decision reached.
            logger.info(
                "Analysis %s for %s: no thesis, panel not convened, no decision. %s",
                result["runId"][:8], event.symbol,
                "; ".join((result.get("unavailable") or [])[-2:]) or "no reason recorded",
            )

    get_message_bus().subscribe("TRIGGER_FIRED", on_trigger)
    _subscribed = True
    logger.info("Trade analysis graph subscribed to TRIGGER_FIRED")


def reset_subscription() -> None:
    """For tests."""
    global _subscribed, _nodes_registered
    _subscribed = False
    _nodes_registered = False
