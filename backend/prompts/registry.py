"""Prompt registry — spec Section 9 and Section 22.

Section 9: *"Every one of these needs its own versioned prompt file"* — the
Master System Prompt, per-agent prompts, planner prompts, debate prompts,
reflection prompts, and the ten specialized domain prompts of Section 22.

WHY A REGISTRY AND NOT A FOLDER OF MARKDOWN
-------------------------------------------
Every backend agent declares a `prompt_reference` in its Section 5 contract, and
almost all of them returned the bare string `"N/A"`. That is unfalsifiable: it
reads the same whether the agent genuinely needs no prompt or whether someone
forgot to write one. A registry lets `prompt_reference` name a key that either
resolves or does not, and `tests/test_prompt_library.py` asserts every one
resolves.

THE HONEST SHAPE OF THIS SYSTEM'S PROMPTS
-----------------------------------------
Most backend agents are DELIBERATELY deterministic. The Debate moderator, the
opportunity scanner, the confidence calibrator, the stress test and the risk
checks are all pure computation, because asking a model to reason over numbers
already on hand adds hallucination risk to a financial decision for no benefit
and is not reproducible — the same candles must always yield the same verdict or
the decision rule cannot be backtested.

So a `DETERMINISTIC` entry is a first-class kind here, not an absence. It records
WHY there is no prompt, which is the useful fact. Section 9's requirement is that
every prompt is accounted for, and "this stage takes no model input, for this
reason" accounts for it.

Runtime model calls live on the TypeScript side (`/api/chat`,
`lib/reflectionAgent.ts`, `lib/hypothesisAgent.ts`,
`lib/collaborationAgent.ts`). Entries for those record the prompt and point at
the implementation, so the library is complete across both halves of the system
rather than pretending the backend is the whole of it.
"""

from dataclasses import dataclass
from enum import Enum
from typing import Dict, List, Optional


class PromptKind(str, Enum):
    MASTER = "master"                # Section 21's Master System Prompt
    AGENT = "agent"                  # per-agent, Section 9
    PLANNER = "planner"
    DEBATE = "debate"
    REFLECTION = "reflection"
    DOMAIN = "domain"                # Section 22's ten specialized prompts
    # Not a missing prompt — a recorded decision that this stage takes no model
    # input, with the reason.
    DETERMINISTIC = "deterministic"


@dataclass(frozen=True)
class PromptEntry:
    key: str
    version: str
    kind: PromptKind
    # Where the prompt is actually used. For DETERMINISTIC entries this is the
    # module that does the computation instead.
    implemented_in: str
    summary: str
    # The prompt text, or None for DETERMINISTIC entries and for the Section 22
    # domain prompts (which live in the spec document and are used by a human
    # driving a coding agent, not at runtime).
    text: Optional[str] = None
    # Why no prompt exists. REQUIRED for DETERMINISTIC entries.
    reason: Optional[str] = None
    spec_section: str = ""


_ENTRIES: List[PromptEntry] = [
    # -----------------------------------------------------------------
    # Master (Section 21)
    # -----------------------------------------------------------------
    PromptEntry(
        key="MASTER_V1",
        version="1.0.0",
        kind=PromptKind.MASTER,
        implemented_in="CLAUDE.md (repo root)",
        spec_section="21",
        summary=(
            "The persistent instruction layer. Adapted to the architecture that actually exists "
            "here rather than the idealised one in the spec, and holds the six safety invariants."
        ),
        text=None,
        reason=(
            "Stored as CLAUDE.md rather than inline, because it must be the file the coding agent "
            "reads automatically every session. Duplicating it here would create two copies that "
            "drift."
        ),
    ),

    # -----------------------------------------------------------------
    # Reflection (Section 9)
    # -----------------------------------------------------------------
    PromptEntry(
        key="REFLECTION_V1",
        version="1.0.0",
        kind=PromptKind.REFLECTION,
        implemented_in="lib/reflectionAgent.ts (TypeScript, via /api/chat)",
        spec_section="9, 12",
        summary="Post-trade reflection on a closed trade: why it won or lost, was confidence correct, did execution hurt.",
        text=(
            "You are reviewing one closed trade. Using ONLY the trade record supplied, answer:\n"
            "1. Why did this trade win or lose?\n"
            "2. Was the stated confidence justified by the outcome?\n"
            "3. Did execution (slippage, latency, partial fill) affect the result?\n"
            "End with a single line beginning 'LESSON:' stating one specific, testable claim.\n"
            "Do not recommend a configuration change. Do not invent data not in the record. "
            "If the trade is uninformative — a small move, a short hold — say so plainly rather "
            "than manufacturing a lesson from noise."
        ),
    ),
    PromptEntry(
        key="REFLECTION_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/reflection_agent.py::analyze_reflection",
        spec_section="9, 12",
        summary="The backend's reflection note, composed from the trade record without a model.",
        reason=(
            "The backend has no LLM client. Rather than leave reflection unimplemented, the note "
            "is composed from measured facts (exit reason, hold time, P&L, active strategies). "
            "A model asked to explain a single trade produces confident narrative from one data "
            "point, which is how a system talks itself into a rule a coin flip justified."
        ),
    ),

    # -----------------------------------------------------------------
    # Hypothesis / research (Sections 12, 22.5)
    # -----------------------------------------------------------------
    PromptEntry(
        key="HYPOTHESIS_V1",
        version="1.0.0",
        kind=PromptKind.AGENT,
        implemented_in="lib/hypothesisAgent.ts (TypeScript, via /api/chat)",
        spec_section="12, 22.5",
        summary="Turns a reflection's LESSON line into one specific, testable claim.",
        text=(
            "Given the LESSON line from a trade reflection, produce exactly one hypothesis in "
            "this form:\n"
            "CLAIM: <one specific, falsifiable statement about what should change>\n"
            "TEST: <how it would be tested against historical data>\n"
            "The claim must name a real, existing parameter or condition. Do not propose a change "
            "you cannot describe a test for. Flag anything that looks like it would only hold for "
            "one historical period."
        ),
    ),
    PromptEntry(
        key="HYPOTHESIS_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/hypothesis_agent.py::_derive",
        spec_section="12",
        summary="The backend's hypothesis, derived from the trade's measured facts.",
        reason=(
            "Section 22.5 requires findings a human can independently verify. A derived claim "
            "cites figures that can be checked against the trade record; a generated one cannot. "
            "The model-backed variant stays on the TypeScript side where the operator reviews it "
            "in context."
        ),
    ),

    # -----------------------------------------------------------------
    # Debate (Section 9)
    # -----------------------------------------------------------------
    PromptEntry(
        key="DEBATE_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/algorithms/debate.py::score_debate",
        spec_section="9, 22.7",
        summary="Bull vs bear scoring across trend, structure, momentum, volume, volatility and the strategy ensemble.",
        reason=(
            "Every input is a number already computed. A model verdict over those numbers would "
            "not be reproducible, so the decision rule could not be backtested — the same candles "
            "could yield a different trade on a re-run. Mirrors lib/debate/moderator.ts, which is "
            "deterministic for the same reason."
        ),
    ),

    # -----------------------------------------------------------------
    # Collaboration (Section 16)
    # -----------------------------------------------------------------
    PromptEntry(
        key="COLLABORATION_V1",
        version="1.0.0",
        kind=PromptKind.AGENT,
        implemented_in="lib/collaborationAgent.ts (TypeScript)",
        spec_section="16",
        summary="Requests a second opinion from a separate model when internal signals conflict.",
        text=(
            "You are being asked for an independent second opinion on a proposed trade. You will "
            "receive: symbol, side, the requesting system's own confidence, and the specific "
            "conflict between its signals.\n"
            "Respond in exactly this form:\n"
            "RECOMMENDATION: BUY | SELL | HOLD\n"
            "CONFIDENCE: <0-100>\n"
            "REASONING: <two or three sentences>\n"
            "You are advisory only. Your answer will be recorded and attributed to you, and it "
            "cannot override the risk layer."
        ),
    ),

    # -----------------------------------------------------------------
    # Planner (Section 9)
    # -----------------------------------------------------------------
    PromptEntry(
        key="PLANNER_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/planner_agent.py::generate_plan",
        spec_section="9",
        summary="Builds an execution plan (trigger price and condition) for a conditional-watch task.",
        reason=(
            "A plan here is a price level and a comparison operator derived from recent candles. "
            "There is no judgement for a model to add, and a model-chosen trigger price would not "
            "be reproducible."
        ),
    ),

    # -----------------------------------------------------------------
    # Deterministic agents (Section 5 contracts point here)
    # -----------------------------------------------------------------
    PromptEntry(
        key="SUPERVISOR_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/supervisor_agent.py",
        spec_section="22.7",
        summary="Arbitration and TAR construction from the debate verdict, risk checks and sizing.",
        reason=(
            "The Supervisor's job is to combine already-computed inputs against fixed thresholds "
            "and refuse when one is missing. Every refusal must be explainable by citing the "
            "missing input, which a model's narrative would obscure."
        ),
    ),
    PromptEntry(
        key="CRO_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/cro_agent.py",
        spec_section="22.3",
        summary="Leverage ceiling, stop-loss validity and portfolio VaR checks.",
        reason=(
            "Section 22.3 requires hard constraints enforced IN CODE, not recommended. A veto "
            "that depended on a model's reading would be a veto that could be talked out of."
        ),
    ),
    PromptEntry(
        key="CEO_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/ceo_agent.py",
        spec_section="18",
        summary="Monthly high-water-mark tracking and the 10% drawdown killswitch.",
        reason="A killswitch must be a threshold comparison. Nothing about halting should depend on a model's judgement.",
    ),
    PromptEntry(
        key="CIO_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/cio_agent.py",
        spec_section="18",
        summary="Pairwise correlation, correlated-exposure caps and cluster detection.",
        reason="Pearson correlation and connected components are exact computations.",
    ),
    PromptEntry(
        key="CONFIDENCE_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/confidence_agent.py",
        spec_section="10",
        summary="Bayesian posterior and multiplicative calibration against measured accuracy.",
        reason="Calibration is arithmetic over a measured track record. A model estimate would defeat the point of calibrating.",
    ),
    PromptEntry(
        key="SIMULATION_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/simulation_agent.py",
        spec_section="10",
        summary="Seeded Monte Carlo ruin and drawdown simulation.",
        reason="Seeded specifically so the verdict is reproducible; a model would make it neither.",
    ),
    PromptEntry(
        key="MARKET_INTELLIGENCE_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/market_intelligence.py",
        spec_section="22.1",
        summary="Multi-timeframe structure, EMA/ATR, support/resistance and macro assembly.",
        reason=(
            "Section 22.1 requires structured data plus a rationale, never a bare signal. Both "
            "are produced by computation; a model would add narrative, not information."
        ),
    ),
    PromptEntry(
        key="EXECUTION_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/execution_agent.py",
        spec_section="22.4",
        summary="Order routing, idempotency, slippage/latency scoring and TWAP planning.",
        reason="Order placement must be exactly reproducible from the approved TAR. There is no judgement to delegate.",
    ),
    PromptEntry(
        key="POSITION_MONITOR_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/position_monitor.py",
        spec_section="6",
        summary="Stop-loss and take-profit threshold comparison per tick.",
        reason="A stop-loss must not depend on a model call. Latency and non-determinism are both unacceptable in an exit path.",
    ),
    PromptEntry(
        key="PORTFOLIO_DETERMINISTIC_V1",
        version="1.0.0",
        kind=PromptKind.DETERMINISTIC,
        implemented_in="backend/agents/portfolio_agent.py",
        spec_section="18",
        summary="Concurrent position and directional exposure limits.",
        reason="Counting positions against a limit is arithmetic.",
    ),
]


# ---------------------------------------------------------------------------
# Section 22's ten specialized domain prompts.
#
# These are BUILD-TIME prompts: a human hands one to a coding agent before a
# work session ("today we're working in Execution Engine mode"). They are not
# invoked at runtime, so their text lives in
# TradingOS-Engineering-Spec-and-Prompts.md Section 22 and is referenced rather
# than duplicated — two copies of a prompt drift, and the spec document is the
# one a human actually opens.
# ---------------------------------------------------------------------------

DOMAIN_PROMPTS: Dict[str, str] = {
    "22.1 Market Intelligence": "Market structure, trend, momentum, liquidity, order flow, funding, regime, news, sentiment. Outputs must be structured data plus a plain-language rationale, never a bare signal.",
    "22.2 Strategy Development": "Implementing, backtesting and maintaining the strategy library. Every strategy must fill in every field of the Section 11.3 template before paper trading.",
    "22.3 Risk Engine": "Position sizing, leverage limits, correlation caps, stress testing, drawdown controls. Hard constraints enforced in code, not recommended. Holds veto power.",
    "22.4 Execution Engine": "Order routing, order-type selection, partial fills, retry policy, idempotency, exchange selection, latency and slippage measurement.",
    "22.5 Research Lab": "The Idea -> Research -> Backtest -> Walk-Forward -> Paper -> Risk Review -> Approval pipeline. May never let a hypothesis affect live capital without human approval.",
    "22.6 Memory & Knowledge": "Knowledge Graph, agent memory, Trade Journal, Reflection storage. Every entity linked to what caused or explains it — a graph, not a flat log.",
    "22.7 Supervisor AI": "Multi-Agent Parliament, consensus scoring, final decision authority subordinate to the CRO veto. Weigh evidence and confidence rather than taking a simple vote.",
    "22.8 Infrastructure": "24/7 reliability. Design against 'the bot goes silent while holding a leveraged position' specifically.",
    "22.9 Testing & QA": "Unit, integration, backtest correctness, walk-forward gates, chaos testing. Tests that try to break the safety principles are the most important in the system.",
    "22.10 Code Review": "Reject changes that duplicate logic, lack tests/docs/logging, introduce direct coupling where an event belongs, or let a learning path write production config.",
}

_BY_KEY: Dict[str, PromptEntry] = {e.key: e for e in _ENTRIES}


def get_prompt(key: str) -> Optional[PromptEntry]:
    return _BY_KEY.get(key)


def all_prompts() -> List[PromptEntry]:
    return list(_ENTRIES)


def prompt_keys() -> List[str]:
    return sorted(_BY_KEY)


def coverage() -> Dict[str, object]:
    """What the library covers, by kind. Reported so gaps are visible."""
    by_kind: Dict[str, int] = {}
    for entry in _ENTRIES:
        by_kind[entry.kind.value] = by_kind.get(entry.kind.value, 0) + 1

    missing_reason = [
        e.key for e in _ENTRIES
        if e.kind == PromptKind.DETERMINISTIC and not (e.reason or "").strip()
    ]
    missing_text = [
        e.key for e in _ENTRIES
        if e.kind in (PromptKind.REFLECTION, PromptKind.AGENT) and not e.text
    ]

    return {
        "total": len(_ENTRIES),
        "byKind": by_kind,
        "domainPrompts": len(DOMAIN_PROMPTS),
        # A DETERMINISTIC entry with no reason is the failure mode this guards
        # against — it would be "N/A" again, just with more ceremony.
        "deterministicWithoutReason": missing_reason,
        "modelPromptsWithoutText": missing_text,
    }
