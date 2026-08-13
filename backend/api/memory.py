"""Memory API (`/api/memory`) — spec Section 8: *"Read/write access to agent
memory stores."*

This module was `router = APIRouter()` with no routes.

WHAT IS DELIBERATELY READ-ONLY
------------------------------
Trade outcomes are NOT writable through this API. `services/ai_memory.record_trade`
exists and is called by the pipeline when a real position closes — but exposing
it over HTTP would let anything that can reach the port insert a fabricated
win or loss into the ledger.

That matters more than it sounds. The ledger feeds `get_memory_stats()`, which
the Confidence Agent uses as its measured historical accuracy, which scales the
confidence that drives position sizing. A writable outcome endpoint is a direct
path from "post some fake wins" to "the system sizes up". The Reflection agent
already learned this lesson the hard way: it used to fabricate a `pnl: -50.0`
on every entry, and those invented losses landed in exactly this store.

Reflections and lessons ARE writable, because a human operator recording an
observation is a legitimate input and it does not alter any counter that feeds
sizing.
"""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from backend.services.ai_memory import generate_learning_report, get_memory_stats

logger = logging.getLogger(__name__)

router = APIRouter()


class LessonInput(BaseModel):
    symbol: str = Field(..., min_length=1)
    lesson: str = Field(..., min_length=1)
    recorded_by: str = Field(..., min_length=1, description="Who recorded this")


@router.get("")
async def get_memory() -> Dict[str, Any]:
    """Global stats and store sizes — the summary view."""
    memory = get_memory_stats() or {}
    global_stats = memory.get("global_stats") or {}
    return {
        "status": "success",
        "globalStats": global_stats,
        "assetCount": len(memory.get("assets") or {}),
        "strategyCount": len(memory.get("successful_strategies") or {}),
        "mistakeCount": len(memory.get("mistakes") or []),
        "ledgerLength": len(memory.get("trade_ledger") or []),
        # The Confidence Agent needs 20 resolved trades before it trusts a
        # measured win rate; below that it uses a conservative assumption.
        # Surfaced so a low confidence figure is explainable.
        "sufficientForCalibration": (global_stats.get("total_trades") or 0) >= 20,
    }


@router.get("/stats")
async def get_stats() -> Dict[str, Any]:
    """Global counters only."""
    memory = get_memory_stats() or {}
    stats = memory.get("global_stats") or {}
    if not stats:
        # Explicit, rather than an empty object that reads as zero trades.
        return {
            "status": "success",
            "stats": {},
            "note": "No memory file exists yet — no trades have been recorded.",
        }
    return {"status": "success", "stats": stats}


@router.get("/ledger")
async def get_ledger(
    limit: int = Query(50, ge=1, le=500),
    symbol: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Recorded trade outcomes, newest first."""
    memory = get_memory_stats() or {}
    ledger = list(memory.get("trade_ledger") or [])

    if symbol:
        ledger = [t for t in ledger if t.get("symbol") == symbol]

    # Newest first: the ledger is appended to, so the tail is the recent end.
    ledger.reverse()
    return {
        "status": "success",
        "count": len(ledger),
        "returned": min(limit, len(ledger)),
        "symbol": symbol,
        "ledger": ledger[:limit],
    }


@router.get("/mistakes")
async def get_mistakes(limit: int = Query(20, ge=1, le=200)) -> Dict[str, Any]:
    """Recorded mistakes and their analyses."""
    memory = get_memory_stats() or {}
    mistakes = list(memory.get("mistakes") or [])
    mistakes.reverse()
    return {
        "status": "success",
        "count": len(mistakes),
        "mistakes": mistakes[:limit],
    }


@router.get("/report")
async def get_report() -> Dict[str, Any]:
    """The learning report — win rate, expectancy, per-strategy performance.

    Returns 200 with an explicit `sufficientData: false` when the ledger is too
    short, rather than an error. "Not enough data yet" is a normal state for a
    new deployment, not a failure.
    """
    report = generate_learning_report()
    if "error" in report:
        return {
            "status": "success",
            "sufficientData": False,
            "reason": report["error"],
            "report": None,
        }
    return {"status": "success", "sufficientData": True, "report": report}


@router.post("/lesson")
async def record_lesson(payload: LessonInput) -> Dict[str, Any]:
    """Record an operator-supplied lesson against a symbol.

    Writes to the `mistakes` store with attribution. Deliberately does NOT
    touch `global_stats` or `trade_ledger` — those drive the accuracy figure
    the Confidence Agent calibrates against, and therefore position sizing.
    See the module docstring for why no route here can write a trade outcome.
    """
    import datetime

    from backend.services.ai_memory import _load_memory, _save_memory

    memory = _load_memory()
    memory.setdefault("mistakes", []).append(
        {
            "ts": datetime.datetime.utcnow().isoformat(),
            "symbol": payload.symbol,
            "lesson": payload.lesson,
            "recorded_by": payload.recorded_by,
            # Marks this as human-entered so it is never confused with an
            # outcome the system observed.
            "source": "operator (POST /api/memory/lesson)",
        }
    )
    _save_memory(memory)
    logger.info("Operator lesson recorded for %s by %s", payload.symbol, payload.recorded_by)
    return {
        "status": "success",
        "symbol": payload.symbol,
        "affectsSizing": False,
        "note": "Recorded to the mistakes store. Global stats and the trade ledger are unchanged.",
    }
