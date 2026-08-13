"""Spec Section 11 — the strategy library and its eligibility rule.

Section 11.3: *"No strategy goes live without every field above filled in and
validated."* Section 11.2 names 21 strategies.

The backend ran nine strategies with NO regime awareness, so Mean Reversion
voted during strong trends and Grid voted in trending markets — the exact
conditions each profile now names as its `worst_conditions`. These tests assert
the gate works, that the vocabulary matches between the ensemble and the
profiles (a mismatch makes gating silently do nothing), and that every strategy
Section 11.2 names is either profiled or explicitly listed as unimplemented with
a concrete blocker.
"""

import pytest

from backend.agents.strategy_ensemble import STRATEGY_FUNCTIONS, vote_strategies
from backend.algorithms.strategy_profiles import (
    ALL_REGIMES,
    PLANNED_STRATEGIES,
    REGIME_HIGH_VOL,
    REGIME_RANGING,
    REGIME_TRENDING_BEAR,
    REGIME_TRENDING_BULL,
    REGIME_UNKNOWN,
    STRATEGY_PROFILES,
    get_profile,
    is_strategy_active_in_regime,
    profile_completeness,
)
from tests.conftest import make_candles

# Section 11.2's list, verbatim.
SPEC_STRATEGIES = [
    "Trend Following", "Momentum Trading", "Breakout Trading", "Mean Reversion",
    "Grid Trading", "ICT", "Smart Money Concepts", "Wyckoff", "Volume Profile",
    "VWAP", "Market Making", "Statistical Arbitrage", "Pairs Trading",
    "Event-Driven", "Volatility", "Funding-Rate Arbitrage", "Basis Trading",
    "Gamma Squeeze Detection", "Liquidation Trading", "News Trading", "Macro Trading",
]

# The 14 fields Section 11.3 requires.
TEMPLATE_FIELDS = [
    "best_conditions", "worst_conditions", "expected_holding_time", "risk_profile",
    "indicators_used", "entry_logic", "exit_logic", "position_sizing_rule",
    "active_regimes", "historical_success_rate", "confidence_rules",
    "portfolio_rules", "failure_modes", "self_evaluation",
]


# ---------------------------------------------------------------------------
# Vocabulary alignment — the bug class that makes gating a no-op
# ---------------------------------------------------------------------------

def test_every_voting_strategy_has_a_profile():
    """A strategy the ensemble votes with but has no profile for is UNGATED.

    This is not hypothetical: on the TypeScript side the Grid strategy escaped
    its regime gate because its profile said `agent: 'Grid'` while the ensemble
    emitted `'Grid Strategy'`. The names must match exactly.
    """
    unprofiled = [name for name in STRATEGY_FUNCTIONS if get_profile(name) is None]
    assert not unprofiled, (
        f"these strategies vote but have no profile, so they are never gated: {unprofiled}"
    )


def test_every_profile_corresponds_to_a_voting_strategy():
    """A profile for a strategy nobody runs is documentation, not a control."""
    orphans = [p.agent for p in STRATEGY_PROFILES if p.agent not in STRATEGY_FUNCTIONS]
    assert not orphans, f"profiles with no matching strategy function: {orphans}"


def test_profile_agent_names_are_unique():
    names = [p.agent for p in STRATEGY_PROFILES]
    assert len(names) == len(set(names))


# ---------------------------------------------------------------------------
# Section 11.3's template
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("profile", STRATEGY_PROFILES, ids=lambda p: p.agent)
def test_profile_has_every_template_field_defined(profile):
    for f in TEMPLATE_FIELDS:
        assert hasattr(profile, f), f"{profile.agent} is missing template field '{f}'"


@pytest.mark.parametrize("profile", STRATEGY_PROFILES, ids=lambda p: p.agent)
def test_profile_states_its_worst_conditions(profile):
    """`worst_conditions` is the field that makes the rest load-bearing — it is
    what `active_regimes` encodes. A strategy with no stated failure condition
    cannot be gated."""
    assert profile.worst_conditions.strip()
    assert profile.active_regimes


@pytest.mark.parametrize("profile", STRATEGY_PROFILES, ids=lambda p: p.agent)
def test_profile_documents_failure_modes(profile):
    assert profile.failure_modes, f"{profile.agent} documents no failure modes"


@pytest.mark.parametrize("profile", STRATEGY_PROFILES, ids=lambda p: p.agent)
def test_historical_success_rate_is_none_not_zero(profile):
    """None means "not established". Zero would claim a measured 0% win rate —
    a much stronger and false statement."""
    assert profile.historical_success_rate is None or profile.historical_success_rate > 0


def test_completeness_report_names_the_outstanding_field():
    """Section 11.3's rule made checkable: the report must say WHAT is missing,
    not just that something is."""
    report = profile_completeness()
    assert report["totalRequiredFields"] == 14
    assert report["profiled"] == len(STRATEGY_PROFILES)
    for row in report["strategies"]:
        # Every profile is outstanding on exactly this field, by design.
        assert row["missingFields"] == ["historical_success_rate"], row


def test_no_strategy_is_formally_eligible_for_live_promotion():
    """None has been validated on this system's own data, so per Section 11.3
    none is eligible. Voting and live-promotion are different bars, and the
    report must not blur them."""
    report = profile_completeness()
    assert report["eligibleForLive"] == []
    assert "eligible to VOTE" in report["note"]


# ---------------------------------------------------------------------------
# Regime gating — the actual control
# ---------------------------------------------------------------------------

def test_mean_reversion_is_barred_from_trending_regimes():
    """Fading a strong trend is the classic way mean reversion produces one loss
    that erases many wins."""
    for regime in (REGIME_TRENDING_BULL, REGIME_TRENDING_BEAR):
        assert is_strategy_active_in_regime("MeanReversion", regime) is False


def test_grid_is_barred_from_trending_regimes():
    """A grid accumulates against a trending market and the losses compound."""
    for regime in (REGIME_TRENDING_BULL, REGIME_TRENDING_BEAR):
        assert is_strategy_active_in_regime("Grid", regime) is False


def test_range_trading_is_barred_from_trending_regimes():
    for regime in (REGIME_TRENDING_BULL, REGIME_TRENDING_BEAR):
        assert is_strategy_active_in_regime("Range", regime) is False


def test_trend_following_is_active_in_trends_and_muted_in_ranges():
    assert is_strategy_active_in_regime("Trend", REGIME_TRENDING_BULL) is True
    assert is_strategy_active_in_regime("Trend", REGIME_RANGING) is False


def test_mean_reversion_is_active_in_a_range():
    assert is_strategy_active_in_regime("MeanReversion", REGIME_RANGING) is True


def test_unknown_regime_gates_nothing():
    """Muting every strategy when the classifier lacks history would silently
    stop the system trading whenever a new symbol starts up — and "unknown" is
    not evidence a strategy is unsuitable."""
    for name in STRATEGY_FUNCTIONS:
        assert is_strategy_active_in_regime(name, REGIME_UNKNOWN) is True
        assert is_strategy_active_in_regime(name, "") is True


def test_an_unprofiled_strategy_is_not_silently_muted():
    """Dropping a strategy nobody profiled would make the ensemble quietly
    weaker with no signal that anything was missing."""
    assert is_strategy_active_in_regime("SomeNewStrategy", REGIME_TRENDING_BULL) is True


# ---------------------------------------------------------------------------
# The ensemble
# ---------------------------------------------------------------------------

def test_ensemble_reports_which_strategies_were_gated_out():
    """"Mean Reversion did not vote because the market is trending" and "Mean
    Reversion saw nothing" are different facts."""
    result = vote_strategies(make_candles(120), regime=REGIME_TRENDING_BULL)
    assert "MeanReversion" in result["gatedOut"]
    assert "Grid" in result["gatedOut"]
    assert "MeanReversion" not in result["votes"]
    # The reason must be stated, not just the fact.
    assert "muted" in result["gatedOut"]["MeanReversion"]


def test_ensemble_runs_everything_when_regime_is_unknown():
    result = vote_strategies(make_candles(120), regime=REGIME_UNKNOWN)
    assert result["gatedOut"] == {}
    assert len(result["votes"]) == len(STRATEGY_FUNCTIONS)


def test_confidence_is_normalised_against_strategies_that_actually_voted():
    """The old version divided by a hardcoded 9. Once gating exists that
    understates confidence for reasons unrelated to the market."""
    gated = vote_strategies(make_candles(120), regime=REGIME_TRENDING_BULL)
    assert gated["strategiesVoted"] < len(STRATEGY_FUNCTIONS)
    assert gated["strategiesVoted"] + gated["strategiesGated"] == len(STRATEGY_FUNCTIONS)
    assert 0 <= gated["confidence"] <= 100


def test_no_candles_yields_hold_with_a_stated_reason():
    result = vote_strategies([], regime=REGIME_RANGING)
    assert result["consensus"] == "HOLD"
    assert result["confidence"] == 0
    assert result["reason"]


def test_consensus_requires_more_than_one_agreeing_strategy():
    """A single vote is not consensus."""
    result = vote_strategies(make_candles(120), regime=REGIME_RANGING)
    assert result["minAgreementRequired"] >= 2.0


def test_a_broken_strategy_is_recorded_not_silently_dropped(monkeypatch):
    """Its absence must reduce the vote base visibly, not invisibly."""
    def boom(_klines):
        raise RuntimeError("strategy exploded")

    monkeypatch.setitem(STRATEGY_FUNCTIONS, "Trend", boom)
    result = vote_strategies(make_candles(120), regime=REGIME_UNKNOWN)
    assert "Trend" in result["gatedOut"]
    assert "errored" in result["gatedOut"]["Trend"]
    assert result["consensus"] in ("BUY", "SELL", "HOLD")


def test_wrapper_classifies_the_regime_so_gating_cannot_be_skipped():
    """Passing regime=None by accident disables every gate — the wrapper exists
    so that cannot happen silently."""
    from backend.agents.strategy_ensemble import vote_strategies_for_klines

    result = vote_strategies_for_klines(make_candles(120))
    assert result["regime"] is not None
    assert result["regime"] != ""


# ---------------------------------------------------------------------------
# Coverage of Section 11.2's 21 strategies
# ---------------------------------------------------------------------------

def test_all_spec_strategies_are_accounted_for():
    """Every strategy Section 11.2 names must be either profiled or explicitly
    listed as unimplemented. Silence about a named strategy is the thing this
    prevents."""
    profiled = " ".join(p.name for p in STRATEGY_PROFILES).lower()
    planned = " ".join(PLANNED_STRATEGIES).lower()

    unaccounted = []
    for strategy in SPEC_STRATEGIES:
        key = strategy.lower().split()[0]
        if key not in profiled and key not in planned:
            unaccounted.append(strategy)
    assert not unaccounted, f"Section 11.2 strategies neither profiled nor planned: {unaccounted}"


def test_every_planned_strategy_states_a_concrete_blocker():
    """"Not implemented" must be a statement about a missing input or venue
    capability, not a vague TODO — an honest gap list is checkable."""
    vague = [
        name for name, reason in PLANNED_STRATEGIES.items()
        if len(reason) < 60 or "TODO" in reason.upper()
    ]
    assert not vague, f"these blockers are too vague to act on: {vague}"


def test_planned_and_profiled_sets_do_not_overlap():
    """A strategy cannot be both implemented and unimplemented."""
    profiled_names = {p.name for p in STRATEGY_PROFILES}
    overlap = profiled_names & set(PLANNED_STRATEGIES)
    assert not overlap, f"listed as both profiled and planned: {overlap}"


def test_spec_coverage_counts():
    """21 named strategies: 9 implemented and profiled, 16 documented as planned
    (some spec names map onto one profile, e.g. Trend Following)."""
    assert len(STRATEGY_PROFILES) == 9
    assert len(PLANNED_STRATEGIES) == 16
