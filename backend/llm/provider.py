"""LLM provider — the prerequisite Phase 23 could not start without.

There is no LLM client anywhere in `backend/`. `api/ai.py::/reason` returns 501
with the reason stated, and `settings.OPENAI_API_KEY` is read by nothing. So
"build the LangGraph runtime" could not have been the first task: every LLM node
in Phases 24-50 would block on this.

IT FAILS CLOSED — THIS IS THE WHOLE POINT
-----------------------------------------
`complete()` returns `LLMResult` with `text=None` on any failure and never
raises into a node. It does not retry into a fabricated answer, and it has no
"fallback text" path.

That rule is not abstract here. This codebase has already had four separate
places where a failure produced a plausible-looking value:

  * `create_market_order` returned a fake filled order at $60,000 on any error
  * `fetch_macro_data` returned fng=50 / "Neutral" when the request failed
  * `compute_stop_loss_take_profit` invented `atr = price * 0.01`
  * `monte_carlo_simulation` reported `prob_of_ruin: 0.0` with no data

An LLM client with a fallback string would be the fifth and the worst, because
prose is the hardest kind of fabricated output to spot.

SECTION 39.6 — TIERED MODELS ARE A COST CONTROL, NOT A PREFERENCE
-----------------------------------------------------------------
    "A multi-agent debate graph with several specialist nodes plus a supervisor
     can consume tens of thousands of tokens per single decision cycle ...
     Reserve your strongest model for the Supervisor/debate/decision nodes where
     judgment actually matters; use smaller, cheaper models for mechanical nodes."

`ModelTier` makes that explicit at the call site, so a mechanical node cannot
quietly use the reasoning model.

PROVIDER-AGNOSTIC BY CONSTRUCTION
---------------------------------
The TypeScript half already supports a configurable provider plus a separate
second-opinion model, and spec Section 31 (Phase 48) requires consulting several
different models. So this is an interface with adapters, not a hardcoded vendor.
No adapter is wired yet — `NullProvider` is the default and it refuses honestly.
"""

from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class ModelTier(str, Enum):
    """Which class of model a call needs. See Section 39.6.

    Declared per call so cost is a visible property of the node, not an
    accident of whichever model happened to be configured.
    """

    # Data validation, formatting, extraction. Cheap model.
    MECHANICAL = "mechanical"
    # Narration over already-computed evidence. Mid model.
    NARRATIVE = "narrative"
    # Supervisor, debate synthesis, research questions. Strongest model.
    REASONING = "reasoning"


@dataclass
class LLMResult:
    """The result of one completion.

    `text is None` means the call did not produce usable output. There is no
    other signal to check and no partial-success state: a caller that sees None
    must handle "no answer", not substitute one.
    """

    text: Optional[str]
    model: Optional[str] = None
    tier: Optional[ModelTier] = None
    prompt_tokens: int = 0
    completion_tokens: int = 0
    latency_ms: Optional[float] = None
    # Present exactly when text is None. Surfaced so a node can report WHY it
    # had no answer rather than reporting that it found nothing.
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.text is not None

    @property
    def total_tokens(self) -> int:
        return self.prompt_tokens + self.completion_tokens


class LLMProvider(ABC):
    """Adapter interface. One implementation per vendor."""

    @property
    @abstractmethod
    def name(self) -> str:
        ...

    @property
    @abstractmethod
    def available(self) -> bool:
        """False when unconfigured. Checked before a graph run starts so a run
        that needs a model fails at the boundary rather than mid-reasoning."""
        ...

    @abstractmethod
    async def complete(
        self,
        *,
        system: str,
        user: str,
        tier: ModelTier,
        max_tokens: int = 1024,
        temperature: float = 0.0,
    ) -> LLMResult:
        """Never raises. Returns `LLMResult` with `text=None` on failure."""
        ...


class NullProvider(LLMProvider):
    """The default. Refuses every call, honestly.

    Not a stub that returns placeholder text — that would let every LLM node
    "work" in development and produce fiction, which is exactly how the
    DebateVisualizer ended up displaying invented reasoning as an agent's own.

    A graph configured with LLM nodes and this provider will have those nodes
    record `unavailable` and continue degraded. That is the correct behaviour
    until a real provider is configured.
    """

    @property
    def name(self) -> str:
        return "null"

    @property
    def available(self) -> bool:
        return False

    async def complete(
        self,
        *,
        system: str,
        user: str,
        tier: ModelTier,
        max_tokens: int = 1024,
        temperature: float = 0.0,
    ) -> LLMResult:
        return LLMResult(
            text=None,
            tier=tier,
            error=(
                "No LLM provider is configured. Set one up in backend/llm/provider.py "
                "and select it via LLM_PROVIDER. This provider deliberately returns no "
                "text rather than placeholder output."
            ),
        )


# Default temperature for every call in this system.
#
# 0.0, not a creative default. Every LLM node here narrates or synthesises over
# evidence that has already been computed; there is no task in the graph where
# variety is desirable, and a non-zero temperature makes two runs over identical
# state produce different rationales — which destroys the ability to compare
# decisions across runs.
DEFAULT_TEMPERATURE = 0.0

_provider: Optional[LLMProvider] = None


def get_provider() -> LLMProvider:
    """The configured provider, or `NullProvider`.

    Selected by the `LLM_PROVIDER` env var. Unknown values fall back to
    NullProvider WITH A WARNING rather than raising: a typo in an env var should
    degrade the reasoning layer, not prevent the trading backend from starting
    and leave open positions unmonitored.
    """
    global _provider
    if _provider is not None:
        return _provider

    choice = (os.getenv("LLM_PROVIDER") or "").strip().lower()

    if not choice or choice == "null":
        _provider = NullProvider()
        return _provider

    logger.warning(
        "LLM_PROVIDER=%r is not a known provider, so no model is configured and "
        "LLM nodes will report themselves unavailable. Known values: 'null'. "
        "Add an adapter in backend/llm/provider.py to support more.",
        choice,
    )
    _provider = NullProvider()
    return _provider


def set_provider(provider: LLMProvider) -> None:
    """Override the provider. For tests and for explicit wiring at startup."""
    global _provider
    _provider = provider


def reset_provider() -> None:
    global _provider
    _provider = None
