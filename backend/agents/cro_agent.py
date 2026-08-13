import logging
import uuid
from typing import List

from backend.agents.supervisor_agent import SupervisorAgent
from backend.core.agent_base import BaseAgent
from backend.core.db import get_db_pool
from backend.core.risk_manager import max_leverage_ceiling
from backend.models.events import EventType, BaseEvent, TarSubmittedEvent, TarApprovedEvent, TarRejectedEvent
from backend.services.portfolio_store import get_portfolio

logger = logging.getLogger(__name__)

# Spec Section 18: "The 99% 24-hour VaR of the entire portfolio must never
# exceed 5% of total equity."
MAX_PORTFOLIO_VAR_FRACTION = 0.05

# The adverse move used as the worst case when converting notional exposure
# into a VaR figure. 10% in 24h is a routine daily range for crypto futures,
# not an extreme — it is intended as a conservative floor, not a tail
# estimate. A real 99% VaR would be computed from the return distribution;
# this is a deliberate, documented approximation, and calling it "VaR" while
# it remains one is the reason this constant is named and commented rather
# than inlined.
WORST_CASE_ADVERSE_MOVE = 0.10

class CROAgent(BaseAgent):
    @property
    def name(self) -> str:
        return "Chief Risk Officer AI"

    @property
    def purpose(self) -> str:
        return "Evaluates all Trade Authorization Requests (TAR) against hard mathematical constraints (VaR, Correlation)."

    @property
    def permissions(self) -> List[str]:
        return ["READ_PORTFOLIO_STATE", "REJECT_TAR", "APPROVE_TAR"]

    @property
    def inputs(self) -> List[str]:
        return [
            "TAR_SUBMITTED events (size, leverage, stop-loss, entry price, tab)",
            "Portfolio equity via services/portfolio_store.get_portfolio",
            "The leverage ceiling constants from core/risk_manager (module constants, not config)",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "TAR_APPROVED events (carrying the stop-loss through to Execution)",
            "TAR_REJECTED events naming the specific rule breached",
            "Rows in the `risk_events` table for both outcomes",
        ]

    @property
    def category(self) -> str:
        return "risk"

    @property
    def events_consumed(self) -> List[EventType]:
        return ["TAR_SUBMITTED"]

    @property
    def events_published(self) -> List[EventType]:
        return ["TAR_APPROVED", "TAR_REJECTED"]


    @property
    def responsibilities(self) -> List[str]:
        return ["Execute core duties as assigned."]

    @property
    def dependencies(self) -> List[str]:
        return ["MessageBus"]

    @property
    def memory_ttl(self) -> str:
        return "Ephemeral (process lifetime)"

    @property
    def knowledge_sources(self) -> List[str]:
        return ["Internal state"]

    @property
    def prompt_reference(self) -> str:
        return "CRO_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return ["None"]

    @property
    def database_tables(self) -> List[str]:
        return ["None"]

    @property
    def metrics_reported(self) -> List[str]:
        return ["Uptime", "Events Processed"]

    @property
    def failure_recovery_strategy(self) -> str:
        return "Restart agent process"

    @property
    def health_status(self) -> str:
        return "Active"


    async def handle_event(self, event: BaseEvent) -> None:
        if event.event_type == "TAR_SUBMITTED":
            if isinstance(event, TarSubmittedEvent):
                await self._process_tar(event)

    async def _reject(self, tar: TarSubmittedEvent, rule: str, reason: str) -> None:
        logger.warning("CRO REJECTED %s: %s", tar.tar_id, reason)
        await self._persist_risk_event(str(tar.tar_id), "REJECTED", rule, reason)
        await self.publish(TarRejectedEvent(
            tar_id=tar.tar_id,
            rule_breached=rule,
            cro_rationale=reason,
        ))

    async def _process_tar(self, tar: TarSubmittedEvent) -> None:
        logger.info(f"CRO evaluating TAR {tar.tar_id} for {tar.symbol}")

        ceiling = max_leverage_ceiling(tar.tab)

        # ---------------------------------------------------------------
        # Constraint 1: the leverage ceiling.
        #
        # Checked FIRST, before any other math, so no other quantity can
        # influence it. This used to be `if tar.requested_leverage > 5` — a
        # bare literal that (a) disagreed with the TypeScript side's 3x real
        # / 10x paper ceiling, so the effective limit depended on which code
        # path a trade took, and (b) ignored paper-vs-real entirely. It now
        # reads the shared constant from core/risk_manager, which is a module
        # constant specifically so no config or agent can raise it
        # (CLAUDE.md invariant 2).
        # ---------------------------------------------------------------
        if tar.requested_leverage > ceiling:
            await self._reject(
                tar,
                "MAX_LEVERAGE_LIMIT",
                f"Requested leverage {tar.requested_leverage}x exceeds the hard {ceiling}x ceiling "
                f"for the '{tar.tab}' tab. This ceiling is not configurable and cannot be raised "
                f"by any agent or confidence level.",
            )
            return

        # ---------------------------------------------------------------
        # Constraint 2: a stop-loss must be present and on the correct side
        # of entry (CLAUDE.md invariant 3).
        #
        # `stop_loss` is a required field on the event, so it cannot be
        # absent — but it can still be nonsense (a stop above entry on a
        # long is not a stop, it is a guaranteed immediate exit or an
        # inverted risk calculation). Verified here rather than trusted,
        # because the CRO is the last gate before execution.
        # ---------------------------------------------------------------
        entry = tar.entry_price
        if entry is not None and entry > 0:
            if tar.direction == "LONG" and tar.stop_loss >= entry:
                await self._reject(
                    tar,
                    "INVALID_STOP_LOSS",
                    f"Stop-loss {tar.stop_loss} is at or above the entry price {entry} on a LONG — "
                    f"that is not a protective stop.",
                )
                return
            if tar.direction == "SHORT" and tar.stop_loss <= entry:
                await self._reject(
                    tar,
                    "INVALID_STOP_LOSS",
                    f"Stop-loss {tar.stop_loss} is at or below the entry price {entry} on a SHORT — "
                    f"that is not a protective stop.",
                )
                return

        # ---------------------------------------------------------------
        # Constraint 3: Global VaR (spec Section 18 — 99% 24h VaR must not
        # exceed 5% of total equity).
        #
        # The previous version was, in its own words, "mocked logic":
        #
        #     total_equity = 100000.0
        #     implied_var = tar.requested_size * 0.10
        #
        # Two problems. Equity was a hardcoded $100,000 that had nothing to
        # do with the actual account, so the limit was meaningless for any
        # real balance — and for the $2-to-$5 capital-target mission in this
        # repo it was off by five orders of magnitude. And `size * 0.10`
        # treats *quantity* as if it were dollars: 0.1 BTC and 0.1 DOGE
        # produced an identical "VaR" of 0.01. With a 5000 threshold the
        # check could never fire, so it always passed.
        #
        # Now: real equity from the portfolio store, and VaR measured in
        # currency as notional × a worst-case adverse move.
        # ---------------------------------------------------------------
        portfolio = await get_portfolio()
        total_equity = SupervisorAgent._equity_for(portfolio, tar.tab)
        if total_equity <= 0:
            await self._reject(
                tar,
                "UNKNOWN_EQUITY",
                f"Equity for the '{tar.tab}' tab is unknown, so portfolio-level VaR cannot be "
                f"evaluated. Refusing rather than approving against an assumed balance "
                f"(this check previously assumed a hardcoded $100,000).",
            )
            return

        if entry is None or entry <= 0:
            await self._reject(
                tar,
                "UNKNOWN_ENTRY_PRICE",
                "TAR carries no entry price, so notional exposure and therefore VaR cannot be computed.",
            )
            return

        notional = tar.requested_size * entry
        implied_var = notional * WORST_CASE_ADVERSE_MOVE
        var_limit = total_equity * MAX_PORTFOLIO_VAR_FRACTION

        if implied_var > var_limit:
            await self._reject(
                tar,
                "GLOBAL_VAR_LIMIT",
                f"Global VaR limit exceeded: a {WORST_CASE_ADVERSE_MOVE * 100:.0f}% adverse move on "
                f"${notional:.2f} notional is ${implied_var:.2f}, above the "
                f"{MAX_PORTFOLIO_VAR_FRACTION * 100:.0f}% of ${total_equity:.2f} equity limit "
                f"(${var_limit:.2f}).",
            )
            return

        # ---------------------------------------------------------------
        # Correlated-exposure and drawdown-killswitch constraints from spec
        # Section 18 are NOT implemented here yet. Named explicitly so this
        # gap is visible rather than implied by the rationale string, which
        # used to claim it had "Passed all VaR and correlation constraints"
        # while performing no correlation check whatsoever.
        # ---------------------------------------------------------------
        rationale = (
            f"Approved: leverage {tar.requested_leverage}x within {ceiling}x ceiling; "
            f"stop-loss {tar.stop_loss:.6g} verified on the correct side of entry {entry:.6g}; "
            f"implied VaR ${implied_var:.2f} within ${var_limit:.2f} "
            f"({MAX_PORTFOLIO_VAR_FRACTION * 100:.0f}% of ${total_equity:.2f} equity). "
            f"Correlation caps and the drawdown killswitch are not yet implemented and were NOT checked."
        )
        logger.info(f"CRO APPROVED {tar.tar_id}")

        await self._persist_risk_event(str(tar.tar_id), "APPROVED", None, rationale)

        await self.publish(TarApprovedEvent(
            tar_id=tar.tar_id,
            symbol=tar.symbol,
            direction=tar.direction,
            approved_size=tar.requested_size,
            approved_leverage=tar.requested_leverage,
            cro_rationale=rationale,
            # Carried through so Execution attaches the stop Risk approved,
            # rather than re-deriving one that could differ.
            stop_loss=tar.stop_loss,
            take_profit=tar.take_profit,
            tab=tar.tab,
        ))

    async def _persist_risk_event(self, tar_id: str, decision: str, rule_breached: str | None, rationale: str):
        pool = get_db_pool()
        if not pool:
            return
            
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO risk_events (event_id, tar_id, decision, rule_breached, rationale)
                    VALUES ($1, $2, $3, $4, $5)
                    """,
                    str(uuid.uuid4()), tar_id, decision, rule_breached, rationale
                )
        except Exception as e:
            logger.error(f"Failed to persist risk event for TAR {tar_id}: {e}")

def get_cro_agent() -> CROAgent:
    return CROAgent()
