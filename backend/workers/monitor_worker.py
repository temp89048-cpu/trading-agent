"""Continuous Monitoring Loop — spec Section 14, "The AI Never Sleeps".

    "Every minute, independent of whether a trade is being considered, the agent
     should be asking itself: What changed? What am I missing? Is my prediction
     still valid? Is risk increasing? Should I reduce leverage? Should I exit?
     Should I hedge? Should I wait? Should I learn something? Should I ask
     another AI? Should I ask the user? Should I perform research?"

WHAT THIS REPLACED
------------------
    open_positions = [{"symbol": "BTC-USDT", "pnl_pct": -2.5}]   # hardcoded
    ...
    # self.bus.publish(EvaluatePositionEvent(...))               # commented out

A hardcoded position, a fabricated P&L, and a publish that never happened. And
`main.py` never started the worker, so even that did not run.

WHAT IT IS AND IS NOT
---------------------
This is a *reporting* loop, not a second decision loop. It answers Section 14's
questions from real state and records the answers; it does not open, close, or
resize anything. Position exits are the Position Monitor's job and run on every
tick rather than once a minute — a stop that only checked each minute would let
price run far past it.

Separating "observe and report" from "act" matters: two loops that can both act
on the same position will eventually act twice on it.
"""

import asyncio
import logging
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ContinuousMonitorWorker:
    """Runs Section 14's checklist every minute against real state."""

    def __init__(self, interval_seconds: int = 60):
        self.interval_seconds = interval_seconds
        self._running = False
        self._task: Optional[asyncio.Task] = None
        self.last_cycle: Optional[Dict[str, Any]] = None
        self.cycles_run = 0

    async def start(self) -> None:
        self._running = True
        logger.info("Continuous Monitoring Loop started (every %ds).", self.interval_seconds)
        while self._running:
            try:
                self.last_cycle = await self.run_cycle()
                self.cycles_run += 1
            except asyncio.CancelledError:
                raise
            except Exception as e:
                # Never let one bad cycle kill the loop. A monitoring loop that
                # dies silently is the failure mode spec Section 22.8 warns
                # about — the operator keeps believing something is watching.
                logger.error("Monitor cycle failed: %s", e)
            await asyncio.sleep(self.interval_seconds)

    def stop(self) -> None:
        self._running = False
        logger.info("Continuous Monitoring Loop stopped after %d cycle(s).", self.cycles_run)

    async def run_cycle(self) -> Dict[str, Any]:
        """One pass of Section 14's questions, answered from real state."""
        from backend.core.config import settings
        from backend.core.system_state import (
            is_in_observation_mode,
            is_system_paused,
            observation_reason,
        )
        from backend.services.market_data import get_price
        from backend.services.portfolio_store import get_portfolio

        now = datetime.utcnow().isoformat()
        tab = settings.execution_tab
        portfolio = await get_portfolio()
        book = portfolio.get(tab) or {}
        positions = book.get("positions", [])

        observations: List[str] = []
        concerns: List[str] = []

        # --- "Is risk increasing?" / "Should I exit?" --------------------
        marked = []
        for pos in positions:
            symbol = pos.get("symbol")
            qty = float(pos.get("qty") or 0)
            cost = float(pos.get("avgCost") or 0)
            live = get_price(symbol) if symbol else 0.0

            if live <= 0:
                # A position we cannot price is a real concern, not a gap to
                # skip over: it is unmonitorable until the feed returns.
                concerns.append(
                    f"{symbol}: no live price — this position cannot be valued or monitored."
                )
                marked.append({"symbol": symbol, "qty": qty, "pnlPct": None, "priced": False})
                continue

            pnl_pct = ((live - cost) / cost * 100) if cost else 0.0
            marked.append({"symbol": symbol, "qty": qty, "pnlPct": round(pnl_pct, 3), "priced": True})
            if pnl_pct <= -5.0:
                concerns.append(f"{symbol}: down {pnl_pct:.2f}% against entry.")

        # --- "What changed?" -------------------------------------------
        if not positions:
            observations.append("No open positions.")
        else:
            observations.append(f"{len(positions)} open position(s) on the {tab} book.")

        # --- "Should I wait?" (operator state) --------------------------
        if is_system_paused():
            observations.append("System is paused — no new entries. Exits remain available.")
        if is_in_observation_mode():
            concerns.append(f"Observation mode active: {observation_reason()}")

        # --- "Should I learn something?" / "perform research?" ----------
        try:
            from backend.services.research_store import queue_summary

            queue = await queue_summary()
            awaiting = queue["awaitingHumanReview"]
            if awaiting:
                observations.append(
                    f"{awaiting} hypothesis/hypotheses awaiting human review "
                    f"(nothing applied automatically)."
                )
            open_tasks = queue["researchTasks"]["open"]
            if open_tasks:
                observations.append(f"{open_tasks} open research task(s).")
        except Exception as e:
            logger.debug("Could not read research queue: %s", e)

        # --- "Should I ask another AI?" / "ask the user?" ---------------
        # Answered honestly: neither is wired in the backend. Reported as a
        # known gap rather than silently omitted from the checklist, so the
        # cycle record reflects what was actually considered.
        unanswered = [
            "Should I ask another AI? — second-opinion collaboration is implemented on the "
            "TypeScript side only (lib/collaborationAgent.ts); no backend path exists.",
            "Should I ask the user? — no backend notification channel exists.",
        ]

        cycle = {
            "ts": now,
            "tab": tab,
            "positions": marked,
            "observations": observations,
            "concerns": concerns,
            "unanswered": unanswered,
            # Stated so this record is never mistaken for a decision log.
            "actionsTaken": [],
            "note": (
                "Reporting only. This loop does not open, close, or resize positions — "
                "exits are handled by the Position Monitor on every tick, not once a minute."
            ),
        }

        if concerns:
            logger.warning("Monitor cycle: %d concern(s): %s", len(concerns), "; ".join(concerns))
        else:
            logger.info("Monitor cycle: %s", "; ".join(observations) or "nothing to report")

        return cycle


_worker: Optional[ContinuousMonitorWorker] = None


def get_monitor_worker(interval_seconds: int = 60) -> ContinuousMonitorWorker:
    global _worker
    if _worker is None:
        _worker = ContinuousMonitorWorker(interval_seconds)
    return _worker
