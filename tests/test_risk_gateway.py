"""Phase 28 / spec Section 11 — the Risk Gateway.

    "One of the most important phases. Do not make the CRO an LLM-only node —
     use deterministic risk code."
    "An LLM can recommend. Code enforces."

Test groups, in descending order of how badly a regression would hurt:

1. **Closes are never gated.** The gateway is the one component whose whole job
   is saying no, so it is the one most likely to say no to an exit. Invariant 4
   says it must not, and it must not *especially* when a limit has been breached.

2. **All nine checks exist and can each reject on their own.** A check that is
   present but unreachable is worse than an absent one, because the check list
   reads as complete.

3. **`unavailable` is not `pass`.** The failure mode this module's own docstring
   warns about is absence of evidence read as evidence of safety.

4. **No order can be placed.** Rule 0 at import level, plus: a rejection produces
   no `ExecutionPlan` at all.
"""

from __future__ import annotations

import datetime

import pytest

from backend.core import system_state
from backend.core.risk_manager import (
    ABSOLUTE_MAX_LEVERAGE,
    MARGIN_BUFFER_MULTIPLIER,
    MAX_DAILY_LOSS_PCT,
    MAX_PORTFOLIO_EXPOSURE_PCT,
    check_correlation,
    check_daily_loss,
    check_kill_switch,
    check_margin,
    check_max_drawdown,
    check_portfolio_exposure,
    validate_trade,
)
from backend.graphs.nodes.risk_gateway import (
    GRAPH_REQUESTED_LEVERAGE,
    RISK_GATEWAY_NODE,
    gate,
)
from backend.graphs.state import (
    MarketSnapshot,
    PortfolioStateSnapshot,
    TechnicalAnalysis,
    TradeDecision,
    TradeThesis,
    TradingState,
    TriggerReason,
    new_state,
)

# The nine checks spec Section 11 names, mapped to the keys this gateway uses.
SPEC_CHECKS = {
    "Max Position": "PositionSize",
    "Max Leverage": "Leverage",
    "Max Drawdown": "MaxDrawdown",
    "Margin": "Margin",
    "Correlation": "Correlation",
    "Daily Loss": "DailyLoss",
    "Exposure": "PortfolioExposure",
    "Liquidity": "Liquidity",
    "Kill Switch": "KillSwitch",
}


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clean_governance():
    system_state.resume("test setup")
    if system_state.is_in_observation_mode():
        system_state.exit_observation_mode("test setup")
    yield
    system_state.resume("test teardown")
    if system_state.is_in_observation_mode():
        system_state.exit_observation_mode("test teardown")


def _candles(n: int = 60, volume: float = 5000.0) -> list:
    out, price = [], 100.0
    for i in range(n):
        price += 0.2
        out.append({"time": i, "open": price - 0.2, "high": price + 0.5,
                    "low": price - 0.5, "close": price, "volume": volume})
    return out


def _today(pnl: float) -> dict:
    return {
        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "symbol": "BTC/USDT", "side": "buy", "pnl": pnl, "is_win": pnl > 0,
    }


def _yesterday(pnl: float) -> dict:
    ts = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)
    return {"timestamp": ts.isoformat(), "symbol": "BTC/USDT", "side": "buy",
            "pnl": pnl, "is_win": pnl > 0}


def _request(**over) -> dict:
    req = {
        "symbol": "BTC/USDT",
        "qty": 0.5,
        "price": 100.0,
        "equityUsd": 10_000.0,
        "klines": _candles(),
        "side": "buy",
        "tab": "paper",
        "requestedLeverage": 1,
        "openPositions": [],
        "freeMarginUsd": 10_000.0,
        "tradeLedger": [],
    }
    req.update(over)
    return req


# --- graph-node state ------------------------------------------------------

def _state(**over) -> TradingState:
    st = new_state(
        run_id="gw-test", symbol="BTC/USDT",
        trigger=TriggerReason(kind="manual", symbol="BTC/USDT", detail="t"),
        started_at=0.0,
    )
    st.update(
        decision=TradeDecision(action="TRADE", direction="LONG", probability=None),
        trade_thesis=TradeThesis(direction="LONG", strategy="Trend", entry_price=100.0,
                                 stop_loss=98.0, take_profit=104.0),
        technical_analysis=TechnicalAnalysis(atr=1.3),
        market_data=MarketSnapshot(symbol="BTC/USDT", price=100.0,
                                   candles={"15m": _candles()}),
        portfolio_state=PortfolioStateSnapshot(tab="paper", equity=10_000.0,
                                               cash=10_000.0, open_positions=[]),
    )
    st.update(over)
    return st


@pytest.fixture(autouse=True)
def _empty_ledger(monkeypatch):
    """The gateway reads the real ledger; tests must not depend on the machine's."""
    monkeypatch.setattr(
        "backend.services.ai_memory.get_memory_stats",
        lambda: {"trade_ledger": []},
    )


# ===========================================================================
# 1. CLOSES ARE NEVER GATED — invariant 4
# ===========================================================================

def test_a_close_bypasses_every_check():
    """The gateway's job is saying no, which makes it the component most likely to
    say no to an exit. Invariant 4 says it must not."""
    result = validate_trade({"intent": "close", "symbol": "BTC/USDT"})

    assert result.approved is True
    assert result.rejection_reasons == []
    assert "CloseBypass" in result.checks
    assert any("never blocked" in n for n in result.caution_notes)


def test_a_close_is_approved_while_emergency_stopped():
    system_state.trigger_emergency_stop("drawdown breach")
    assert validate_trade({"intent": "close", "symbol": "BTC/USDT"}).approved is True


def test_a_close_is_approved_while_paused():
    system_state.pause("operator request")
    assert validate_trade({"intent": "close", "symbol": "BTC/USDT"}).approved is True


def test_a_close_is_approved_with_a_daily_loss_limit_already_breached():
    """The case that matters most. A gateway that blocks exits once the daily loss
    limit is hit traps the operator in the losing positions that caused it."""
    result = validate_trade({
        "intent": "close",
        "symbol": "BTC/USDT",
        "equityUsd": 10_000.0,
        "tradeLedger": [_today(-9_000.0)],
    })
    assert result.approved is True


def test_a_close_is_approved_with_no_market_data_at_all():
    """An open with no candles is rejected. A close is not — needing a liquidity
    reading to permit an exit would make bad data a reason to stay in."""
    assert validate_trade({"intent": "close", "symbol": "BTC/USDT", "klines": []}).approved is True


def test_the_gateway_node_approves_an_exit_unconditionally():
    system_state.trigger_emergency_stop("regression check")
    out = gate(_state(
        decision=TradeDecision(action="EXIT", direction="LONG", probability=None),
        portfolio_state=PortfolioStateSnapshot(
            tab="paper", equity=10_000.0, cash=5_000.0,
            open_positions=[{"symbol": "BTC/USDT", "qty": 0.5, "avgCost": 100.0}],
        ),
    ))

    assert out["risk_assessment"].approved is True
    assert out["execution_plan"] is not None
    assert out["execution_plan"].side == "sell", "closing a long is a sell"
    assert out["execution_plan"].size == pytest.approx(0.5)
    assert out["execution_plan"].leverage == 1, "never lever up to close"
    assert out["execution_plan"].stop_loss is None, "a close IS the exit"


def test_closing_a_short_is_a_buy():
    out = gate(_state(
        decision=TradeDecision(action="EXIT", direction="SHORT", probability=None),
        portfolio_state=PortfolioStateSnapshot(
            tab="paper", equity=10_000.0, cash=5_000.0,
            open_positions=[{"symbol": "BTC/USDT", "qty": -0.5, "avgCost": 100.0}],
        ),
    ))
    assert out["execution_plan"].side == "buy"
    assert out["execution_plan"].size == pytest.approx(0.5)


def test_an_exit_with_an_unreadable_quantity_still_produces_a_plan():
    """A close the executor must size itself is far better than no close."""
    out = gate(_state(
        decision=TradeDecision(action="EXIT", direction="LONG", probability=None),
        portfolio_state=PortfolioStateSnapshot(
            tab="paper", equity=10_000.0, cash=5_000.0,
            open_positions=[{"symbol": "BTC/USDT", "qty": None, "avgCost": 100.0}],
        ),
    ))
    assert out["risk_assessment"].approved is True
    assert out["execution_plan"] is not None
    assert out["execution_plan"].size is None, "no guessed quantity"
    assert any("executor must determine" in n or "size=None" in n
               for n in out["risk_assessment"].caution_notes)


# ===========================================================================
# 2. ALL NINE CHECKS EXIST AND EACH CAN REJECT
# ===========================================================================

def test_every_check_the_spec_names_is_present():
    """A check list that reads as complete while a check is missing is worse than
    an obviously incomplete one."""
    result = validate_trade(_request())
    for spec_name, key in SPEC_CHECKS.items():
        assert key in result.checks, f"spec Section 11 names '{spec_name}' — no '{key}' check ran"


def test_a_clean_request_is_approved():
    """The baseline. If this fails, the rejection tests below prove nothing."""
    result = validate_trade(_request())
    assert result.approved is True, f"unexpected rejections: {result.rejection_reasons}"


@pytest.mark.parametrize(
    "label,override,expect_key",
    [
        ("max position", {"qty": 60.0}, "PositionSize"),
        ("max leverage", {"requestedLeverage": 50, "tab": "real"}, "Leverage"),
        ("margin", {"freeMarginUsd": 1.0}, "Margin"),
        ("daily loss", {"tradeLedger": [_today(-900.0)]}, "DailyLoss"),
        ("liquidity", {"klines": _candles(volume=1.0)}, "Liquidity"),
        ("correlation", {"openPositions": [{"symbol": "BTC/USDT", "qty": 1.0,
                                            "avgCost": 100.0}]}, "Correlation"),
        ("exposure", {"openPositions": [{"symbol": "ETH/USDT", "qty": 100.0,
                                         "avgCost": 100.0}]}, "PortfolioExposure"),
    ],
)
def test_each_check_can_reject_on_its_own(label, override, expect_key):
    result = validate_trade(_request(**override))
    assert result.approved is False, f"{label}: should have been rejected"
    assert result.checks[expect_key].status == "reject", (
        f"{label}: expected {expect_key} to reject, got "
        f"{result.checks[expect_key].status}"
    )


def test_the_kill_switch_rejects_an_open():
    system_state.pause("operator request")
    result = validate_trade(_request())
    assert result.approved is False
    assert result.checks["KillSwitch"].status == "reject"
    assert "PAUSED" in result.checks["KillSwitch"].detail


def test_emergency_stop_rejects_an_open():
    system_state.trigger_emergency_stop("drawdown")
    result = validate_trade(_request())
    assert result.checks["KillSwitch"].status == "reject"
    assert "EMERGENCY STOP" in result.checks["KillSwitch"].detail


def test_observation_mode_rejects_both_the_kill_switch_and_the_drawdown_check():
    """Observation mode IS the CEO's drawdown verdict surfaced."""
    system_state.enter_observation_mode("drawdown 11% from HWM")
    result = validate_trade(_request())
    assert result.checks["KillSwitch"].status == "reject"
    assert result.checks["MaxDrawdown"].status == "reject"
    assert "11%" in result.checks["MaxDrawdown"].detail


def test_no_governance_block_uses_the_predicates_not_a_guessed_dict_key():
    """`snapshot()` keys are `is_paused`/`emergency_stop`/`observation_mode`. Reading
    guessed camelCase keys returned None and reported "no block" while paused —
    that bug shipped once already in the Phase 26 risk specialist."""
    assert check_kill_switch().status == "pass"
    system_state.pause("x")
    assert check_kill_switch().status == "reject"


# --- Max Leverage: the un-overridable ceiling -----------------------------

def test_the_leverage_ceiling_cannot_be_raised_by_the_request():
    """Invariant 2. The ceiling is a module constant, not a config field."""
    result = validate_trade(_request(requestedLeverage=ABSOLUTE_MAX_LEVERAGE + 1,
                                     tab="real"))
    assert result.approved is False
    assert result.checks["Leverage"].status == "reject"
    assert "not operator-configurable" in result.checks["Leverage"].detail


def test_leverage_is_checked_before_any_stop_distance_maths():
    """A very tight stop must not compute its way past the ceiling."""
    result = validate_trade(_request(requestedLeverage=99, tab="real",
                                     qty=0.0001, price=100.0))
    assert result.checks["Leverage"].status == "reject"


# --- Margin ---------------------------------------------------------------

def test_margin_requires_a_buffer_above_the_bare_requirement():
    """Using the last dollar of margin means an adverse tick triggers a margin call
    before the stop is reached — the position gets liquidated at the exchange's
    price instead of exited at ours, making the computed stop meaningless."""
    notional, leverage = 1000.0, 1.0
    bare = notional / leverage

    assert check_margin(notional, leverage, bare).status == "reject", (
        "exactly the bare requirement leaves no buffer"
    )
    assert check_margin(notional, leverage, bare * MARGIN_BUFFER_MULTIPLIER).status == "pass"


def test_margin_accounts_for_leverage():
    """3x leverage needs a third of the margin."""
    assert check_margin(3000.0, 1.0, 1200.0).status == "reject"
    assert check_margin(3000.0, 3.0, 1200.0).status == "pass"


def test_margin_is_unavailable_not_passing_when_cash_is_unknown():
    assert check_margin(1000.0, 1.0, None).status == "unavailable"


def test_margin_falling_back_to_equity_is_a_warning_not_a_silent_pass():
    """Equity overstates free margin on a book with open positions, so the fallback
    is the OPTIMISTIC direction and must be visible."""
    result = validate_trade(_request(freeMarginUsd=None, openPositions=[]))
    assert result.checks["Margin"].status == "warn"
    assert "ASSUMED" in result.checks["Margin"].detail


# --- Daily loss -----------------------------------------------------------

def test_daily_loss_counts_only_today():
    """Yesterday's loss must not halt today."""
    check = check_daily_loss(10_000.0, [_yesterday(-9_000.0)])
    assert check.status == "pass"
    assert "No trades closed today" in check.detail


def test_daily_loss_sums_multiple_closes_rather_than_checking_each():
    """Two 3% losses are individually within the per-trade limit and together over
    the 5% daily one. A check that looked at trades one at a time would miss it."""
    single = check_daily_loss(10_000.0, [_today(-300.0)])
    assert single.status in ("pass", "warn"), "one 3% loss is within the daily limit"

    both = check_daily_loss(10_000.0, [_today(-300.0), _today(-300.0)])
    assert both.status == "reject", "600 of 10,000 is 6%, over the 5% daily limit"
    assert "2 closed trade(s)" in both.detail


def test_daily_loss_rejects_past_the_limit():
    over = -(10_000.0 * MAX_DAILY_LOSS_PCT / 100.0) - 1.0
    check = check_daily_loss(10_000.0, [_today(over)])
    assert check.status == "reject"
    assert "Stop for the day" in check.detail


def test_daily_loss_warns_while_approaching_the_limit():
    approaching = -(10_000.0 * MAX_DAILY_LOSS_PCT / 100.0) * 0.8
    assert check_daily_loss(10_000.0, [_today(approaching)]).status == "warn"


def test_a_profitable_day_passes():
    assert check_daily_loss(10_000.0, [_today(500.0)]).status == "pass"


def test_daily_loss_is_above_the_per_trade_limit_by_design():
    """At or below the 3% per-trade limit, one losing trade taken entirely within
    the rules would halt trading — making the per-trade limit unusable."""
    assert MAX_DAILY_LOSS_PCT > 3.0


def test_daily_loss_is_unavailable_without_a_ledger():
    """None means unknown; [] means measured and empty. The difference decides
    whether strict mode rejects."""
    assert check_daily_loss(10_000.0, None).status == "unavailable"
    assert check_daily_loss(10_000.0, []).status == "pass"


# --- Portfolio exposure ---------------------------------------------------

def test_portfolio_exposure_is_distinct_from_this_trades_size():
    """Three positions each inside the 50% single-trade limit are 150% in
    aggregate, which the single-trade check cannot see."""
    positions = [
        {"symbol": "ETH/USDT", "qty": 40.0, "avgCost": 100.0},   # 4,000
        {"symbol": "SOL/USDT", "qty": 40.0, "avgCost": 100.0},   # 4,000
    ]
    # This trade alone is 3,000 — well inside the 50% single-trade limit.
    result = validate_trade(_request(qty=30.0, openPositions=positions))

    assert result.checks["PositionSize"].status == "pass", (
        "this trade on its own is within the single-trade limit"
    )
    assert result.checks["PortfolioExposure"].status == "reject", (
        "but 11,000 total against 10,000 equity is over the portfolio limit"
    )
    assert result.approved is False


def test_portfolio_exposure_states_that_positions_are_at_entry_cost():
    check = check_portfolio_exposure(
        10_000.0, 1000.0, [{"symbol": "ETH/USDT", "qty": 1.0, "avgCost": 100.0}]
    )
    assert "entry cost" in check.detail


def test_portfolio_exposure_limit_generalises_the_single_trade_limit():
    """50% for one position, 100% total — two maximum-size positions."""
    assert MAX_PORTFOLIO_EXPOSURE_PCT == pytest.approx(100.0)


def test_portfolio_exposure_is_unavailable_when_positions_are_not_supplied():
    assert check_portfolio_exposure(10_000.0, 100.0, None).status == "unavailable"
    assert check_portfolio_exposure(10_000.0, 100.0, []).status == "pass"


# --- Correlation ----------------------------------------------------------

def test_correlation_rejects_adding_to_the_same_asset():
    """Concentration needs no correlation matrix to establish."""
    check = check_correlation("BTC/USDT", [{"symbol": "BTC/USDT", "qty": 1.0,
                                            "avgCost": 100.0}])
    assert check.status == "reject"
    assert "concentrates risk" in check.detail


def test_correlation_passes_on_an_empty_book():
    check = check_correlation("BTC/USDT", [])
    assert check.status == "pass"


def test_cross_asset_correlation_is_unavailable_not_passing():
    """Reporting 'pass' would claim correlation was checked when only concentration
    was. Reporting 'reject' would block every trade the moment a second unrelated
    position existed. Neither is honest, so it is 'unavailable' with the owner named.
    """
    check = check_correlation("BTC/USDT", [{"symbol": "ETH/USDT", "qty": 1.0,
                                            "avgCost": 100.0}])
    assert check.status == "delegated", (
        "no caller can supply a correlation matrix to a synchronous function, so "
        "this is delegated to the CIO rather than a missing input"
    )
    assert "CIO agent" in check.detail


def test_max_drawdown_is_delegated_rather_than_passing_when_nothing_fired():
    """"The mandate has not tripped" is genuinely weaker than "drawdown was
    measured and is within limits" — the CEO only evaluates on its own schedule."""
    check = check_max_drawdown()
    assert check.status == "delegated"
    assert "CEO agent" in check.detail
    assert "NOT a measurement" in check.detail
    assert "absence of objection" in check.detail


# ===========================================================================
# 3. 'unavailable' IS NOT 'pass'
# ===========================================================================

def test_unavailable_is_a_caution_in_lenient_mode():
    """The existing agent callers supply no portfolio or ledger. Rejecting every
    trade they submit would take a working path offline rather than improve it."""
    result = validate_trade(_request(openPositions=None, tradeLedger=None))
    assert result.approved is True
    assert any("NOT EVALUATED" in n for n in result.caution_notes)
    assert any("Correlation" in n for n in result.caution_notes)


def test_unavailable_rejects_in_strict_mode():
    """Inside the graph every input exists, so a check that cannot run is a bug —
    and an unrun check must never look like a passed one."""
    result = validate_trade(_request(openPositions=None, tradeLedger=None), strict=True)
    assert result.approved is False
    assert any("strict mode is on" in r for r in result.rejection_reasons)


def test_strict_mode_does_not_reject_a_delegated_check():
    """The distinction that makes strict mode usable at all.

    `MaxDrawdown` is ALWAYS structurally unmeasurable per-request, so treating it as
    'unavailable' made strict mode reject every trade and the graph's gateway could
    never approve anything. 'delegated' means a named owner has not objected and no
    caller can supply the data — it is reported, never blocking.
    """
    result = validate_trade(_request(), strict=True)
    assert result.approved is True, f"unexpected rejections: {result.rejection_reasons}"
    assert result.checks["MaxDrawdown"].status == "delegated"
    assert any("MaxDrawdown DELEGATED" in n for n in result.caution_notes), (
        "a delegated check must still appear in every assessment, so nine checks "
        "cannot read as clean when two of them are somebody else's"
    )


def test_strict_mode_still_rejects_a_caller_omission():
    """Strict mode has to bite on data the caller could have passed."""
    result = validate_trade(_request(tradeLedger=None), strict=True)
    assert result.approved is False
    assert any("DailyLoss" in r and "strict mode" in r for r in result.rejection_reasons)


def test_liquidity_pass_does_not_claim_the_size_is_fillable():
    """It is a VOLUME proxy. No depth feed is subscribed, which the Phase 26
    liquidity specialist reports as unavailable for the same reason."""
    result = validate_trade(_request())
    detail = result.checks["Liquidity"].detail
    assert result.checks["Liquidity"].status == "pass"
    assert "does NOT bound slippage" in detail


def test_rejection_reasons_are_deduped():
    result = validate_trade(_request(klines=[]))
    assert len(result.rejection_reasons) == len(set(result.rejection_reasons))


# ===========================================================================
# 4. NO ORDER CAN BE PLACED
# ===========================================================================

def test_the_gateway_node_cannot_reach_the_execution_path():
    """Rule 0 at import level."""
    import ast
    import pathlib

    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    src = pathlib.Path("backend/graphs/nodes/risk_gateway.py").read_text(encoding="utf-8")
    imported = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)

    assert not (imported & FORBIDDEN_IMPORTS)


def test_a_rejected_trade_produces_no_execution_plan_at_all():
    """An unapproved plan is an object shaped exactly like an approved one, and the
    only thing stopping a downstream reader acting on it is that reader remembering
    to check a separate field. Not producing it removes the question."""
    system_state.pause("blocked")
    out = gate(_state())

    assert out["risk_assessment"].approved is False
    assert "execution_plan" not in out


def test_the_gateway_contract_writes_only_the_assessment_and_the_plan():
    from backend.graphs.nodes.risk_gateway import register_risk_gateway_node
    from backend.graphs.registry import get_contract

    if get_contract(RISK_GATEWAY_NODE) is None:
        register_risk_gateway_node()
    contract = get_contract(RISK_GATEWAY_NODE)

    assert contract.deterministic is True
    assert contract.may_call_llm is False
    assert set(contract.writes) == {"risk_assessment", "execution_plan"}
    assert "decision" not in contract.writes, (
        "the Supervisor owns the decision record; a second node mutating it would "
        "leave an auditor unable to tell which node produced which field"
    )
    assert contract.phase == 28


def test_the_gateway_never_writes_the_decision():
    out = gate(_state())
    assert "decision" not in out


# ===========================================================================
# The node: sizing
# ===========================================================================

def test_the_gateway_is_what_sets_the_size():
    """Phase 27 left `decision.size` None and named this phase as its owner."""
    st = _state()
    assert st["decision"].size is None

    out = gate(st)
    assert out["risk_assessment"].approved is True
    assert out["execution_plan"].size is not None
    assert out["execution_plan"].size > 0


def test_sizing_uses_the_decision_probability_never_the_panel_confidence():
    """`decision.probability` is the only honest win rate this system has, and it is
    None until 20 trades resolve. Feeding Kelly the panel confidence instead would
    be sizing on a number that is not a win rate."""
    out = gate(_state(decision=TradeDecision(action="TRADE", direction="LONG",
                                             probability=None)))
    notes = " ".join(out["risk_assessment"].caution_notes)
    assert "fixed-fractional" in notes, (
        "with no win probability, Kelly must fall back and say so"
    )

    # A real measured probability engages Kelly, capped downward only.
    out2 = gate(_state(decision=TradeDecision(action="TRADE", direction="LONG",
                                              probability=0.35)))
    notes2 = " ".join(out2["risk_assessment"].caution_notes)
    assert "kelly" in notes2.lower()
    assert out2["execution_plan"] is None or out2["execution_plan"].size <= out["execution_plan"].size, (
        "a 35% win rate must never size LARGER than the conservative fallback"
    )


def test_a_negative_edge_sizes_to_zero_and_rejects():
    """Kelly saying the edge is negative means the honest size is zero."""
    out = gate(_state(decision=TradeDecision(action="TRADE", direction="LONG",
                                             probability=0.05)))
    assert out["risk_assessment"].approved is False
    assert "execution_plan" not in out


def test_the_graph_requests_1x_leverage_not_the_ceiling():
    """The ceiling is the maximum a human may configure, not a target for an
    autonomous system to aim at. Nothing here has a validated track record to
    justify amplifying anything."""
    assert GRAPH_REQUESTED_LEVERAGE == 1
    out = gate(_state())
    assert out["execution_plan"].leverage == 1


def test_the_requested_leverage_is_still_capped_by_the_ceiling(monkeypatch):
    """Belt and braces: even a careless edit to the constant cannot exceed the hard
    limit, because it is passed through `max_leverage_ceiling`."""
    monkeypatch.setattr("backend.graphs.nodes.risk_gateway.GRAPH_REQUESTED_LEVERAGE", 999)
    out = gate(_state(portfolio_state=PortfolioStateSnapshot(
        tab="real", equity=10_000.0, cash=10_000.0, open_positions=[])))
    plan = out.get("execution_plan")
    if plan is not None:
        assert plan.leverage <= ABSOLUTE_MAX_LEVERAGE


def test_sizing_refuses_without_atr():
    """Invariant 3. Sizing is a function of ATR; without it the quantity would be a
    guess and the stop distance already is one."""
    out = gate(_state(technical_analysis=TechnicalAnalysis(atr=None)))
    assert out["risk_assessment"].approved is False
    assert "execution_plan" not in out
    assert any("ATR" in r for r in out["risk_assessment"].rejection_reasons)


def test_sizing_refuses_without_a_stop():
    out = gate(_state(trade_thesis=TradeThesis(direction="LONG", strategy="Trend",
                                               entry_price=100.0, stop_loss=None)))
    assert out["risk_assessment"].approved is False
    assert out["risk_assessment"].checks["MandatoryStopLoss"]["status"] == "reject"


def test_sizing_refuses_without_equity():
    out = gate(_state(portfolio_state=PortfolioStateSnapshot(
        tab="paper", equity=None, cash=None, open_positions=[])))
    assert out["risk_assessment"].approved is False
    assert any("equity" in r for r in out["risk_assessment"].rejection_reasons)


def test_wait_and_do_not_trade_record_an_assessment_rather_than_silence():
    """An absent `risk_assessment` is indistinguishable in the trace from a gateway
    that failed to run."""
    for action in ("WAIT", "DO_NOT_TRADE"):
        out = gate(_state(decision=TradeDecision(action=action, direction=None)))
        assert out["risk_assessment"] is not None
        assert out["risk_assessment"].approved is False
        assert "NotApplicable" in out["risk_assessment"].checks
        assert "execution_plan" not in out


def test_no_decision_reports_unavailable():
    out = gate(_state(decision=None))
    assert "risk_assessment" not in out
    assert any("no decision" in u for u in out["unavailable"])


# ===========================================================================
# Idempotency (Section 39.3)
# ===========================================================================

def test_the_idempotency_basis_is_stable_for_one_decision():
    a = gate(_state())["execution_plan"].idempotency_basis
    b = gate(_state())["execution_plan"].idempotency_basis
    assert a == b, "the same decision must produce the same key, so a retry is caught"


def test_the_idempotency_basis_differs_across_runs():
    """A later run reaching the same conclusion is a real second decision, not a
    duplicate submission of the first."""
    st = _state()
    st["run_id"] = "run-two"
    assert gate(_state())["execution_plan"].idempotency_basis != \
        gate(st)["execution_plan"].idempotency_basis


def test_the_idempotency_basis_is_not_derived_from_a_thread_id():
    """Section 39.3. A thread id changes every run, so a basis built from it would
    let the same decision be submitted twice after a restart — which for an order
    means opening the position twice."""
    import inspect

    from backend.graphs.nodes import risk_gateway

    src = inspect.getsource(risk_gateway._idempotency_basis)
    # The docstring EXPLAINS why thread_id is not used, so grep the body only.
    body = src.split('"""')[-1]
    assert "thread_id" not in body


# ===========================================================================
# Graph wiring
# ===========================================================================

def test_the_gateway_runs_after_the_supervisor_and_before_the_narrative():
    from backend.graphs.analysis import (
        NARRATIVE_NODE,
        SUPERVISOR_NODE,
        analysis_config,
    )

    cfg = analysis_config()
    assert RISK_GATEWAY_NODE in cfg.nodes
    assert (SUPERVISOR_NODE, RISK_GATEWAY_NODE) in cfg.edges
    assert (RISK_GATEWAY_NODE, NARRATIVE_NODE) in cfg.edges
    cfg.validate()


def test_the_narrative_prompt_treats_the_gateway_as_the_last_word():
    """Prose describing an approved trade the gateway then refused is the same
    failure as prose describing one the Supervisor refused."""
    from backend.graphs.nodes.opportunity import _narrative_prompt

    system_state.pause("blocked")
    st = _state()
    st.update(gate(st))
    prompt = _narrative_prompt(st, st["trade_thesis"])

    assert "RISK GATEWAY: REJECTED" in prompt
    assert "will NOT be placed" in prompt
    assert "No approved size exists" in prompt


def test_the_narrative_prompt_states_the_approved_size_when_there_is_one():
    from backend.graphs.nodes.opportunity import _narrative_prompt

    st = _state()
    st.update(gate(st))
    prompt = _narrative_prompt(st, st["trade_thesis"])

    assert "RISK GATEWAY: APPROVED" in prompt
    assert "Approved size:" in prompt
    assert "do not invent a different one" in prompt


def test_the_summary_surfaces_the_checks_and_the_plan():
    from backend.graphs.analysis import summarise_analysis

    st = _state()
    st.update(gate(st))
    out = summarise_analysis(st)

    assert out["risk"]["approved"] is True
    for key in SPEC_CHECKS.values():
        assert key in out["risk"]["checks"], f"summary is missing the {key} check"
    assert out["executionPlan"]["size"] is not None
    assert out["executionPlan"]["idempotencyBasis"]
    assert "code enforces" in out["riskMeaning"]
    assert "invariant 4" in out["exitMeaning"]
    assert "INERT" in out["executionMeaning"]
