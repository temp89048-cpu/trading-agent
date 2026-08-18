"""Phase 27 — Supervisor Graph node (spec Section 10).

    The Supervisor coordinates the specialists and must be able to answer, for
    every decision:

      1. What happened?              6. What evidence contradicts it?
      2. What is happening?          7. What is the probability?
      3. Why is it happening?        8. What is the downside?
      4. What could happen next?     9. What happens to the portfolio?
      5. What evidence supports it? 10. Should we trade / wait / exit?

All ten are required fields on `TradeDecision`, and `_assert_all_ten_answered`
fails the node if any is left blank. Section 10 makes explainability
non-negotiable, and a decision object with three of ten questions filled is not a
decision — it is a recommendation with a paper trail attached afterwards.

THIS SUPERVISOR DECIDES. IT DOES NOT EXECUTE, AND IT DOES NOT SIZE.
------------------------------------------------------------------
Two boundaries, both easy to erode and both load-bearing:

* **Execution.** Rule 0 and CLAUDE.md invariant 1. `components/Supervisor.tsx`'s
  `reviewAndExecute()` remains the single execution path for every AI-originated
  trade. This node produces an inert `TradeDecision` that nothing acts on
  automatically, and the forbidden-import ban means it cannot reach an order call
  even if a future edit tried.

* **Sizing.** `size` and `leverage` are left `None`, deliberately, and a test
  asserts it. They belong to the Phase 28 Risk Gateway, which owns the hard
  limits — margin, daily loss, portfolio exposure, and the un-overridable
  leverage ceiling. A Supervisor that filled them in would be a second sizing
  authority, and the gateway's checks would then be validating a number the
  Supervisor had already committed to rather than deciding it.

  This matters more than it sounds: the Risk Gateway's margin and daily-loss
  checks do not exist yet. Filling `size` here would make the pipeline LOOK
  complete while the checks that bound it were still missing.

WHY DETERMINISTIC
-----------------
Every one of the ten answers is computable from state. The trigger says what
happened; the regime says what is happening; the specialist evidence says why;
the stop and target bound what could happen next; the thesis and debate already
hold both evidence lists; the portfolio snapshot gives the portfolio impact.

`decision` is in `DETERMINISTIC_ONLY_FIELDS`. The narrative node still runs after
this one and now narrates the decision — prose remains a model's job, and the
audit record remains computed.

THE PROBABILITY QUESTION IS THE DANGEROUS ONE
---------------------------------------------
"What is the probability?" invites the single most persuasive fabrication
available to this system, because a number there looks like a calibrated
forecast and feeds position sizing downstream.

`debate_verdict.confidence` is NOT a probability. It is coverage-scaled weighted
agreement among specialists — a measure of how much of the panel agreed, not of
how often such agreement has been right.

So `probability` is only populated when this system has ≥20 resolved trades to
measure its own hit rate from, via `algorithms/probability`. With no track record
it is `None` and the reason is recorded. Today, on a fresh deployment, that means
**every decision reports `probability=None`** — which is the correct answer, and
is why the field is Optional rather than defaulted.

EXITS ARE EVALUATED BEFORE THE GOVERNANCE GATE
----------------------------------------------
CLAUDE.md invariant 4: closes are never blocked — not by pause, not by risk
checks, not by a veto. So `_consider_exit` runs FIRST and can return EXIT while
the system is paused or emergency-stopped. Only after that does
`may_open_new_position()` gate anything.

Getting that order wrong would produce a Supervisor that refuses to recommend
closing a losing position precisely because the operator hit pause — which is
the situation where getting out matters most.

WHAT THIS NODE IS NOT
---------------------
It is not the exit manager. It only sees a symbol on a run that produced a
thesis, because the panel does not convene otherwise. Authoritative exit handling
is `agents/position_monitor.py` (stop/target) and Phase 30's monitoring graph.
`_consider_exit` here covers one specific case: we hold a position and this
analysis now argues the other way.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from backend.algorithms.probability import (
    MIN_TRADES_FOR_ACCURACY,
    bayesian_update,
    calibrate_confidence,
    measured_accuracy,
    volatility_penalty_from_closes,
)
from backend.core import system_state
from backend.core.risk_manager import ATR_STOP_MULTIPLIER, ATR_TARGET_MULTIPLIER
from backend.graphs.contracts import NodeContract
from backend.graphs.registry import register_node
from backend.graphs.state import TradeDecision, TradingState

logger = logging.getLogger(__name__)

# Actions. `DO_NOT_TRADE` and `WAIT` are separated on purpose: WAIT means the
# setup is not good enough yet and may become so, DO_NOT_TRADE means something
# actively forbids or contradicts it. Collapsing them would lose the distinction
# between "not now" and "not this".
ACTION_TRADE = "TRADE"
ACTION_WAIT = "WAIT"
ACTION_EXIT = "EXIT"
ACTION_DO_NOT_TRADE = "DO_NOT_TRADE"

# Minimum panel confidence to recommend opening.
#
# Chosen in the SAME scaled units the debate emits, so wiring up the missing feeds
# RAISES achievable confidence rather than requiring this threshold to be retuned.
# A threshold set against unscaled agreement would have needed changing every time
# coverage changed, and would silently have been either unreachable or trivial.
#
# WHAT THIS NUMBER ACTUALLY MEANS TODAY — measured, not assumed.
#
# RE-MEASURED after the Section 14-41 audit, and the first measurement was wrong
# through no fault of the arithmetic. `algorithms/debate.score_debate` weights the
# strategy ensemble at 4.0 — its single heaviest leg — and that leg had been
# permanently unavailable because `regime_agent` and `strategy_profiles` spoke
# different regime vocabularies (see `strategy_profiles.REGIME_ALIASES`). Every
# number below was originally taken from a debate missing 4.0 of its ~14.5 weight.
#
# With the leg restored the ensemble frequently DISAGREES with the trend legs — a
# range or mean-reversion strategy firing at an extreme while trend and structure
# read up — and that disagreement is real evidence, correctly lowering conviction.
# The consequence is a lower ceiling than before:
#
#   Arithmetic ceiling            0.571   (4.0 of 7.0 directional weight available)
#   Observed, both legs agreeing  ~0.239  (swept across trend steepness/noise)
#   Observed, funding neutral     ~0.153  (market alone)
#
# 0.25 was therefore UNREACHABLE — the Supervisor could never return TRADE, and
# `test_the_trade_threshold_is_reachable_by_the_real_scorers` caught it, which is
# exactly why that test exists.
#
# 0.18 sits between the two observed ceilings, which preserves the property the old
# value was chosen for — **TRADE requires both directional legs to agree**, because
# market evidence alone tops out at ~0.153 — while being achievable.
#
# This is not tuning toward action. The bar is still "two independent legs agree",
# and it is still low in absolute terms because the system has three blind
# specialists and no validated track record. What changed is that the scale
# underneath it is now measured with the debate intact rather than crippled.
MIN_CONFIDENCE_TO_TRADE = 0.18

# A held position is reconsidered for exit when the fresh panel argues the other
# way with at least this much conviction. Lower than the entry threshold on
# purpose: the bar to STOP taking risk should be lower than the bar to take it.
MIN_CONFIDENCE_TO_EXIT = 0.15

# The ten fields Section 10 requires. Checked at the end of every decision.
REQUIRED_ANSWERS: Tuple[str, ...] = (
    "what_happened",
    "what_is_happening",
    "why",
    "what_could_happen_next",
    "evidence_for",
    "evidence_against",
    # `probability` is NOT here — None is a legitimate, and currently the only
    # honest, answer. See the module docstring.
    "downside",
    "portfolio_impact",
    "trade_wait_or_exit",
)


def supervise(state: TradingState) -> Optional[Dict[str, Any]]:
    """Produce the `TradeDecision`. Deterministic; writes nothing else."""
    thesis = state.get("trade_thesis")
    verdict = state.get("debate_verdict")

    if thesis is None:
        # Unreachable through the analysis graph, whose router does not convene the
        # panel without a thesis. Handled anyway so the node is safe to call
        # directly and in any future graph that routes differently.
        return {"unavailable": ["supervisor decision (no thesis to decide on)"]}

    unavailable: List[str] = []
    probability, prob_note = _probability(state, verdict)
    if probability is None:
        unavailable.append(f"decision probability ({prob_note})")

    # Shared narrative answers, built once and used by every branch. A branch that
    # answered only some of the ten would be an unexplained decision.
    answers = _answer_the_ten(state, thesis, verdict, probability, prob_note)

    # ---- 1. EXIT FIRST. Invariant 4: never gated. --------------------------
    exit_reason = _consider_exit(state, thesis, verdict)
    if exit_reason is not None:
        decision = _build(
            action=ACTION_EXIT,
            direction=exit_reason["direction"],
            rationale=exit_reason["rationale"],
            probability=probability,
            answers=answers,
            trade_wait_or_exit=(
                f"EXIT — {exit_reason['rationale']} Exits are never blocked by "
                f"pause, emergency stop or a risk check."
            ),
        )
        return _emit(state, decision, unavailable)

    # ---- 2. Invariant 3: no position without a computed stop. ---------------
    #
    # `detect_opportunity` already hard-rejects when no ATR is available, so in
    # practice a thesis reaching here always has a stop. This node does not rely on
    # that. It was found by a test that passed `stop_loss=None` and got a
    # `TypeError` from the TRADE branch formatting the missing number — a crash is
    # the wrong failure mode for the invariant that matters most, because the
    # wrapper degrades a node error into "no decision produced" and the REASON
    # would have been lost.
    #
    # Placed after the exit check on purpose: a position already open must still be
    # closeable even if its thesis is malformed.
    if thesis.stop_loss is None or thesis.entry_price is None:
        decision = _build(
            action=ACTION_DO_NOT_TRADE,
            direction=None,
            rationale=(
                f"DO NOT TRADE: the {thesis.direction} thesis has no computed "
                f"{'stop-loss' if thesis.stop_loss is None else 'entry price'}. "
                f"Every position requires a computed stop; this is not overridable "
                f"by confidence or by an operator setting."
            ),
            probability=probability,
            answers=answers,
            trade_wait_or_exit="DO NOT TRADE — no computed stop-loss.",
        )
        return _emit(state, decision, unavailable)

    # ---- 3. Governance. Only reached for actions that ADD risk. ------------
    if not system_state.may_open_new_position():
        blocker = (
            "emergency stop" if system_state.is_emergency_stopped()
            else "pause" if system_state.is_system_paused()
            else f"observation mode ({system_state.observation_reason()})"
        )
        decision = _build(
            action=ACTION_DO_NOT_TRADE,
            direction=None,
            rationale=(
                f"No new position may be opened: {blocker} is active. The thesis "
                f"({thesis.direction} {thesis.strategy}) is recorded but not actionable."
            ),
            probability=probability,
            answers=answers,
            trade_wait_or_exit=f"DO NOT TRADE — {blocker} is active.",
        )
        return _emit(state, decision, unavailable)

    # ---- 4. The panel could form no directional view. ----------------------
    if verdict is None or verdict.direction is None or verdict.confidence is None:
        reason = (
            "no specialist panel ran" if verdict is None
            else "no directional specialist could be measured"
        )
        decision = _build(
            action=ACTION_WAIT,
            direction=None,
            rationale=(
                f"WAIT: {reason}, so the {thesis.direction} thesis is untested. "
                f"This is a refusal for want of evidence, not a judgement that "
                f"conditions are balanced."
            ),
            probability=probability,
            answers=answers,
            trade_wait_or_exit=f"WAIT — {reason}.",
        )
        return _emit(state, decision, unavailable)

    # ---- 5. The panel contradicts the setup. -------------------------------
    if verdict.direction != thesis.direction:
        decision = _build(
            action=ACTION_DO_NOT_TRADE,
            direction=None,
            rationale=(
                f"DO NOT TRADE: the {thesis.strategy} setup is {thesis.direction} but "
                f"the specialist panel reads {verdict.direction} at "
                f"{verdict.confidence:.2f}. Acting on a setup the evidence argues "
                f"against is the failure the panel exists to catch."
            ),
            probability=probability,
            answers=answers,
            trade_wait_or_exit=(
                f"DO NOT TRADE — panel says {verdict.direction}, setup says "
                f"{thesis.direction}."
            ),
        )
        return _emit(state, decision, unavailable)

    # ---- 6. Agreement, but not enough conviction. --------------------------
    if verdict.confidence < MIN_CONFIDENCE_TO_TRADE:
        shortfall = _explain_low_confidence(verdict)
        decision = _build(
            action=ACTION_WAIT,
            direction=thesis.direction,
            rationale=(
                f"WAIT: the panel agrees with the {thesis.direction} setup but only at "
                f"{verdict.confidence:.2f}, below the {MIN_CONFIDENCE_TO_TRADE} minimum. "
                f"{shortfall}"
            ),
            probability=probability,
            answers=answers,
            trade_wait_or_exit=(
                f"WAIT — agreement at {verdict.confidence:.2f} is below the "
                f"{MIN_CONFIDENCE_TO_TRADE} minimum."
            ),
        )
        return _emit(state, decision, unavailable)

    # ---- 7. Trade. ---------------------------------------------------------
    decision = _build(
        action=ACTION_TRADE,
        direction=thesis.direction,
        rationale=(
            f"TRADE {thesis.direction} via {thesis.strategy}: the panel agrees at "
            f"{verdict.confidence:.2f} (coverage {verdict.coverage:.2f}) with entry "
            f"{thesis.entry_price:.8g}, stop {thesis.stop_loss:.8g} and target "
            f"{thesis.take_profit:.8g}. Size and leverage are NOT set here — the Risk "
            f"Gateway owns them."
        ),
        probability=probability,
        answers=answers,
        trade_wait_or_exit=(
            f"TRADE — {thesis.direction} {thesis.strategy}, pending risk validation "
            f"and sizing."
        ),
    )
    return _emit(state, decision, unavailable)


# ---------------------------------------------------------------------------
# Exit consideration
# ---------------------------------------------------------------------------

def _consider_exit(
    state: TradingState, thesis: Any, verdict: Any
) -> Optional[Dict[str, Any]]:
    """Do we hold this symbol, and does the fresh panel now argue against it?

    Returns None when there is nothing held or the panel does not contradict it.

    Reads `portfolio_state`, which the Phase 26 portfolio specialist wrote in an
    EARLIER superstep — the debate node sits between them, so unlike a sibling
    read this one is not stale.
    """
    if verdict is None or verdict.direction is None:
        # No view means no basis for reversing course. Left in the position; the
        # position monitor's stop is what protects it, not this node's silence.
        return None

    # `directional_confidence`, NOT `confidence`. This is the invariant-4 fix.
    #
    # `confidence` has been reduced by the binding constraint, and the risk
    # specialist reports concern 1.0 whenever the system is paused or
    # emergency-stopped — driving `confidence` to exactly 0.0. Gating the exit on it
    # meant that firing a kill switch made an exit recommendation impossible, which
    # is the precise inverse of what a kill switch is for.
    #
    # A constraint says "do not take on new risk". It must never suppress a signal
    # to shed risk. Found by an end-to-end run; the unit tests missed it because
    # they set `confidence` directly and never went through the dampening.
    evidence_strength = verdict.directional_confidence
    if evidence_strength is None:
        # Pre-Phase-27 verdicts (and hand-built ones) may not carry the split field.
        # Falling back to `confidence` is only safe when no constraint was applied —
        # otherwise the fallback would reintroduce the bug it exists to avoid.
        if verdict.constraint_applied:
            return None
        evidence_strength = verdict.confidence
    if evidence_strength is None:
        return None

    portfolio = state.get("portfolio_state")
    if portfolio is None or not portfolio.open_positions:
        return None

    base = str(state["symbol"]).split("/")[0].upper()
    held = [
        p for p in portfolio.open_positions
        if str(p.get("symbol", "")).split("/")[0].upper() == base
    ]
    if not held:
        return None

    qty = 0.0
    for pos in held:
        try:
            qty += float(pos["qty"])
        except (KeyError, TypeError, ValueError):
            continue

    if qty == 0.0:
        return None

    held_side = "LONG" if qty > 0 else "SHORT"
    opposing = "SHORT" if held_side == "LONG" else "LONG"

    if verdict.direction != opposing:
        return None
    if evidence_strength < MIN_CONFIDENCE_TO_EXIT:
        return None

    dampened = ""
    if verdict.binding_constraint and verdict.confidence is not None:
        # Stated explicitly so an operator reading an EXIT during a pause can see
        # why the two numbers differ, rather than suspecting one of them is wrong.
        dampened = (
            f" (the panel's overall confidence is {verdict.confidence:.2f} after the "
            f"{verdict.binding_constraint} constraint, but a constraint against "
            f"OPENING must not suppress a signal to CLOSE)"
        )

    return {
        "direction": held_side,
        "rationale": (
            f"A {held_side} position in {base} is open ({qty:+g} units) and the "
            f"specialist evidence now reads {verdict.direction} at "
            f"{evidence_strength:.2f}, above the {MIN_CONFIDENCE_TO_EXIT} exit "
            f"threshold{dampened}. Recommending the position be closed."
        ),
    }


# ---------------------------------------------------------------------------
# The probability question
# ---------------------------------------------------------------------------

def _probability(state: TradingState, verdict: Any) -> Tuple[Optional[float], str]:
    """P(direction correct), or None when this system has no track record.

    Only ever returns a number when accuracy is MEASURED over at least
    `MIN_TRADES_FOR_ACCURACY` resolved trades. Reuses the ConfidenceAgent's
    approach exactly — Bayesian posterior and multiplicative calibration, taking
    the lower — because they answer different questions and taking the smaller
    means neither can inflate the other.

    The volatility penalty is computed from the candles ALREADY in state rather
    than fetched, so it cannot describe a different market than the decision does.
    """
    if verdict is None or verdict.confidence is None:
        return None, "no panel confidence to calibrate"

    try:
        from backend.services.ai_memory import get_memory_stats

        stats = get_memory_stats() or {}
    except Exception as exc:  # noqa: BLE001 - a probability is never worth guessing
        return None, f"trade history unreadable: {exc}"

    accuracy, accuracy_note = measured_accuracy(stats)
    if accuracy is None:
        # THE CURRENT CASE on a fresh deployment. The ConfidenceAgent substitutes a
        # 0.55 prior here because it must emit a number; this must not, because a
        # prior dressed as a probability is worse than an admitted absence.
        return None, (
            f"{accuracy_note} — a probability would be a prior, not a measurement, "
            f"and panel agreement is not a hit rate"
        )

    snapshot = state.get("market_data")
    closes = [
        float(bar["close"])
        for bar in ((snapshot.candles.get("15m") if snapshot else None) or [])
        if bar.get("close") is not None
    ]
    penalty, _ = volatility_penalty_from_closes(closes)

    raw = verdict.confidence
    posterior = bayesian_update(
        prior=accuracy,
        likelihood_evidence_given_regime=max(0.01, min(0.99, raw)),
        likelihood_evidence_given_not_regime=max(0.01, min(0.99, 1.0 - raw)),
    )
    calibrated = calibrate_confidence(raw, accuracy, penalty)
    final = min(calibrated, posterior)

    return final, (
        f"accuracy {accuracy:.3f} ({accuracy_note}), volatility penalty "
        f"{penalty:.3f}, panel {raw:.3f} -> Bayesian {posterior:.3f} / "
        f"calibrated {calibrated:.3f}, taking the lower"
    )


# ---------------------------------------------------------------------------
# The ten answers
# ---------------------------------------------------------------------------

def _answer_the_ten(
    state: TradingState,
    thesis: Any,
    verdict: Any,
    probability: Optional[float],
    prob_note: str,
) -> Dict[str, Any]:
    """Build the nine shared answers. The tenth (trade/wait/exit) is per-branch."""
    trigger = state.get("trigger")
    regime = state.get("market_regime")
    technical = state.get("technical_analysis")

    # 1. What happened — the trigger, verbatim. Not a summary: the trigger IS the
    #    thing that happened, and paraphrasing it loses the measured value.
    if trigger is not None:
        what_happened = f"{trigger.kind}: {trigger.detail}"
        if trigger.observed_value is not None and trigger.threshold is not None:
            what_happened += (
                f" (observed {trigger.observed_value:.6g} against threshold "
                f"{trigger.threshold:.6g})"
            )
    else:
        what_happened = "no trigger recorded — this run was started directly"

    # 2. What is happening — the classified market state.
    if regime is not None and regime.regime:
        what_is_happening = (
            f"{state['symbol']} is in a '{regime.regime}' regime with "
            f"{regime.volatility or 'unclassified'} volatility"
        )
        if regime.trend_strength is not None:
            what_is_happening += f" and trend strength {regime.trend_strength:.3f}"
        if regime.confidence is not None:
            what_is_happening += (
                f". Market-state confidence {regime.confidence:.2f} is DATA COVERAGE, "
                f"not a forecast"
            )
    else:
        what_is_happening = (
            f"the regime for {state['symbol']} could not be classified, so conditions "
            f"are unclassified rather than neutral"
        )

    # 3. Why — the specialists' own evidence, attributed. Attribution matters: an
    #    unattributed "why" cannot be checked against the specialist that produced
    #    it, and this is exactly where DebateVisualizer used to invent reasoning.
    why = _why_from_specialists(state, verdict)

    # 4. What could happen next — bounded by the computed stop and target, not
    #    speculated. These are the two outcomes the trade actually defines.
    what_could_happen_next = _scenarios(thesis)

    # 5 + 6. Evidence, already gathered deterministically by the thesis and panel.
    evidence_for = list(thesis.supporting_evidence)
    evidence_against = list(thesis.contradicting_evidence)
    if verdict is not None:
        evidence_for += [f"panel: {s}" for s in verdict.supporting]
        evidence_against += [f"panel: {c}" for c in verdict.contradicting]
        for absent in verdict.absent:
            evidence_against.append(
                f"panel: {absent} could not be measured, so its evidence is unknown "
                f"rather than absent"
            )

    # 8. Downside — real per-unit numbers. The DOLLAR downside is unknowable here
    #    because size is the Risk Gateway's to set, and saying so is more useful
    #    than a figure computed against an assumed size.
    downside = _downside(thesis, technical)

    # 9. Portfolio impact.
    portfolio_impact = _portfolio_impact(state, thesis)

    return {
        "what_happened": what_happened,
        "what_is_happening": what_is_happening,
        "why": why,
        "what_could_happen_next": what_could_happen_next,
        "evidence_for": evidence_for,
        "evidence_against": evidence_against,
        "probability_note": prob_note,
        "downside": downside,
        "portfolio_impact": portfolio_impact,
    }


def _why_from_specialists(state: TradingState, verdict: Any) -> str:
    """Attributed evidence from the panel, or an honest statement of its absence."""
    findings = state.get("specialist_findings") or []
    available = [f for f in findings if f.available and f.evidence]

    if not available:
        return (
            "no specialist produced usable evidence, so the cause cannot be "
            "attributed — only the price action that triggered the run is known"
        )

    parts: List[str] = []
    for finding in sorted(available, key=lambda f: (f.role != "directional", f.specialist)):
        lead = finding.evidence[0]
        if finding.role == "directional":
            stance = finding.stance or "no stance"
            parts.append(f"{finding.specialist} ({stance}): {lead}")
        else:
            parts.append(f"{finding.specialist} (constraint, {finding.concern:.2f}): {lead}")

    why = "; ".join(parts)
    if verdict is not None and verdict.absent:
        why += (
            f". Not attributable to {', '.join(verdict.absent)} — those specialists "
            f"have no data feed, so their contribution is unknown"
        )
    return why


def _scenarios(thesis: Any) -> str:
    """The two outcomes the trade defines, in real numbers.

    Deliberately not a forecast and not a third "or it chops sideways" scenario —
    the stop and target are the levels at which this specific trade resolves, and
    they are computed, not guessed.
    """
    if thesis.entry_price is None or thesis.stop_loss is None or thesis.take_profit is None:
        return (
            "cannot be bounded: entry, stop or target is missing, so the outcomes "
            "this trade resolves at are undefined"
        )

    entry = thesis.entry_price
    to_target = (thesis.take_profit - entry) / entry * 100.0
    to_stop = (thesis.stop_loss - entry) / entry * 100.0

    return (
        f"this trade resolves at one of two computed levels: target "
        f"{thesis.take_profit:.8g} ({to_target:+.2f}%) or stop {thesis.stop_loss:.8g} "
        f"({to_stop:+.2f}%). Risk/reward is 1:"
        f"{ATR_TARGET_MULTIPLIER / ATR_STOP_MULTIPLIER:.1f} by construction "
        f"({ATR_STOP_MULTIPLIER}x ATR stop, {ATR_TARGET_MULTIPLIER}x ATR target). "
        f"Neither level is a prediction — no probability is attached to either "
        f"outcome here"
    )


def _downside(thesis: Any, technical: Any) -> str:
    if thesis.entry_price is None or thesis.stop_loss is None:
        return (
            "UNBOUNDED as specified: no stop level is available, which is itself "
            "disqualifying — every position requires a computed stop"
        )

    distance_pct = abs(thesis.entry_price - thesis.stop_loss) / thesis.entry_price * 100.0
    text = (
        f"the stop is {distance_pct:.2f}% from entry, so the loss on a stop-out is "
        f"{distance_pct:.2f}% of notional before fees and slippage"
    )
    if technical is not None and technical.atr is not None:
        text += f" (stop derived from ATR {technical.atr:.8g})"
    text += (
        ". The DOLLAR downside cannot be stated here because position size is set "
        "by the Risk Gateway, not by this node; a figure computed against an "
        "assumed size would be fiction"
    )
    text += (
        ". Slippage beyond the stop is not bounded either: the stop is enforced by "
        "the position monitor while the process runs, not by a resting exchange order"
    )
    return text


def _portfolio_impact(state: TradingState, thesis: Any) -> str:
    portfolio = state.get("portfolio_state")
    if portfolio is None:
        return (
            "cannot be assessed: no portfolio snapshot was taken this run, so "
            "existing exposure is unknown rather than zero"
        )

    positions = portfolio.open_positions or []
    base = str(state["symbol"]).split("/")[0].upper()
    same = [
        p for p in positions
        if str(p.get("symbol", "")).split("/")[0].upper() == base
    ]

    parts = [
        f"the {portfolio.tab} book holds {len(positions)} open position(s)"
    ]
    if portfolio.equity is not None:
        parts.append(f"equity ${portfolio.equity:,.2f}")
    else:
        parts.append("equity could not be computed")

    if same:
        parts.append(
            f"{len(same)} of them already in {base}, so a {thesis.direction} entry "
            f"here concentrates rather than diversifies"
        )
    else:
        parts.append(f"none in {base}, so this would be a new exposure")

    parts.append(
        "correlation clustering was not run this run (owned by the CIO agent) and "
        "drawdown from high-water mark is not available here (owned by the CEO "
        "agent), so neither is reflected in this assessment"
    )
    parts.append(
        "the change in exposure cannot be quantified until the Risk Gateway sets a size"
    )
    return "; ".join(parts)


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

def _build(
    action: str,
    direction: Optional[str],
    rationale: str,
    probability: Optional[float],
    answers: Dict[str, Any],
    trade_wait_or_exit: str,
) -> TradeDecision:
    """Assemble the decision. `size` and `leverage` are never set here."""
    return TradeDecision(
        action=action,
        direction=direction,
        # NOT SET, deliberately. The Risk Gateway (Phase 28) owns sizing and the
        # leverage ceiling. A test asserts both stay None.
        size=None,
        leverage=None,
        rationale=rationale,
        what_happened=answers["what_happened"],
        what_is_happening=answers["what_is_happening"],
        why=answers["why"],
        what_could_happen_next=answers["what_could_happen_next"],
        evidence_for=answers["evidence_for"],
        evidence_against=answers["evidence_against"],
        probability=probability,
        downside=answers["downside"],
        portfolio_impact=answers["portfolio_impact"],
        trade_wait_or_exit=trade_wait_or_exit,
    )


def _emit(
    state: TradingState, decision: TradeDecision, unavailable: List[str]
) -> Dict[str, Any]:
    _assert_all_ten_answered(decision)

    logger.info(
        "Supervisor decision for %s: %s %s (probability %s) — %s",
        state["symbol"], decision.action, decision.direction or "",
        "unmeasurable" if decision.probability is None else f"{decision.probability:.3f}",
        decision.trade_wait_or_exit,
    )

    out: Dict[str, Any] = {"decision": decision}
    if unavailable:
        out["unavailable"] = unavailable
    return out


def _assert_all_ten_answered(decision: TradeDecision) -> None:
    """Fail loudly rather than emit a partly-explained decision.

    Section 10 requires all ten answers. This raises rather than logging, so the
    wrapper records a node error and the gap is visible — a decision that silently
    shipped with three of ten questions answered would pass every other check in
    the system and be unexplainable exactly when someone needed to audit it.
    """
    missing = [
        field for field in REQUIRED_ANSWERS
        if not getattr(decision, field, None)
    ]
    if missing:
        raise ValueError(
            f"supervisor produced a {decision.action} decision without answering "
            f"{missing}. Spec Section 10 requires all ten questions; an unanswered "
            f"one means the decision cannot be explained."
        )


def _explain_low_confidence(verdict: Any) -> str:
    """Say WHICH of the two reductions produced a low number.

    "Confidence was low" is not actionable. "Three specialists have no feed" and
    "the risk constraint is binding" lead to different operator actions — wiring up
    a feed versus looking at why risk objects.
    """
    reasons: List[str] = []
    if verdict.coverage is not None and verdict.coverage < 1.0:
        reasons.append(
            f"coverage is {verdict.coverage:.2f} — "
            f"{', '.join(verdict.absent) or 'some specialists'} could not be measured"
        )
    if verdict.binding_constraint:
        reasons.append(
            f"the {verdict.binding_constraint} constraint reduced it a further "
            f"{(verdict.constraint_applied or 0.0) * 100:.0f}%"
        )
    if not reasons:
        reasons.append("the panel simply did not agree strongly")
    return "Cause: " + "; ".join(reasons) + "."


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

SUPERVISOR_NODE = "supervisor"


def register_supervisor_node() -> None:
    register_node(
        NodeContract(
            name=SUPERVISOR_NODE,
            reads=(
                "trade_thesis", "debate_verdict", "specialist_findings",
                "portfolio_state", "market_regime", "technical_analysis",
                "market_data", "trigger", "symbol",
            ),
            writes=("decision",),
            purpose=(
                "Answer Section 10's ten questions and decide TRADE / WAIT / EXIT / "
                "DO_NOT_TRADE. Does not size, does not execute."
            ),
            deterministic=True,
            phase=27,
        ),
        supervise,
    )
