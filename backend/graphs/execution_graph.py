"""Execution planning — spec Section 24 (Phase 41), Execution Intelligence.

THIS IS DELIBERATELY NOT A LANGGRAPH GRAPH, DESPITE THE FILENAME
---------------------------------------------------------------
Spec Section 12 is explicit: *"LangGraph generates an execution request; execution
happens **outside** LangGraph."* Section 36 puts orders in the Execution Plane, and
Rule 0 says the reasoning layer can recommend but never place.

This file previously contained a real `StateGraph` with a `route_to_exchange` node.
That put order routing inside the cognitive plane — the one thing the whole
architecture exists to prevent. The filename is kept only because renaming a file
is a delete plus a create; treat the name as historical.

WHAT IT USED TO DO, AND WHY THAT WAS WORSE THAN NOTHING
------------------------------------------------------
    def fetch_order_book_depth(state):
        state["market_conditions"] = {
            "spread_bps": 2.5,
            "volume_1m": 150000,
            "depth_imbalance": -0.1,
        }

Three invented numbers, and the next node made a real slicing decision from one of
them (`size > cond["volume_1m"] * 0.05`). This system subscribes **no order-book
feed at all** — the Phase 26 liquidity specialist and the Phase 28 liquidity check
both report that honestly and refuse to estimate depth. This module invented the
exact data three other components decline to invent, then sized an order with it.
CLAUDE.md invariant 6.

WHAT IT DOES NOW
----------------
Plans execution from data that actually exists — traded candle volume — and says
plainly that volume is not depth. The slicing arithmetic is delegated to
`algorithms/execution.twap_order_slicer`, which already existed and is already used
by `agents/execution_agent.py`; this does not reimplement it.

When volume is unavailable it returns a plan that says so and does NOT slice.
Slicing on an unknown market impact is not conservative — it just spreads an order
of unknown size over time for reasons nobody measured.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from backend.algorithms.execution import twap_order_slicer

logger = logging.getLogger(__name__)

# An order larger than this share of recent traded volume is sliced.
#
# 5% of the volume actually printed in the sampled window. Not a depth measure and
# not a slippage model — a coarse "is this order large for this market" test, which
# is the most that candle volume can honestly support.
PARTICIPATION_THRESHOLD = 0.05

# TWAP window when slicing. Long enough for the book to refill between slices,
# short enough that the thesis that justified the entry has not moved on.
TWAP_WINDOW_MINUTES = 5
TWAP_INTERVAL_MINUTES = 1

# Candles sampled for the volume estimate. Five 15m candles is roughly the last
# hour — recent enough to reflect the current session, long enough that one quiet
# candle does not make an ordinary order look large.
VOLUME_SAMPLE_CANDLES = 5


@dataclass
class ExecutionPlanning:
    """How to work an approved order. Advisory to the execution chokepoint.

    Carries `unavailable` for the same reason every other result object in this
    codebase does: "sliced into 5" and "not sliced because volume was unknown" are
    different facts, and an executor reading `slices == 1` must be able to tell
    which one it is looking at.
    """

    strategy: str = "MARKET"
    slices: List[float] = field(default_factory=list)
    interval_seconds: int = 0
    detail: str = ""
    unavailable: List[str] = field(default_factory=list)

    @property
    def slice_count(self) -> int:
        return len(self.slices) or 1


def plan_execution(
    quantity: float,
    candles: Optional[List[Dict[str, Any]]] = None,
) -> ExecutionPlanning:
    """Decide whether to work an order in slices. Pure; no I/O, no fabrication.

    `candles` is the same 15m series the graph already fetched into
    `TradingState.market_data` — passed in rather than fetched so this cannot
    reason over a different market than the decision did (Section 39.4).
    """
    if quantity <= 0:
        return ExecutionPlanning(
            strategy="NONE",
            detail=f"nothing to execute (quantity {quantity!r})",
            unavailable=["execution planning (no quantity)"],
        )

    volume, sampled = _recent_volume(candles)

    if volume is None:
        # NOT sliced. Slicing on an unknown market impact spreads an order over
        # time for reasons nobody measured, which is activity rather than caution.
        return ExecutionPlanning(
            strategy="MARKET",
            slices=[quantity],
            interval_seconds=0,
            detail=(
                f"single market order for {quantity:.10g}: recent traded volume "
                f"could not be measured, so participation is unknown and there is "
                f"no measured reason to slice"
            ),
            unavailable=[
                "execution participation (no candle volume available). NOTE: even "
                "with volume this is a TRADED-VOLUME proxy — no order-book depth "
                "feed is subscribed, so slippage and fillable size remain unbounded"
            ],
        )

    participation = quantity / volume if volume > 0 else None

    always_unavailable = [
        "execution slippage estimate (no order-book depth feed is subscribed; "
        "traded volume bounds neither slippage nor fillable size)"
    ]

    if participation is None or participation <= PARTICIPATION_THRESHOLD:
        return ExecutionPlanning(
            strategy="MARKET",
            slices=[quantity],
            interval_seconds=0,
            detail=(
                f"single market order for {quantity:.10g}: "
                + (f"{participation * 100:.2f}% of " if participation is not None else "under ")
                + f"{volume:,.0f} traded over {sampled} candle(s), within the "
                f"{PARTICIPATION_THRESHOLD * 100:.0f}% participation threshold"
            ),
            unavailable=always_unavailable,
        )

    slices = twap_order_slicer(
        total_qty=quantity,
        execution_window_minutes=TWAP_WINDOW_MINUTES,
        interval_minutes=TWAP_INTERVAL_MINUTES,
    )
    planning = ExecutionPlanning(
        strategy="TWAP",
        slices=slices,
        interval_seconds=TWAP_INTERVAL_MINUTES * 60,
        detail=(
            f"TWAP {len(slices)} slice(s) of ~{slices[0]:.10g} every "
            f"{TWAP_INTERVAL_MINUTES}m: {quantity:.10g} is "
            f"{participation * 100:.2f}% of the {volume:,.0f} traded over "
            f"{sampled} candle(s), above the "
            f"{PARTICIPATION_THRESHOLD * 100:.0f}% threshold. Slicing is based on "
            f"TRADED VOLUME, not order-book depth"
        ),
        unavailable=always_unavailable,
    )
    logger.info("Execution planning: %s", planning.detail)
    return planning


def _recent_volume(candles: Optional[List[Dict[str, Any]]]) -> tuple:
    """Total traded volume over the sampled candles, or (None, 0).

    Returns None rather than 0.0 when nothing is usable. A zero volume would read
    as "this market traded nothing", which is a measurement, and would make every
    order look infinitely large relative to it.
    """
    if not candles:
        return None, 0
    recent = candles[-VOLUME_SAMPLE_CANDLES:]
    total, counted = 0.0, 0
    for bar in recent:
        try:
            total += float(bar["volume"])
            counted += 1
        except (KeyError, TypeError, ValueError):
            continue
    if counted == 0 or total <= 0:
        return None, counted
    return total, counted
