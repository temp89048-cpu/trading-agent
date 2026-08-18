"""Graph 7 — Learning / Meta-Learning (spec Sections 33 and 35).

    Section 35, Graph 7: Evidence -> Pattern -> Hypothesis -> Validation
                                  -> Knowledge Update

    Section 33 (Phase 50), the six questions the system must ask about itself:
      1. Where am I systematically wrong?
      2. Which market conditions cause failures?
      3. Which strategies are degrading?
      4. Which confidence scores are inaccurate?
      5. Which data sources are unreliable?
      6. Which agents disagree most often?

DETERMINISTIC, AND THAT IS THE WHOLE POINT
------------------------------------------
Meta-learning is the system judging its own decisions. If a model produced that
judgement, the system's account of where it is systematically wrong would itself vary
between runs on identical history — and an unstable self-assessment is worse than
none, because it invites acting on whichever version happens to be flattering.

Every answer below is arithmetic over the trade ledger, the trace store and the
memory stores. Same history in, same findings out.

IT PRODUCES FINDINGS, NEVER CHANGES
-----------------------------------
CLAUDE.md invariant 5: learning never auto-deploys, and `LOSS -> AI rewrites strategy
-> Live` must remain impossible. So this module writes to NOTHING. It returns a
report. Turning a finding into a change means a human reading it and acting, and the
`hypothesis` path (Phase 34) is the only route from a finding toward production —
gated on an explicit click.

There is deliberately no `apply()` function here, not even a disabled one.

WHY EVERY ANSWER CAN BE "NOT ENOUGH DATA"
-----------------------------------------
With a handful of closed trades, "you are systematically wrong about breakouts" is
noise wearing a conclusion's clothes. Each finding carries the sample size it was
computed from and is withheld below a floor — a confident meta-finding from four
trades would be the most persuasive wrong answer this module could produce, because
it is *about* the system's own reliability.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence

logger = logging.getLogger(__name__)

# Minimum resolved trades before a meta-finding is reported at all.
#
# 20 matches `algorithms/probability.MIN_TRADES_FOR_ACCURACY`, referenced for the same
# reason: below it, a win-rate-shaped number is a sampling artefact, and that is
# doubly true of a claim about the system's own reliability.
MIN_TRADES_FOR_FINDING = 20

# Per-bucket floor for a claim about a specific strategy or condition. Lower than the
# global floor because a per-strategy claim is narrower, but not so low that three
# trades can indict a strategy.
MIN_TRADES_PER_BUCKET = 8

# A strategy whose recent win rate is this far below its earlier rate is degrading.
DEGRADATION_DELTA = 0.15

# Section 33's six questions, so a caller can assert coverage rather than counting
# whatever happened to be produced.
META_QUESTIONS = (
    "systematically_wrong",
    "failing_conditions",
    "degrading_strategies",
    "confidence_calibration",
    "unreliable_data_sources",
    "agent_disagreement",
)


@dataclass
class MetaFinding:
    """One answer, with the sample it rests on.

    `answered=False` is a first-class result. A finding withheld for want of data is
    genuinely different from a finding of "nothing wrong", and only one of them is
    reassuring.
    """

    question: str
    answered: bool
    finding: Optional[str] = None
    evidence: List[str] = field(default_factory=list)
    sample_size: Optional[int] = None
    reason_unanswered: Optional[str] = None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "question": self.question,
            "answered": self.answered,
            "finding": self.finding,
            "evidence": self.evidence,
            "sampleSize": self.sample_size,
            "reasonUnanswered": self.reason_unanswered,
        }


def _withheld(question: str, reason: str, sample: Optional[int] = None) -> MetaFinding:
    return MetaFinding(
        question=question, answered=False, reason_unanswered=reason, sample_size=sample
    )


async def run_meta_learning() -> Dict[str, Any]:
    """Answer all six of Section 33's questions from real records. Never raises.

    Reads the trade ledger and the trace store. Writes nothing — see the module
    docstring on invariant 5.
    """
    ledger, ledger_error = _load_ledger()
    traces, trace_error = _load_traces()

    findings: List[MetaFinding] = [
        _systematically_wrong(ledger, ledger_error),
        _failing_conditions(ledger, ledger_error),
        _degrading_strategies(ledger, ledger_error),
        _confidence_calibration(ledger, ledger_error),
        _unreliable_data_sources(traces, trace_error),
        _agent_disagreement(traces, trace_error),
    ]

    answered = [f for f in findings if f.answered]
    logger.info(
        "Meta-learning: %d/%d question(s) answerable from %d trade(s) and %d trace(s)",
        len(answered), len(META_QUESTIONS), len(ledger), len(traces),
    )
    return {
        "findings": [f.as_dict() for f in findings],
        "questionsAnswered": len(answered),
        "questionsTotal": len(META_QUESTIONS),
        "tradesAvailable": len(ledger),
        "tracesAvailable": len(traces),
        "deploymentMeaning": (
            "FINDINGS ONLY. This module writes to nothing — no risk config, no "
            "strategy selection, no confidence weights. CLAUDE.md invariant 5: "
            "learning never auto-deploys, and there is deliberately no apply() "
            "function here, not even a disabled one. The route from a finding toward "
            "production is a human reading it and creating a hypothesis"
        ),
        "sampleMeaning": (
            f"a finding is withheld below {MIN_TRADES_FOR_FINDING} resolved trades "
            f"({MIN_TRADES_PER_BUCKET} per bucket for a narrower claim). A confident "
            f"claim about the system's own reliability from a handful of trades would "
            f"be the most persuasive wrong answer this module could produce"
        ),
    }


# ---------------------------------------------------------------------------
# Sources
# ---------------------------------------------------------------------------

def _load_ledger() -> tuple:
    """Resolved trades. Returns (ledger, error)."""
    try:
        from backend.services.ai_memory import get_memory_stats

        stats = get_memory_stats() or {}
        ledger = stats.get("trade_ledger")
        return (ledger if isinstance(ledger, list) else []), None
    except Exception as exc:  # noqa: BLE001
        return [], f"trade ledger unreadable: {exc}"


def _load_traces() -> tuple:
    """Recent graph run traces. Returns (traces, error)."""
    try:
        from backend.graphs.tracing import list_recent_runs

        return (list_recent_runs() or []), None
    except Exception as exc:  # noqa: BLE001
        return [], f"trace store unreadable: {exc}"


# ---------------------------------------------------------------------------
# 1. Where am I systematically wrong?
# ---------------------------------------------------------------------------

def _systematically_wrong(ledger: Sequence[Dict[str, Any]], error: Optional[str]) -> MetaFinding:
    """Directional bias: is one SIDE consistently worse than the other?

    "Systematically wrong" means a repeatable skew, not a losing streak. Comparing
    long against short win rates is the narrowest claim the ledger can actually
    support — anything broader would be inferred from data that is not there.
    """
    q = "systematically_wrong"
    if error:
        return _withheld(q, error)
    if len(ledger) < MIN_TRADES_FOR_FINDING:
        return _withheld(
            q,
            f"{len(ledger)} resolved trade(s); {MIN_TRADES_FOR_FINDING} needed before a "
            f"bias claim is distinguishable from a losing streak",
            len(ledger),
        )

    by_side: Dict[str, List[bool]] = {}
    for trade in ledger:
        side = str(trade.get("side") or "unknown").lower()
        by_side.setdefault(side, []).append(bool(trade.get("is_win")))

    evidence: List[str] = []
    worst: Optional[tuple] = None
    for side, wins in sorted(by_side.items()):
        if len(wins) < MIN_TRADES_PER_BUCKET:
            evidence.append(
                f"{side}: {len(wins)} trade(s) — below the {MIN_TRADES_PER_BUCKET} "
                f"floor, not counted"
            )
            continue
        rate = sum(wins) / len(wins)
        evidence.append(f"{side}: {rate * 100:.1f}% win rate over {len(wins)} trade(s)")
        if worst is None or rate < worst[1]:
            worst = (side, rate, len(wins))

    if worst is None:
        return _withheld(
            q,
            f"no side reached {MIN_TRADES_PER_BUCKET} trades, so no per-side rate is "
            f"measurable",
            len(ledger),
        )

    side, rate, count = worst
    if rate >= 0.5:
        finding = (
            f"no systematic directional weakness: the worst side ({side}) still wins "
            f"{rate * 100:.1f}% over {count} trade(s)"
        )
    else:
        finding = (
            f"{side} trades win {rate * 100:.1f}% over {count} trade(s) — below "
            f"break-even, which is a candidate systematic weakness rather than a proven "
            f"one until the sample grows"
        )

    return MetaFinding(q, True, finding, evidence, len(ledger))


# ---------------------------------------------------------------------------
# 2. Which market conditions cause failures?
# ---------------------------------------------------------------------------

def _failing_conditions(ledger: Sequence[Dict[str, Any]], error: Optional[str]) -> MetaFinding:
    q = "failing_conditions"
    if error:
        return _withheld(q, error)

    # The ledger records symbol, side, pnl, is_win and strategies — NOT the regime at
    # entry. Stated rather than approximated: attributing failures to conditions the
    # record does not contain would be inventing the correlation.
    tagged = [t for t in ledger if t.get("regime")]
    if len(tagged) < MIN_TRADES_PER_BUCKET:
        return _withheld(
            q,
            f"only {len(tagged)} trade(s) in the ledger record the regime at entry. "
            f"`services/ai_memory.record_trade` stores symbol, side, pnl, is_win and "
            f"strategies — condition attribution needs the regime captured AT ENTRY, "
            f"which means extending that record rather than inferring it afterwards",
            len(tagged),
        )

    by_regime: Dict[str, List[bool]] = {}
    for trade in tagged:
        by_regime.setdefault(str(trade["regime"]), []).append(bool(trade.get("is_win")))

    evidence, worst = [], None
    for regime, wins in sorted(by_regime.items()):
        if len(wins) < MIN_TRADES_PER_BUCKET:
            evidence.append(f"{regime}: {len(wins)} trade(s) — below the floor")
            continue
        rate = sum(wins) / len(wins)
        evidence.append(f"{regime}: {rate * 100:.1f}% over {len(wins)} trade(s)")
        if worst is None or rate < worst[1]:
            worst = (regime, rate, len(wins))

    if worst is None:
        return _withheld(q, "no regime reached the per-bucket floor", len(tagged))

    return MetaFinding(
        q, True,
        f"worst regime is {worst[0]} at {worst[1] * 100:.1f}% over {worst[2]} trade(s)",
        evidence, len(tagged),
    )


# ---------------------------------------------------------------------------
# 3. Which strategies are degrading?
# ---------------------------------------------------------------------------

def _degrading_strategies(ledger: Sequence[Dict[str, Any]], error: Optional[str]) -> MetaFinding:
    """Degradation means a TREND, so each strategy is split early vs recent.

    A low overall win rate is not degradation — it may always have been low, which is
    a different finding with a different response. Splitting the series is what
    separates "getting worse" from "never worked".
    """
    q = "degrading_strategies"
    if error:
        return _withheld(q, error)

    by_strategy: Dict[str, List[bool]] = {}
    for trade in ledger:
        for strategy in (trade.get("strategies") or []):
            by_strategy.setdefault(str(strategy), []).append(bool(trade.get("is_win")))

    evidence: List[str] = []
    degrading: List[str] = []
    measurable = 0

    for strategy, wins in sorted(by_strategy.items()):
        # Twice the bucket floor: the series has to be split in two, and each half
        # needs enough to mean anything.
        if len(wins) < MIN_TRADES_PER_BUCKET * 2:
            evidence.append(
                f"{strategy}: {len(wins)} trade(s) — needs "
                f"{MIN_TRADES_PER_BUCKET * 2} to compare early against recent"
            )
            continue

        measurable += 1
        half = len(wins) // 2
        early = sum(wins[:half]) / half
        recent = sum(wins[half:]) / (len(wins) - half)
        delta = recent - early
        evidence.append(
            f"{strategy}: {early * 100:.0f}% -> {recent * 100:.0f}% "
            f"({delta * 100:+.0f} pts over {len(wins)} trade(s))"
        )
        if delta <= -DEGRADATION_DELTA:
            degrading.append(f"{strategy} ({delta * 100:+.0f} pts)")

    if measurable == 0:
        return _withheld(
            q,
            f"no strategy has {MIN_TRADES_PER_BUCKET * 2} resolved trades, so a trend "
            f"cannot be separated from a low baseline",
            len(ledger),
        )

    finding = (
        f"degrading: {', '.join(degrading)}" if degrading
        else f"no strategy degraded by more than {DEGRADATION_DELTA * 100:.0f} points "
             f"across {measurable} measurable strategy/strategies"
    )
    return MetaFinding(q, True, finding, evidence, len(ledger))


# ---------------------------------------------------------------------------
# 4. Which confidence scores are inaccurate?
# ---------------------------------------------------------------------------

def _confidence_calibration(ledger: Sequence[Dict[str, Any]], error: Optional[str]) -> MetaFinding:
    """Calibration compares PREDICTED confidence against realised outcome.

    The ledger does not store the confidence a trade was entered at, so this cannot be
    computed — and that gap is the finding. It is reported rather than approximated
    from P&L, because P&L magnitude is not prediction accuracy: a lucky win on a wrong
    read would register as good calibration.

    This is the same limitation `reflection_agent.calibration_delta` documents, and it
    has the same fix — record the predicted direction and confidence at entry.
    """
    q = "confidence_calibration"
    if error:
        return _withheld(q, error)

    with_confidence = [t for t in ledger if t.get("entry_confidence") is not None]
    if len(with_confidence) < MIN_TRADES_FOR_FINDING:
        return _withheld(
            q,
            f"only {len(with_confidence)} trade(s) record the confidence they were "
            f"entered at. Calibration is predicted-vs-realised and cannot be derived "
            f"from P&L, which measures size of outcome rather than accuracy of "
            f"prediction — a lucky win on a wrong read would score as well calibrated. "
            f"The fix is to record entry confidence in "
            f"`services/ai_memory.record_trade`",
            len(with_confidence),
        )

    buckets: Dict[str, List[bool]] = {}
    for trade in with_confidence:
        band = f"{int(float(trade['entry_confidence']) * 10) * 10}-{int(float(trade['entry_confidence']) * 10) * 10 + 10}%"
        buckets.setdefault(band, []).append(bool(trade.get("is_win")))

    evidence, worst = [], None
    for band, wins in sorted(buckets.items()):
        if len(wins) < MIN_TRADES_PER_BUCKET:
            continue
        realised = sum(wins) / len(wins)
        predicted = (int(band.split("-")[0]) + 5) / 100.0
        gap = realised - predicted
        evidence.append(
            f"{band} predicted, {realised * 100:.0f}% realised ({gap * 100:+.0f} pts, "
            f"{len(wins)} trade(s))"
        )
        if worst is None or abs(gap) > abs(worst[1]):
            worst = (band, gap)

    if worst is None:
        return _withheld(q, "no confidence band reached the per-bucket floor",
                         len(with_confidence))

    direction = "OVERconfident" if worst[1] < 0 else "UNDERconfident"
    return MetaFinding(
        q, True,
        f"most miscalibrated band is {worst[0]}, {direction} by "
        f"{abs(worst[1]) * 100:.0f} points",
        evidence, len(with_confidence),
    )


# ---------------------------------------------------------------------------
# 5. Which data sources are unreliable?
# ---------------------------------------------------------------------------

def _unreliable_data_sources(traces: Sequence[Any], error: Optional[str]) -> MetaFinding:
    """Counts `unavailable` entries across recent traces.

    This is the question the system is BEST equipped to answer, because every
    component already records what it could not measure. The `unavailable` discipline
    that runs through this codebase is exactly a data-reliability log.
    """
    q = "unreliable_data_sources"
    if error:
        return _withheld(q, error)
    if not traces:
        return _withheld(q, "no run traces recorded yet", 0)

    counts: Dict[str, int] = {}
    for trace in traces:
        entries = (
            trace.get("unavailable") if isinstance(trace, dict)
            else getattr(trace, "unavailable", None)
        ) or []
        for entry in entries:
            # The leading clause before the parenthesis names the source; the rest is
            # the per-run detail, which would fragment the count.
            key = str(entry).split("(")[0].strip().rstrip(":").strip()
            if key:
                counts[key] = counts.get(key, 0) + 1

    if not counts:
        return MetaFinding(
            q, True,
            f"no input reported itself unavailable across {len(traces)} trace(s)",
            [], len(traces),
        )

    ranked = sorted(counts.items(), key=lambda kv: kv[1], reverse=True)
    evidence = [
        f"{name}: unavailable in {n}/{len(traces)} run(s) ({n / len(traces) * 100:.0f}%)"
        for name, n in ranked[:8]
    ]
    return MetaFinding(
        q, True,
        f"most frequently unavailable input: {ranked[0][0]} "
        f"({ranked[0][1]}/{len(traces)} runs)",
        evidence, len(traces),
    )


# ---------------------------------------------------------------------------
# 6. Which agents disagree most often?
# ---------------------------------------------------------------------------

def _agent_disagreement(traces: Sequence[Any], error: Optional[str]) -> MetaFinding:
    """How often each node errored, as the disagreement proxy the traces support.

    Genuine specialist-vs-specialist disagreement needs each panel member's stance
    persisted per run. Traces record nodes visited and errors, not stances — so this
    reports node RELIABILITY and says plainly that it is not the same question.
    Answering the asked question needs `specialist_findings` persisted into the trace,
    which is a real and small change to `graphs/tracing`.
    """
    q = "agent_disagreement"
    if error:
        return _withheld(q, error)
    if not traces:
        return _withheld(q, "no run traces recorded yet", 0)

    errors: Dict[str, int] = {}
    for trace in traces:
        entries = (
            trace.get("errors") if isinstance(trace, dict)
            else getattr(trace, "errors", None)
        ) or []
        for entry in entries:
            node = str(entry).split(":")[0].strip()
            if node:
                errors[node] = errors.get(node, 0) + 1

    evidence = [
        f"{node}: errored in {n}/{len(traces)} run(s)"
        for node, n in sorted(errors.items(), key=lambda kv: kv[1], reverse=True)[:8]
    ]
    evidence.append(
        "NOTE: this measures node RELIABILITY, not specialist disagreement. Traces "
        "record nodes visited and errors, not each specialist's stance — answering the "
        "question as asked needs `specialist_findings` persisted per run in "
        "graphs/tracing"
    )

    finding = (
        f"most error-prone node: {max(errors, key=errors.get)} "
        f"({max(errors.values())}/{len(traces)} runs)" if errors
        else f"no node errored across {len(traces)} trace(s)"
    )
    return MetaFinding(q, True, finding, evidence, len(traces))
