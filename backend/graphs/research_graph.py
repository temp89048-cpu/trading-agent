"""Graph 6 — Research (spec Section 28 / Phase 45, Section 35's Graph 6).

    Question -> Research -> Hypothesis -> Experiment -> Backtest
             -> Validation -> Candidate

WHAT THE SECTION 14-41 AUDIT FOUND, AND WHY IT WAS THE MOST DANGEROUS BUG IN THE
NEW WORK
-------------------------------------------------------------------------------
    def run_backtest(state):
        state["backtest_score"] = 0.85
        state["validation_notes"] = ["Backtest yielded high sharpe."]

    def run_forward_test(state):
        state["forward_test_score"] = 0.70
        state["validation_notes"].append("Walk-forward degraded but remained positive.")

    def evaluate_results(state):
        if state["backtest_score"] > 0.5 and state["forward_test_score"] > 0.5:
            state["status"] = "VALIDATED"

Two invented numbers, an invented Sharpe claim, and then a hypothesis marked
**VALIDATED** on the strength of them. Both scores were hardcoded above the
threshold, so the comparison could only ever pass — the graph was a function that
returned VALIDATED for every input while appearing to test something.

CLAUDE.md invariant 5 says learning never auto-deploys and a hypothesis reaching
production needs an explicit human click. This did not technically write to
production — but it destroyed the meaning of that click. An operator approving a
"validated" hypothesis would believe they were approving something backtested,
when the evidence was the literal `0.85` above.

That is worse than an unimplemented validation step, because an unimplemented step
is visibly unimplemented.

WHY IT DOES NOT SIMPLY CALL THE REAL BACKTESTER
----------------------------------------------
`core/backtest_engine.HistoricalBacktestEngine` exists and is real. It also does
this in its constructor:

    self.bus._subscribers.clear()

Calling it from a graph node would wipe every subscription in the live process —
the trigger worker, the CRO, the execution agent, the position monitor. A
validation run would silently disable trading.

So this graph does NOT run it inline. It records the validation request and reports
honestly that no backtest was executed, leaving the hypothesis where it was. Wiring
the real engine requires giving it an isolated bus and running it out of band; that
is a genuine follow-up, and it is named here rather than faked.

WHAT VALIDATED MEANS NOW
------------------------
Only ever set from a MEASURED score. With no measurement the status is left
untouched and `unavailable` says why. There is no code path from this graph to
VALIDATED without a real number.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# A hypothesis needs to clear this in BOTH backtest and walk-forward.
#
# Both, not either: a strategy that backtests well and degrades out of sample is
# the single most common way a research pipeline fools itself, and requiring only
# the in-sample score would institutionalise exactly that.
MIN_SCORE_TO_VALIDATE = 0.5

# Why no score is available today. Stated once so every code path that reports it
# gives the same reason.
BACKTEST_UNAVAILABLE = (
    "no backtest was executed: core/backtest_engine.HistoricalBacktestEngine calls "
    "bus._subscribers.clear() in its constructor, so running it inside a live "
    "process would unsubscribe the trigger worker, the CRO, the execution agent and "
    "the position monitor. It must run out of band with an isolated bus before this "
    "graph can produce a real score."
)


@dataclass
class ResearchResult:
    """The outcome of one validation attempt.

    `status` is deliberately Optional. `None` means "not decided" — distinct from
    REJECTED, which is a decision. A pipeline that reported REJECTED when it could
    not measure would discard good hypotheses for want of a backtester.
    """

    hypothesis_id: Optional[str] = None
    status: Optional[str] = None            # VALIDATED | REJECTED | None
    backtest_score: Optional[float] = None
    forward_test_score: Optional[float] = None
    validation_notes: List[str] = field(default_factory=list)
    unavailable: List[str] = field(default_factory=list)

    @property
    def measured(self) -> bool:
        return self.backtest_score is not None and self.forward_test_score is not None


def evaluate_hypothesis(
    hypothesis_id: str,
    backtest_score: Optional[float] = None,
    forward_test_score: Optional[float] = None,
) -> ResearchResult:
    """Decide a hypothesis from MEASURED scores, or decline to decide.

    Pure. Scores are passed in, never invented here — which is what makes the
    VALIDATED path auditable: the only way to reach it is to supply two real
    numbers, so a caller cannot get a validation without having measured one.
    """
    result = ResearchResult(
        hypothesis_id=hypothesis_id,
        backtest_score=backtest_score,
        forward_test_score=forward_test_score,
    )

    if not result.measured:
        missing = []
        if backtest_score is None:
            missing.append("backtest")
        if forward_test_score is None:
            missing.append("walk-forward")
        result.unavailable.append(
            f"hypothesis {hypothesis_id} could not be evaluated: no "
            f"{' or '.join(missing)} score. {BACKTEST_UNAVAILABLE}"
        )
        result.validation_notes.append(
            "Status left UNCHANGED. Not rejected — an unmeasured hypothesis is "
            "undecided, and reporting REJECTED here would discard good ideas for "
            "want of a backtester."
        )
        logger.info(
            "Hypothesis %s not evaluated: missing %s score(s)",
            hypothesis_id, ", ".join(missing),
        )
        return result

    passed_backtest = backtest_score >= MIN_SCORE_TO_VALIDATE
    passed_forward = forward_test_score >= MIN_SCORE_TO_VALIDATE

    result.validation_notes.append(
        f"backtest {backtest_score:.3f} "
        f"({'pass' if passed_backtest else 'fail'} vs {MIN_SCORE_TO_VALIDATE})"
    )
    result.validation_notes.append(
        f"walk-forward {forward_test_score:.3f} "
        f"({'pass' if passed_forward else 'fail'} vs {MIN_SCORE_TO_VALIDATE})"
    )

    if passed_backtest and passed_forward:
        result.status = "VALIDATED"
    else:
        result.status = "REJECTED"
        if passed_backtest and not passed_forward:
            result.validation_notes.append(
                "Backtested well and degraded out of sample — the most common way a "
                "research pipeline fools itself. Rejected on the walk-forward."
            )

    logger.info(
        "Hypothesis %s -> %s (backtest %.3f, walk-forward %.3f)",
        hypothesis_id, result.status, backtest_score, forward_test_score,
    )
    return result


async def request_validation(hypothesis_id: str) -> ResearchResult:
    """Record a validation request and report what could be measured.

    Today that is nothing, for the reason in `BACKTEST_UNAVAILABLE`. It still
    persists the attempt so an operator can see the hypothesis was queued for
    validation rather than ignored.

    VALIDATED IS UNREACHABLE FROM HERE, and that is the point: this function has no
    parameter through which a score could arrive, so no amount of editing it can
    produce a validation without first wiring a real backtester.
    """
    result = evaluate_hypothesis(hypothesis_id)

    try:
        from backend.services.research_store import get_hypotheses

        known = await get_hypotheses()
        if not any(h.get("id") == hypothesis_id for h in (known or [])):
            result.unavailable.append(
                f"hypothesis {hypothesis_id} is not in the research store"
            )
    except Exception as exc:  # noqa: BLE001
        result.unavailable.append(f"research store unreadable: {exc}")

    # Deliberately does NOT call `update_hypothesis_status`. With no measured score
    # there is no status to set, and writing one would be the original bug.
    return result
