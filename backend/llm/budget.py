"""Per-run LLM budget — spec Section 39.6.

    "Track token cost per graph run as a first-class metric next to latency and
     confidence."

WHY A HARD CEILING AND NOT JUST A METRIC
----------------------------------------
The `AgentOS` scheduler currently ticks every 3 seconds. If a graph run is ever
wired to that tick — which is exactly the mistake this system is one config
change away from — an unbounded reasoning graph makes roughly 28,800 model calls
a day per symbol. A metric tells you that happened afterwards. A ceiling stops
it.

It is enforced per RUN, not per minute, because the failure mode being prevented
is a single graph looping on itself (a supervisor that keeps re-consulting
specialists), not steady traffic. Rate limiting across runs is the trigger
layer's job (Phase 31) and belongs there.

BUDGET EXHAUSTION IS NOT AN ERROR
---------------------------------
When the budget runs out, remaining LLM nodes report themselves `unavailable`
and the run continues on its deterministic nodes. The run degrades; it does not
abort. A trading system that stops monitoring positions because it ran out of
narration budget would be trading reliability for prose.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# Defaults sized for one decision cycle of the Phase 26/47 debate graph: roughly
# 7 specialists plus a supervisor plus a thesis. Deliberately not generous —
# a run that needs more than this is looping, and the ceiling should surface that
# rather than absorb it.
DEFAULT_MAX_CALLS_PER_RUN = 12
DEFAULT_MAX_TOKENS_PER_RUN = 60_000


@dataclass
class RunBudget:
    """Tracks and enforces one run's model spend."""

    max_calls: int = DEFAULT_MAX_CALLS_PER_RUN
    max_tokens: int = DEFAULT_MAX_TOKENS_PER_RUN

    calls_made: int = 0
    tokens_used: int = 0
    # Per-node spend, so an expensive node is identifiable rather than the run
    # merely being expensive in total.
    by_node: Dict[str, int] = field(default_factory=dict)
    # Nodes that were denied a call, and why. Reported on the run's trace.
    denied: List[str] = field(default_factory=list)

    def can_spend(self, node: str) -> tuple[bool, Optional[str]]:
        """May `node` make a model call?

        Returns `(allowed, reason_if_denied)`. The reason is returned rather
        than logged-only so the node can put it in `state['unavailable']` — the
        operator then sees "the supervisor had no narrative because the budget
        was exhausted", not an unexplained gap.
        """
        if self.calls_made >= self.max_calls:
            reason = (
                f"LLM call budget exhausted for this run "
                f"({self.calls_made}/{self.max_calls} calls). Node '{node}' was denied."
            )
            if reason not in self.denied:
                self.denied.append(reason)
            return False, reason

        if self.tokens_used >= self.max_tokens:
            reason = (
                f"LLM token budget exhausted for this run "
                f"({self.tokens_used}/{self.max_tokens} tokens). Node '{node}' was denied."
            )
            if reason not in self.denied:
                self.denied.append(reason)
            return False, reason

        return True, None

    def record(self, node: str, tokens: int) -> None:
        """Record a completed call.

        Called even when the completion FAILED, because a failed call still
        consumed a request and possibly prompt tokens. Not counting failures
        would let a node retry indefinitely inside one run.
        """
        self.calls_made += 1
        self.tokens_used += max(0, tokens)
        self.by_node[node] = self.by_node.get(node, 0) + max(0, tokens)

    @property
    def exhausted(self) -> bool:
        return self.calls_made >= self.max_calls or self.tokens_used >= self.max_tokens

    def summary(self) -> Dict[str, object]:
        return {
            "callsMade": self.calls_made,
            "maxCalls": self.max_calls,
            "tokensUsed": self.tokens_used,
            "maxTokens": self.max_tokens,
            "exhausted": self.exhausted,
            "byNode": dict(self.by_node),
            "denied": list(self.denied),
        }
