"""Phase 32 node — Memory Loader (spec Section 15).

Reads Section 15's SEVEN memory stores into `TradingState.memory_context` so every
downstream node reasons with the same history instead of each fetching its own.

THREE FIXES FROM THE SECTION 14-41 AUDIT
----------------------------------------
1. **It dropped the seventh store.** The docstring said "the 6 Phase 32 memory
   stores" and `procedural` was never copied out of the fetched dict, so
   `services/procedural_memory.py` stayed unreachable even after
   `memory_manager` was corrected to read it.

2. **`reads`/`writes` were sets, not tuples.** Every other contract in the system
   uses tuples. It happened to work because `validate_node_output` does
   `set(contract.writes)`, but a frozen dataclass holding a mutable set is a
   contract whose declared permissions are mutable by anything holding a
   reference — which is the one property `NodeContract` exists to prevent.

3. **`NodeContract` was imported from `graphs.runtime`.** It is defined in
   `graphs.contracts`; runtime merely re-exports it. Importing through the
   re-export works and hides where the type actually lives.

WHY THE NODE STILL RETURNS A CONTEXT ON FAILURE
----------------------------------------------
`fetch_memory_context` never raises and records per-store failures itself, so the
outer try/except here is for genuinely unexpected errors only. It returns a
`MemoryContext` with `unavailable` populated rather than `None`, because a
downstream node reading `memory_context.risk_events` must get an empty list with a
stated reason, not an AttributeError.
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from backend.graphs.contracts import NodeContract
from backend.graphs.registry import register_node
from backend.graphs.state import MemoryContext, TradingState
from backend.services.memory_manager import MEMORY_STORES, fetch_memory_context

logger = logging.getLogger(__name__)

MEMORY_LOADER_NODE = "memory_loader"


async def load_memory_context(state: TradingState) -> Dict[str, Any]:
    """Populate all seven Section 15 stores into state."""
    symbol = state.get("symbol")
    if not symbol:
        return {
            "memory_context": MemoryContext(
                unavailable=["all stores: no symbol on the state to read memory for"]
            )
        }

    try:
        data = await fetch_memory_context(symbol)
    except Exception as exc:  # noqa: BLE001
        # `fetch_memory_context` handles its own per-store failures, so reaching here
        # means something unexpected broke. Recorded rather than raised: a memory
        # read must never fail a trading decision.
        logger.error("Memory context could not be fetched for %s: %s", symbol, exc)
        return {
            "memory_context": MemoryContext(
                unavailable=[f"all stores: {exc}"]
            )
        }

    context = MemoryContext(
        working=data.get("working") or {},
        episodic=data.get("episodic") or [],
        semantic=data.get("semantic") or [],
        # The store that was being dropped. See fix 1.
        procedural=data.get("procedural") or [],
        strategy_performance=data.get("strategy_performance") or {},
        risk_events=data.get("risk_events") or [],
        research_findings=data.get("research_findings") or [],
        unavailable=data.get("unavailable") or [],
    )

    read = len(MEMORY_STORES) - len(context.unavailable)
    logger.debug(
        "Memory loaded for %s: %d/%d stores", symbol, read, len(MEMORY_STORES)
    )
    out: Dict[str, Any] = {"memory_context": context}
    if context.unavailable:
        # Surfaced onto the run's own `unavailable` list too, so a trace shows the
        # gap without a reader having to open `memory_context`.
        out["unavailable"] = [f"memory store {u}" for u in context.unavailable]
    return out


def register_memory_node() -> None:
    register_node(
        NodeContract(
            name=MEMORY_LOADER_NODE,
            # Tuples, not sets. See fix 2.
            reads=("symbol",),
            writes=("memory_context",),
            purpose=(
                "Read Section 15's seven memory stores into state so every "
                "downstream node reasons over the same history"
            ),
            deterministic=True,
            phase=32,
        ),
        load_memory_context,
    )
