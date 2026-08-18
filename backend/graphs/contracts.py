"""NodeContract — how spec Rule 0 gets enforced instead of merely stated.

    Section 0: "LangGraph is the agent's reasoning/orchestration layer — it is
    not the exchange execution engine, and it is not the risk-control boundary."

    Section 2: "The LLM never gets direct permission to place an exchange order.
    This single sentence is the most important line in this whole document."

A sentence in a document does not prevent anything. This module is the
mechanism, modelled on `core/agent_base.BaseAgent.publish()` — which already
raises `PermissionError` when an agent emits an event it never declared, and has
a test proving it.

FOUR ENFORCEMENT LAYERS
-----------------------
1. **Declared writes.** A node writing a state field outside its contract
   raises. Prevents scope creep where a node that "just needs to also set
   confidence" quietly becomes a decision-maker.

2. **Deterministic flag.** A node marked deterministic that reaches the LLM
   provider raises. This is what stops the debate, the confidence calibration,
   the stress test and the risk checks from drifting into LLM calls — all four
   were deliberately made deterministic and have tests asserting the same
   candles always produce the same verdict.

3. **Deterministic-only fields.** An LLM node cannot write `risk_assessment`,
   `market_data`, `confidence`, or the other fields in
   `state.DETERMINISTIC_ONLY_FIELDS`. A model may describe a computed number; it
   may not replace it.

4. **Write-once fields.** `market_data` is written by exactly one node. Section
   39.4: a node re-fetching on replay reasons over a different market than the
   decision it is supposed to be resuming.

WHAT THIS MODULE DOES *NOT* DO
------------------------------
It does not stop a node importing the execution engine. Import-level isolation
is a separate, stronger control enforced by an AST test over every module under
`graphs/` (see `tests/test_graph_contracts.py`). Runtime checks and import
checks catch different mistakes and both are needed: a contract can be edited,
but a symbol that is not importable cannot be called at all.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Set, Tuple

from backend.graphs.state import (
    DETERMINISTIC_ONLY_FIELDS,
    STATE_FIELDS,
    WRITE_ONCE_FIELDS,
    TradingState,
)


class NodeContractViolation(RuntimeError):
    """Raised when a node exceeds its declared contract.

    A distinct type rather than a bare RuntimeError so the runtime can log it as
    a contract breach — a category of bug worth separating from an ordinary node
    failure, because it means the safety model was bypassed rather than that the
    market data was bad.
    """


@dataclass(frozen=True)
class NodeContract:
    """What one graph node is permitted to do.

    Frozen because a mutable contract is not a control: any code holding a
    reference could widen its own permissions at runtime.
    """

    name: str
    # State fields the node may read. Documented rather than enforced — reading
    # is not a safety concern and enforcing it would mean proxying the whole
    # state object on every node call for no protection.
    reads: Tuple[str, ...]
    # State fields the node may write. ENFORCED.
    writes: Tuple[str, ...]
    # Plain-language purpose, surfaced in traces and the node registry API.
    purpose: str
    # True = pure computation, no model call. A deterministic node that reaches
    # the LLM provider raises.
    deterministic: bool = True
    # True only for nodes that genuinely need judgement. Mutually exclusive with
    # `deterministic` — a node cannot be both.
    may_call_llm: bool = False
    # Which spec phase this node belongs to, for traceability back to the spec.
    phase: Optional[int] = None

    def __post_init__(self) -> None:
        if self.deterministic and self.may_call_llm:
            raise ValueError(
                f"node '{self.name}' declares both deterministic=True and "
                f"may_call_llm=True. A node is one or the other: if it calls a model "
                f"its output is not reproducible, and reproducibility is what lets a "
                f"decision rule be backtested."
            )

        unknown_writes = set(self.writes) - STATE_FIELDS
        if unknown_writes:
            # Caught at construction, not at first run. A typo'd field name
            # would otherwise produce a state write LangGraph silently discards,
            # and the node would appear to work while writing nothing.
            raise ValueError(
                f"node '{self.name}' declares writes to unknown TradingState "
                f"field(s): {sorted(unknown_writes)}. Known fields: "
                f"{sorted(STATE_FIELDS)}"
            )

        unknown_reads = set(self.reads) - STATE_FIELDS
        if unknown_reads:
            raise ValueError(
                f"node '{self.name}' declares reads of unknown TradingState "
                f"field(s): {sorted(unknown_reads)}"
            )

        if self.may_call_llm:
            forbidden = set(self.writes) & DETERMINISTIC_ONLY_FIELDS
            if forbidden:
                raise ValueError(
                    f"LLM node '{self.name}' may not write {sorted(forbidden)}. "
                    f"These fields hold measured or computed values (risk assessment, "
                    f"market data, confidence). A model may narrate them; it may not "
                    f"replace them — otherwise a node asked to describe a score could "
                    f"change it."
                )


def validate_node_output(
    contract: NodeContract,
    output: Optional[Dict[str, Any]],
    state_before: TradingState,
) -> Dict[str, Any]:
    """Check a node's returned state delta against its contract.

    Returns the delta unchanged when valid; raises `NodeContractViolation`
    otherwise. Called by the runtime around every node, so a violation cannot be
    skipped by a node that forgets to self-check.

    `None` is a legal return meaning "I wrote nothing" — a node that could not
    run should return None rather than an empty-but-plausible payload.
    """
    if output is None:
        return {}

    if not isinstance(output, dict):
        raise NodeContractViolation(
            f"node '{contract.name}' returned {type(output).__name__}, expected a "
            f"dict of state updates or None."
        )

    written = set(output.keys())
    declared = set(contract.writes)

    # Bookkeeping fields every node may append to. These are how a node reports
    # its own failure or an unavailable input, so requiring each contract to
    # declare them would mean a node could be forbidden from reporting that it
    # broke.
    always_writable = {"errors", "unavailable", "nodes_visited", "llm_calls_made", "llm_tokens_used"}

    undeclared = written - declared - always_writable
    if undeclared:
        raise NodeContractViolation(
            f"node '{contract.name}' wrote undeclared state field(s): "
            f"{sorted(undeclared)}. Declared writes: {sorted(declared)}. "
            f"Add them to the contract deliberately, or stop writing them — a node "
            f"quietly widening what it touches is how a reasoning node becomes a "
            f"decision-maker."
        )

    # Write-once enforcement (Section 39.4).
    for key in written & WRITE_ONCE_FIELDS:
        if state_before.get(key) is not None:
            raise NodeContractViolation(
                f"node '{contract.name}' attempted to overwrite write-once field "
                f"'{key}', which already holds a value. Market data is fetched once "
                f"per run; re-fetching means a resumed run reasons over a different "
                f"market than the decision it is continuing (spec Section 39.4)."
            )

    # Deterministic-only enforcement, checked again here rather than trusting
    # construction: a contract could be built correctly and the node still
    # return a forbidden field.
    if contract.may_call_llm:
        forbidden = written & DETERMINISTIC_ONLY_FIELDS
        if forbidden:
            raise NodeContractViolation(
                f"LLM node '{contract.name}' wrote deterministic-only field(s) "
                f"{sorted(forbidden)}."
            )

    return output


# ---------------------------------------------------------------------------
# The forbidden-import list.
#
# These are the symbols that can move money or grant authorization. No module
# under `backend/graphs/` may import any of them. Enforced by an AST test rather
# than by convention — `tests/test_graph_contracts.py` walks every graph module
# and fails on a match.
#
# Rule 0 becomes structural this way: a node cannot place an order because the
# symbol that places orders is not reachable from it. That is stronger than any
# runtime check, which could be bypassed by a node that simply doesn't call it.
# ---------------------------------------------------------------------------

FORBIDDEN_IMPORTS: FrozenSet[str] = frozenset({
    # The only component permitted to talk to an exchange.
    "ExecutionAgent",
    "get_execution_agent",
    "execution_agent",
    # The actual order call.
    "create_market_order",
    "close_position",
    "get_exchange_client",
    # Only the CRO may construct an approval.
    "TarApprovedEvent",
    # Only the Supervisor may submit a TAR.
    "TarSubmittedEvent",
    # Direct portfolio mutation.
    "buy_paper",
    "sell_paper",
    "update_portfolio",
})

# Modules under graphs/ exempt from the import ban, with the reason. Empty by
# design — an exemption list that fills up is how the ban stops meaning
# anything. Adding an entry requires a stated reason and a review.
IMPORT_BAN_EXEMPTIONS: Dict[str, str] = {}
