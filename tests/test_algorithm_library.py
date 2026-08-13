"""Spec Section 10 — every required algorithm must exist AND be reachable.

The audit that prompted this file: of eleven required algorithms, the library
implemented most of them and **almost nothing called any of them**. Only
`calibrate_confidence` had an external caller. Meanwhile two were duplicated:
`agents/simulation_agent` had written its own Monte Carlo and `agents/cio_agent`
its own Pearson correlation, both alongside library versions that already
existed. Spec Section 20: *"Never duplicate logic."*

An algorithm that exists but is never called is not a capability — it is a file.
`test_no_required_algorithm_is_dead_code` is the check that keeps that honest.
"""

import ast
import pathlib

import numpy as np
import pytest

from backend.algorithms.execution import estimate_slippage, twap_order_slicer
from backend.algorithms.portfolio import (
    build_asset_graph,
    calculate_correlation_matrix,
    optimize_portfolio_weights_naive,
    pearson_correlation,
)
from backend.algorithms.probability import bayesian_update, calibrate_confidence
from backend.algorithms.risk import (
    RUIN_EQUITY_FRACTION,
    half_kelly_criterion,
    monte_carlo_simulation,
    monte_carlo_trade_sequence,
    volatility_adjusted_size,
)
from backend.algorithms.structure import detect_bos_choch
from backend.core.risk_manager import calculate_atr, kelly_risk_fraction

ROOT = pathlib.Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"

# Spec Section 10's list, mapped to the callable that implements each one.
REQUIRED_ALGORITHMS = {
    "risk sizing (fixed-fractional, volatility-adjusted)": "volatility_adjusted_size",
    "Kelly Criterion (fractional/half-Kelly)": "half_kelly_criterion",
    "ATR for volatility-based stops": "calculate_atr",
    "Monte Carlo (drawdown/ruin probability)": "monte_carlo_trade_sequence",
    "Bayesian probability updating": "bayesian_update",
    "graph intelligence (asset relationships)": "build_asset_graph",
    "market structure analysis (BOS/CHoCH)": "detect_bos_choch",
    "correlation analysis": "pearson_correlation",
    "confidence scoring/calibration": "calibrate_confidence",
    "portfolio optimization": "optimize_portfolio_weights_naive",
    "execution optimization (slippage/TWAP)": "twap_order_slicer",
}


# Algorithms that exist, are correct, are unit-tested, and have no production
# caller yet — with the reason. This is a gap list, not an excuse list: the test
# below asserts it does not grow, and anything added needs a stated reason.
#
#   optimize_portfolio_weights_naive — mean-variance optimisation produces
#       target ALLOCATION weights across a set of assets. Nothing in this system
#       allocates that way: the Supervisor sizes one trade at a time from a risk
#       budget, and the CIO caps correlated exposure. Wiring an optimiser would
#       mean inventing a rebalancing feature nobody asked for, and a
#       half-implemented one that computed weights without acting on them would
#       be worse than none. Left available and tested for when allocation
#       becomes a real requirement.
KNOWN_UNWIRED = {"optimize_portfolio_weights_naive"}


def _callers_of(name: str, allow_algorithms_internal: bool = True) -> set:
    """Modules that reference `name` outside its own definition site.

    Parsed with `ast` rather than grepped so a mention inside a docstring or
    comment does not count as a call site — this test's whole purpose is to
    distinguish "referenced in prose" from "actually wired in".

    Reachability is transitive by design. `detect_bos_choch` is called only from
    `algorithms/debate.py`, which is itself called by `agents/debate_agent.py`,
    so it IS reachable from production even though its only direct caller lives
    under `algorithms/`. Excluding that would have reported a genuinely wired
    algorithm as dead.
    """
    callers = set()
    for path in BACKEND.rglob("*.py"):
        if "__pycache__" in path.parts:
            continue
        rel = path.relative_to(ROOT).as_posix()
        is_algo = "algorithms" in path.parts
        try:
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source)
        except (SyntaxError, OSError):
            continue

        # Skip the module that DEFINES it — a definition is not a call site.
        defines = any(
            isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name
            for n in ast.walk(tree)
        )
        if defines:
            continue
        if is_algo and not allow_algorithms_internal:
            continue

        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id == name:
                callers.add(rel)
            elif isinstance(node, ast.Attribute) and node.attr == name:
                callers.add(rel)
            elif isinstance(node, ast.ImportFrom) and any(a.name == name for a in node.names):
                callers.add(rel)
    return callers


@pytest.mark.parametrize("description,func_name", sorted(REQUIRED_ALGORITHMS.items()))
def test_required_algorithm_exists(description, func_name):
    assert func_name in globals(), f"Section 10 requires {description} — '{func_name}' not importable"


@pytest.mark.parametrize("description,func_name", sorted(REQUIRED_ALGORITHMS.items()))
def test_no_required_algorithm_is_dead_code(description, func_name):
    """An algorithm nothing calls is a file, not a capability.

    This test found six dead algorithms on its first run: Bayesian updating,
    TWAP slicing, graph intelligence, market structure, portfolio optimisation
    and volatility-adjusted sizing were all implemented and called by nothing.
    """
    if func_name in KNOWN_UNWIRED:
        pytest.skip(f"{func_name} is in KNOWN_UNWIRED with a documented reason")
    callers = _callers_of(func_name)
    assert callers, (
        f"Section 10's {description} ('{func_name}') has no caller anywhere in backend/ — "
        f"it is implemented but unreachable. Wire it, or add it to KNOWN_UNWIRED with a reason."
    )


def test_known_unwired_list_does_not_grow():
    """A gap list that grows is an excuse list."""
    assert KNOWN_UNWIRED == {"optimize_portfolio_weights_naive"}


def test_known_unwired_algorithms_are_still_unwired():
    """Once something in KNOWN_UNWIRED gains a caller it must be removed, or the
    list stops describing reality."""
    stale = {name for name in KNOWN_UNWIRED if _callers_of(name)}
    assert not stale, f"{sorted(stale)} now has a caller — remove it from KNOWN_UNWIRED."


def test_no_duplicate_monte_carlo_implementation():
    """simulation_agent used to define its own `_simulate`."""
    src = (BACKEND / "agents" / "simulation_agent.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    names = {n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}
    assert "_simulate" not in names, (
        "simulation_agent must use algorithms.risk.monte_carlo_trade_sequence, not a private copy"
    )
    assert "monte_carlo_trade_sequence" in src


def test_no_duplicate_correlation_implementation():
    """cio_agent used to define its own `pearson`."""
    src = (BACKEND / "agents" / "cio_agent.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    funcs = {n.name for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
    assert "pearson" not in funcs, (
        "cio_agent must use algorithms.portfolio.pearson_correlation, not a private copy"
    )


# ---------------------------------------------------------------------------
# Kelly
# ---------------------------------------------------------------------------

def test_half_kelly_is_half_of_full_kelly():
    """Spec Section 10 is explicit: half-Kelly, *not* full Kelly."""
    win_prob, payoff = 0.6, 2.0
    full = win_prob - ((1 - win_prob) / payoff)
    assert half_kelly_criterion(win_prob, payoff) == pytest.approx(full / 2)


def test_kelly_returns_zero_on_a_negative_edge():
    assert half_kelly_criterion(0.2, 1.0) == 0.0


def test_kelly_is_hard_capped():
    """Even a near-certain edge must not size the whole account."""
    assert half_kelly_criterion(0.99, 10.0) <= 0.25


def test_kelly_risk_fraction_can_only_reduce_size_never_increase_it():
    """Kelly assumes a KNOWN win probability; ours is estimated from a modest
    sample, and Kelly is brutal when the estimate is optimistic."""
    fallback = 0.02
    # A very strong (over-optimistic) estimate.
    result = kelly_risk_fraction(win_prob=0.9, payoff_ratio=3.0, fallback=fallback)
    assert result["fraction"] <= fallback


def test_kelly_risk_fraction_falls_back_when_win_rate_unknown():
    result = kelly_risk_fraction(win_prob=None, fallback=0.02)
    assert result["fraction"] == 0.02
    assert result["rule"] == "fixed-fractional"
    assert "not used" in result["detail"]


def test_kelly_risk_fraction_returns_zero_on_negative_edge():
    result = kelly_risk_fraction(win_prob=0.2, payoff_ratio=1.0, fallback=0.02)
    assert result["fraction"] == 0.0
    assert result["rule"] == "kelly-negative-edge"


def test_kelly_risk_fraction_names_the_rule_that_applied():
    """A 2% position sized by Kelly and one sized by the fallback are different
    decisions with the same number."""
    for win_prob in (None, 0.55, 0.2):
        result = kelly_risk_fraction(win_prob=win_prob, fallback=0.02)
        assert result["rule"]
        assert result["detail"]


# ---------------------------------------------------------------------------
# Monte Carlo
# ---------------------------------------------------------------------------

def test_monte_carlo_is_deterministic():
    """A stress test that changes verdict on a re-run cannot gate anything."""
    a = monte_carlo_trade_sequence(risk_fraction=0.02)
    b = monte_carlo_trade_sequence(risk_fraction=0.02)
    assert a["prob_of_ruin"] == b["prob_of_ruin"]
    assert a["expected_max_drawdown"] == b["expected_max_drawdown"]


def test_monte_carlo_with_no_returns_reports_unknown_not_zero_risk():
    """It used to return `prob_of_ruin: 0.0` for an empty series — claiming a
    zero probability of ruin for a strategy it had no data about, which would
    pass every threshold check."""
    result = monte_carlo_simulation([])
    assert result["available"] is False
    assert result["prob_of_ruin"] is None
    assert "not zero" in result["reason"]


def test_monte_carlo_return_keys_are_consistent_across_both_paths():
    """The empty path returned `max_drawdown` while the success path returned
    `expected_max_drawdown`, so a caller reading the latter hit a KeyError
    exactly when data was missing."""
    empty = monte_carlo_simulation([])
    populated = monte_carlo_simulation([0.01, -0.02, 0.03, -0.01, 0.02] * 20)
    assert set(empty) >= {"available", "prob_of_ruin", "expected_max_drawdown"}
    assert set(populated) >= {"available", "prob_of_ruin", "expected_max_drawdown"}


def test_monte_carlo_flags_a_constant_return_series():
    """std=0 would make np.random.normal emit one deterministic path and present
    it as a distribution."""
    result = monte_carlo_simulation([0.01] * 50)
    assert result["available"] is False
    assert "identical" in result["reason"]


def test_higher_risk_fraction_raises_ruin_probability():
    """Sanity check that the simulation responds to its main input."""
    low = monte_carlo_trade_sequence(risk_fraction=0.01)
    high = monte_carlo_trade_sequence(risk_fraction=0.30)
    assert high["prob_of_ruin"] >= low["prob_of_ruin"]


def test_ruin_threshold_is_shared_not_per_caller():
    """simulation_agent used 0.2 while algorithms/risk used 0.5, so the two
    disagreed about what 'ruin' meant."""
    assert RUIN_EQUITY_FRACTION == 0.20


# ---------------------------------------------------------------------------
# Correlation
# ---------------------------------------------------------------------------

def test_pearson_returns_none_not_nan_for_a_flat_series():
    """np.corrcoef returns nan here, and `abs(nan) > 0.75` is False — so an
    unmeasurable pair would read as uncorrelated and pass an exposure check it
    should have failed."""
    assert pearson_correlation([1.0] * 10, list(range(10))) is None
    raw = np.corrcoef([1.0] * 10, list(range(10)))[0, 1]
    assert np.isnan(raw), "this test documents the numpy behaviour being guarded against"


def test_pearson_perfect_correlations():
    a = [1.0, 2.0, 3.0, 4.0, 5.0]
    assert pearson_correlation(a, a) == pytest.approx(1.0)
    assert pearson_correlation(a, [-x for x in a]) == pytest.approx(-1.0)


def test_pearson_stays_within_bounds():
    """Floating-point error can produce 1.0000000000000002."""
    a = [float(i) for i in range(200)]
    r = pearson_correlation(a, a)
    assert -1.0 <= r <= 1.0


def test_pearson_aligns_on_the_most_recent_points():
    """Zipping from the start would compare last week's returns for one symbol
    against yesterday's for the other."""
    long_series = [0.0, 0.0, 0.0, 1.0, 2.0, 3.0]
    short_series = [1.0, 2.0, 3.0]
    assert pearson_correlation(long_series, short_series) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Bayesian updating & calibration
# ---------------------------------------------------------------------------

def test_bayesian_update_moves_the_prior_toward_the_evidence():
    posterior = bayesian_update(prior=0.5, likelihood_evidence_given_regime=0.9,
                               likelihood_evidence_given_not_regime=0.1)
    assert posterior > 0.5


def test_bayesian_update_with_uninformative_evidence_is_a_no_op():
    """Equal likelihoods carry no information, so the prior must not move."""
    assert bayesian_update(0.3, 0.5, 0.5) == pytest.approx(0.3)


def test_calibration_cannot_exceed_one_or_go_negative():
    assert 0.0 <= calibrate_confidence(1.0, 1.0, 0.0) <= 1.0
    assert calibrate_confidence(1.0, 1.0, 2.0) == 0.0


def test_calibration_reduces_confidence_for_a_poor_track_record():
    assert calibrate_confidence(0.9, 0.5, 0.0) < 0.9


# ---------------------------------------------------------------------------
# Execution optimization
# ---------------------------------------------------------------------------

def test_twap_slices_sum_to_the_original_quantity():
    """A slicer that loses or invents quantity would under- or over-fill."""
    slices = twap_order_slicer(10.0, execution_window_minutes=15, interval_minutes=5)
    assert len(slices) == 3
    assert sum(slices) == pytest.approx(10.0)


def test_twap_returns_a_single_slice_for_a_short_window():
    assert twap_order_slicer(5.0, execution_window_minutes=5, interval_minutes=5) == [5.0]


def test_slippage_estimate_reports_total_failure_for_no_liquidity():
    assert estimate_slippage(1.0, 0.0) == 1.0


def test_slippage_grows_with_order_size():
    assert estimate_slippage(10.0, 100.0) > estimate_slippage(1.0, 100.0)


# ---------------------------------------------------------------------------
# Portfolio optimization & graph intelligence
# ---------------------------------------------------------------------------

def test_optimizer_weights_are_normalized():
    expected = np.array([0.05, 0.03])
    cov = np.array([[0.04, 0.01], [0.01, 0.03]])
    weights = optimize_portfolio_weights_naive(expected, cov)
    assert weights.sum() == pytest.approx(1.0)
    assert (weights >= 0).all()


def test_optimizer_falls_back_to_equal_weight_on_a_singular_matrix():
    expected = np.array([0.05, 0.03])
    singular = np.array([[1.0, 1.0], [1.0, 1.0]])
    weights = optimize_portfolio_weights_naive(expected, singular)
    assert weights == pytest.approx(np.array([0.5, 0.5]))


def test_asset_graph_links_only_correlated_pairs():
    symbols = ["A", "B", "C"]
    corr = np.array([[1.0, 0.9, 0.1], [0.9, 1.0, 0.2], [0.1, 0.2, 1.0]])
    g = build_asset_graph(symbols, corr, threshold=0.7)
    assert g.has_edge("A", "B")
    assert not g.has_edge("A", "C")


# ---------------------------------------------------------------------------
# Market structure
# ---------------------------------------------------------------------------

def test_bos_detected_when_price_breaks_the_last_high_in_an_uptrend():
    result = detect_bos_choch([100.0, 105.0], [95.0, 98.0], current_price=106.0, trend="UP")
    assert result["event"] == "BOS"


def test_choch_detected_when_price_breaks_the_last_low_in_an_uptrend():
    result = detect_bos_choch([100.0, 105.0], [95.0, 98.0], current_price=97.0, trend="UP")
    assert result["event"] == "CHOCH"


def test_no_structural_event_inside_the_range():
    result = detect_bos_choch([100.0, 105.0], [95.0, 98.0], current_price=102.0, trend="UP")
    assert result["event"] == "NONE"


def test_insufficient_swings_returns_none_rather_than_guessing():
    assert detect_bos_choch([100.0], [95.0], current_price=110.0, trend="UP")["event"] == "NONE"
