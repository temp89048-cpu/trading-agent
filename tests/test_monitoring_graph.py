"""Phase 30 / spec Section 13 — Position Monitoring.

Ordered by consequence:

1. **A stop is never widened.** `tighten_stop` is a one-way ratchet. Widening
   invalidates the per-trade risk limit the position was sized against — the
   position would risk more than 3% of equity while every record still said 3% —
   and it is the specific mechanism by which a small loss becomes a large one.

2. **This is not a second stop-loss.** `PositionMonitorAgent` fires levels on every
   tick. When price is already through one, this graph must defer, not race it to a
   close it is already performing.

3. **All nine dimensions report, or say why not.** A HOLD from four measurable
   dimensions and a HOLD from nine are different statements.

4. **Deciding is not acting.** Nodes are pure; the runner acts. An EXIT travels the
   ungated close path, and a MODIFY can be refused by the agent that owns the stop.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from backend.agents.position_monitor import PositionMonitorAgent, _Tracked
from backend.graphs.monitoring import (
    MONITOR_DIMENSIONS,
    apply_decision,
    monitoring_config,
    positions_from_agent,
    summarise_monitoring,
)
from backend.graphs.nodes.monitoring import (
    MONITOR_NODES,
    POSITION_DECISION_NODE,
    POSITION_SNAPSHOT_NODE,
    REDUCE_AT_ADVERSE_R,
    REDUCE_FRACTION,
    STALE_HOURS,
    TRAIL_BEHIND_PEAK_R,
    TRAIL_TO_BREAKEVEN_R,
    decide_position,
    load_position,
    monitor_market_conditions,
    monitor_portfolio_risk,
    monitor_price_levels,
)
from backend.graphs.state import (
    MarketRegimeState,
    MarketSnapshot,
    MonitoredPosition,
    PortfolioStateSnapshot,
    SentimentAnalysis,
    TechnicalAnalysis,
    TradingState,
    TriggerReason,
    new_state,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _position(**over) -> MonitoredPosition:
    base = dict(
        tar_id="tar-1", symbol="BTC/USDT", side="buy", tab="paper",
        qty=1.0, entry_price=100.0, stop_loss=98.0, take_profit=104.0,
        opened_at_ts=time.time() - 3600.0, peak_price=101.0,
    )
    base.update(over)
    return MonitoredPosition(**base)


def _candles(n: int = 60) -> list:
    return [
        {"time": i, "open": 100.0, "high": 101.0, "low": 99.0,
         "close": 100.0 + i * 0.05, "volume": 3000.0}
        for i in range(n)
    ]


def _state(price: float = 100.0, **over) -> TradingState:
    st = new_state("mon-1", "BTC/USDT",
                   TriggerReason(kind="scheduled", symbol="BTC/USDT", detail="sweep"),
                   0.0)
    st.update(
        monitored_position=_position(),
        market_data=MarketSnapshot(symbol="BTC/USDT", price=price,
                                   candles={"15m": _candles()}),
        market_regime=MarketRegimeState(regime="Trending Bullish", volatility="MEDIUM",
                                        trend_strength=0.6, confidence=1.0),
        technical_analysis=TechnicalAnalysis(atr=1.3, multi_timeframe_trend="Bullish"),
        sentiment_analysis=SentimentAnalysis(funding_rate=0.0001, fear_greed=50),
        portfolio_state=PortfolioStateSnapshot(
            tab="paper", equity=10_000.0, cash=9_000.0,
            open_positions=[{"symbol": "BTC/USDT", "qty": 1.0, "avgCost": 100.0}],
        ),
    )
    st.update(over)
    return st


def _enriched(price: float, **position_over) -> TradingState:
    """A state with `load_position` already applied — what the monitor nodes see."""
    st = _state(price=price, monitored_position=_position(**position_over))
    out = load_position(st)
    if "monitored_position" in (out or {}):
        st["monitored_position"] = out["monitored_position"]
    return st


def _all_findings(st: TradingState) -> TradingState:
    """Run the three monitor nodes and merge, as the fan-out would."""
    from backend.graphs.state import _merge_findings

    findings: list = []
    for node in (monitor_price_levels, monitor_market_conditions, monitor_portfolio_risk):
        out = node(st) or {}
        findings = _merge_findings(findings, out.get("monitor_findings") or [])
    st["monitor_findings"] = findings
    return st


def _agent_with_position(**over) -> PositionMonitorAgent:
    agent = PositionMonitorAgent()
    kw = dict(tar_id="tar-1", symbol="BTC/USDT", side="buy", tab="paper", qty=1.0,
              entry_price=100.0, stop_loss=98.0, take_profit=104.0,
              opened_at=None, peak_price=101.0)
    kw.update(over)
    agent._open[kw["tar_id"]] = _Tracked(**kw)
    return agent


# ===========================================================================
# 1. A STOP IS NEVER WIDENED
# ===========================================================================

def test_tighten_stop_refuses_to_widen_a_long_stop():
    """THE most important rule in this phase.

    Widening invalidates the per-trade risk limit the position was sized against:
    the position would risk more than 3% of equity while every record still said
    3%. It is also how "give it room to breathe" turns a small loss into a large one.
    """
    agent = _agent_with_position()
    applied, reason = agent.tighten_stop("tar-1", 95.0)   # further from a long's price

    assert applied is False
    assert agent._open["tar-1"].stop_loss == 98.0, "the stop must not have moved"
    assert "not tighter" in reason
    assert "one-way ratchet" in reason


def test_tighten_stop_refuses_to_widen_a_short_stop():
    agent = _agent_with_position(side="sell", stop_loss=102.0, take_profit=96.0,
                                 peak_price=99.0)
    applied, reason = agent.tighten_stop("tar-1", 105.0)   # further from a short's price

    assert applied is False
    assert agent._open["tar-1"].stop_loss == 102.0


def test_tighten_stop_accepts_a_tighter_long_stop():
    agent = _agent_with_position()
    applied, reason = agent.tighten_stop("tar-1", 100.0)   # to break-even

    assert applied is True
    assert agent._open["tar-1"].stop_loss == 100.0
    assert "tightened" in reason


def test_tighten_stop_accepts_a_tighter_short_stop():
    agent = _agent_with_position(side="sell", stop_loss=102.0, peak_price=99.0)
    applied, _ = agent.tighten_stop("tar-1", 100.0)
    assert applied is True
    assert agent._open["tar-1"].stop_loss == 100.0


def test_tighten_stop_refuses_an_equal_stop():
    """Not tighter is not tighter. Accepting it would log a change that did not happen."""
    agent = _agent_with_position()
    applied, _ = agent.tighten_stop("tar-1", 98.0)
    assert applied is False


def test_tighten_stop_refuses_a_stop_already_through_price():
    """That is a market exit disguised as a stop, and it must be requested as an
    EXIT so it is recorded as a decision rather than as a stop-out."""
    agent = _agent_with_position(peak_price=101.0)
    applied, reason = agent.tighten_stop("tar-1", 101.5)

    assert applied is False
    assert "fire on the next tick" in reason
    assert "Request an EXIT" in reason


def test_tighten_stop_refuses_a_non_positive_stop():
    agent = _agent_with_position()
    assert agent.tighten_stop("tar-1", 0.0)[0] is False
    assert agent.tighten_stop("tar-1", -5.0)[0] is False


def test_tighten_stop_refuses_an_unknown_position():
    agent = _agent_with_position()
    applied, reason = agent.tighten_stop("nope", 99.0)
    assert applied is False
    assert "no open position" in reason


def test_snapshot_returns_copies_not_live_objects():
    """A caller holding a `_Tracked` reference could assign `stop_loss` directly and
    bypass the widen-refusal — the one rule here that must not be bypassable."""
    agent = _agent_with_position()
    rows = agent.snapshot_open()

    rows[0]["stopLoss"] = 1.0
    assert agent._open["tar-1"].stop_loss == 98.0, "mutating the snapshot must not reach the book"

    positions = positions_from_agent(agent)
    positions[0].stop_loss = 1.0
    assert agent._open["tar-1"].stop_loss == 98.0


def test_the_trailing_rule_only_ever_proposes_tighter_stops():
    """Belt and braces on the proposal side. The agent would refuse a widened stop,
    but a rule that proposed one would still be a bug worth catching here."""
    from backend.graphs.nodes.monitoring import _trail_stop

    for r, peak, side, stop, entry in [
        (1.5, 103.0, "buy", 98.0, 100.0),
        (3.0, 106.0, "buy", 98.0, 100.0),
        (1.5, 97.0, "sell", 102.0, 100.0),
        (3.0, 94.0, "sell", 102.0, 100.0),
    ]:
        pos = _position(side=side, entry_price=entry, stop_loss=stop, peak_price=peak)
        pos.r_multiple = r
        proposed, note = _trail_stop(pos)
        if proposed is None:
            continue
        tighter = proposed > stop if side == "buy" else proposed < stop
        assert tighter, f"{side} at {r}R proposed {proposed}, not tighter than {stop}"


def test_no_trailing_below_one_r():
    """Tightening earlier would pull the stop inside the noise the ATR distance was
    sized to absorb, stopping the position out of an intact thesis."""
    from backend.graphs.nodes.monitoring import _trail_stop

    pos = _position()
    pos.r_multiple = TRAIL_TO_BREAKEVEN_R - 0.01
    proposed, note = _trail_stop(pos)
    assert proposed is None
    assert "noise" in note


def test_break_even_at_one_r_and_peak_trailing_beyond_two_r():
    from backend.graphs.nodes.monitoring import _trail_stop

    at_1r = _position()
    at_1r.r_multiple = TRAIL_TO_BREAKEVEN_R
    proposed, note = _trail_stop(at_1r)
    assert proposed == pytest.approx(100.0), "break-even is the entry price"
    assert "break-even" in note

    at_3r = _position(peak_price=106.0)
    at_3r.r_multiple = TRAIL_BEHIND_PEAK_R + 1.0
    proposed, note = _trail_stop(at_3r)
    # initial risk is 2.0, trailing 1.0R behind a 106 peak -> 104.
    assert proposed == pytest.approx(104.0)
    assert "behind the peak" in note


# ===========================================================================
# 2. THIS IS NOT A SECOND STOP-LOSS
# ===========================================================================

def test_price_through_the_stop_defers_to_the_monitor_agent():
    """Racing a faster component to a close it is already performing would
    double-submit."""
    st = _all_findings(_enriched(price=97.0))     # below a long's 98 stop
    decision = decide_position(st)["position_decision"]

    assert decision.action == "HOLD"
    assert "position monitor agent" in decision.reason
    assert "double-submit" in decision.reason


def test_price_through_the_take_profit_also_defers():
    st = _all_findings(_enriched(price=105.0))    # above a long's 104 target
    decision = decide_position(st)["position_decision"]
    assert decision.action == "HOLD"
    assert "take-profit" in decision.reason


def test_the_level_dimensions_report_but_never_close():
    """`monitor_price_levels` writes only findings — it has no path to a close."""
    from backend.graphs.nodes.monitoring import register_monitoring_nodes
    from backend.graphs.registry import get_contract

    if get_contract("monitor_price_levels") is None:
        register_monitoring_nodes()
    contract = get_contract("monitor_price_levels")
    assert contract.writes == ("monitor_findings",)


def test_no_monitoring_node_can_reach_the_execution_path():
    """Rule 0 at import level, for the whole module."""
    import ast
    import pathlib

    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    src = pathlib.Path("backend/graphs/nodes/monitoring.py").read_text(encoding="utf-8")
    imported = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)
    assert not (imported & FORBIDDEN_IMPORTS)


def test_every_monitoring_contract_is_deterministic():
    """Spec Section 13: "Risk rules remain deterministic here too.\""""
    from backend.graphs.nodes.monitoring import register_monitoring_nodes
    from backend.graphs.registry import get_contract

    if get_contract(POSITION_SNAPSHOT_NODE) is None:
        register_monitoring_nodes()

    for name in (POSITION_SNAPSHOT_NODE, *MONITOR_NODES, POSITION_DECISION_NODE):
        contract = get_contract(name)
        assert contract is not None, f"{name} is not registered"
        assert contract.deterministic is True
        assert contract.may_call_llm is False
        assert contract.phase == 30


def test_the_position_decision_is_deterministic_only():
    from backend.graphs.state import DETERMINISTIC_ONLY_FIELDS

    for key in ("position_decision", "monitored_position", "monitor_findings"):
        assert key in DETERMINISTIC_ONLY_FIELDS, (
            f"{key} must not be writable by a model"
        )


def test_the_same_conditions_always_produce_the_same_decision():
    a = decide_position(_all_findings(_enriched(price=100.5)))["position_decision"]
    b = decide_position(_all_findings(_enriched(price=100.5)))["position_decision"]
    assert (a.action, a.reason) == (b.action, b.reason)


# ===========================================================================
# 3. ALL NINE DIMENSIONS
# ===========================================================================

def test_all_nine_spec_dimensions_report():
    """A check list that reads as complete while a dimension is missing is worse
    than an obviously incomplete one."""
    st = _all_findings(_enriched(price=100.5))
    reported = {f.specialist for f in st["monitor_findings"]}

    for dimension in MONITOR_DIMENSIONS:
        assert dimension in reported, f"spec Section 13 names '{dimension}' — it did not report"
    assert len(MONITOR_DIMENSIONS) == 9


def test_liquidity_and_news_report_unavailable_not_neutral():
    """Same feed-blocked honesty as Phase 26. An unmeasured event risk against an
    OPEN position is more dangerous, not less."""
    st = _all_findings(_enriched(price=100.5))
    by_name = {f.specialist: f for f in st["monitor_findings"]}

    for name in ("liquidity", "news"):
        finding = by_name[name]
        assert finding.available is False
        assert finding.stance is None
        assert finding.concern is None
        assert finding.reason_unavailable

    assert "slippage" in by_name["liquidity"].reason_unavailable
    assert "unknown rather than absent" in by_name["news"].reason_unavailable


def test_a_ranging_regime_is_neutral_not_an_invalidation():
    """A range neither confirms nor invalidates a directional thesis. Treating it as
    invalidation would exit every position the moment the trend paused."""
    st = _all_findings(_enriched(price=100.5))
    st["market_regime"] = MarketRegimeState(regime="Ranging / Low Volatility",
                                            volatility="LOW", trend_strength=0.1,
                                            confidence=1.0)
    st = _all_findings(st)
    by_name = {f.specialist: f for f in st["monitor_findings"]}

    assert by_name["market_regime"].stance == "neutral"
    assert decide_position(st)["position_decision"].action != "EXIT"


def test_the_summary_reports_every_dimension_including_absent_ones():
    st = _all_findings(_enriched(price=100.5))
    st.update(decide_position(st))
    out = summarise_monitoring(st)

    assert out["dimensionsTotal"] == 9
    assert len(out["dimensions"]) == 9
    names = [d["name"] for d in out["dimensions"]]
    assert names == list(MONITOR_DIMENSIONS), "reported in the spec's order"

    news = next(d for d in out["dimensions"] if d["name"] == "news")
    assert news["reported"] is True
    assert news["available"] is False
    assert news["reasonUnavailable"]
    assert out["dimensionsAvailable"] < 9, "liquidity and news cannot be available"


def test_the_summary_explains_r_multiples_and_the_stop_ratchet():
    st = _all_findings(_enriched(price=100.5))
    st.update(decide_position(st))
    out = summarise_monitoring(st)

    assert "entry-to-stop" in out["rMultipleMeaning"]
    assert "refuses to widen" in out["stopMeaning"]
    assert "never fires a stop" in out["notASecondStopMeaning"]
    assert "THESIS is invalidated" in out["exitMeaning"]


def test_volatility_that_has_risen_says_size_is_the_only_lever():
    """Widening the stop is forbidden, so the honest consequence must be stated
    rather than the dimension silently reporting a mild concern."""
    st = _enriched(price=100.5)
    # ATR much larger than the stop distance -> volatility rose since entry.
    st["technical_analysis"] = TechnicalAnalysis(atr=5.0, multi_timeframe_trend="Bullish")
    st = _all_findings(st)
    by_name = {f.specialist: f for f in st["monitor_findings"]}

    assert by_name["volatility"].concern >= 0.6
    joined = " ".join(by_name["volatility"].evidence)
    assert "RISEN" in joined
    assert "reduce size" in joined


# ===========================================================================
# Derived numbers
# ===========================================================================

def test_r_multiple_is_profit_in_units_of_initial_risk():
    """Entry 100, stop 98 -> initial risk 2. Price 104 is +2R."""
    st = _enriched(price=104.0)
    assert st["monitored_position"].r_multiple == pytest.approx(2.0)
    assert st["monitored_position"].unrealised_pct == pytest.approx(4.0)
    assert st["monitored_position"].unrealised_pnl == pytest.approx(4.0)


def test_r_multiple_is_signed_correctly_for_a_short():
    st = _state(price=96.0, monitored_position=_position(
        side="sell", entry_price=100.0, stop_loss=102.0, take_profit=94.0,
        peak_price=95.0))
    enriched = load_position(st)["monitored_position"]
    assert enriched.r_multiple == pytest.approx(2.0), "a short in profit is POSITIVE R"
    assert enriched.unrealised_pnl == pytest.approx(4.0)


def test_no_live_price_reports_unavailable_rather_than_guessing():
    """Every downstream number is a function of current price. A monitoring run that
    invented one would produce a confident HOLD or EXIT about a position it could
    not see."""
    st = _state(price=0.0)
    out = load_position(st)
    assert "monitored_position" not in out
    assert any("no live price" in u for u in out["unavailable"])


def test_the_fan_out_is_skipped_when_the_position_cannot_be_measured():
    """Nine "unavailable" findings and a HOLD would look like a considered decision."""
    from backend.graphs.monitoring import _after_snapshot

    assert _after_snapshot(_state(price=0.0)) == "cannot_monitor"
    assert _after_snapshot(_enriched(price=100.0)) == "monitor"


# ===========================================================================
# Decision branches
# ===========================================================================

def test_a_flipped_regime_exits():
    st = _enriched(price=100.5)
    st["market_regime"] = MarketRegimeState(regime="Trending Bearish", volatility="MEDIUM",
                                            trend_strength=0.7, confidence=1.0)
    st = _all_findings(st)
    decision = decide_position(st)["position_decision"]

    assert decision.action == "EXIT"
    assert "thesis invalidated" in decision.reason
    assert "not a reason" in decision.reason, (
        "must distinguish a broken thesis from a price level"
    )


def test_exit_outranks_modify():
    """If the thesis is gone, protecting a better price on a position that should not
    exist is the wrong action.

    The target is moved to 110 so +2R does not also touch the take-profit — at 104
    it did, and branch 1 correctly deferred to the monitor agent instead, which
    tested the wrong thing.
    """
    st = _enriched(price=104.0, take_profit=110.0)   # +2R, so a trail WOULD apply
    st["market_regime"] = MarketRegimeState(regime="Trending Bearish", volatility="MEDIUM",
                                            trend_strength=0.7, confidence=1.0)
    st = _all_findings(st)
    decision = decide_position(st)["position_decision"]

    assert decision.action == "EXIT"
    assert decision.new_stop_loss is None


def test_a_working_position_at_one_r_modifies_to_break_even():
    st = _all_findings(_enriched(price=102.0))    # +1R
    decision = decide_position(st)["position_decision"]

    assert decision.action == "MODIFY"
    assert decision.new_stop_loss == pytest.approx(100.0)
    assert "break-even" in decision.reason
    assert "can never rise" in decision.reason


def test_a_quiet_position_holds():
    st = _all_findings(_enriched(price=100.2))    # +0.1R, nothing to do
    decision = decide_position(st)["position_decision"]

    assert decision.action == "HOLD"
    assert decision.new_stop_loss is None
    assert decision.reduce_qty is None


def test_an_adverse_position_with_a_binding_constraint_reduces():
    st = _enriched(price=98.9)    # about -0.55R, past the 0.5R reduce threshold
    # Exposure over the limit gives portfolio_risk a high concern.
    st["portfolio_state"] = PortfolioStateSnapshot(
        tab="paper", equity=1_000.0, cash=100.0,
        open_positions=[{"symbol": "BTC/USDT", "qty": 20.0, "avgCost": 100.0}],
    )
    st = _all_findings(st)
    decision = decide_position(st)["position_decision"]

    assert decision.action == "REDUCE"
    assert decision.reduce_qty == pytest.approx(1.0 * REDUCE_FRACTION)
    assert "only lever" in decision.reason
    assert f"{REDUCE_AT_ADVERSE_R}R" in decision.reason


def test_an_adverse_position_with_no_binding_constraint_does_not_reduce():
    """Being underwater is not by itself a reason to reduce — that is what the stop
    is for. It takes deteriorating CONDITIONS too.

    This originally failed: the `stop` dimension's concern is `1 - r_multiple`, so
    an underwater position automatically reported a high concern and the gate's
    second condition was just restating its first. Every position drifting to
    -0.5R would have been halved. `CONDITION_DIMENSIONS` now restricts which
    dimensions may bind.
    """
    st = _all_findings(_enriched(price=98.9))
    decision = decide_position(st)["position_decision"]
    assert decision.action != "REDUCE"


def test_the_reduce_gate_ignores_concerns_derived_from_the_positions_own_pnl():
    """Structural guard on the independence fix.

    `stop` and `price` restate the R multiple under different names. If either
    could bind the REDUCE gate, "underwater" would count as both halves of a
    two-condition test.
    """
    from backend.graphs.nodes.monitoring import CONDITION_DIMENSIONS

    assert "stop" not in CONDITION_DIMENSIONS
    assert "price" not in CONDITION_DIMENSIONS
    assert "take_profit" not in CONDITION_DIMENSIONS

    st = _all_findings(_enriched(price=98.9))
    by_name = {f.specialist: f for f in st["monitor_findings"]}
    assert by_name["stop"].concern >= 0.5, (
        "the stop dimension DOES report a high concern when underwater — which is "
        "exactly why it must not be allowed to bind the reduce gate"
    )


def test_a_stale_position_can_reduce():
    st = _enriched(price=100.1,
                   opened_at_ts=time.time() - (STALE_HOURS + 1) * 3600)
    st["portfolio_state"] = PortfolioStateSnapshot(
        tab="paper", equity=1_000.0, cash=100.0,
        open_positions=[{"symbol": "BTC/USDT", "qty": 20.0, "avgCost": 100.0}],
    )
    st = _all_findings(st)
    decision = decide_position(st)["position_decision"]

    assert decision.action == "REDUCE"
    assert "without reaching" in decision.reason


def test_the_decision_names_which_dimensions_could_not_be_evaluated():
    st = _all_findings(_enriched(price=100.2))
    decision = decide_position(st)["position_decision"]

    assert decision.unavailable
    assert any("liquidity" in u for u in decision.unavailable)
    assert any("news" in u for u in decision.unavailable)
    assert "could not be evaluated" in decision.reason


def test_no_position_reports_unavailable_rather_than_deciding():
    st = _state()
    st["monitored_position"] = None
    out = decide_position(st)
    assert "position_decision" not in out
    assert any("no position" in u for u in out["unavailable"])


# ===========================================================================
# 4. DECIDING IS NOT ACTING
# ===========================================================================

def test_hold_applies_nothing_but_says_so_explicitly():
    """"we looked and chose not to act" must be distinguishable from "nothing ran"."""
    outcome = asyncio.run(apply_decision(
        {"decision": {"action": "HOLD", "reason": "quiet"}}, _position(), None))
    assert outcome["applied"] is False
    assert outcome["action"] == "HOLD"
    assert outcome["reason"] == "quiet"


def test_modify_asks_the_agent_which_may_refuse():
    """The agent owns the stop precisely so a bug in the rule cannot widen one."""
    agent = _agent_with_position()

    ok = asyncio.run(apply_decision(
        {"decision": {"action": "MODIFY", "newStopLoss": 100.0}}, _position(), agent))
    assert ok["applied"] is True
    assert agent._open["tar-1"].stop_loss == 100.0

    refused = asyncio.run(apply_decision(
        {"decision": {"action": "MODIFY", "newStopLoss": 95.0}}, _position(), agent))
    assert refused["applied"] is False
    assert agent._open["tar-1"].stop_loss == 100.0, "still the tightened value"
    assert "not tighter" in refused["reason"]


def test_modify_without_an_agent_leaves_the_existing_stop_standing():
    outcome = asyncio.run(apply_decision(
        {"decision": {"action": "MODIFY", "newStopLoss": 100.0}}, _position(), None))
    assert outcome["applied"] is False
    assert "wiring failure" in outcome["reason"]
    assert "existing stop still stands" in outcome["reason"]


def test_exit_publishes_a_close_down_the_ungated_path():
    published = []

    class Bus:
        async def publish(self, topic, payload):
            published.append((topic, payload))

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        outcome = asyncio.run(apply_decision(
            {"decision": {"action": "EXIT", "reason": "thesis gone"}}, _position(), None))
    finally:
        mb.get_message_bus = original

    assert outcome["applied"] is True
    assert len(published) == 1
    topic, event = published[0]
    assert topic == "EXECUTION_PLAN_READY"
    assert event.intent == "close", "a close is what makes it ungated"
    assert event.side == "sell", "closing a long is a sell"
    assert event.size == pytest.approx(1.0)
    assert event.stop_loss is None, "a close IS the exit"
    assert event.leverage == 1


def test_reduce_publishes_a_partial_close():
    published = []

    class Bus:
        async def publish(self, topic, payload):
            published.append(payload)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        outcome = asyncio.run(apply_decision(
            {"decision": {"action": "REDUCE", "reduceQty": 0.5}}, _position(), None))
    finally:
        mb.get_message_bus = original

    assert outcome["applied"] is True
    assert published[0].size == pytest.approx(0.5)
    assert published[0].intent == "close"


def test_a_reduce_and_a_later_exit_are_not_duplicates():
    """The basis includes the action and quantity, so an EXIT after a REDUCE is a
    genuinely new request rather than a duplicate of the partial close."""
    published = []

    class Bus:
        async def publish(self, topic, payload):
            published.append(payload)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        asyncio.run(apply_decision(
            {"decision": {"action": "REDUCE", "reduceQty": 0.5}}, _position(), None))
        asyncio.run(apply_decision(
            {"decision": {"action": "EXIT"}}, _position(), None))
    finally:
        mb.get_message_bus = original

    assert published[0].idempotency_basis != published[1].idempotency_basis


def test_closing_a_short_is_a_buy():
    published = []

    class Bus:
        async def publish(self, topic, payload):
            published.append(payload)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        asyncio.run(apply_decision({"decision": {"action": "EXIT"}},
                                   _position(side="sell"), None))
    finally:
        mb.get_message_bus = original

    assert published[0].side == "buy"


def test_a_bus_failure_reports_the_position_is_still_open():
    class Bus:
        async def publish(self, topic, payload):
            raise RuntimeError("bus down")

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        outcome = asyncio.run(apply_decision(
            {"decision": {"action": "EXIT"}}, _position(), None))
    finally:
        mb.get_message_bus = original

    assert outcome["applied"] is False
    assert "could not publish" in outcome["reason"]


def test_a_close_with_no_quantity_refuses_rather_than_guessing():
    outcome = asyncio.run(apply_decision(
        {"decision": {"action": "EXIT"}}, _position(qty=None), None))
    assert outcome["applied"] is False
    assert "guess" in outcome["reason"]


# ===========================================================================
# Graph shape and the worker gate
# ===========================================================================

def test_the_graph_reuses_the_phase_24_and_26_nodes():
    """Re-deriving the regime here would mean two definitions of "what regime is
    BTC in", and a monitoring graph disagreeing with the entry graph about that
    would be worse than one that could not tell."""
    cfg = monitoring_config()
    for node in ("data_validation", "market_state", "specialist_portfolio"):
        assert node in cfg.nodes
    cfg.validate()


def test_the_three_monitor_nodes_fan_out_and_converge():
    cfg = monitoring_config()
    for node in MONITOR_NODES:
        assert (node, POSITION_DECISION_NODE) in cfg.edges

    router = next(ce for ce in cfg.conditional_edges
                  if ce.source == POSITION_SNAPSHOT_NODE)
    assert router.destinations["monitor"] == MONITOR_NODES, "a tuple, so one superstep"


def test_the_fan_out_writes_all_nine_dimensions_through_a_real_graph():
    """The reducer, exercised through a compiled graph rather than by hand."""
    from backend.graphs.builder import GraphConfig, build_graph
    from backend.graphs.nodes.monitoring import register_monitoring_nodes
    from backend.graphs.registry import get_contract
    from backend.graphs.runtime import start_run

    if get_contract(POSITION_SNAPSHOT_NODE) is None:
        register_monitoring_nodes()

    cfg = GraphConfig(
        name="monitor_fanout_probe",
        nodes=[*MONITOR_NODES, POSITION_DECISION_NODE],
        entry=MONITOR_NODES[0],
        edges=[
            *[(n, POSITION_DECISION_NODE) for n in MONITOR_NODES[1:]],
            (POSITION_DECISION_NODE, "__end__"),
        ],
        conditional_edges=[
            __import__("backend.graphs.builder", fromlist=["ConditionalEdge"]).ConditionalEdge(
                source=MONITOR_NODES[0],
                router=lambda s: "go",
                destinations={"go": (*MONITOR_NODES[1:], POSITION_DECISION_NODE)},
            ),
        ],
    )
    st, ctx, _ = start_run(graph="monitor_fanout_probe", symbol="BTC/USDT",
                           trigger=TriggerReason(kind="manual", symbol="BTC/USDT",
                                                 detail="probe"),
                           thread_scope="probe")
    seed = _enriched(price=100.5)
    for key in ("monitored_position", "market_data", "market_regime",
                "technical_analysis", "sentiment_analysis", "portfolio_state"):
        st[key] = seed[key]

    final = asyncio.run(build_graph(cfg, ctx).ainvoke(st))
    reported = {f.specialist for f in final["monitor_findings"]}
    assert reported == set(MONITOR_DIMENSIONS), (
        f"expected all nine, got {sorted(reported)}"
    )
    assert final["position_decision"] is not None


def test_the_worker_gate_defaults_off_and_is_read_at_call_time(monkeypatch):
    from backend.workers.position_worker import ENV_ENABLE, monitoring_enabled

    monkeypatch.delenv(ENV_ENABLE, raising=False)
    assert monitoring_enabled() is False
    monkeypatch.setenv(ENV_ENABLE, "true")
    assert monitoring_enabled() is True


def test_the_worker_computes_decisions_but_withholds_action_when_off(monkeypatch):
    """Off, the reasoning must be complete and only the action withheld."""
    from backend.workers.position_worker import ENV_ENABLE, PositionMonitoringWorker

    monkeypatch.delenv(ENV_ENABLE, raising=False)
    agent = _agent_with_position()

    calls = []

    async def fake_run(position, trigger, checkpointer=None):
        calls.append(position.tar_id)
        return {"ok": True, "decision": {"action": "EXIT", "reason": "thesis gone"},
                "position": {"rMultiple": -0.8}, "dimensionsAvailable": 7,
                "dimensionsTotal": 9}

    monkeypatch.setattr("backend.graphs.monitoring.run_monitoring_graph", fake_run)

    worker = PositionMonitoringWorker(monitor_agent=agent)
    cycle = asyncio.run(worker.run_cycle())

    assert calls == ["tar-1"], "the graph still ran"
    assert cycle["acting"] is False
    record = cycle["decisions"][0]
    assert record["action"] == "EXIT", "the decision was computed"
    assert record["applied"]["applied"] is False, "but not applied"
    assert ENV_ENABLE in record["applied"]["reason"]
    assert "Stop-loss enforcement is unaffected" in cycle["note"]


def test_the_worker_is_separate_from_the_reporting_monitor_worker():
    """`monitor_worker` documents itself as reporting only: "two loops that can both
    act on the same position will eventually act twice on it.\""""
    import pathlib

    src = pathlib.Path("backend/workers/monitor_worker.py").read_text(encoding="utf-8")
    assert "run_monitoring_graph" not in src
    assert "apply_decision" not in src


def test_the_worker_interval_is_slow_because_the_stop_is_what_protects_capital():
    from backend.workers.position_worker import DEFAULT_INTERVAL_SECONDS

    assert DEFAULT_INTERVAL_SECONDS >= 300


def test_the_monitoring_thread_is_keyed_on_the_position_not_the_run():
    """One thread per position means a restart resumes that position's reasoning
    rather than forming a fresh opinion with no memory of the trailing decisions
    already made."""
    import inspect

    from backend.graphs import monitoring

    src = inspect.getsource(monitoring.run_monitoring_graph)
    assert 'f"position:{position.tar_id}"' in src
    assert "run_id" not in src.split("thread_id = ")[1].split("\n")[0]


# ===========================================================================
# Bounded accumulators — a defect the live run exposed
# ===========================================================================

def test_accumulating_reducers_are_bounded():
    """Found by reading the first live checkpoint, not by a test.

    `nodes_visited` used `operator.add`, which was correct while every thread lived
    for one short run. Phase 30 keys its thread on the POSITION, so one thread
    accumulates every sweep for as long as the position is open — three sweeps left
    33 entries, and at a five-minute interval that is roughly 8,000 per week per
    position.

    LangGraph serialises the WHOLE state into the checkpoint on every superstep, so
    an unbounded list does not merely produce a large row: it makes every write
    progressively slower for the position's entire life.
    """
    from backend.graphs.state import MAX_ACCUMULATED_HISTORY, _append_bounded

    grown = []
    for _ in range(MAX_ACCUMULATED_HISTORY + 50):
        grown = _append_bounded(grown, ["node"])

    assert len(grown) == MAX_ACCUMULATED_HISTORY, "history must be capped"


def test_the_bounded_reducer_keeps_the_RECENT_tail():
    """The recent tail is what has debugging value. Dropping it and keeping the
    oldest entries would preserve the least useful half."""
    from backend.graphs.state import MAX_ACCUMULATED_HISTORY, _append_bounded

    combined = _append_bounded(
        [f"old-{i}" for i in range(MAX_ACCUMULATED_HISTORY)],
        ["newest"],
    )
    assert combined[-1] == "newest"
    assert "old-0" not in combined, "the oldest entry should have been dropped"


def test_the_bounded_reducer_is_used_on_the_growing_fields():
    import typing

    from backend.graphs import state as state_mod
    from backend.graphs.state import TradingState, _append_bounded

    # `from __future__ import annotations` makes raw `__annotations__` strings, so
    # they must be resolved. `include_extras=True` is what preserves the Annotated
    # metadata that LangGraph reads as the reducer.
    hints = typing.get_type_hints(
        TradingState, include_extras=True, globalns=vars(state_mod)
    )
    for field_name in ("nodes_visited", "errors"):
        assert _append_bounded in getattr(hints[field_name], "__metadata__", ()), (
            f"{field_name} must use the bounded reducer — it accumulates across "
            f"every sweep on a checkpointed position thread"
        )
