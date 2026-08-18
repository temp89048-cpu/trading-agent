"""Phase 27 / spec Section 10 — the Supervisor.

Four groups of tests, in descending order of how badly a regression would hurt:

1. **Exits are never gated.** `test_exit_is_recommended_even_when_emergency_stopped`
   is the single most important test in this file. Invariant 4 says a close is
   never blocked, and the branch ordering inside `supervise()` is the only thing
   enforcing it — an innocent-looking refactor that hoisted the governance check
   would silently trap an operator in a losing position precisely because they
   hit pause.

2. **The Supervisor never sizes.** `size` and `leverage` must stay None on every
   branch. The Risk Gateway's margin and daily-loss checks do not exist yet, so a
   populated `size` here would make the pipeline look complete while the checks
   bounding it were missing.

3. **Probability is None without a track record.** The most persuasive
   fabrication available to this system is a number in that field, because it
   looks like a calibrated forecast and feeds sizing.

4. **All ten questions are answered on every branch.** Including the rejections —
   a rejected trade needs explaining at least as much as an accepted one.
"""

from __future__ import annotations

import asyncio

import pytest

from backend.algorithms.probability import (
    ACCURACY_CEILING,
    ACCURACY_FLOOR,
    MIN_CANDLES_FOR_VOLATILITY,
    MIN_TRADES_FOR_ACCURACY,
    UNKNOWN_VOLATILITY_PENALTY,
    measured_accuracy,
    volatility_penalty_from_closes,
)
from backend.core import system_state
from backend.graphs.nodes.supervisor import (
    ACTION_DO_NOT_TRADE,
    ACTION_EXIT,
    ACTION_TRADE,
    ACTION_WAIT,
    MIN_CONFIDENCE_TO_EXIT,
    MIN_CONFIDENCE_TO_TRADE,
    REQUIRED_ANSWERS,
    SUPERVISOR_NODE,
    supervise,
)
from backend.graphs.state import (
    DebateVerdict,
    MarketRegimeState,
    MarketSnapshot,
    PortfolioStateSnapshot,
    SpecialistFinding,
    TechnicalAnalysis,
    TradeThesis,
    TradingState,
    TriggerReason,
    new_state,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clean_governance():
    """Every test starts with no kill switch active and leaves none behind.

    Without this, `test_exit_is_recommended_even_when_emergency_stopped` would
    leak an emergency stop into every test that ran after it.
    """
    system_state.resume("test setup")
    if system_state.is_in_observation_mode():
        system_state.exit_observation_mode("test setup")
    yield
    system_state.resume("test teardown")
    if system_state.is_in_observation_mode():
        system_state.exit_observation_mode("test teardown")


def _thesis(direction: str = "LONG", **over) -> TradeThesis:
    t = TradeThesis(
        direction=direction,
        strategy="Trend",
        entry_price=100.0,
        stop_loss=98.0 if direction == "LONG" else 102.0,
        take_profit=104.0 if direction == "LONG" else 96.0,
        supporting_evidence=["15m trend is Bullish"],
        contradicting_evidence=["high-volatility regime widens the stop"],
    )
    for k, v in over.items():
        setattr(t, k, v)
    return t


def _verdict(direction: str = "LONG", confidence: float = 0.5, **over) -> DebateVerdict:
    v = DebateVerdict(
        direction=direction,
        confidence=confidence,
        participants=["market", "funding", "portfolio", "risk"],
        absent=["orderflow", "liquidity", "news"],
        supporting=["market (supports_long, 0.80)"],
        contradicting=["funding (supports_short, 0.20)"],
        rationale="test verdict",
        coverage=0.571,
        # Defaults to `confidence`, matching what `run_debate` produces when no
        # constraint is binding. Set explicitly rather than left None so the ordinary
        # tests exercise the real code path instead of the stale-verdict fallback.
        directional_confidence=confidence,
    )
    for k, v_ in over.items():
        setattr(v, k, v_)
    return v


def _candles(n: int = 60) -> list:
    return [
        {"time": i, "open": 100.0, "high": 101.0, "low": 99.0,
         "close": 100.0 + i * 0.1, "volume": 1000.0}
        for i in range(n)
    ]


def _state(**over) -> TradingState:
    st = new_state(
        run_id="sup-test",
        symbol="BTC/USDT",
        trigger=TriggerReason(
            kind="price_move", symbol="BTC/USDT",
            detail="2.40% move from 100 to 102.4",
            observed_value=2.4, threshold=2.0,
        ),
        started_at=0.0,
    )
    st.update(
        trade_thesis=_thesis(),
        debate_verdict=_verdict(),
        market_data=MarketSnapshot(symbol="BTC/USDT", price=100.0,
                                   candles={"15m": _candles()}),
        market_regime=MarketRegimeState(regime="Trending Bullish", volatility="MEDIUM",
                                        trend_strength=0.62, confidence=1.0),
        technical_analysis=TechnicalAnalysis(atr=1.3, trend="Bullish"),
        portfolio_state=PortfolioStateSnapshot(tab="paper", equity=10_000.0,
                                               cash=10_000.0, open_positions=[]),
        specialist_findings=[
            SpecialistFinding("market", "directional", available=True,
                              stance="supports_long", confidence=0.8,
                              evidence=["Structure (+3.00) BOS continuing UP"]),
            SpecialistFinding("risk", "constraint", available=True, concern=0.1,
                              evidence=["no governance block active"]),
            SpecialistFinding("news", "directional", available=False,
                              reason_unavailable="no news feed is ingested"),
        ],
    )
    st.update(over)
    return st


def _decide(**over):
    out = supervise(_state(**over))
    return out["decision"], out


# ===========================================================================
# 1. EXITS ARE NEVER GATED — invariant 4
# ===========================================================================

def _long_position_state(**over) -> TradingState:
    """Holding a LONG in BTC while the panel now reads SHORT.

    Overrides REPLACE the defaults rather than being passed alongside them, so a
    caller can weaken the contrary reading without a duplicate-keyword TypeError.
    """
    base = {
        "portfolio_state": PortfolioStateSnapshot(
            tab="paper", equity=10_000.0, cash=5_000.0,
            open_positions=[{"symbol": "BTC/USDT", "qty": 0.5, "avgCost": 100.0}],
        ),
        "debate_verdict": _verdict(direction="SHORT", confidence=0.4),
        "trade_thesis": _thesis("SHORT"),
    }
    base.update(over)
    return _state(**base)


def test_exit_is_recommended_when_the_panel_reverses_on_a_held_position():
    decision, _ = _decide(**{})
    # Sanity: the default state holds nothing, so no exit.
    assert decision.action != ACTION_EXIT

    out = supervise(_long_position_state())
    assert out["decision"].action == ACTION_EXIT
    assert out["decision"].direction == "LONG", "names the side being closed"
    assert "0.5" in out["decision"].rationale or "+0.5" in out["decision"].rationale


def test_exit_is_recommended_even_when_the_system_is_paused():
    """INVARIANT 4. The most important test in this file.

    A paused system must still be told to get out. Refusing to recommend a close
    because the operator hit pause is actively harmful.
    """
    system_state.pause("operator hit pause")
    out = supervise(_long_position_state())
    assert out["decision"].action == ACTION_EXIT
    assert "never blocked" in out["decision"].trade_wait_or_exit


def test_exit_is_recommended_even_when_emergency_stopped():
    """INVARIANT 4 under the strongest possible kill switch."""
    system_state.trigger_emergency_stop("drawdown breach")
    out = supervise(_long_position_state())
    assert out["decision"].action == ACTION_EXIT


def test_exit_is_recommended_even_in_observation_mode():
    system_state.enter_observation_mode("CEO drawdown mandate fired")
    out = supervise(_long_position_state())
    assert out["decision"].action == ACTION_EXIT


def test_the_exit_check_runs_before_the_governance_check():
    """Structural guard on the branch ORDER, not just its outcome.

    Asserting the outcome alone would still pass if someone hoisted the governance
    gate above the exit check AND the test happened to use an unpaused system.
    """
    import ast
    import inspect

    src = inspect.getsource(supervise)
    tree = ast.parse(src.lstrip())

    exit_line = gov_line = None
    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            fn = node.func
            name = getattr(fn, "id", None) or getattr(fn, "attr", None)
            if name == "_consider_exit" and exit_line is None:
                exit_line = node.lineno
            if name == "may_open_new_position" and gov_line is None:
                gov_line = node.lineno

    assert exit_line is not None, "_consider_exit is no longer called"
    assert gov_line is not None, "may_open_new_position is no longer called"
    assert exit_line < gov_line, (
        "the exit check must run BEFORE the governance gate — invariant 4 says a "
        "close is never blocked by pause or emergency stop"
    )


def test_exit_survives_a_constraint_that_zeroes_the_panel_confidence():
    """THE regression test for a real invariant-4 violation.

    The risk specialist reports concern 1.0 whenever the system is paused or
    emergency-stopped, which drives `debate_verdict.confidence` to exactly 0.0. The
    exit check originally gated on that number, so firing a kill switch made an
    exit recommendation structurally impossible — the precise inverse of what a
    kill switch is for.

    Both halves were individually correct: a constraint SHOULD stop new risk, and an
    exit SHOULD need evidence behind it. The bug was one number answering both
    questions. The exit now reads `directional_confidence`, which is coverage-scaled
    agreement BEFORE constraint dampening.

    Found by an end-to-end run. The earlier unit tests missed it because they built
    verdicts with `confidence` set directly and never went through the dampening.
    """
    st = _long_position_state(debate_verdict=_verdict(
        direction="SHORT",
        confidence=0.0,                 # fully dampened by the constraint
        directional_confidence=0.40,    # the evidence itself is strong
        binding_constraint="risk",
        constraint_applied=1.0,
    ))
    decision = supervise(st)["decision"]

    assert decision.action == ACTION_EXIT, (
        "a constraint against OPENING must not suppress a signal to CLOSE"
    )
    assert "must not suppress a signal to CLOSE" in decision.rationale, (
        "the two differing numbers must be explained, not left looking like a bug"
    )


def test_exit_survives_the_real_debate_node_under_an_emergency_stop():
    """The same guard, but going through `run_debate` rather than a hand-built
    verdict — which is what the unit-level version failed to catch."""
    from backend.graphs.nodes.specialists import run_debate

    system_state.trigger_emergency_stop("regression check")

    findings = [
        SpecialistFinding("market", "directional", available=True,
                          stance="supports_short", confidence=0.9,
                          evidence=["structure broke down"]),
        SpecialistFinding("funding", "directional", available=True,
                          stance="supports_short", confidence=0.5, evidence=["crowded longs"]),
        # concern 1.0 is exactly what `specialist_risk` returns when stopped.
        SpecialistFinding("risk", "constraint", available=True, concern=1.0,
                          evidence=["EMERGENCY STOP is active"]),
    ]
    verdict = run_debate(_state(specialist_findings=findings))["debate_verdict"]

    assert verdict.confidence == pytest.approx(0.0), "the constraint should zero it"
    assert verdict.directional_confidence > 0.0, "but the evidence itself is not zero"

    st = _long_position_state(debate_verdict=verdict)
    assert supervise(st)["decision"].action == ACTION_EXIT


def test_a_stale_verdict_without_the_split_field_does_not_reintroduce_the_bug():
    """A hand-built or pre-Phase-27 verdict may lack `directional_confidence`.

    Falling back to `confidence` is only safe when NO constraint was applied;
    falling back when one was would silently restore the violation.
    """
    st = _long_position_state(debate_verdict=_verdict(
        direction="SHORT", confidence=0.4, directional_confidence=None,
        binding_constraint="risk", constraint_applied=0.9,
    ))
    # No exit rather than an exit computed from a dampened number: refusing is safe,
    # acting on the wrong number is not.
    assert supervise(st)["decision"].action != ACTION_EXIT

    # With no constraint, the fallback is sound and the exit stands.
    st = _long_position_state(debate_verdict=_verdict(
        direction="SHORT", confidence=0.4, directional_confidence=None,
    ))
    assert supervise(st)["decision"].action == ACTION_EXIT


def test_no_exit_when_the_panel_still_agrees_with_the_held_side():
    """Holding a LONG and the panel says LONG is not a reason to close."""
    st = _state(
        portfolio_state=PortfolioStateSnapshot(
            tab="paper", equity=10_000.0, cash=5_000.0,
            open_positions=[{"symbol": "BTC/USDT", "qty": 0.5, "avgCost": 100.0}],
        ),
        debate_verdict=_verdict(direction="LONG", confidence=0.5),
    )
    assert supervise(st)["decision"].action != ACTION_EXIT


def test_no_exit_on_a_weak_contrary_reading():
    st = _long_position_state(
        debate_verdict=_verdict(direction="SHORT",
                                confidence=MIN_CONFIDENCE_TO_EXIT - 0.01),
    )
    assert supervise(st)["decision"].action != ACTION_EXIT


def test_the_exit_bar_is_lower_than_the_entry_bar():
    """The bar to STOP taking risk should be lower than the bar to take it."""
    assert MIN_CONFIDENCE_TO_EXIT < MIN_CONFIDENCE_TO_TRADE


def test_a_position_in_another_symbol_does_not_trigger_an_exit():
    st = _state(
        portfolio_state=PortfolioStateSnapshot(
            tab="paper", equity=10_000.0, cash=5_000.0,
            open_positions=[{"symbol": "ETH/USDT", "qty": 2.0, "avgCost": 3000.0}],
        ),
        debate_verdict=_verdict(direction="SHORT", confidence=0.4),
        trade_thesis=_thesis("SHORT"),
    )
    assert supervise(st)["decision"].action != ACTION_EXIT


# ===========================================================================
# 2. THE SUPERVISOR NEVER SIZES
# ===========================================================================

@pytest.mark.parametrize("scenario", ["trade", "wait", "do_not_trade", "exit"])
def test_size_and_leverage_are_never_set_on_any_branch(scenario):
    """The Risk Gateway (Phase 28) owns sizing, and its margin and daily-loss
    checks do not exist yet. A populated size here would make the pipeline look
    complete while the checks bounding it were missing."""
    if scenario == "trade":
        out = supervise(_state(debate_verdict=_verdict("LONG", 0.5)))
    elif scenario == "wait":
        out = supervise(_state(debate_verdict=_verdict("LONG", 0.05)))
    elif scenario == "do_not_trade":
        out = supervise(_state(debate_verdict=_verdict("SHORT", 0.5)))
    else:
        out = supervise(_long_position_state())

    decision = out["decision"]
    assert decision.size is None, f"{scenario}: the Supervisor must not size"
    assert decision.leverage is None, f"{scenario}: the Supervisor must not set leverage"


def test_the_trade_rationale_says_who_owns_sizing():
    decision, _ = _decide(debate_verdict=_verdict("LONG", 0.5))
    assert decision.action == ACTION_TRADE
    assert "Risk Gateway" in decision.rationale


def test_the_supervisor_cannot_reach_the_execution_path():
    """Rule 0 / invariant 1, at import level."""
    import ast
    import pathlib

    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    src = pathlib.Path("backend/graphs/nodes/supervisor.py").read_text(encoding="utf-8")
    imported = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)

    assert not (imported & FORBIDDEN_IMPORTS)


def test_the_decision_is_deterministic_only():
    """No LLM node may write `decision` — it is the audit record."""
    from backend.graphs.state import DETERMINISTIC_ONLY_FIELDS

    assert "decision" in DETERMINISTIC_ONLY_FIELDS


def test_the_supervisor_contract_is_deterministic_and_writes_only_the_decision():
    from backend.graphs.nodes.supervisor import register_supervisor_node
    from backend.graphs.registry import get_contract

    if get_contract(SUPERVISOR_NODE) is None:
        register_supervisor_node()
    contract = get_contract(SUPERVISOR_NODE)

    assert contract.deterministic is True
    assert contract.may_call_llm is False
    assert contract.writes == ("decision",)
    assert contract.phase == 27


# ===========================================================================
# 3. PROBABILITY
# ===========================================================================

def test_probability_is_none_without_a_measured_track_record(monkeypatch):
    """THE fabrication guard.

    Panel confidence measures how much of the panel agreed. It does NOT measure
    how often such agreement has been right. Reporting it as a probability would
    be the most persuasive fabrication available to this system, because it looks
    like a calibrated forecast and feeds position sizing.
    """
    monkeypatch.setattr(
        "backend.services.ai_memory.get_memory_stats",
        lambda: {"global_stats": {"total_trades": 3, "wins": 3}},
    )
    decision, out = _decide()

    assert decision.probability is None, "a 3-trade sample is not a hit rate"
    assert any("probability" in u for u in out.get("unavailable", []))
    reason = next(u for u in out["unavailable"] if "probability" in u)
    assert "not a measurement" in reason or "need" in reason


def test_probability_is_populated_once_there_is_a_real_sample(monkeypatch):
    monkeypatch.setattr(
        "backend.services.ai_memory.get_memory_stats",
        lambda: {"global_stats": {"total_trades": 40, "wins": 24}},
    )
    decision, out = _decide()

    assert decision.probability is not None
    assert 0.0 <= decision.probability <= 1.0
    assert not any("probability" in u for u in out.get("unavailable", []))


def test_probability_never_exceeds_the_panel_confidence_it_calibrates(monkeypatch):
    """Calibration must temper conviction, never amplify it."""
    monkeypatch.setattr(
        "backend.services.ai_memory.get_memory_stats",
        lambda: {"global_stats": {"total_trades": 100, "wins": 90}},
    )
    raw = 0.5
    decision, _ = _decide(debate_verdict=_verdict("LONG", raw))
    assert decision.probability <= raw


def test_probability_is_none_when_the_history_is_unreadable(monkeypatch):
    def boom():
        raise RuntimeError("store corrupt")

    monkeypatch.setattr("backend.services.ai_memory.get_memory_stats", boom)
    decision, out = _decide()

    assert decision.probability is None
    assert any("unreadable" in u for u in out.get("unavailable", []))


def test_probability_is_none_when_the_panel_had_no_confidence():
    decision, _ = _decide(debate_verdict=DebateVerdict(direction=None, confidence=None))
    assert decision.probability is None


def test_probability_is_not_in_the_required_answers():
    """None is a legitimate answer to "what is the probability?" today.

    Requiring it would force a fabricated number to satisfy the check.
    """
    assert "probability" not in REQUIRED_ANSWERS


# --- the shared calibration helpers ---------------------------------------

def test_measured_accuracy_returns_none_below_the_minimum_sample():
    rate, note = measured_accuracy({"global_stats": {"total_trades": 19, "wins": 12}})
    assert rate is None
    assert str(MIN_TRADES_FOR_ACCURACY) in note


def test_measured_accuracy_clamps_an_implausible_win_rate():
    """A 100% rate over a small sample is a sampling artefact; unclamped it would
    make calibration amplify confidence instead of tempering it."""
    rate, _ = measured_accuracy({"global_stats": {"total_trades": 25, "wins": 25}})
    assert rate == ACCURACY_CEILING

    rate, _ = measured_accuracy({"global_stats": {"total_trades": 25, "wins": 0}})
    assert rate == ACCURACY_FLOOR


def test_measured_accuracy_reads_the_nested_shape_not_the_root():
    """The counters live under "global_stats". Reading them from the root returned
    None every time, so the ConfidenceAgent silently always used its prior."""
    rate, note = measured_accuracy({"global_stats": {"total_trades": 50, "wins": 30}})
    assert rate == pytest.approx(0.6)
    assert "50" in note


def test_measured_accuracy_handles_no_history():
    assert measured_accuracy({})[0] is None
    assert measured_accuracy(None)[0] is None


def test_unmeasurable_volatility_gets_the_maximum_penalty_not_zero():
    """Treating an unknown volatility regime as calm is the assumption most likely
    to produce an oversized position at the worst moment."""
    penalty, note = volatility_penalty_from_closes([100.0] * (MIN_CANDLES_FOR_VOLATILITY - 1))
    assert penalty == UNKNOWN_VOLATILITY_PENALTY
    assert "maximum penalty" in note


def test_a_flat_series_measured_as_calm_gets_no_penalty():
    """Distinct from unmeasurable: enough candles, and they really are flat."""
    penalty, note = volatility_penalty_from_closes([100.0] * 50)
    assert penalty == pytest.approx(0.0)
    assert "stdev" in note


def test_the_confidence_agent_still_substitutes_its_prior():
    """The shared helper returns None; the ConfidenceAgent must still emit a number.

    Both behaviours are correct and the split lives at the call site — this asserts
    the Phase 27 extraction did not change the agent.
    """
    from backend.agents.confidence_agent import (
        ASSUMED_ACCURACY_WITHOUT_HISTORY,
        get_confidence_agent,
    )

    rate, _ = get_confidence_agent()._measured_accuracy()
    assert rate is not None, "the calibration stage must always emit a number"
    assert rate == ASSUMED_ACCURACY_WITHOUT_HISTORY or 0.2 <= rate <= 0.9


# ===========================================================================
# 4. ALL TEN QUESTIONS, ON EVERY BRANCH
# ===========================================================================

@pytest.mark.parametrize(
    "label,builder",
    [
        ("TRADE", lambda: _state(debate_verdict=_verdict("LONG", 0.5))),
        ("WAIT low confidence", lambda: _state(debate_verdict=_verdict("LONG", 0.05))),
        ("WAIT no coverage", lambda: _state(
            debate_verdict=DebateVerdict(direction=None, confidence=None, coverage=0.0))),
        ("DO_NOT_TRADE contradiction", lambda: _state(debate_verdict=_verdict("SHORT", 0.5))),
        ("EXIT", _long_position_state),
    ],
)
def test_all_ten_questions_are_answered_on_every_branch(label, builder):
    """Section 10 makes explainability non-negotiable, and a rejection needs
    explaining at least as much as an acceptance."""
    decision = supervise(builder())["decision"]
    for field in REQUIRED_ANSWERS:
        value = getattr(decision, field)
        assert value, f"{label}: Section 10 question '{field}' was left blank"


def test_a_decision_missing_an_answer_raises_rather_than_shipping():
    """A partly-explained decision would pass every other check in the system and
    be unexplainable exactly when someone needed to audit it."""
    from backend.graphs.nodes.supervisor import _assert_all_ten_answered
    from backend.graphs.state import TradeDecision

    with pytest.raises(ValueError, match="without answering"):
        _assert_all_ten_answered(TradeDecision(action="TRADE"))


def test_what_happened_is_the_trigger_verbatim_with_its_numbers():
    """Paraphrasing the trigger loses the measured value that caused the run."""
    decision, _ = _decide()
    assert "price_move" in decision.what_happened
    assert "2.4" in decision.what_happened
    assert "threshold" in decision.what_happened


def test_what_is_happening_says_confidence_is_coverage_not_a_forecast():
    decision, _ = _decide()
    assert "Trending Bullish" in decision.what_is_happening
    assert "DATA COVERAGE" in decision.what_is_happening


def test_an_unclassified_regime_is_reported_as_unclassified_not_neutral():
    decision, _ = _decide(market_regime=MarketRegimeState(regime=None))
    assert "unclassified rather than neutral" in decision.what_is_happening


def test_why_attributes_evidence_to_the_specialist_that_produced_it():
    """An unattributed "why" cannot be checked against its source — which is exactly
    where DebateVisualizer used to invent "EMA 9 crossed above EMA 21"."""
    decision, _ = _decide()
    assert "market" in decision.why
    assert "BOS continuing UP" in decision.why
    assert "news" in decision.why, "the absent specialist should be named"


def test_why_refuses_to_attribute_when_no_specialist_had_evidence():
    decision, _ = _decide(specialist_findings=[
        SpecialistFinding("market", "directional", available=False,
                          reason_unavailable="no candles"),
    ])
    assert "cannot be attributed" in decision.why


def test_what_could_happen_next_is_bounded_by_the_computed_levels():
    """Two computed outcomes, not a speculative third."""
    decision, _ = _decide()
    assert "104" in decision.what_could_happen_next
    assert "98" in decision.what_could_happen_next
    assert "Neither level is a prediction" in decision.what_could_happen_next


def test_evidence_carries_both_the_thesis_and_the_panel_contributions():
    decision, _ = _decide()
    assert any("15m trend" in e for e in decision.evidence_for)
    assert any(e.startswith("panel:") for e in decision.evidence_for)
    assert any(e.startswith("panel:") for e in decision.evidence_against)


def test_an_absent_specialist_counts_as_evidence_against_not_as_silence():
    decision, _ = _decide()
    assert any(
        "unknown rather than absent" in e for e in decision.evidence_against
    ), "a specialist that could not be measured is a reason for less conviction"


def test_downside_is_a_real_percentage_and_refuses_to_invent_a_dollar_figure():
    decision, _ = _decide()
    assert "2.00%" in decision.downside
    assert "DOLLAR downside cannot be stated" in decision.downside
    assert "Risk Gateway" in decision.downside


def test_downside_names_the_soft_stop_limitation():
    """The stop is enforced by a process, not by a resting exchange order. A
    downside statement that omits that overstates the protection."""
    decision, _ = _decide()
    assert "resting exchange order" in decision.downside


def test_downside_is_unbounded_when_no_stop_exists():
    decision, _ = _decide(trade_thesis=_thesis(stop_loss=None))
    assert "UNBOUNDED" in decision.downside


def test_portfolio_impact_distinguishes_a_new_exposure_from_concentration():
    fresh, _ = _decide()
    assert "new exposure" in fresh.portfolio_impact

    held = supervise(_state(
        portfolio_state=PortfolioStateSnapshot(
            tab="paper", equity=10_000.0, cash=5_000.0,
            open_positions=[{"symbol": "BTC/USDT", "qty": 0.5, "avgCost": 100.0}],
        ),
        debate_verdict=_verdict("LONG", 0.5),
    ))["decision"]
    assert "concentrates" in held.portfolio_impact


def test_portfolio_impact_says_what_it_did_not_measure():
    decision, _ = _decide()
    assert "CIO" in decision.portfolio_impact
    assert "CEO" in decision.portfolio_impact
    assert "until the Risk Gateway sets a size" in decision.portfolio_impact


def test_portfolio_impact_reports_an_absent_snapshot_as_unknown_not_zero():
    decision, _ = _decide(portfolio_state=None)
    assert "unknown rather than zero" in decision.portfolio_impact


# ===========================================================================
# Decision logic
# ===========================================================================

def test_agreement_above_the_threshold_trades():
    decision, _ = _decide(debate_verdict=_verdict("LONG", MIN_CONFIDENCE_TO_TRADE + 0.01))
    assert decision.action == ACTION_TRADE
    assert decision.direction == "LONG"


def test_agreement_below_the_threshold_waits_and_says_which_reduction_caused_it():
    """"Confidence was low" is not actionable; "three specialists have no feed" and
    "the risk constraint is binding" lead to different operator actions."""
    decision, _ = _decide(debate_verdict=_verdict(
        "LONG", 0.10, coverage=0.571, binding_constraint="risk", constraint_applied=0.5,
    ))
    assert decision.action == ACTION_WAIT
    assert "coverage is 0.57" in decision.rationale
    assert "risk constraint reduced it" in decision.rationale


def test_a_contradicting_panel_is_do_not_trade_not_wait():
    """WAIT means "not yet"; DO_NOT_TRADE means something actively contradicts it.
    Collapsing them would lose the distinction between "not now" and "not this"."""
    decision, _ = _decide(debate_verdict=_verdict("SHORT", 0.5))
    assert decision.action == ACTION_DO_NOT_TRADE
    assert decision.direction is None, "a rejected trade has no direction to act on"
    assert "argues against" in decision.rationale


def test_no_directional_coverage_waits_and_calls_itself_a_refusal():
    decision, _ = _decide(debate_verdict=DebateVerdict(
        direction=None, confidence=None, coverage=0.0,
    ))
    assert decision.action == ACTION_WAIT
    assert "refusal for want of evidence" in decision.rationale
    assert "not a judgement that conditions are balanced" in decision.rationale


def test_a_paused_system_does_not_trade_but_the_thesis_is_still_recorded():
    system_state.pause("operator request")
    decision, _ = _decide(debate_verdict=_verdict("LONG", 0.5))
    assert decision.action == ACTION_DO_NOT_TRADE
    assert "pause" in decision.rationale
    assert "recorded but not actionable" in decision.rationale


def test_observation_mode_blocks_a_new_position_and_names_the_reason():
    system_state.enter_observation_mode("drawdown 11% from HWM")
    decision, _ = _decide(debate_verdict=_verdict("LONG", 0.5))
    assert decision.action == ACTION_DO_NOT_TRADE
    assert "observation mode" in decision.rationale
    assert "drawdown 11%" in decision.rationale


def test_the_trade_threshold_is_within_the_arithmetic_ceiling():
    """Three of seven specialists have no feed, capping coverage at 0.571.

    A threshold above that would make trading structurally impossible while looking
    like an ordinary tuning choice.
    """
    from backend.graphs.nodes.specialists import (
        DIRECTIONAL_WEIGHTS,
        TOTAL_DIRECTIONAL_WEIGHT,
    )

    cap = (DIRECTIONAL_WEIGHTS["market"] + DIRECTIONAL_WEIGHTS["funding"]) / TOTAL_DIRECTIONAL_WEIGHT
    assert cap == pytest.approx(0.571, abs=0.001)
    assert MIN_CONFIDENCE_TO_TRADE < cap, (
        f"threshold {MIN_CONFIDENCE_TO_TRADE} exceeds today's arithmetic maximum "
        f"{cap:.3f} — no trade could ever be recommended"
    )


def test_the_trade_threshold_is_reachable_by_the_real_scorers():
    """The arithmetic ceiling is not the OBSERVED ceiling, and only the latter
    decides whether this system can ever recommend a trade.

    `score_debate` tops out near 0.53 on real-shaped candles, and the market leg is
    diluted by the funding leg's weight. Measured behaviour today:

        market alone (funding neutral)  ~0.23  -> below the bar
        market + funding agreeing       ~0.31  -> above the bar

    So TRADE requires both directional legs to agree. That is deliberate, and this
    test exists so a future change to `score_debate` or the panel weights that puts
    the observed ceiling BELOW the threshold fails loudly rather than quietly
    producing a system that never trades.
    """
    import math

    from backend.algorithms.debate import score_debate
    from backend.graphs.nodes.specialists import (
        DIRECTIONAL_WEIGHTS as W,
        TOTAL_DIRECTIONAL_WEIGHT as T,
        run_debate,
    )

    # A trend with pullbacks. A perfectly linear ramp is degenerate — RSI saturates
    # and the momentum check flips bearish, so `score_debate` returns NEUTRAL.
    #
    # The step/noise below was re-picked after the Section 14-41 audit restored the
    # ensemble leg to `score_debate`. The original fixture asserted `> 0.4`, which was
    # achievable only while that 4.0-weight leg was missing — see
    # `MIN_CONFIDENCE_TO_TRADE`.
    bars, price = [], 100.0
    for i in range(120):
        price += 0.3 + 1.0 * math.sin(i / 2.4)
        s = 1.35
        bars.append({"time": i, "open": price - s * 0.4, "high": price + s * 0.5,
                     "low": price - s * 0.5, "close": price, "volume": 1000.0 + i * 8})

    market = score_debate(bars)
    assert not market.unavailable, (
        f"score_debate could not evaluate every check: {market.unavailable}. A leg "
        f"reporting itself unavailable silently lowers every confidence in the "
        f"system — the strategy ensemble did exactly that for the whole of Phases "
        f"24-30 because of a regime-vocabulary mismatch."
    )
    assert market.direction == "LONG" and market.confidence > 0.3, (
        f"the reference uptrend no longer scores as a confident LONG "
        f"({market.direction} {market.confidence:.3f}) — retune this fixture before "
        f"trusting the ceiling below"
    )

    verdict = run_debate(_state(specialist_findings=[
        SpecialistFinding("market", "directional", available=True,
                          stance="supports_long", confidence=market.confidence,
                          evidence=["reference uptrend"]),
        SpecialistFinding("funding", "directional", available=True,
                          stance="supports_long", confidence=0.6,
                          evidence=["crowded shorts"]),
    ]))["debate_verdict"]

    assert verdict.confidence > MIN_CONFIDENCE_TO_TRADE, (
        f"with BOTH directional legs agreeing, the best achievable confidence is "
        f"{verdict.confidence:.3f} but the threshold is {MIN_CONFIDENCE_TO_TRADE} — "
        f"TRADE would be unreachable and the system could never act"
    )
    assert supervise(_state(debate_verdict=verdict))["decision"].action == ACTION_TRADE


def test_market_evidence_alone_does_not_clear_the_bar():
    """The stated consequence of the threshold, pinned so it cannot drift silently.

    An available-but-NEUTRAL funding specialist still counts in the denominator —
    correctly, since a specialist that looked and found nothing is evidence of
    weaker conviction. The effect is that market evidence alone lands just below
    0.25 and the Supervisor says WAIT.
    """
    from backend.graphs.nodes.specialists import run_debate

    from backend.graphs.nodes.specialists import (
        DIRECTIONAL_WEIGHTS as W,
        TOTAL_DIRECTIONAL_WEIGHT as T,
    )

    # 0.358 is `score_debate`'s observed ceiling AFTER the Section 14-41 audit
    # restored its strategy-ensemble leg. The original value here was 0.53, measured
    # while that 4.0-weight leg was permanently unavailable — and at 0.53 market
    # evidence alone DOES clear a 0.18 threshold, so the stale fixture made this test
    # assert a property that no longer held.
    OBSERVED_MARKET_CEILING = 0.358

    verdict = run_debate(_state(specialist_findings=[
        SpecialistFinding("market", "directional", available=True,
                          stance="supports_long", confidence=OBSERVED_MARKET_CEILING,
                          evidence=["strong uptrend"]),
        SpecialistFinding("funding", "directional", available=True,
                          stance="neutral", confidence=0.0,
                          evidence=["funding within the neutral band"]),
    ]))["debate_verdict"]

    assert verdict.confidence < MIN_CONFIDENCE_TO_TRADE
    decision = supervise(_state(debate_verdict=verdict))["decision"]
    assert decision.action == ACTION_WAIT

    # Pin the BOUNDARY, not just this one sample. The property "market alone does not
    # clear the bar" holds only while `score_debate` stays below the market
    # confidence at which a solo reading would reach the threshold. If it ever scores
    # higher than that, this stops being true and the threshold needs revisiting —
    # so the arithmetic is asserted rather than left implicit in a fixture value.
    coverage = (W["market"] + W["funding"]) / T
    solo_break_even = MIN_CONFIDENCE_TO_TRADE / coverage * (W["market"] + W["funding"]) / W["market"]
    assert OBSERVED_MARKET_CEILING < solo_break_even, (
        f"score_debate's observed ceiling {OBSERVED_MARKET_CEILING} now reaches the "
        f"{MIN_CONFIDENCE_TO_TRADE} threshold on its own (break-even "
        f"{solo_break_even:.3f}) — 'both legs must agree' no longer holds"
    )


def test_the_supervisor_reports_unavailable_rather_than_deciding_without_a_thesis():
    st = _state(trade_thesis=None)
    out = supervise(st)
    assert "decision" not in out
    assert any("no thesis" in u for u in out["unavailable"])


def test_the_decision_is_deterministic():
    """Identical state, identical decision — what makes it auditable."""
    st = _state()
    first = supervise(st)["decision"]
    second = supervise(_state())["decision"]
    assert (first.action, first.direction, first.rationale) == (
        second.action, second.direction, second.rationale
    )
    assert first.why == second.why


# ===========================================================================
# Graph wiring
# ===========================================================================

def test_the_supervisor_sits_between_the_debate_and_the_narrative():
    """It needs the verdict to decide; the narrative needs the decision to explain.

    Asserted as ORDERING, not adjacency. The first version of this test required
    `(supervisor, narrative)` to be a direct edge, and Phase 28 broke it by
    inserting the Risk Gateway between them — a change that preserved exactly the
    property being tested. The same mistake broke a Phase 26 test when Phase 27
    landed, so this one checks reachability.
    """
    from backend.graphs.analysis import (
        DEBATE_NODE,
        NARRATIVE_NODE,
        analysis_config,
    )

    cfg = analysis_config()
    assert SUPERVISOR_NODE in cfg.nodes

    successors: dict = {}
    for src, dst in cfg.edges:
        successors.setdefault(src, set()).add(dst)

    def downstream_of(start: str) -> set:
        seen, frontier = set(), [start]
        while frontier:
            for nxt in successors.get(frontier.pop(), ()):
                if nxt not in seen:
                    seen.add(nxt)
                    frontier.append(nxt)
        return seen

    assert SUPERVISOR_NODE in downstream_of(DEBATE_NODE), "supervisor must follow the debate"
    assert NARRATIVE_NODE in downstream_of(SUPERVISOR_NODE), "narrative must follow the supervisor"
    assert SUPERVISOR_NODE not in downstream_of(NARRATIVE_NODE), "and not precede it"
    cfg.validate()


def test_the_narrative_prompt_forbids_arguing_for_a_rejected_trade():
    """The node now runs after the Supervisor, so most of what it explains is a
    decision NOT to trade. Prose arguing for the entry would be worse than none."""
    from backend.graphs.nodes.opportunity import _narrative_prompt

    st = _state(debate_verdict=_verdict("SHORT", 0.5))
    st["decision"] = supervise(st)["decision"]
    prompt = _narrative_prompt(st, st["trade_thesis"])

    assert "SUPERVISOR DECISION: DO_NOT_TRADE" in prompt
    assert "This trade is NOT being taken" in prompt
    assert "Do not state or imply a position size" in prompt


def test_the_narrative_prompt_forbids_substituting_confidence_for_probability(monkeypatch):
    from backend.graphs.nodes.opportunity import _narrative_prompt

    monkeypatch.setattr(
        "backend.services.ai_memory.get_memory_stats",
        lambda: {"global_stats": {"total_trades": 2, "wins": 1}},
    )
    st = _state()
    st["decision"] = supervise(st)["decision"]
    prompt = _narrative_prompt(st, st["trade_thesis"])

    assert "NOT MEASURABLE" in prompt
    assert "do not substitute the panel confidence" in prompt


def test_the_narrative_prompt_is_unchanged_when_no_supervisor_ran():
    """The Phase 25 graph has no supervisor node and must still work."""
    from backend.graphs.nodes.opportunity import _narrative_prompt

    st = _state()
    st["decision"] = None
    prompt = _narrative_prompt(st, st["trade_thesis"])
    assert "SUPERVISOR DECISION" not in prompt


def test_the_summary_surfaces_all_ten_answers_and_the_honesty_strings():
    from backend.graphs.analysis import summarise_analysis

    st = _state()
    st["decision"] = supervise(st)["decision"]
    out = summarise_analysis(st)

    for key in ("action", "whatHappened", "whatIsHappening", "why",
                "whatCouldHappenNext", "evidenceFor", "evidenceAgainst",
                "probability", "downside", "portfolioImpact", "tradeWaitOrExit"):
        assert key in out["decision"], f"summary is missing Section 10 field '{key}'"

    assert out["decision"]["size"] is None
    assert out["decision"]["leverage"] is None
    assert "NOT a probability" in out["probabilityMeaning"]
    assert "Risk Gateway" in out["sizingMeaning"]
    assert "INERT" in out["executionMeaning"]


def test_the_graph_now_reports_why_nothing_traded():
    """`produces_decision=True` as of Phase 27, so an early exit gets a reason
    filled in from `unavailable` instead of the field being suppressed."""
    import inspect

    from backend.graphs import analysis

    src = inspect.getsource(analysis.run_analysis_graph)
    assert "produces_decision=True" in src
