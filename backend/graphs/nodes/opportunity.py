"""Phase 25 — Trading Opportunity Graph nodes (spec Section 8).

    Market State -> Strategy Candidates -> Strategy Scoring
                 -> Opportunity Detection -> Trade Thesis

    Example (BTC, Bull Trend): Trend Following 0.91 · Breakout 0.84 ·
    Mean Reversion 0.32 -> Selected: Trend Following

THIS IS WHERE THE FIRST LLM NODE LANDS — AND WHERE THE CONTRACT EARNS ITS KEEP
-----------------------------------------------------------------------------
Three of the four nodes are deterministic. The fourth (`trade_thesis_narrative`)
is the first model call in the system.

It writes `thesis_narrative` and nothing else. `trade_thesis` — which holds
direction, entry price, stop-loss and take-profit — is in
`DETERMINISTIC_ONLY_FIELDS`, so `NodeContract` REFUSES to construct an LLM
contract that writes it.

That split is not decoration. State writes are enforced per key, so if the
narrative lived inside `TradeThesis` the model would write the whole object and
could change the stop-loss it was asked to describe. Splitting the field is what
makes "a model may narrate a computed value; it may not replace it" a structural
property instead of a code-review request.

SCORING CANNOT USE TRACK RECORD, AND SAYS SO
--------------------------------------------
All nine profiles in `algorithms/strategy_profiles` carry
`historical_success_rate=None` — none has been validated on this system's own
data. So scoring is based on current-conditions fit only, and
`HISTORICAL_UNAVAILABLE` is reported on every run rather than a neutral 0.5 being
quietly substituted. A score that silently included an invented win rate would be
the most persuasive fabrication in the system, because it would look like
evidence.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional, Tuple

from backend.agents.strategy_ensemble import STRATEGY_FUNCTIONS
from backend.algorithms.strategy_profiles import (
    STRATEGY_PROFILES,
    get_profile,
    is_strategy_active_in_regime,
)
from backend.core.risk_manager import (
    ATR_STOP_MULTIPLIER,
    ATR_TARGET_MULTIPLIER,
    compute_stop_loss_take_profit,
)
from backend.graphs.contracts import NodeContract
from backend.graphs.registry import register_node
from backend.graphs.state import (
    StrategyCandidate,
    TradeThesis,
    TradingState,
)
from backend.llm.budget import RunBudget
from backend.llm.provider import DEFAULT_TEMPERATURE, ModelTier, get_provider

logger = logging.getLogger(__name__)

# Score weights. They sum to 1.0 so a score is directly readable as 0-1, which is
# what the spec's example (0.91, 0.84, 0.32) implies.
WEIGHT_SIGNAL = 0.5        # does this strategy actually see a setup right now
WEIGHT_TREND_ALIGN = 0.3   # does its direction agree with the higher timeframe
WEIGHT_VOL_FIT = 0.2       # is current volatility suited to it

# Reported on every run. Section 11.3 lists historical success rate as a required
# field and every profile has it as None, so it CANNOT contribute to a score.
HISTORICAL_UNAVAILABLE = (
    "strategy scoring excludes historical success rate: no profile has been "
    "validated on this system's own data (all 9 carry historical_success_rate=None), "
    "so scores reflect current-conditions fit only"
)

# A strategy scoring below this is not worth proposing. Not a tuned number — it is
# the point below which the score is mostly the absence of contradiction rather
# than the presence of a setup.
MIN_SCORE_TO_SELECT = 0.35


# ===========================================================================
# 1. Strategy Candidates
# ===========================================================================

def enumerate_candidates(state: TradingState) -> Optional[Dict[str, Any]]:
    """List every strategy and mark which are eligible in this regime.

    Returns ALL nine, not just the eligible ones. A gated-out strategy carries
    its profile's own `worst_conditions` as the reason, so "Mean Reversion did not
    compete because the market is trending" is visible rather than the strategy
    simply being absent from the list. Those are different facts and only one of
    them is explainable.
    """
    regime_state = state.get("market_regime")
    regime = regime_state.regime if regime_state else None

    if regime is None:
        # No regime means no gating is possible. Every strategy is listed as
        # eligible — `is_strategy_active_in_regime` treats an unknown regime as
        # permissive, because muting everything when the classifier lacks history
        # would silently stop the system reasoning at exactly the moment a new
        # symbol starts up.
        candidates = [
            StrategyCandidate(name=p.agent, eligible=True) for p in STRATEGY_PROFILES
        ]
        return {
            "candidate_strategies": candidates,
            "unavailable": ["candidate gating (no regime determined — nothing gated out)"],
        }

    candidates: List[StrategyCandidate] = []
    for profile in STRATEGY_PROFILES:
        eligible = is_strategy_active_in_regime(profile.agent, regime)
        candidates.append(
            StrategyCandidate(
                name=profile.agent,
                eligible=eligible,
                gated_out_reason=None if eligible else (
                    f"muted in '{regime}': {profile.worst_conditions}"
                ),
            )
        )

    gated = [c.name for c in candidates if not c.eligible]
    logger.info(
        "Strategy candidates for %s in '%s': %d eligible, %d gated out (%s)",
        state["symbol"], regime,
        sum(1 for c in candidates if c.eligible), len(gated), ", ".join(gated) or "none",
    )
    return {"candidate_strategies": candidates}


# ===========================================================================
# 2. Strategy Scoring
# ===========================================================================

def score_candidates(state: TradingState) -> Optional[Dict[str, Any]]:
    """Score each eligible candidate and select the best.

    Deterministic. The spec's example shows numeric scores (0.91, 0.84, 0.32),
    which are computed from measurable current conditions — not a model's ranking.

    Writes the scores back onto `candidate_strategies` and sets
    `selected_strategy`. A gated-out candidate keeps `score=None` rather than 0.0:
    zero would read as "scored and found worthless" when it was never scored.
    """
    candidates = list(state.get("candidate_strategies") or [])
    snapshot = state.get("market_data")
    technical = state.get("technical_analysis")
    regime_state = state.get("market_regime")

    if not candidates:
        return {"unavailable": ["strategy scoring (no candidates)"]}
    if snapshot is None:
        return {"unavailable": ["strategy scoring (no market data)"]}

    bars = snapshot.candles.get("15m", [])
    if not bars:
        return {"unavailable": ["strategy scoring (no 15m candles)"]}

    mtf_trend = technical.multi_timeframe_trend if technical else None
    volatility = regime_state.volatility if regime_state else None

    scored: List[StrategyCandidate] = []
    for candidate in candidates:
        if not candidate.eligible:
            # Preserved unscored, with its gating reason intact.
            scored.append(candidate)
            continue

        score, detail = _score_one(candidate.name, bars, mtf_trend, volatility)
        scored.append(
            StrategyCandidate(
                name=candidate.name,
                score=score,
                eligible=True,
                gated_out_reason=None,
            )
        )
        logger.debug("Scored %s: %s (%s)", candidate.name, score, detail)

    ranked = sorted(
        (c for c in scored if c.eligible and c.score is not None),
        key=lambda c: c.score,
        reverse=True,
    )

    out: Dict[str, Any] = {
        "candidate_strategies": scored,
        # Always reported — see HISTORICAL_UNAVAILABLE.
        "unavailable": [HISTORICAL_UNAVAILABLE],
    }

    if not ranked:
        out["unavailable"] = out["unavailable"] + [
            "strategy selection (no eligible strategy could be scored)"
        ]
        return out

    best = ranked[0]
    if best.score < MIN_SCORE_TO_SELECT:
        # Deliberately selects nothing rather than the least-bad option. The
        # highest of several weak scores is still a weak setup, and proposing it
        # would turn "nothing is happening" into a trade.
        out["unavailable"] = out["unavailable"] + [
            f"strategy selection (best score {best.score:.2f} for {best.name} is below "
            f"the {MIN_SCORE_TO_SELECT} minimum — no setup worth proposing)"
        ]
        return out

    out["selected_strategy"] = best
    logger.info(
        "Selected %s (%.2f) for %s from %d scored candidate(s): %s",
        best.name, best.score, state["symbol"], len(ranked),
        ", ".join(f"{c.name} {c.score:.2f}" for c in ranked[:4]),
    )
    return out


def _score_one(
    name: str,
    bars: List[Dict[str, Any]],
    mtf_trend: Optional[str],
    volatility: Optional[str],
) -> Tuple[Optional[float], str]:
    """Score one strategy from current conditions. Returns (score, explanation).

    Three components, all measurable. Track record is excluded — see
    HISTORICAL_UNAVAILABLE.
    """
    fn = STRATEGY_FUNCTIONS.get(name)
    if fn is None:
        return None, "no strategy function registered"

    try:
        signal = fn(bars)
    except Exception as e:
        # A broken strategy scores None, not 0.0. It was not evaluated.
        return None, f"strategy function errored: {e}"

    parts: List[str] = []

    # --- signal: does it see a setup at all? ---------------------------
    # HOLD is not a weak buy — it is the strategy declining to act, and a
    # strategy with no opinion should not compete for selection.
    if signal in ("BUY", "SELL"):
        signal_score = 1.0
        parts.append(f"signal={signal}")
    else:
        signal_score = 0.0
        parts.append("signal=HOLD (no setup)")

    # --- trend alignment ----------------------------------------------
    if mtf_trend is None:
        # Unmeasurable, so it contributes its midpoint rather than zero. Scoring
        # a missing measurement as a failure would systematically penalise every
        # strategy whenever the higher-timeframe data was thin.
        align_score = 0.5
        parts.append("trend=unknown (neutral contribution)")
    elif signal == "HOLD":
        align_score = 0.0
        parts.append("trend alignment n/a (no signal)")
    elif (signal == "BUY" and mtf_trend == "Bullish") or (signal == "SELL" and mtf_trend == "Bearish"):
        align_score = 1.0
        parts.append(f"aligned with {mtf_trend} higher timeframe")
    elif mtf_trend == "Mixed":
        align_score = 0.5
        parts.append("higher timeframe mixed")
    else:
        align_score = 0.0
        parts.append(f"opposes {mtf_trend} higher timeframe")

    # --- volatility fit -----------------------------------------------
    vol_score, vol_detail = _volatility_fit(name, volatility)
    parts.append(vol_detail)

    score = (
        signal_score * WEIGHT_SIGNAL
        + align_score * WEIGHT_TREND_ALIGN
        + vol_score * WEIGHT_VOL_FIT
    )
    return round(score, 3), "; ".join(parts)


def _volatility_fit(name: str, volatility: Optional[str]) -> Tuple[float, str]:
    """How well current volatility suits this strategy.

    Derived from each profile's own `active_regimes` rather than a separate
    hardcoded table: a strategy listing the high-volatility regime as one it
    operates in is, by its own declaration, suited to high volatility. Keeping one
    source means the two cannot disagree.
    """
    if volatility is None:
        return 0.5, "volatility unknown (neutral contribution)"

    profile = get_profile(name)
    if profile is None:
        return 0.5, "no profile (neutral contribution)"

    from backend.algorithms.strategy_profiles import REGIME_HIGH_VOL, REGIME_RANGING

    likes_high_vol = REGIME_HIGH_VOL in profile.active_regimes
    likes_quiet = REGIME_RANGING in profile.active_regimes

    if volatility == "HIGH":
        return (1.0, "high volatility suits this strategy") if likes_high_vol else (
            0.2, "high volatility is outside this strategy's declared regimes"
        )
    if volatility == "LOW":
        return (1.0, "low volatility suits this strategy") if likes_quiet else (
            0.4, "low volatility gives this strategy little to work with"
        )
    return 0.7, "medium volatility"


# ===========================================================================
# 3. Opportunity Detection
# ===========================================================================

def detect_opportunity(state: TradingState) -> Optional[Dict[str, Any]]:
    """Turn a selected strategy into a concrete, tradeable thesis — or refuse.

    THIS NODE ENFORCES INVARIANT 3 AT THE COGNITIVE LAYER.

    A thesis with no computable stop-loss is not an opportunity, it is a hope. If
    ATR is unavailable, `compute_stop_loss_take_profit` returns None and this node
    produces NO thesis with a stated reason — rather than proposing an entry and
    leaving the stop for the risk layer to reject later.

    Catching it here matters even though the CRO would also reject it: a thesis
    that reaches the Risk Gateway without a stop wastes the whole reasoning chain
    and, worse, appears in traces as a rejected trade rather than as a setup that
    was never viable.
    """
    selected = state.get("selected_strategy")
    if selected is None:
        return {"unavailable": ["opportunity (no strategy was selected)"]}

    snapshot = state.get("market_data")
    technical = state.get("technical_analysis")
    if snapshot is None or snapshot.price is None:
        return {"unavailable": ["opportunity (no price)"]}
    if technical is None or technical.atr is None:
        # The invariant-3 refusal.
        return {
            "unavailable": [
                "opportunity (no ATR, so no stop-loss can be computed — a thesis "
                "without a computable stop is not tradeable)"
            ]
        }

    bars = snapshot.candles.get("15m", [])
    fn = STRATEGY_FUNCTIONS.get(selected.name)
    if fn is None or not bars:
        return {"unavailable": [f"opportunity (cannot re-read {selected.name}'s signal)"]}

    try:
        signal = fn(bars)
    except Exception as e:
        return {"unavailable": [f"opportunity ({selected.name} errored: {e})"]}

    if signal not in ("BUY", "SELL"):
        # The strategy scored well on conditions but is not signalling entry now.
        return {
            "unavailable": [
                f"opportunity ({selected.name} scored {selected.score} on conditions but "
                f"signals {signal} — no entry)"
            ]
        }

    side = "buy" if signal == "BUY" else "sell"
    price = snapshot.price
    sltp = compute_stop_loss_take_profit(price, technical.atr, side)
    if sltp is None:
        return {
            "unavailable": [
                f"opportunity (stop/target could not be derived from ATR {technical.atr})"
            ]
        }

    evidence_for, evidence_against = _gather_evidence(state, side, selected.name)

    thesis = TradeThesis(
        direction="LONG" if side == "buy" else "SHORT",
        strategy=selected.name,
        entry_price=price,
        stop_loss=sltp["stopLoss"],
        take_profit=sltp["takeProfit"],
        supporting_evidence=evidence_for,
        contradicting_evidence=evidence_against,
        # Written by the LLM node, into a SEPARATE state field. Left None here so
        # a missing narrative is visible rather than being an empty string that
        # reads as "the model had nothing to say".
        narrative=None,
    )

    logger.info(
        "Opportunity on %s: %s %s at %.6g, stop %.6g, target %.6g (%d for / %d against)",
        state["symbol"], thesis.direction, selected.name, price,
        thesis.stop_loss, thesis.take_profit, len(evidence_for), len(evidence_against),
    )
    return {"trade_thesis": thesis}


def _gather_evidence(
    state: TradingState, side: str, strategy: str
) -> Tuple[List[str], List[str]]:
    """Collect the evidence for and against, from state only.

    Spec Section 10 requires the Supervisor to answer "what evidence supports it"
    and "what evidence contradicts it". Both lists are built here from measured
    values, so the later LLM node narrates real evidence rather than inventing
    plausible-sounding support — which is exactly what `DebateVisualizer` used to
    do with its hardcoded "EMA 9 crossed above EMA 21".
    """
    for_: List[str] = []
    against: List[str] = []

    technical = state.get("technical_analysis")
    regime = state.get("market_regime")
    sentiment = state.get("sentiment_analysis")

    if technical:
        if technical.trend:
            (for_ if _trend_agrees(technical.trend, side) else against).append(
                f"15m trend is {technical.trend}"
            )
        if technical.multi_timeframe_trend:
            (for_ if _trend_agrees(technical.multi_timeframe_trend, side) else against).append(
                f"multi-timeframe trend is {technical.multi_timeframe_trend}"
            )
        if technical.rsi is not None:
            if side == "buy" and technical.rsi > 70:
                against.append(f"RSI {technical.rsi:.1f} is overbought for a long")
            elif side == "sell" and technical.rsi < 30:
                against.append(f"RSI {technical.rsi:.1f} is oversold for a short")
            else:
                for_.append(f"RSI {technical.rsi:.1f} is not at an extreme against this side")

    if regime:
        if regime.regime:
            for_.append(f"regime is {regime.regime}, in which {strategy} is eligible")
        if regime.trend_strength is not None:
            (for_ if regime.trend_strength >= 0.5 else against).append(
                f"trend strength {regime.trend_strength:.2f}"
            )
        if regime.volatility == "HIGH":
            against.append("high-volatility regime widens the stop distance required")
        # Data coverage below 1.0 is evidence against acting, and saying so is the
        # point of defining confidence as coverage in the first place.
        if regime.confidence is not None and regime.confidence < 1.0:
            against.append(
                f"market-state confidence {regime.confidence:.2f} — not every input "
                f"could be measured"
            )

    if sentiment:
        if sentiment.risk_level == "elevated":
            against.append("macro risk level is elevated")
        elif sentiment.risk_level == "unknown":
            against.append("macro risk level could not be measured")
        if sentiment.funding_rate is not None and abs(sentiment.funding_rate) > 0.001:
            against.append(f"funding rate {sentiment.funding_rate:.5f} is far from neutral")

    return for_, against


def _trend_agrees(trend: str, side: str) -> bool:
    if side == "buy":
        return trend == "Bullish"
    return trend == "Bearish"


# ===========================================================================
# 4. Trade Thesis narrative — THE FIRST LLM NODE
# ===========================================================================

async def narrate_thesis(state: TradingState) -> Optional[Dict[str, Any]]:
    """Write a plain-language rationale for the computed thesis.

    THE FIRST MODEL CALL IN THE SYSTEM. Three properties make it safe:

    1. It writes ONLY `thesis_narrative`. `trade_thesis` is in
       `DETERMINISTIC_ONLY_FIELDS`, so its contract cannot even declare a write to
       the numbers.
    2. It is given the evidence rather than the market. The prompt contains the
       already-computed direction, stop, target and evidence lists, so there is
       nothing for the model to derive — only to explain.
    3. Its absence is harmless. If no provider is configured, the budget is spent,
       or the call fails, the run continues with `thesis_narrative=None` and the
       reason recorded. A thesis without prose is still a complete, tradeable
       thesis; the numbers were never the model's to produce.
    """
    thesis = state.get("trade_thesis")
    if thesis is None:
        # Nothing to narrate. Not an error — most runs end without an opportunity.
        return None

    provider = get_provider()
    if not provider.available:
        return {
            "unavailable": [
                f"thesis narrative (no LLM provider configured — provider '{provider.name}' "
                f"reports unavailable; the thesis numbers are unaffected)"
            ]
        }

    system = (
        "You explain a trading thesis and decision that have ALREADY been computed. "
        "You do not make or change trading decisions.\n"
        "Rules:\n"
        "- Use ONLY the figures and evidence supplied. Do not introduce indicators, "
        "levels or data that are not in the input.\n"
        "- Do not restate the numbers as different numbers.\n"
        "- Mention the contradicting evidence explicitly; a rationale that omits it "
        "is not useful.\n"
        # Added in Phase 27. The node now runs after the Supervisor, so most of what
        # it explains is a decision NOT to trade. Prose arguing for an entry the
        # Supervisor declined would be worse than no prose at all.
        "- If a SUPERVISOR DECISION is given, explain THAT decision. When the action "
        "is not TRADE, explain why the trade was rejected or deferred — do not argue "
        "for entering.\n"
        "- Never state a probability that is marked NOT MEASURABLE, and never "
        "substitute the panel confidence for it. Say it is unknown.\n"
        "- If a RISK GATEWAY verdict is given, it is the last word. When it is "
        "REJECTED the trade is not happening, whatever the decision above said.\n"
        "- State a position size ONLY if an approved size is given, and only that "
        "number. Never invent or imply one.\n"
        "- 3 to 5 sentences. No preamble, no recommendation, no price prediction."
    )
    user = _narrative_prompt(state, thesis)

    result = await provider.complete(
        system=system,
        user=user,
        tier=ModelTier.NARRATIVE,
        max_tokens=400,
        temperature=DEFAULT_TEMPERATURE,
    )

    # Budget accounting happens whether or not the call succeeded: a failed call
    # still consumed a request, and not counting it would let a node retry
    # indefinitely within one run.
    delta: Dict[str, Any] = {
        "llm_calls_made": (state.get("llm_calls_made") or 0) + 1,
        "llm_tokens_used": (state.get("llm_tokens_used") or 0) + result.total_tokens,
    }

    if not result.ok:
        delta["unavailable"] = [f"thesis narrative (model call failed: {result.error})"]
        return delta

    delta["thesis_narrative"] = result.text.strip()
    return delta


def _narrative_prompt(state: TradingState, thesis: TradeThesis) -> str:
    """Build the prompt from state.

    Everything the model sees is a measured or computed value. There is
    deliberately no raw candle data: handing over the market would invite the
    model to form its own view, and its view is not what is being asked for.
    """
    lines = [
        f"Symbol: {state['symbol']}",
        f"Direction: {thesis.direction}",
        f"Strategy: {thesis.strategy}",
        f"Entry: {thesis.entry_price:.8g}",
        f"Stop-loss: {thesis.stop_loss:.8g} "
        f"({abs(thesis.entry_price - thesis.stop_loss) / thesis.entry_price * 100:.2f}% away)",
        f"Take-profit: {thesis.take_profit:.8g}",
        f"Risk/reward: 1:{ATR_TARGET_MULTIPLIER / ATR_STOP_MULTIPLIER:.1f}",
    ]

    regime = state.get("market_regime")
    if regime:
        lines.append(
            f"Market state: regime={regime.regime}, volatility={regime.volatility}, "
            f"trend strength={regime.trend_strength}, "
            f"data coverage={regime.confidence} (this is coverage, not a probability)"
        )

    trigger = state.get("trigger")
    if trigger is not None:
        lines.append(f"What prompted this: {trigger.kind} — {trigger.detail}")

    lines.append("")
    lines.append("Evidence supporting:")
    lines.extend(f"  - {e}" for e in thesis.supporting_evidence) or lines.append("  (none)")
    lines.append("Evidence contradicting:")
    if thesis.contradicting_evidence:
        lines.extend(f"  - {e}" for e in thesis.contradicting_evidence)
    else:
        lines.append("  (none recorded)")

    # Phase 26. Present only when the analysis graph ran the panel; the Phase 25
    # graph still ends at the thesis, so this block is simply absent there.
    #
    # The panel's verdict goes in because the system prompt REQUIRES the narrative
    # to state the contradicting evidence, and a specialist panel disagreeing with
    # the thesis direction is the strongest contradiction available in the run.
    # Omitting it would let the model write a confident rationale for a trade four
    # specialists had argued against.
    verdict = state.get("debate_verdict")
    if verdict is not None:
        lines.append("")
        lines.append(
            f"Specialist panel verdict: {verdict.direction} at "
            f"{'unknown' if verdict.confidence is None else f'{verdict.confidence:.2f}'} "
            f"confidence"
        )
        if verdict.direction and verdict.direction != thesis.direction:
            lines.append(
                f"  THE PANEL DISAGREES with the {thesis.direction} thesis above. Say so "
                f"plainly; do not smooth it over."
            )
        if verdict.coverage is not None:
            lines.append(
                f"  Panel coverage: {verdict.coverage:.2f} — "
                f"{len(verdict.participants)} specialist(s) reported, "
                f"{len(verdict.absent)} could not run"
            )
        if verdict.binding_constraint:
            lines.append(
                f"  Binding constraint: {verdict.binding_constraint} reduced confidence "
                f"by {(verdict.constraint_applied or 0.0) * 100:.0f}%"
            )
        for label in verdict.supporting:
            lines.append(f"  For: {label}")
        for label in verdict.contradicting:
            lines.append(f"  Against: {label}")

    # Phase 27. Present only when the Supervisor ran. The DECISION is what a reader
    # actually needs explained — a rationale for a thesis the Supervisor declined
    # to act on would be actively misleading, since the prose would read as a case
    # for a trade that is not being taken.
    decision = state.get("decision")
    if decision is not None:
        lines.append("")
        lines.append(f"SUPERVISOR DECISION: {decision.action}")
        lines.append(f"  {decision.trade_wait_or_exit}")
        if decision.action != "TRADE":
            lines.append(
                "  This trade is NOT being taken. Explain why it was rejected or "
                "deferred. Do not write a case for entering."
            )
        lines.append(
            f"  Probability the direction is correct: "
            f"{'NOT MEASURABLE — this system has no validated track record yet; do not substitute the panel confidence for it' if decision.probability is None else f'{decision.probability:.3f}'}"
        )
        lines.append(f"  Downside: {decision.downside}")
        lines.append(f"  Portfolio impact: {decision.portfolio_impact}")
        lines.append(
            "  Size and leverage are NOT set on the decision: the Risk Gateway owns them."
        )

    # Phase 28. The gateway's verdict is the LAST word on whether this happens, so
    # it goes in last and overrides the tone of everything above it. A narrative
    # explaining an approved trade that the gateway then rejected would be the same
    # failure as one explaining a trade the Supervisor rejected.
    risk = state.get("risk_assessment")
    if risk is not None:
        lines.append("")
        lines.append(
            f"RISK GATEWAY: {'APPROVED' if risk.approved else 'REJECTED'}"
        )
        for reason in risk.rejection_reasons[:6]:
            lines.append(f"  REJECTED BECAUSE: {reason}")
        for note in risk.caution_notes[:6]:
            lines.append(f"  caution: {note}")
        if not risk.approved:
            lines.append(
                "  This trade will NOT be placed. Explain the risk rejection. Do not "
                "describe it as a trade being taken."
            )

    plan = state.get("execution_plan")
    if plan is not None and plan.size is not None:
        lines.append(
            f"  Approved size: {plan.size:.8g} at {plan.leverage}x on the "
            f"{plan.tab} book. State this size if you mention size at all; do not "
            f"invent a different one."
        )
    else:
        lines.append(
            "  No approved size exists. Do not state or imply a position size."
        )

    unavailable = state.get("unavailable") or []
    if unavailable:
        lines.append("")
        lines.append("Could NOT be measured (state these as unknown, do not infer them):")
        lines.extend(f"  - {u}" for u in unavailable[:8])

    return "\n".join(lines)


# ===========================================================================
# Registration
# ===========================================================================

def register_opportunity_nodes() -> None:
    register_node(
        NodeContract(
            name="strategy_candidates",
            reads=("market_regime", "symbol"),
            writes=("candidate_strategies",),
            purpose="List all strategies and mark which are eligible in this regime, with the reason for each exclusion",
            deterministic=True,
            phase=25,
        ),
        enumerate_candidates,
    )

    register_node(
        NodeContract(
            name="strategy_scoring",
            reads=("candidate_strategies", "market_data", "technical_analysis", "market_regime", "symbol"),
            writes=("candidate_strategies", "selected_strategy"),
            purpose="Score eligible strategies on current conditions and select the best, or none",
            deterministic=True,
            phase=25,
        ),
        score_candidates,
    )

    register_node(
        NodeContract(
            name="opportunity_detection",
            reads=("selected_strategy", "market_data", "technical_analysis", "market_regime",
                   "sentiment_analysis", "symbol"),
            writes=("trade_thesis",),
            purpose="Build a concrete thesis with entry, stop and target — or refuse when no stop is computable",
            deterministic=True,
            phase=25,
        ),
        detect_opportunity,
    )

    register_node(
        NodeContract(
            name="trade_thesis_narrative",
            # `debate_verdict` (Phase 26) and `decision` (Phase 27) are read when
            # present. Neither is a dependency: the Phase 25 graph has no debate or
            # supervisor node and this node works exactly as before there.
            reads=("trade_thesis", "market_regime", "trigger", "unavailable", "symbol",
                   "debate_verdict", "decision", "risk_assessment", "execution_plan",
                   "llm_calls_made", "llm_tokens_used"),
            # ONLY the narrative. `trade_thesis` is deterministic-only, so
            # NodeContract would raise if this tried to declare it.
            writes=("thesis_narrative",),
            purpose="Explain the already-computed thesis in plain language. Cannot change any number.",
            deterministic=False,
            may_call_llm=True,
            phase=25,
        ),
        narrate_thesis,
    )
