"""Memory Manager — spec Section 15 (Phase 32).

Unifies Section 15's SEVEN memory stores behind one interface for LangGraph.

    | Store      | Contains                     | Backed by                    |
    |------------|------------------------------|------------------------------|
    | Working    | Current market context       | services/working_memory      |
    | Episodic   | Previous trades              | services/ai_memory ledger    |
    | Semantic   | Trading knowledge            | services/semantic_memory     |
    | Procedural | How the system operates      | services/procedural_memory   |
    | Strategy   | Strategy-specific perf.      | services/ai_memory strategies|
    | Risk       | Previous risk events         | services/risk_memory         |
    | Research   | Experimental findings        | services/research_store      |

WHAT THE SECTION 14-41 AUDIT FOUND HERE
---------------------------------------
This function existed, imported cleanly, ran without raising, and returned a
plausible-looking context — while reading almost nothing. **Four of its five store
calls named methods that do not exist:**

    get_working_memory          -> the module has `get_current_context` (async)
    SemanticMemory              -> the module is functions, not a class
    sm.get_relevant_lessons     -> never existed; semantic memory is an
                                   entity/relationship store, not a lesson store
    get_validated_strategies    -> the module has `get_hypotheses` / `queue_summary`
    rm.get_recent_events        -> the class defines `get_recent_risk_events`

Every call was wrapped in `except Exception: log; append("unavailable")`, so all
five failed silently and the caller received a context with five of six dimensions
empty. It was invisible precisely BECAUSE the degradation was honest — the
`unavailable` list was doing its job while nothing else was.

It also implemented **six** stores, not seven: its own docstring said "all 6
memory dimensions". Procedural Memory was absent, which is why
`services/procedural_memory.py` had zero callers anywhere in the codebase — the
store existed and there was nowhere for its output to go.

WHY EACH STORE IS STILL WRAPPED IN A try/except
-----------------------------------------------
Because a memory read must never fail a trading decision: a broken lesson store is
not a reason to stop watching a position. But the handler now records WHICH store
failed and WHY, and `MEMORY_STORES` lets a test assert all seven were attempted —
so a silently-missing store cannot recur.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List

logger = logging.getLogger(__name__)

# Section 15's seven stores, by the name used in the returned context. Declared so
# a test can assert every one is attempted — the previous version was missing
# `procedural` and nothing caught it.
MEMORY_STORES = (
    "working",
    "episodic",
    "semantic",
    "procedural",
    "strategy_performance",
    "risk_events",
    "research_findings",
)


async def fetch_memory_context(symbol: str) -> Dict[str, Any]:
    """Read all seven stores for one symbol. Never raises.

    `unavailable` carries one entry per store that could not be read, with the
    reason. An empty list there means all seven were read — NOT that they all
    returned data.
    """
    context: Dict[str, Any] = {
        "working": {},
        "episodic": [],
        "semantic": [],
        "procedural": [],
        "strategy_performance": {},
        "risk_events": [],
        "research_findings": [],
        "unavailable": [],
    }

    def failed(store: str, exc: Exception) -> None:
        logger.error("Memory store '%s' unavailable: %s", store, exc)
        context["unavailable"].append(f"{store}: {exc}")

    # --- 1. Working memory: the current market context ---------------------
    try:
        from backend.services.working_memory import (
            get_current_context,
            get_latest_monitoring_cycles,
        )

        context["working"] = {
            "context": await get_current_context(),
            "recentCycles": await get_latest_monitoring_cycles(limit=3),
        }
    except Exception as exc:  # noqa: BLE001
        failed("working", exc)

    # --- 2 + 5. Episodic and Strategy memory, both from the trade ledger ----
    #
    # One try block because they share a single read. Two blocks would read the
    # file twice for one result, and the file is the same on both reads.
    try:
        from backend.services.ai_memory import _load_memory

        ai_mem = _load_memory() or {}
        ledger = ai_mem.get("trade_ledger") or []
        context["episodic"] = [
            t for t in ledger if t.get("symbol") == symbol
        ][-10:]
        context["strategy_performance"] = ai_mem.get("successful_strategies") or {}
    except Exception as exc:  # noqa: BLE001
        failed("episodic", exc)
        failed("strategy_performance", exc)

    # --- 3. Semantic memory: what this system knows about the asset ---------
    #
    # An entity/relationship store, NOT a lesson store. The previous version called
    # a `get_relevant_lessons` that never existed; lessons live in `ai_memory`'s
    # mistakes list and in the reflection store.
    try:
        from backend.services.semantic_memory import get_entity, get_relationships

        base = str(symbol).split("/")[0].upper()
        entity = await get_entity(base)
        relationships = await get_relationships(base)
        context["semantic"] = {
            "entity": entity,
            "relationships": relationships or [],
        }
    except Exception as exc:  # noqa: BLE001
        failed("semantic", exc)

    # --- 4. Procedural memory: how the system operates ----------------------
    #
    # THE STORE THAT HAD NO CALLER. Section 15 requires it and this manager did not
    # read it, so `procedural_memory.py` was unreachable dead code.
    try:
        from backend.services.procedural_memory import ProceduralMemory

        context["procedural"] = ProceduralMemory().get_all_instructions() or []
    except Exception as exc:  # noqa: BLE001
        failed("procedural", exc)

    # --- 6. Risk memory: what has been blocked before ----------------------
    #
    # `None` from the store means UNREADABLE; `[]` means read-and-empty. Collapsing
    # them would make a broken query read as "this system has never been blocked".
    try:
        from backend.services.risk_memory import RiskMemory

        events = await RiskMemory.get_recent_risk_events(limit=5)
        if events is None:
            raise RuntimeError(
                "risk_events could not be read (no database pool, or the query "
                "failed) — this is NOT the same as there being no risk events"
            )
        context["risk_events"] = events
    except Exception as exc:  # noqa: BLE001
        failed("risk_events", exc)

    # --- 7. Research memory: experimental findings -------------------------
    try:
        from backend.services.research_store import get_hypotheses, queue_summary

        validated = await get_hypotheses(status="validated")
        context["research_findings"] = {
            "validated": validated or [],
            "queue": await queue_summary(),
        }
    except Exception as exc:  # noqa: BLE001
        failed("research_findings", exc)

    read = len(MEMORY_STORES) - len(context["unavailable"])
    logger.info(
        "Memory context for %s: %d/%d store(s) read%s",
        symbol, read, len(MEMORY_STORES),
        "" if not context["unavailable"]
        else f" — unavailable: {', '.join(u.split(':')[0] for u in context['unavailable'])}",
    )
    return context
