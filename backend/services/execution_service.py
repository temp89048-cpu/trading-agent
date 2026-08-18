"""Phase 29 — Execution Service (spec Section 12).

    "LangGraph generates an execution request; execution happens OUTSIDE
     LangGraph."

    LangGraph -> "BUY BTC" -> ExecutionRequest -> Risk Gateway
              -> Execution Service -> Exchange -> Order Confirmation
              -> Event Bus -> LangGraph Monitoring

THIS MODULE IS THE TRUST BOUNDARY
---------------------------------
Everything upstream of here is inert. `ExecutionPlan` is a dataclass;
`EXECUTION_PLAN_READY` is a notification. Neither can move money. This service is
where an inert object becomes a live instruction, which makes it the one place
that must assume its input is wrong.

So it RE-VALIDATES rather than trusting the gateway ran. Not because the gateway
is suspected, but because "the upstream check already did this" is how a
downstream check gets deleted in a refactor and nobody notices for six months.
The re-checks are cheap; the failure they prevent is not.

IT DOES NOT TALK TO AN EXCHANGE
-------------------------------
Spec Section 8: *"the Execution API is a hard chokepoint — no agent talks to an
exchange directly, ever."* `agents/execution_agent.py` is that chokepoint, and it
already exists. This service converts a plan into the input that chokepoint
consumes — it does not become a second one.

OPENS AND CLOSES TAKE DIFFERENT PATHS, AND THAT IS THE POINT
------------------------------------------------------------
    open  -> TarSubmittedEvent -> CRO reviews -> TAR_APPROVED -> ExecutionAgent
    close -> ExecutionAgent.close_position() directly, NO CRO

A close must NOT go through the TAR chain. The CRO can publish `TAR_REJECTED`, so
routing an exit through it would let a risk agent block a close — CLAUDE.md
invariant 4, violated by the exact component whose job is to prevent losses.
`ExecutionAgent.close_position` already documents this and is ungated; this
service routes to it rather than reinventing the asymmetry.

IT SUBMITS. IT NEVER APPROVES.
-----------------------------
This module publishes `TarSubmittedEvent` and never `TarApprovedEvent`.
`agents/cro_agent.py` is the sole publisher of approvals and remains so. A service
that could approve its own submission would make the CRO decorative.

TWO INDEPENDENT GATES BELOW THIS
--------------------------------
1. `GRAPH_EXECUTION_ENABLED` (default **false**). Off, this service does
   everything except publish the TAR: it validates, quantises, dedupes and records
   a full receipt. The chain is observable end to end without a graph run being
   able to submit anything. Turning it on is an explicit operator decision.
2. `LIVE_TRADING` (default false) already puts `ExecutionAgent` in simulation mode
   and makes no exchange calls at all.

Both must be on for a graph to reach a real venue. Neither is checked as a
substitute for the other.
"""

from __future__ import annotations

import logging
import os
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from backend.core.risk_manager import max_leverage_ceiling
from backend.services.instrument_rules import get_rules, quantise_quantity

logger = logging.getLogger(__name__)

ENV_ENABLE = "GRAPH_EXECUTION_ENABLED"


def execution_enabled() -> bool:
    """Read at CALL TIME, not import time.

    A module-level constant would freeze the value at first import, so an operator
    flipping the flag would see no effect until a restart — and, worse, a test that
    set it would silently not take effect depending on import order.
    """
    return os.getenv(ENV_ENABLE, "false").strip().lower() == "true"


# Every submission this process has made, keyed by idempotency basis.
#
# In-process and therefore lost on restart, which is a real limitation and is
# stated rather than papered over: a plan whose TAR was published immediately
# before a crash could be submitted again after one. Closing that needs a
# persisted key store, which belongs with the execution-quality store rather than
# here. What this DOES prevent is the common case — a retried bus delivery, a
# resumed checkpoint, or two subscribers on one event.
_submitted: Dict[str, "Receipt"] = {}


@dataclass
class Receipt:
    """What happened to one plan. Always produced, including on refusal.

    A refusal with no record is indistinguishable from a plan that never arrived,
    and "why didn't that trade happen?" is the question this object exists to
    answer.
    """

    idempotency_basis: str
    symbol: str
    intent: str
    accepted: bool
    # 'submitted' | 'closed' | 'dry-run' | 'duplicate' | 'refused'
    outcome: str
    reasons: List[str] = field(default_factory=list)
    notes: List[str] = field(default_factory=list)
    submitted_size: Optional[float] = None
    tar_id: Optional[str] = None
    fill_price: Optional[float] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "idempotencyBasis": self.idempotency_basis,
            "symbol": self.symbol,
            "intent": self.intent,
            "accepted": self.accepted,
            "outcome": self.outcome,
            "reasons": self.reasons,
            "notes": self.notes,
            "submittedSize": self.submitted_size,
            "tarId": self.tar_id,
            "fillPrice": self.fill_price,
        }


class ExecutionService:
    """Converts an approved plan into the chokepoint's input. Nothing more."""

    def __init__(self, execution_agent: Any = None) -> None:
        # Injected rather than fetched, so tests can supply a double and so this
        # module has no import-time dependency on the agent singleton.
        self._agent = execution_agent

    def attach_agent(self, agent: Any) -> None:
        self._agent = agent

    # -- the entry point --------------------------------------------------

    async def handle_plan(self, event: Any) -> Receipt:
        """Validate and route one `EXECUTION_PLAN_READY`. Never raises.

        Never raising matters: this runs from a bus subscriber, and an exception
        here would propagate into the publisher's task and could take down the
        loop that delivers every other event.
        """
        try:
            return await self._handle(event)
        except Exception as exc:  # noqa: BLE001
            logger.exception("Execution service failed on a plan for %s", getattr(event, "symbol", "?"))
            return Receipt(
                idempotency_basis=getattr(event, "idempotency_basis", "unknown"),
                symbol=getattr(event, "symbol", "unknown"),
                intent=getattr(event, "intent", "unknown"),
                accepted=False,
                outcome="refused",
                reasons=[f"execution service error: {exc}"],
            )

    async def _handle(self, event: Any) -> Receipt:
        basis = event.idempotency_basis
        receipt = Receipt(
            idempotency_basis=basis,
            symbol=event.symbol,
            intent=event.intent,
            accepted=False,
            outcome="refused",
        )

        # --- 1. Idempotency, FIRST -----------------------------------------
        # Before any validation, because a duplicate must be rejected even if it
        # would otherwise pass. Checking it last would mean a valid plan delivered
        # twice was submitted twice.
        if basis in _submitted:
            prior = _submitted[basis]
            receipt.outcome = "duplicate"
            receipt.reasons.append(
                f"idempotency basis {basis[:16]} was already handled "
                f"(outcome '{prior.outcome}'). Refusing to submit the same decision "
                f"twice — for an order that means opening the position twice."
            )
            logger.warning(
                "Execution service refused a DUPLICATE plan for %s (basis %s, prior %s)",
                event.symbol, basis[:16], prior.outcome,
            )
            return receipt

        # --- 2. Closes bypass everything else ------------------------------
        if event.intent == "close":
            return await self._close(event, receipt)

        # --- 3. Re-validate the open at the boundary -----------------------
        problems = _revalidate_open(event)
        if problems:
            receipt.reasons.extend(problems)
            logger.warning(
                "Execution service REFUSED an open on %s: %s",
                event.symbol, "; ".join(problems),
            )
            _submitted[basis] = receipt
            return receipt

        # --- 4. Quantise to the venue's lot size ---------------------------
        rules = await get_rules(event.symbol)
        size, note = quantise_quantity(event.size, rules, price=event.entry_price)
        receipt.notes.append(note)

        if size is None:
            receipt.reasons.append(note)
            _submitted[basis] = receipt
            return receipt

        if not rules.known and event.tab == "real":
            # Fails closed exactly where the consequence is real. The paper book has
            # no lot size, so an unknown step harms nothing there.
            receipt.reasons.append(
                f"real-money order refused: {rules.unavailable}. Submitting a "
                f"quantity the venue may silently truncate means the position would "
                f"not be the size the risk checks approved."
            )
            _submitted[basis] = receipt
            return receipt

        receipt.submitted_size = size

        # --- 5. Submit. Never approve. -------------------------------------
        if not execution_enabled():
            receipt.outcome = "dry-run"
            receipt.notes.append(
                f"{ENV_ENABLE} is not 'true', so no TAR was published. Everything "
                f"upstream ran: the plan validated, quantised to {size:.10g} and "
                f"passed the duplicate check. Set {ENV_ENABLE}=true to let graph "
                f"runs submit."
            )
            logger.info(
                "Execution service DRY RUN for %s: would submit %s %.10g at %sx "
                "(stop %s). %s is off.",
                event.symbol, event.side, size, event.leverage, event.stop_loss,
                ENV_ENABLE,
            )
            _submitted[basis] = receipt
            return receipt

        return await self._submit_tar(event, receipt, size)

    # -- opens ------------------------------------------------------------

    async def _submit_tar(self, event: Any, receipt: Receipt, size: float) -> Receipt:
        """Publish a TAR. The CRO decides whether it becomes an approval."""
        from backend.core.message_bus import get_message_bus
        from backend.models.events import TarSubmittedEvent

        tar = TarSubmittedEvent(
            symbol=event.symbol,
            direction="LONG" if event.side == "buy" else "SHORT",
            requested_size=size,
            requested_leverage=int(event.leverage or 1),
            strategy=event.strategy or "graph",
            supervisor_rationale=(
                event.rationale
                or f"LangGraph run {event.run_id or 'unknown'} — risk gateway approved"
            ),
            stop_loss=event.stop_loss,
            tab=event.tab,
            take_profit=event.take_profit,
            entry_price=event.entry_price,
        )
        # MessageBus.publish takes (topic, payload) — see agent_base.publish.
        await get_message_bus().publish("TAR_SUBMITTED", tar)

        receipt.accepted = True
        receipt.outcome = "submitted"
        receipt.tar_id = str(tar.tar_id)
        receipt.notes.append(
            "TAR published. This is a SUBMISSION, not an approval — the CRO is the "
            "sole publisher of TAR_APPROVED and may still reject this."
        )
        logger.info(
            "Execution service SUBMITTED TAR %s: %s %s %.10g at %sx on %s "
            "(stop %.8g, tab %s)",
            str(tar.tar_id)[:8], event.symbol, tar.direction, size,
            tar.requested_leverage, event.symbol, event.stop_loss, event.tab,
        )
        _submitted[receipt.idempotency_basis] = receipt
        return receipt

    # -- closes -----------------------------------------------------------

    async def _close(self, event: Any, receipt: Receipt) -> Receipt:
        """Route a close straight to the chokepoint. No CRO, no risk checks.

        Invariant 4. The CRO can publish TAR_REJECTED, so routing an exit through
        the TAR chain would let a risk agent block a close — and it would do so
        precisely when a limit has been breached, which is when the exit matters
        most. `ExecutionAgent.close_position` is already ungated for this reason.

        `GRAPH_EXECUTION_ENABLED` is deliberately NOT checked here. A flag that
        gates opens is a safety feature; the same flag gating closes would trap the
        operator in positions while it was off.
        """
        if self._agent is None:
            receipt.reasons.append(
                "no execution agent is attached, so the close could not be routed. "
                "The position remains open — this is a wiring failure, not a refusal."
            )
            logger.error(
                "Execution service could NOT close %s: no agent attached", event.symbol
            )
            # NOT recorded in `_submitted`: a close that failed for a wiring reason
            # must be retryable, and marking the basis as handled would make the
            # retry look like a duplicate.
            return receipt

        if event.size is None or event.size <= 0:
            receipt.reasons.append(
                "no quantity to close was determined. Refusing to guess a size "
                "rather than closing an arbitrary amount."
            )
            return receipt

        # The side to CLOSE is the opposite of the side held, and the plan already
        # carries the closing side. `close_position` wants the ENTRY side, so it is
        # inverted back here rather than having the plan carry both.
        entry_side = "buy" if event.side == "sell" else "sell"

        fill = await self._agent.close_position(
            symbol=event.symbol,
            entry_side=entry_side,
            qty=event.size,
            tab=event.tab,
            reason="thesis-invalidated",
        )

        if fill is None:
            receipt.reasons.append(
                "the execution agent could not fill the close. The position is still "
                "open and this must be retried."
            )
            logger.error("Execution service failed to close %s", event.symbol)
            # Again not recorded: an unfilled close must be retryable.
            return receipt

        receipt.accepted = True
        receipt.outcome = "closed"
        receipt.submitted_size = event.size
        receipt.fill_price = fill
        receipt.notes.append(
            "closed WITHOUT risk validation or CRO review (invariant 4), and without "
            f"checking {ENV_ENABLE} — a flag that gated closes would trap the "
            "operator in positions while it was off."
        )
        logger.info(
            "Execution service CLOSED %s %.10g at %.8g (was %s)",
            event.symbol, event.size, fill, entry_side,
        )
        _submitted[receipt.idempotency_basis] = receipt
        return receipt


# ---------------------------------------------------------------------------
# Boundary re-validation
# ---------------------------------------------------------------------------

def _revalidate_open(event: Any) -> List[str]:
    """Re-check an open at the trust boundary. Returns problems, empty if clean.

    Every one of these was already checked by the Risk Gateway. They are repeated
    because this is the point where an inert object becomes a live instruction, and
    a boundary that trusts its input is not a boundary.

    Deliberately NOT a re-run of all nine gateway checks: that would need a
    portfolio snapshot and a ledger, would double the work, and could DISAGREE with
    the gateway on a moving market — which would be worse than not checking, since
    it is not obvious which answer should win. These are the invariants that must
    hold regardless of market state.
    """
    problems: List[str] = []

    if event.size is None or event.size <= 0:
        problems.append(f"no size on the plan ({event.size!r}); nothing to submit")

    # Invariant 3. The one check whose absence lets a stopless position exist.
    if event.stop_loss is None:
        problems.append(
            "no stop-loss on the plan. Every position requires a computed stop; "
            "this is not overridable by any setting or confidence level."
        )
    elif event.entry_price is not None:
        # A stop on the wrong side of entry is worse than no stop: it would be
        # triggered immediately, or never. The gateway derives both from ATR so this
        # should be impossible — which is exactly why it is worth asserting at the
        # boundary rather than assumed.
        if event.side == "buy" and event.stop_loss >= event.entry_price:
            problems.append(
                f"stop {event.stop_loss:.8g} is at or above entry "
                f"{event.entry_price:.8g} for a long — it would trigger immediately"
            )
        if event.side == "sell" and event.stop_loss <= event.entry_price:
            problems.append(
                f"stop {event.stop_loss:.8g} is at or below entry "
                f"{event.entry_price:.8g} for a short — it would trigger immediately"
            )

    # Invariant 2. Re-checked here so the ceiling holds even if a plan were
    # constructed by something that skipped the gateway entirely.
    leverage = event.leverage or 1
    ceiling = max_leverage_ceiling(event.tab)
    if leverage > ceiling:
        problems.append(
            f"{leverage}x exceeds the hard {ceiling}x ceiling for the '{event.tab}' "
            f"tab. Not raisable by any setting, agent or confidence level."
        )

    # The kill switch, again. The gateway checked it when the decision was made;
    # an operator may have hit stop in between, and this is the last moment it can
    # still take effect.
    from backend.core import system_state

    if not system_state.may_open_new_position():
        blocker = (
            "emergency stop" if system_state.is_emergency_stopped()
            else "pause" if system_state.is_system_paused()
            else f"observation mode ({system_state.observation_reason()})"
        )
        problems.append(
            f"{blocker} is active at the execution boundary. It may have been "
            f"engaged after the gateway approved this plan."
        )

    return problems


# ---------------------------------------------------------------------------
# Wiring
# ---------------------------------------------------------------------------

_service: Optional[ExecutionService] = None
_subscribed = False


def get_execution_service() -> ExecutionService:
    global _service
    if _service is None:
        _service = ExecutionService()
    return _service


def subscribe_to_plans(execution_agent: Any = None) -> None:
    """Subscribe the service to `EXECUTION_PLAN_READY`. Idempotent.

    The agent is injected here rather than imported inside the service, so the
    service module itself never depends on the agent singleton and stays testable
    with a double.
    """
    global _subscribed

    service = get_execution_service()
    if execution_agent is not None:
        service.attach_agent(execution_agent)

    if _subscribed:
        return

    from backend.core.message_bus import get_message_bus
    from backend.models.events import BaseEvent, ExecutionPlanReadyEvent

    async def on_plan(event: BaseEvent) -> None:
        if not isinstance(event, ExecutionPlanReadyEvent):
            return
        await service.handle_plan(event)

    get_message_bus().subscribe("EXECUTION_PLAN_READY", on_plan)
    _subscribed = True
    logger.info(
        "Execution service subscribed to EXECUTION_PLAN_READY (%s=%s)",
        ENV_ENABLE, execution_enabled(),
    )


def reset_for_tests() -> None:
    global _service, _subscribed
    _service = None
    _subscribed = False
    _submitted.clear()
