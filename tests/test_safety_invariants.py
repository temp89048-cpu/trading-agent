"""Tests that actively try to BREAK the safety invariants.

Spec Section 22.9: *"Write tests that specifically try to break the safety
principles ... (e.g. try to get an agent to bypass the CRO veto) — these are
the most important tests in the whole system."*

Each test below corresponds to a hole that was actually open in this
codebase, not a hypothetical one. If one of these starts failing, a real
safety regression has landed — do not "fix" the test to match the code.
"""

import asyncio
import uuid

import pytest
from pydantic import ValidationError

from backend.core import system_state
from backend.core.risk_manager import (
    ABSOLUTE_MAX_LEVERAGE,
    ABSOLUTE_MAX_LEVERAGE_PAPER,
    calculate_atr,
    check_leverage,
    compute_stop_loss_take_profit,
    max_leverage_ceiling,
    validate_trade,
)
from backend.models.events import TarApprovedEvent, TarSubmittedEvent


@pytest.fixture(autouse=True)
def _reset_kill_switch():
    """Every test starts with the kill switch clear and leaves it clear."""
    system_state.resume("test setup")
    yield
    system_state.resume("test teardown")


def _candles(n=60, base=100.0, spread=2.0, volume=1000.0):
    """Synthetic candles with a real high/low range so ATR is non-zero."""
    return [
        {
            "openTime": i * 60_000,
            "open": base + i * 0.1,
            "high": base + i * 0.1 + spread,
            "low": base + i * 0.1 - spread,
            "close": base + i * 0.1,
            "volume": volume,
        }
        for i in range(n)
    ]


# ---------------------------------------------------------------------------
# Invariant 2 — the leverage ceiling is not overridable
# ---------------------------------------------------------------------------

def test_leverage_ceiling_values_match_the_typescript_side():
    """3x real / 10x paper. The CRO previously used a bare `> 5` literal, so
    the effective limit depended on which code path a trade took."""
    assert ABSOLUTE_MAX_LEVERAGE == 3
    assert ABSOLUTE_MAX_LEVERAGE_PAPER == 10
    assert max_leverage_ceiling("real") == 3
    assert max_leverage_ceiling("paper") == 10


def test_unknown_tab_gets_the_stricter_ceiling():
    """A typo'd or missing tab must not be handed the permissive paper limit."""
    for tab in ("", "REAL", "live", "production", "nonsense", None):
        assert max_leverage_ceiling(tab) == ABSOLUTE_MAX_LEVERAGE


@pytest.mark.parametrize("leverage", [3.01, 4, 5, 10, 50, 125])
def test_leverage_above_the_real_ceiling_is_rejected(leverage):
    assert check_leverage(leverage, "real").status == "reject"


def test_no_argument_can_raise_the_ceiling():
    """check_leverage takes only the request and the tab — there is
    deliberately no config, confidence, or override parameter that could
    widen the limit."""
    import inspect

    params = set(inspect.signature(check_leverage).parameters)
    assert params == {"requested_leverage", "tab"}


def test_validate_trade_rejects_leverage_over_ceiling_even_when_all_else_passes():
    """The escape hatch to check for: a trade that is otherwise perfect must
    still be rejected on leverage alone."""
    result = validate_trade(
        {
            "qty": 0.01,
            "price": 100.0,
            "equityUsd": 100_000.0,
            "klines": _candles(),
            "side": "buy",
            "tab": "real",
            "requestedLeverage": 25,
        }
    )
    assert result.approved is False
    assert result.checks["Leverage"].status == "reject"


# ---------------------------------------------------------------------------
# Invariant 3 — every position requires a COMPUTED stop-loss
# ---------------------------------------------------------------------------

def test_no_atr_yields_no_stop_rather_than_a_fabricated_one():
    """This used to fall back to `atr = price * 0.01`, inventing a 1%
    volatility estimate nobody measured."""
    assert compute_stop_loss_take_profit(price=100.0, atr=0.0, side="buy") is None
    assert compute_stop_loss_take_profit(price=100.0, atr=-1.0, side="buy") is None
    assert compute_stop_loss_take_profit(price=0.0, atr=5.0, side="buy") is None


def test_stop_is_on_the_protective_side_of_entry():
    long_sltp = compute_stop_loss_take_profit(price=100.0, atr=2.0, side="buy")
    assert long_sltp["stopLoss"] < 100.0 < long_sltp["takeProfit"]

    short_sltp = compute_stop_loss_take_profit(price=100.0, atr=2.0, side="sell")
    assert short_sltp["takeProfit"] < 100.0 < short_sltp["stopLoss"]


def test_trade_with_no_candles_is_rejected_not_silently_approved():
    """The original bug: no klines meant ATR 0, which made the stop-exposure
    and liquidity checks not run at all. Approval was `len(reasons) == 0`, so
    a trade with no market data whatsoever came back approved."""
    result = validate_trade(
        {"qty": 1.0, "price": 100.0, "equityUsd": 10_000.0, "klines": [], "side": "buy", "tab": "real"}
    )
    assert result.approved is False
    assert result.checks["MandatoryStopLoss"].status == "reject"
    assert result.checks["Liquidity"].status == "reject"
    assert result.checks["DrawdownExposure"].status == "reject"


def test_too_few_candles_for_atr_is_rejected():
    """14-period ATR needs 15 candles. 14 must not squeak through."""
    result = validate_trade(
        {"qty": 0.01, "price": 100.0, "equityUsd": 10_000.0, "klines": _candles(14), "side": "buy", "tab": "real"}
    )
    assert result.approved is False
    assert result.checks["MandatoryStopLoss"].status == "reject"


def test_unknown_equity_is_rejected_not_treated_as_unlimited():
    result = validate_trade(
        {"qty": 0.01, "price": 100.0, "equityUsd": 0.0, "klines": _candles(), "side": "buy", "tab": "real"}
    )
    assert result.approved is False
    assert result.checks["PositionSize"].status == "reject"


def test_a_fully_specified_sane_trade_still_passes():
    """Guard against over-tightening: the checks must not reject everything."""
    candles = _candles()
    atr = calculate_atr(candles)
    assert atr > 0
    result = validate_trade(
        {
            "qty": 0.5,
            "price": 100.0,
            "equityUsd": 100_000.0,
            "klines": candles,
            "side": "buy",
            "tab": "real",
            "requestedLeverage": 1,
        }
    )
    assert result.approved is True, result.rejection_reasons
    assert result.stop_loss_take_profit is not None


def test_tar_cannot_be_constructed_without_a_stop_loss():
    """`stop_loss` is a required field with no default precisely so that a
    stopless TAR fails at construction rather than downstream."""
    with pytest.raises(ValidationError):
        TarSubmittedEvent(
            symbol="BTC/USDT",
            direction="LONG",
            requested_size=0.1,
            requested_leverage=1,
            strategy="test",
            supervisor_rationale="test",
            tab="paper",
            # stop_loss deliberately omitted
        )

    with pytest.raises(ValidationError):
        TarApprovedEvent(
            tar_id=uuid.uuid4(),
            symbol="BTC/USDT",
            direction="LONG",
            approved_size=0.1,
            approved_leverage=1,
            cro_rationale="test",
            tab="paper",
            # stop_loss deliberately omitted
        )


# ---------------------------------------------------------------------------
# Invariant 4 — closes/exits are NEVER blocked
# ---------------------------------------------------------------------------

def test_pause_blocks_opens_but_never_closes():
    assert system_state.may_open_new_position() is True
    system_state.pause("test")
    assert system_state.may_open_new_position() is False
    assert system_state.may_close_position() is True, (
        "A pause must never trap the operator in an open position."
    )


def test_emergency_stop_blocks_opens_but_never_closes():
    system_state.trigger_emergency_stop("test")
    assert system_state.may_open_new_position() is False
    assert system_state.may_close_position() is True, (
        "An emergency stop must never prevent exiting a position."
    )


def test_may_close_position_takes_no_arguments_that_could_gate_it():
    """It returns True unconditionally by construction — there is no
    parameter through which a caller could make it return False."""
    import inspect

    assert inspect.signature(system_state.may_close_position).parameters == {}
    assert system_state.may_close_position() is True


def test_emergency_stop_snapshot_cannot_be_mutated_by_callers():
    system_state.trigger_emergency_stop("test")
    snap = system_state.snapshot()
    snap["is_paused"] = False
    assert system_state.is_system_paused() is True


# ---------------------------------------------------------------------------
# Invariant 6 — never fabricate market data
# ---------------------------------------------------------------------------

def test_order_without_credentials_returns_none_and_invents_no_fill():
    """create_market_order used to return a fake filled order at a hardcoded
    price of 60000.0 on ANY exception, which the caller could not distinguish
    from a real fill."""
    import os

    from backend.services.exchange_client import ExchangeClient

    saved = (os.environ.get("BINANCE_API_KEY"), os.environ.get("BINANCE_SECRET"))
    os.environ["BINANCE_API_KEY"] = ""
    os.environ["BINANCE_SECRET"] = ""
    try:
        client = ExchangeClient()
        result = asyncio.run(client.create_market_order("BTC/USDT", "buy", 0.001))
        assert result is None, "A failed order must return None, never a fabricated fill."
    finally:
        for key, value in zip(("BINANCE_API_KEY", "BINANCE_SECRET"), saved):
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value


def test_create_market_order_contains_no_hardcoded_price_literal():
    """Regression guard on the specific fabricated value that was there.

    Parsed with `ast` rather than grepped: the fabricated price is quoted in
    the function's docstring as an explanation of what was removed, so a text
    search matches the prose describing the fix as well as the bug. This
    inspects actual numeric literals in the function body, which the docstring
    cannot trigger.
    """
    import ast
    import pathlib

    src = pathlib.Path(__file__).resolve().parents[1] / "backend" / "services" / "exchange_client.py"
    tree = ast.parse(src.read_text(encoding="utf-8"))

    target = None
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == "create_market_order":
            target = node
            break
    assert target is not None, "create_market_order not found — has it been renamed?"

    literals = [
        n.value
        for n in ast.walk(target)
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool)
    ]
    assert 60000 not in literals and 60000.0 not in literals, (
        f"create_market_order contains a hardcoded price literal: {literals}"
    )

    # And it must have no `return {` of a synthesised order dict at all.
    returns_a_dict = [
        n for n in ast.walk(target) if isinstance(n, ast.Return) and isinstance(n.value, ast.Dict)
    ]
    assert not returns_a_dict, (
        "create_market_order returns a literal dict — it must return the exchange's "
        "order or None, never a synthesised one."
    )


def test_slippage_is_none_when_unmeasurable_rather_than_zero():
    """Reporting 0.0 bps for an unmeasurable slippage gave every trade a
    perfect execution score."""
    from backend.agents.execution_agent import ExecutionAgent

    assert ExecutionAgent._slippage_bps(0.0, 100.0, "buy") is None
    assert ExecutionAgent._slippage_bps(100.0, 0.0, "buy") is None


def test_slippage_sign_is_cost_positive_and_side_aware():
    """A fill above expectation costs a buyer and benefits a seller."""
    # buy filled worse (higher) -> positive cost
    assert ExecutionAgent_slip(100.0, 101.0, "buy") == pytest.approx(100.0)
    # buy filled better (lower) -> negative, i.e. a saving
    assert ExecutionAgent_slip(100.0, 99.0, "buy") == pytest.approx(-100.0)
    # sell filled worse (lower) -> positive cost
    assert ExecutionAgent_slip(100.0, 99.0, "sell") == pytest.approx(100.0)
    # sell filled better (higher) -> negative
    assert ExecutionAgent_slip(100.0, 101.0, "sell") == pytest.approx(-100.0)


def ExecutionAgent_slip(expected, fill, side):
    from backend.agents.execution_agent import ExecutionAgent

    return ExecutionAgent._slippage_bps(expected, fill, side)


# ---------------------------------------------------------------------------
# Fail-closed execution mode
# ---------------------------------------------------------------------------

def test_execution_agent_defaults_to_simulation_when_live_trading_is_off():
    """It used to default to `simulation_mode=False` (live), and main.py
    constructed it with no arguments."""
    from backend.agents.execution_agent import ExecutionAgent, get_execution_agent
    from backend.core.config import settings

    assert settings.LIVE_TRADING is False, (
        "This test assumes LIVE_TRADING is not enabled in the test environment."
    )
    assert ExecutionAgent().simulation_mode is True
    assert get_execution_agent().simulation_mode is True


def test_explicit_simulation_mode_still_wins():
    """The backtest engine passes simulation_mode=True explicitly."""
    from backend.agents.execution_agent import ExecutionAgent

    assert ExecutionAgent(simulation_mode=True).simulation_mode is True
    assert ExecutionAgent(simulation_mode=False).simulation_mode is False


def test_live_trading_flag_is_actually_read_somewhere():
    """LIVE_TRADING existed in Settings but nothing read it, so setting it to
    false changed nothing."""
    import pathlib

    root = pathlib.Path(__file__).resolve().parents[1]
    readers = [
        p
        for p in (root / "backend").rglob("*.py")
        if "LIVE_TRADING" in p.read_text(encoding="utf-8") and p.name != "config.py"
    ]
    assert readers, "settings.LIVE_TRADING is defined but never consumed."
