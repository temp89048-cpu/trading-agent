"""Node registry — spec Section 6's "Node Registry" deliverable.

Maps a node name to its callable and its `NodeContract`. Registering is the only
way a node becomes usable by `builder.py`, which means:

  * every node in every graph has a declared contract (there is no path to an
    unconstrained node);
  * the contract is validated at REGISTRATION, so a typo'd state field or a
    node declaring both `deterministic` and `may_call_llm` fails at import time
    rather than mid-run;
  * the set of nodes is introspectable, which the monitoring API needs and which
    makes "what can this system actually do?" answerable.

This mirrors `core/agent_os.AgentOS.register`, deliberately. That registry is
what made 16 agents visible to health monitoring after they had been invisible;
the same reasoning applies to graph nodes.
"""

from __future__ import annotations

import logging
import sys
from typing import Any, Callable, Dict, List, Optional

from backend.graphs.contracts import NodeContract
from backend.graphs.state import TradingState

logger = logging.getLogger(__name__)

# A node is an async callable taking the state and returning a partial update
# (or None to write nothing).
NodeFn = Callable[[TradingState], Any]


class _Registry:
    def __init__(self) -> None:
        self._nodes: Dict[str, NodeFn] = {}
        self._contracts: Dict[str, NodeContract] = {}

    def register(self, contract: NodeContract, fn: NodeFn) -> None:
        if contract.name in self._nodes:
            # Raise rather than overwrite. A duplicate name means two different
            # implementations claim the same graph position, and silently keeping
            # the last one registered would make behaviour depend on import order.
            raise ValueError(
                f"node '{contract.name}' is already registered. Two nodes cannot "
                f"share a name — the graph would silently use whichever imported last."
            )
        self._nodes[contract.name] = fn
        self._contracts[contract.name] = contract
        logger.debug(
            "Registered graph node '%s' (%s, phase %s)",
            contract.name,
            "deterministic" if contract.deterministic else "llm",
            contract.phase,
        )

    def get(self, name: str) -> tuple[NodeFn, NodeContract]:
        if name not in self._nodes:
            raise KeyError(
                f"no graph node named '{name}'. Registered: {sorted(self._nodes)}"
            )
        return self._nodes[name], self._contracts[name]

    def contract(self, name: str) -> Optional[NodeContract]:
        return self._contracts.get(name)

    def names(self) -> List[str]:
        return sorted(self._nodes)

    def all_contracts(self) -> List[NodeContract]:
        return [self._contracts[n] for n in sorted(self._contracts)]

    def clear(self) -> None:
        """For tests. Not called in production."""
        self._nodes.clear()
        self._contracts.clear()


_registry = _Registry()


def register_node(contract: NodeContract, fn: NodeFn) -> None:
    _registry.register(contract, fn)


def get_node(name: str) -> tuple[NodeFn, NodeContract]:
    return _registry.get(name)


def get_contract(name: str) -> Optional[NodeContract]:
    return _registry.contract(name)


def registered_nodes() -> List[str]:
    return _registry.names()


def all_contracts() -> List[NodeContract]:
    return _registry.all_contracts()


def clear_registry() -> None:
    """Empty the registry AND reset the graph modules' "already registered" flags.

    Clearing only the registry left the system unable to rebuild. Each graph module
    keeps a `_nodes_registered` flag so it does not re-register on every
    `*_config()` call — and that flag survived the clear, so every subsequent
    `_ensure_nodes()` returned early and the registry stayed empty. Any config built
    after a clear then raised `KeyError` on its first node.

    It only bit under a full test run, where one module clears the registry and a
    later test builds a graph — the failing test passed in isolation. A cleanup
    helper that leaves the system unusable is worse than one that does nothing,
    because the damage surfaces somewhere else entirely.

    The reset is done by import rather than by a registration hook so the modules
    stay unaware of the registry's lifecycle: a module that had to register a reset
    callback could forget to, and forgetting would reproduce exactly this bug.
    """
    _registry.clear()

    for module_name in (
        "backend.graphs.market_state",
        "backend.graphs.opportunity",
        "backend.graphs.analysis",
        "backend.graphs.monitoring",
    ):
        module = sys.modules.get(module_name)
        if module is not None and hasattr(module, "_nodes_registered"):
            module._nodes_registered = False


def coverage() -> Dict[str, Any]:
    """Registry summary, for the monitoring API.

    Reports the deterministic/LLM split explicitly. That ratio is the number to
    watch over time: this system's safety rests on the decision-critical nodes
    staying deterministic, and a drift toward LLM nodes is the failure mode the
    plan names as most likely.
    """
    contracts = _registry.all_contracts()
    deterministic = [c.name for c in contracts if c.deterministic]
    llm = [c.name for c in contracts if c.may_call_llm]
    return {
        "total": len(contracts),
        "deterministic": deterministic,
        "llm": llm,
        "deterministicCount": len(deterministic),
        "llmCount": len(llm),
        "byPhase": {
            str(c.phase): c.name for c in contracts if c.phase is not None
        },
    }
