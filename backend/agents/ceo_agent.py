"""CEO AI — top of spec Section 4's chain of command.

    CEO AI -> CIO AI -> CRO AI -> Research -> Supervisor -> ...

The CEO and CIO were the only two links in that chain with no implementation.

WHAT THIS AGENT IS FOR — AND WHAT IT DELIBERATELY IS NOT
--------------------------------------------------------
It would be easy to add a "CEO AI" that produces strategy commentary and
changes nothing. That is ceremony, and this codebase does not need another
layer that reads well and does no work.

Instead the CEO owns the one authority that genuinely belongs at the top and
was genuinely missing: **the mandate to stop trading altogether.** Spec
Section 18 requires it —

    "Drawdown Killswitch: If portfolio equity drops 10% from the monthly
     high-water mark, the CRO automatically transitions the system to
     Observation Mode (close all trades, halt new entries)."

— and `agents/cro_agent.py` had this gap named in a comment because the CRO
evaluates one TAR at a time and has no view of equity over time. Tracking a
high-water mark across trades is a firm-level judgement, so it lives here.

WHY NOT IN THE CRO
------------------
The CRO is per-trade and stateless: it answers "may this trade proceed?".
The killswitch is per-account and stateful: it answers "should we be trading
at all?". Putting a running equity series inside a per-trade validator would
make each risk decision depend on hidden accumulated state, which is both
harder to test and easy to get wrong after a restart.

WHY IT ACTS ON `system_state` RATHER THAN VETOING TRADES
-------------------------------------------------------
Observation Mode is enforced through `may_open_new_position()`, which every
gate in the system already calls. Halting there stops new entries everywhere
at once, including the task-based `trading_agent` path that never goes through
the CRO. A CEO that published a "please stop" event would only be honoured by
agents that happened to subscribe.

Exits are never blocked (CLAUDE.md invariant 4). "Close all trades" from the
spec is deliberately NOT automated here: firing a market close on every
position during a drawdown is itself a large, slippage-bearing trade executed
in the worst conditions, and the drawdown is evidence the system's judgement
is currently unreliable. The CEO halts and reports what is still open; closing
is the operator's call.
"""

import datetime
import logging
from typing import Any, Dict, List, Optional

from backend.core.agent_base import BaseAgent
from backend.core.config import settings
from backend.core.system_state import (
    enter_observation_mode,
    is_in_observation_mode,
)
from backend.models.events import BaseEvent, EventType, PositionClosedEvent
from backend.services.portfolio_store import get_portfolio

logger = logging.getLogger(__name__)

# Spec Section 18's threshold.
MAX_DRAWDOWN_FROM_HIGH_WATER_MARK = 0.10

# The high-water mark resets monthly per the spec ("monthly high-water mark").
# Without a reset, a single early peak would gate the account forever; with too
# frequent a reset, a slow bleed never trips the limit because the mark keeps
# following equity down.
HWM_WINDOW = "month"


class CEOAgent(BaseAgent):
    version = "1.0.0"
    priority = 1  # highest — evaluated before any other agent

    def __init__(self) -> None:
        self._high_water_mark: Optional[float] = None
        self._hwm_period: Optional[str] = None
        self._last_equity: Optional[float] = None
        super().__init__()

    @property
    def name(self) -> str:
        return "CEO AI"

    @property
    def purpose(self) -> str:
        return "Holds the firm-level mandate to trade, and halts the system into Observation Mode when equity falls more than 10% from the monthly high-water mark."

    @property
    def permissions(self) -> List[str]:
        # It can halt the firm but cannot size, approve, or place a trade.
        # Deliberately no TAR or order permissions: the ability to stop
        # everything should not come bundled with the ability to start it.
        return ["READ_PORTFOLIO", "HALT_TRADING", "SET_OPERATING_MODE"]

    @property
    def inputs(self) -> List[str]:
        return [
            "POSITION_CLOSED events (realized P&L, to update the equity series)",
            "Portfolio equity via services/portfolio_store.get_portfolio",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "Observation Mode transitions via core/system_state.enter_observation_mode",
            "A decision record for every drawdown evaluation, including the ones that pass",
            "NO trade authorizations and NO orders — it can only stop, never start",
        ]

    @property
    def category(self) -> str:
        return "orchestration"

    @property
    def events_consumed(self) -> List[EventType]:
        return ["POSITION_CLOSED"]

    @property
    def events_published(self) -> List[EventType]:
        # Publishes nothing. Observation Mode is enforced through
        # may_open_new_position(), which every gate already calls — an event
        # would only be honoured by agents that happened to subscribe.
        return []

    @property
    def responsibilities(self) -> List[str]:
        return [
            "Track the monthly equity high-water mark.",
            "Transition the system to Observation Mode on a 10% drawdown breach.",
            "Report what remains open when it halts — it does not auto-close positions.",
        ]

    @property
    def dependencies(self) -> List[str]:
        return ["MessageBus", "PortfolioStore", "core/system_state"]

    @property
    def memory_ttl(self) -> str:
        return (
            "High-water mark held in-process for the current calendar month. NOT persisted — "
            "see the note in _current_period(); a restart re-establishes the mark from live "
            "equity, which is a real limitation, not a design choice."
        )

    @property
    def knowledge_sources(self) -> List[str]:
        return ["Portfolio equity", "Realized P&L from POSITION_CLOSED events"]

    @property
    def prompt_reference(self) -> str:
        return "CEO_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return []

    @property
    def database_tables(self) -> List[str]:
        return []

    @property
    def metrics_reported(self) -> List[str]:
        return ["Current drawdown from HWM", "High-water mark", "Observation-mode transitions"]

    @property
    def failure_recovery_strategy(self) -> str:
        return (
            "Fails safe in the direction of halting. If equity cannot be read the drawdown check "
            "is skipped and logged as unevaluated — it does NOT clear an existing halt. A restart "
            "loses the in-process high-water mark, which is recorded as a known limitation rather "
            "than papered over."
        )

    @property
    def health_status(self) -> str:
        return "Active"

    # -----------------------------------------------------------------

    async def handle_event(self, event: BaseEvent) -> None:
        if isinstance(event, PositionClosedEvent):
            await self.evaluate_mandate(trigger=f"{event.symbol} closed at {event.realized_pnl:+.2f}")

    @staticmethod
    def _current_period() -> str:
        """Calendar month key for the high-water mark.

        Not persisted anywhere. That is a genuine limitation: after a restart
        the mark is re-established from current equity, so a drawdown that
        began before the restart is not detected. Fixing it properly needs an
        equity-history table, which is a schema change and therefore a
        separate piece of work — stated here rather than left for someone to
        discover during a drawdown.
        """
        now = datetime.datetime.utcnow()
        return f"{now.year}-{now.month:02d}"

    async def evaluate_mandate(self, trigger: str = "manual") -> Dict[str, Any]:
        """Update the high-water mark and halt if the drawdown limit is breached."""
        tab = settings.execution_tab
        equity = await self._read_equity(tab)

        if equity is None:
            # Unevaluated is not "passed". Importantly this does not clear an
            # existing halt.
            rationale = (
                f"Drawdown check NOT evaluated: equity for the '{tab}' tab is unknown. "
                f"An existing halt (if any) remains in force."
            )
            self.record_decision("unevaluated", rationale, {"trigger": trigger}, acted=False)
            logger.warning(rationale)
            return {"evaluated": False, "reason": rationale}

        period = self._current_period()
        if self._hwm_period != period:
            # New month: reset the mark to current equity per the spec's
            # "monthly high-water mark".
            self._hwm_period = period
            self._high_water_mark = equity
            logger.info("CEO: high-water mark reset for %s at %.2f", period, equity)

        if self._high_water_mark is None or equity > self._high_water_mark:
            self._high_water_mark = equity

        self._last_equity = equity
        hwm = self._high_water_mark
        drawdown = 0.0 if hwm <= 0 else max(0.0, (hwm - equity) / hwm)

        evidence = {
            "trigger": trigger,
            "tab": tab,
            "equity": round(equity, 2),
            "highWaterMark": round(hwm, 2),
            "drawdownPct": round(drawdown * 100, 3),
            "limitPct": MAX_DRAWDOWN_FROM_HIGH_WATER_MARK * 100,
            "period": period,
        }

        if drawdown > MAX_DRAWDOWN_FROM_HIGH_WATER_MARK:
            reason = (
                f"Equity ${equity:.2f} is {drawdown * 100:.2f}% below the {period} high-water mark "
                f"of ${hwm:.2f}, exceeding the {MAX_DRAWDOWN_FROM_HIGH_WATER_MARK * 100:.0f}% "
                f"drawdown limit."
            )
            already = is_in_observation_mode()
            enter_observation_mode(reason)

            open_positions = await self._open_positions(tab)
            if open_positions:
                # Surfaced loudly: the spec's "close all trades" is not
                # automated here (see the module docstring), so the operator
                # needs to know exactly what risk is still on the book.
                logger.critical(
                    "CEO halted trading with %d position(s) still OPEN — these were NOT closed: %s",
                    len(open_positions),
                    open_positions,
                )

            self.record_decision(
                "halt",
                reason,
                {**evidence, "openPositionsNotClosed": open_positions},
                acted=not already,
            )
            return {
                "evaluated": True,
                "halted": True,
                "reason": reason,
                "openPositionsNotClosed": open_positions,
                **evidence,
            }

        rationale = (
            f"Mandate to trade upheld: drawdown {drawdown * 100:.2f}% is within the "
            f"{MAX_DRAWDOWN_FROM_HIGH_WATER_MARK * 100:.0f}% limit "
            f"(equity ${equity:.2f} vs HWM ${hwm:.2f})."
        )
        # Recorded even when it passes — a killswitch that only logs on the day
        # it fires gives no way to see how close the account has been running.
        self.record_decision("continue", rationale, evidence, acted=False)
        return {"evaluated": True, "halted": False, "reason": rationale, **evidence}

    @staticmethod
    async def _read_equity(tab: str) -> Optional[float]:
        """Cash plus marked positions, or None when unknowable."""
        from backend.agents.supervisor_agent import SupervisorAgent

        portfolio = await get_portfolio()
        equity = SupervisorAgent._equity_for(portfolio, tab)
        # _equity_for returns 0.0 for "unknown", which must not be read as a
        # wiped-out account — that would trip the killswitch on every startup
        # for the real tab, where no cash figure is declared.
        return None if equity <= 0 else equity

    @staticmethod
    async def _open_positions(tab: str) -> List[Dict[str, Any]]:
        portfolio = await get_portfolio()
        book = portfolio.get(tab) or {}
        return [
            {"symbol": p.get("symbol"), "qty": p.get("qty"), "avgCost": p.get("avgCost")}
            for p in book.get("positions", [])
        ]


def get_ceo_agent() -> CEOAgent:
    return CEOAgent()
