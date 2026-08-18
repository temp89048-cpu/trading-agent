import logging
from typing import Dict, Any, TypedDict, List
from backend.algorithms.trading_styles import get_viable_styles
from backend.algorithms.strategy_profiles import get_profile, is_strategy_active_in_regime

logger = logging.getLogger(__name__)

# Scoring constants.
#
# BASE_SCORE is what surviving regime gating is worth on its own. SELECTION_THRESHOLD
# is deliberately ABOVE it: passing the gate means "not disqualified", which is not
# the same as "worth activating", and a threshold equal to the base collapses the
# two.
BASE_SCORE = 80.0
REGIME_MATCH_BONUS = 15.0
VOLATILITY_FIT_BONUS = 5.0
SELECTION_THRESHOLD = 90.0


class StrategySelectionState(TypedDict):
    # Inputs
    market_state: Dict[str, Any]
    available_strategies: List[str]
    
    # Analysis
    viable_styles: List[str]
    strategy_scores: Dict[str, float]
    # Which of Section 19's named inputs could not be used.
    unavailable: List[str]
    gated_out: Dict[str, str]
    
    # Output
    selected_strategies: Dict[str, float]
    # Section 19's "Activate:" shortlist. Reported, never used to prune votes.
    activated_strategies: Dict[str, float]  # name -> weight

def fetch_signals(state: StrategySelectionState) -> StrategySelectionState:
    """Ensure market_state has the requisite fields for scoring."""
    market = state.get("market_state", {})
    if "regime" not in market:
        market["regime"] = "UNKNOWN"
    if "volatility" not in market:
        market["volatility"] = "MEDIUM"
    if "liquidity" not in market:
        market["liquidity"] = "HIGH"
    
    state["market_state"] = market
    return state

def score_styles(state: StrategySelectionState) -> StrategySelectionState:
    """Determine which high-level trading styles are currently viable."""
    viable = get_viable_styles(state["market_state"])
    state["viable_styles"] = viable
    return state

def score_strategies(state: StrategySelectionState) -> StrategySelectionState:
    """
    Score each available strategy. 
    A strategy is gated out if the regime rejects it.
    If it survives gating, it gets a base score modified by styles/volatility.
    """
    market = state["market_state"]
    regime = market["regime"]
    available = state.get("available_strategies", [])
    
    scores = {}
    gated = {}
    
    volatility = market.get("volatility")
    unavailable = list(state.get("unavailable") or [])
    if volatility is None:
        unavailable.append(
            "strategy scoring: volatility not supplied, so the volatility-fit "
            "component contributed nothing"
        )
    if market.get("liquidity") is None:
        unavailable.append(
            "strategy scoring: liquidity not supplied. No order-book depth feed is "
            "subscribed anywhere in this system, so it cannot be supplied"
        )

    for strat in available:
        if not is_strategy_active_in_regime(strat, regime):
            profile = get_profile(strat)
            reason = profile.worst_conditions if profile else "regime mismatch"
            gated[strat] = f"muted in '{regime}' regime — {reason}"
            continue

        profile = get_profile(strat)
        score = BASE_SCORE

        # `active_regimes`, not `optimal_conditions`.
        #
        # `optimal_conditions` does not exist on `StrategyProfile` — the field is
        # `best_conditions`, a prose description, and the regime LIST is
        # `active_regimes`. Reading the missing attribute raised AttributeError on
        # every scored strategy, which crashed the strategy ensemble that calls this
        # graph. `is_strategy_active_in_regime` above already uses `active_regimes`,
        # so this now agrees with the gate immediately preceding it instead of
        # consulting a different (non-existent) field.
        if profile and regime and regime in (profile.active_regimes or []):
            score += REGIME_MATCH_BONUS

        # Volatility fit, only when volatility was actually measured. An unmeasured
        # volatility contributes nothing rather than a neutral bonus — a bonus for
        # unknown conditions would make every strategy look better in the dark.
        if profile and volatility:
            score += _volatility_fit(profile, volatility)

        # Historical performance is REQUIRED by Section 19's input list and is
        # unavailable for every profile in this system (all nine carry
        # historical_success_rate=None). Reported once rather than silently omitted.
        if profile and profile.historical_success_rate is None:
            note = (
                "strategy scoring excludes historical performance: no profile has "
                "been validated on this system's own data"
            )
            if note not in unavailable:
                unavailable.append(note)

        scores[strat] = round(score, 2)

    state["strategy_scores"] = scores
    state["gated_out"] = gated
    state["unavailable"] = unavailable
    return state


def _volatility_fit(profile, volatility: str) -> float:
    """Bonus or penalty for how the regime's volatility suits this strategy.

    Derived from the profile's own prose rather than a per-strategy table, so a new
    strategy gets sensible treatment without a second place to update. Returns 0.0
    when the profile says nothing about volatility — silence is not agreement.
    """
    best = (profile.best_conditions or "").lower()
    worst = (profile.worst_conditions or "").lower()
    token = volatility.lower()

    if token in best:
        return VOLATILITY_FIT_BONUS
    if token in worst:
        return -VOLATILITY_FIT_BONUS
    return 0.0

def select_strategies(state: StrategySelectionState) -> StrategySelectionState:
    """Every non-gated strategy votes; the SCORE becomes its weight.

    THE THRESHOLD DOES NOT PRUNE THE VOTERS, and getting that wrong cost real
    accuracy. `selected_strategies` values are consumed by
    `agents/strategy_ensemble` as vote WEIGHTS:

        buy_weight = sum(selected_strategies[k] for k, v in votes.items() if v == "BUY")

    An earlier revision of this function raised the threshold above the base score so
    it would actually discriminate — a correct criticism of the original
    `>= 80.0` against a base of exactly `80.0`, which could never reject anything. But
    applying it here pruned the ensemble down to whichever strategies happened to
    match the regime, and in ordinary conditions that was NONE. The knock-on was
    measurable: `algorithms/debate.score_debate` weights the ensemble at 4.0 of its
    total, so with the ensemble empty its coverage fell to 72% and every debate
    confidence in the system dropped (0.53 -> 0.295 on the reference fixture).

    So scoring and activation are separated instead:

      * `selected_strategies` — everything that survived regime gating, weighted by
        its score. An ensemble that discards its members is not an ensemble.
      * `activated_strategies` — Section 19's "Activate: Trend + Momentum" shortlist,
        those clearing `SELECTION_THRESHOLD`. Reported for consumers that want a
        shortlist, and deliberately NOT used to prune the vote.
    """
    scores = state.get("strategy_scores", {})
    regime = (state.get("market_state") or {}).get("regime")
    unknown_regime = not regime or str(regime).upper() == "UNKNOWN"

    # Weight is the normalised score. Every non-gated strategy is included: gating
    # already removed the ones the regime disqualifies, and a second filter here
    # would mute the library at exactly the moment the classifier lacks history —
    # which `enumerate_candidates` (Phase 25) also refuses to do, for the same reason.
    selected = {
        strat: max(0.0, min(score / 100.0, 1.0)) for strat, score in scores.items()
    }
    activated = {
        strat: weight
        for strat, weight in selected.items()
        if scores[strat] >= SELECTION_THRESHOLD
    }

    state["selected_strategies"] = selected
    state["activated_strategies"] = activated

    # Appended to the EXISTING list rather than assigning a new key: creating one
    # here grew the state dict while LangGraph was iterating it and raised
    # "RuntimeError: dictionary changed size during iteration".
    notes = state.get("unavailable")
    if notes is None:
        notes = []
        state["unavailable"] = notes

    if unknown_regime:
        note = (
            "strategy selection scored WITHOUT a regime: nothing could be scored on "
            "regime fit, so every non-gated strategy carries the base weight and none "
            "reached the activation shortlist"
        )
        if note not in notes:
            notes.append(note)

    if not activated and selected:
        note = (
            f"no strategy cleared the {SELECTION_THRESHOLD:.0f} activation threshold, "
            f"so the Section 19 shortlist is empty. All {len(selected)} non-gated "
            f"strategies still VOTE in the ensemble — activation is a shortlist, not a "
            f"filter on voting"
        )
        if note not in notes:
            notes.append(note)

    return state


# The four stages, in order. A list rather than four calls so `run_strategy_selection`
# cannot silently skip one, and so a reader sees the pipeline at a glance.
STAGES = (fetch_signals, score_styles, score_strategies, select_strategies)


def run_strategy_selection(state: StrategySelectionState) -> StrategySelectionState:
    """Run the four stages in order. Plain function calls; no LangGraph.

    THIS WAS A `StateGraph` AND SHOULD NOT HAVE BEEN — measured, not asserted.
    `vote_strategies` called `build_strategy_selection_graph()` on every invocation,
    so every call paid a full graph compile:

        compile only          7.03 ms/call
        vote_strategies total 8.97 ms/call   -> compile was 78% of the call

    And it is called from `algorithms/debate.score_debate`, which the Phase 26 market
    specialist runs on every graph run.

    None of what LangGraph provides was being used. The pipeline is synchronous, has
    no branching, no parallelism, no LLM call, no checkpointer and nothing to resume —
    it is four pure functions in a fixed order. A graph here bought a compile per call
    and cost the Phase 23 safety layer nothing to lose, because a raw `StateGraph`
    never went through `build_graph` and so had no contract validation, no tracing and
    no error capture either.

    Same conclusion as `graphs/execution_graph.py`, reached the same way: the question
    is not "can this be a graph" but "does being one do anything".

    Kept in `graphs/` rather than moved, because renaming a file is a delete plus a
    create; treat the module path as historical.
    """
    for stage in STAGES:
        state = stage(state)
    return state


def build_strategy_selection_graph():
    """Deprecated shim. Returns an object whose `.invoke()` runs the stages.

    Kept so any caller written against the old graph API keeps working rather than
    breaking on an attribute error — but it does NOT compile anything, so the 78%
    overhead is gone for those callers too.
    """
    class _Pipeline:
        @staticmethod
        def invoke(state, config=None):
            return run_strategy_selection(state)

    return _Pipeline()
