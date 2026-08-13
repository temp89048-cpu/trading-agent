"""Spec Section 18 — the two portfolio-level controls the CRO could not enforce.

    "Max Correlated Exposure: If Pearson correlation between Asset A and Asset B
     > 0.75 over 30 days, their combined directional exposure cannot exceed
     1.5x the max limit of a single asset."

    "Drawdown Killswitch: If portfolio equity drops 10% from the monthly
     high-water mark, the CRO automatically transitions the system to
     Observation Mode."

Both were named as unimplemented in `agents/cro_agent.py` and are now owned by
the CEO and CIO agents respectively.
"""

import pytest

from backend.agents.ceo_agent import MAX_DRAWDOWN_FROM_HIGH_WATER_MARK, CEOAgent
from backend.agents.cio_agent import (
    CORRELATED_EXPOSURE_MULTIPLIER,
    CORRELATION_THRESHOLD,
    MAX_SINGLE_ASSET_EXPOSURE,
    CIOAgent,
    pearson,
)
from backend.core import system_state
from tests.conftest import make_candles, make_correlated_candles


@pytest.fixture(autouse=True)
def _clean_state():
    system_state.resume("test setup")
    system_state.exit_observation_mode("test setup")
    yield
    system_state.resume("test teardown")
    system_state.exit_observation_mode("test teardown")


@pytest.fixture(autouse=True)
def _stub_klines(monkeypatch):
    """Stub the CIO's candle source for every test in this module.

    Without this, `CIOAgent._returns_for` reaches the real ccxt client, which
    retries with exponential backoff against an unreachable host — turning a
    2-second suite into a multi-minute hang. Defaults to an empty series
    (correlation unmeasurable), which is the conservative branch; tests that
    need real correlation values override it.
    """

    async def no_klines(*_a, **_k):
        return []

    monkeypatch.setattr("backend.agents.cio_agent.fetch_klines", no_klines)


# ---------------------------------------------------------------------------
# Observation mode
# ---------------------------------------------------------------------------

def test_observation_mode_halts_new_entries():
    assert system_state.may_open_new_position() is True
    system_state.enter_observation_mode("test breach")
    assert system_state.may_open_new_position() is False


def test_observation_mode_never_blocks_exits():
    """CLAUDE.md invariant 4 holds for a risk-driven halt too — arguably more
    so, since the operator most needs to exit during a drawdown."""
    system_state.enter_observation_mode("test breach")
    assert system_state.may_close_position() is True


def test_operator_resume_does_not_silently_clear_a_risk_halt():
    """The reason observation_mode is a separate flag from is_paused.

    A routine `resume()` must not clear a drawdown-triggered halt while the
    drawdown that caused it is still in force.
    """
    system_state.enter_observation_mode("drawdown breach")
    system_state.resume("operator clicked resume")
    assert system_state.is_in_observation_mode() is True
    assert system_state.may_open_new_position() is False

    system_state.exit_observation_mode("operator acknowledged")
    assert system_state.may_open_new_position() is True


def test_observation_mode_records_why():
    system_state.enter_observation_mode("equity 12% below HWM")
    assert "12%" in system_state.observation_reason()


# ---------------------------------------------------------------------------
# CEO drawdown killswitch
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_ceo_halts_when_drawdown_exceeds_the_limit(monkeypatch):
    ceo = CEOAgent()

    equities = iter([1000.0, 1000.0, 850.0])  # peak 1000, then -15%

    async def fake_equity(tab):
        return next(equities)

    monkeypatch.setattr(CEOAgent, "_read_equity", staticmethod(fake_equity))

    first = await ceo.evaluate_mandate("seed")
    assert first["halted"] is False
    assert first["highWaterMark"] == 1000.0

    second = await ceo.evaluate_mandate("flat")
    assert second["halted"] is False

    third = await ceo.evaluate_mandate("drawdown")
    assert third["halted"] is True
    assert third["drawdownPct"] == pytest.approx(15.0, abs=0.01)
    assert system_state.is_in_observation_mode() is True
    assert system_state.may_open_new_position() is False


@pytest.mark.asyncio
async def test_ceo_does_not_halt_just_below_the_limit(monkeypatch):
    """Guard against an off-by-one that would halt on every small dip."""
    ceo = CEOAgent()
    equities = iter([1000.0, 1000.0 * (1 - (MAX_DRAWDOWN_FROM_HIGH_WATER_MARK - 0.005))])

    async def fake_equity(tab):
        return next(equities)

    monkeypatch.setattr(CEOAgent, "_read_equity", staticmethod(fake_equity))

    await ceo.evaluate_mandate("seed")
    result = await ceo.evaluate_mandate("dip")
    assert result["halted"] is False
    assert system_state.is_in_observation_mode() is False


@pytest.mark.asyncio
async def test_unknown_equity_is_not_treated_as_a_wiped_out_account(monkeypatch):
    """_equity_for returns 0.0 for "unknown". Reading that as zero equity would
    trip the killswitch on every startup for the real tab, which declares no
    cash figure."""
    ceo = CEOAgent()

    async def no_equity(tab):
        return None

    monkeypatch.setattr(CEOAgent, "_read_equity", staticmethod(no_equity))

    result = await ceo.evaluate_mandate("unknown equity")
    assert result["evaluated"] is False
    assert system_state.is_in_observation_mode() is False


@pytest.mark.asyncio
async def test_unknown_equity_does_not_clear_an_existing_halt(monkeypatch):
    """An unevaluated check is not a passed check."""
    ceo = CEOAgent()
    system_state.enter_observation_mode("earlier breach")

    async def no_equity(tab):
        return None

    monkeypatch.setattr(CEOAgent, "_read_equity", staticmethod(no_equity))
    await ceo.evaluate_mandate("unknown")
    assert system_state.is_in_observation_mode() is True


@pytest.mark.asyncio
async def test_ceo_records_passing_evaluations_too(monkeypatch):
    """A killswitch that only logs on the day it fires gives no way to see how
    close the account has been running."""
    ceo = CEOAgent()

    async def fake_equity(tab):
        return 1000.0

    monkeypatch.setattr(CEOAgent, "_read_equity", staticmethod(fake_equity))
    await ceo.evaluate_mandate("routine")
    explanation = ceo.explain_decision()
    assert explanation["explained"] is True
    assert explanation["decision"] == "continue"
    assert "drawdownPct" in explanation["evidence"]


# ---------------------------------------------------------------------------
# Pearson correlation
# ---------------------------------------------------------------------------

def test_pearson_perfect_positive_and_negative():
    a = [1.0, 2.0, 3.0, 4.0, 5.0]
    assert pearson(a, a) == pytest.approx(1.0)
    assert pearson(a, [-x for x in a]) == pytest.approx(-1.0)


def test_pearson_returns_none_for_a_flat_series():
    """None means "not measured"; 0.0 means "measured, they don't move
    together". Collapsing the two would let an unmeasurable pair read as
    safely uncorrelated."""
    assert pearson([1.0, 1.0, 1.0], [1.0, 2.0, 3.0]) is None
    assert pearson([1.0], [2.0]) is None


# ---------------------------------------------------------------------------
# CIO correlated exposure
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_exposure_allowed_on_an_empty_book(monkeypatch):
    cio = CIOAgent()

    async def empty(*_a, **_k):
        return {"paper": {"cash": 10_000.0, "positions": []}}

    monkeypatch.setattr("backend.agents.cio_agent.get_portfolio", empty)

    result = await cio.check_exposure("BTC/USDT", "buy", proposed_notional=500.0, equity=10_000.0)
    assert result["allowed"] is True
    assert result["max_notional"] == 500.0


@pytest.mark.asyncio
async def test_same_symbol_exposure_is_capped(monkeypatch):
    """Adding to an existing position counts toward the group limit whether or
    not correlation can be measured."""
    cio = CIOAgent()
    equity = 10_000.0
    group_limit = equity * MAX_SINGLE_ASSET_EXPOSURE * CORRELATED_EXPOSURE_MULTIPLIER  # 3000

    async def book(*_a, **_k):
        return {"paper": {"cash": equity, "positions": [
            {"symbol": "BTC/USDT", "qty": 1.0, "avgCost": 2800.0},
        ]}}

    monkeypatch.setattr("backend.agents.cio_agent.get_portfolio", book)

    result = await cio.check_exposure("BTC/USDT", "buy", proposed_notional=1000.0, equity=equity)
    # 2800 held + 1000 proposed = 3800 > 3000 limit -> reduced to 200 headroom
    assert result["max_notional"] == pytest.approx(group_limit - 2800.0)
    assert result["allowed"] is True


@pytest.mark.asyncio
async def test_exposure_declined_when_group_limit_already_reached(monkeypatch):
    cio = CIOAgent()
    equity = 10_000.0

    async def book(*_a, **_k):
        return {"paper": {"cash": equity, "positions": [
            {"symbol": "BTC/USDT", "qty": 1.0, "avgCost": 3000.0},
        ]}}

    monkeypatch.setattr("backend.agents.cio_agent.get_portfolio", book)

    result = await cio.check_exposure("BTC/USDT", "buy", proposed_notional=500.0, equity=equity)
    assert result["allowed"] is False
    assert result["max_notional"] == 0.0


@pytest.mark.asyncio
async def test_unmeasurable_correlation_counts_as_correlated(monkeypatch):
    """Assuming independence you have not measured is how a book that looks
    diversified turns out to be one position in five instruments."""
    cio = CIOAgent()
    equity = 10_000.0

    async def book(*_a, **_k):
        return {"paper": {"cash": equity, "positions": [
            {"symbol": "ETH/USDT", "qty": 1.0, "avgCost": 2900.0},
        ]}}

    async def no_klines(*_a, **_k):
        return []  # correlation unmeasurable for both symbols

    monkeypatch.setattr("backend.agents.cio_agent.get_portfolio", book)
    monkeypatch.setattr("backend.agents.cio_agent.fetch_klines", no_klines)

    result = await cio.check_exposure("BTC/USDT", "buy", proposed_notional=500.0, equity=equity)
    held = [c["symbol"] for c in result["correlated_group"]]
    assert "ETH/USDT" in held, "an unmeasurable pair must be counted as correlated"
    assert result["max_notional"] < 500.0
    assert "unmeasurable" in result["detail"].lower() or "could not be measured" in result["detail"]


@pytest.mark.asyncio
async def test_equity_unknown_declines_rather_than_allowing(monkeypatch):
    cio = CIOAgent()
    result = await cio.check_exposure("BTC/USDT", "buy", proposed_notional=500.0, equity=0.0)
    assert result["allowed"] is False
    assert result["max_notional"] == 0.0


@pytest.mark.asyncio
async def test_highly_correlated_same_direction_exposure_is_capped(monkeypatch):
    """The spec's actual rule, exercised with measurable correlation."""
    cio = CIOAgent()
    equity = 10_000.0

    async def book(*_a, **_k):
        return {"paper": {"cash": equity, "positions": [
            {"symbol": "ETH/USDT", "qty": 1.0, "avgCost": 2900.0},
        ]}}

    async def klines(symbol, *_a, **_k):
        # Both series trend up together -> returns correlate near +1.
        return make_candles() if symbol == "BTC/USDT" else make_correlated_candles(sign=1.0)

    monkeypatch.setattr("backend.agents.cio_agent.get_portfolio", book)
    monkeypatch.setattr("backend.agents.cio_agent.fetch_klines", klines)

    result = await cio.check_exposure("BTC/USDT", "buy", proposed_notional=500.0, equity=equity)
    correlations = [c["correlation"] for c in result["correlated_group"] if c["symbol"] == "ETH/USDT"]
    assert correlations and correlations[0] is not None
    assert correlations[0] > CORRELATION_THRESHOLD
    # 2900 held + 500 proposed = 3400 > 3000 group limit -> reduced.
    assert result["max_notional"] < 500.0


@pytest.mark.asyncio
async def test_opposite_direction_in_a_correlated_pair_is_not_compounded(monkeypatch):
    """A long in one and a short in a highly correlated other is a partial
    hedge, not doubled risk. Counting it as compounding would block legitimate
    hedges."""
    cio = CIOAgent()
    equity = 10_000.0

    async def book(*_a, **_k):
        return {"paper": {"cash": equity, "positions": [
            {"symbol": "ETH/USDT", "qty": 1.0, "avgCost": 2900.0},
        ]}}

    async def klines(symbol, *_a, **_k):
        return make_candles() if symbol == "BTC/USDT" else make_correlated_candles(sign=1.0)

    monkeypatch.setattr("backend.agents.cio_agent.get_portfolio", book)
    monkeypatch.setattr("backend.agents.cio_agent.fetch_klines", klines)

    # Selling BTC against a held long in a positively correlated ETH.
    result = await cio.check_exposure("BTC/USDT", "sell", proposed_notional=500.0, equity=equity)
    held = [c["symbol"] for c in result["correlated_group"]]
    assert "ETH/USDT" not in held, "an opposite-direction correlated position should not compound"
    assert result["allowed"] is True
    assert result["max_notional"] == 500.0


@pytest.mark.asyncio
async def test_uncorrelated_holdings_do_not_consume_the_group_limit(monkeypatch):
    """Guard against over-tightening: independent positions must not be lumped
    into one correlated group."""
    cio = CIOAgent()
    equity = 10_000.0

    async def book(*_a, **_k):
        return {"paper": {"cash": equity, "positions": [
            {"symbol": "ETH/USDT", "qty": 1.0, "avgCost": 2900.0},
        ]}}

    async def klines(symbol, *_a, **_k):
        if symbol == "BTC/USDT":
            return make_candles(drift=0.1)
        # Alternating series: returns flip sign every candle, so correlation
        # with a steady uptrend is near zero rather than unmeasurable.
        out = []
        for i in range(120):
            close = 50.0 + (1.0 if i % 2 else -1.0)
            out.append({"openTime": i * 900_000, "open": close, "high": close + 1,
                        "low": close - 1, "close": close, "volume": 100.0})
        return out

    monkeypatch.setattr("backend.agents.cio_agent.get_portfolio", book)
    monkeypatch.setattr("backend.agents.cio_agent.fetch_klines", klines)

    result = await cio.check_exposure("BTC/USDT", "buy", proposed_notional=500.0, equity=equity)
    assert result["allowed"] is True
    assert result["max_notional"] == 500.0, result["detail"]


def test_thresholds_match_the_spec():
    assert CORRELATION_THRESHOLD == 0.75
    assert CORRELATED_EXPOSURE_MULTIPLIER == 1.5
    assert MAX_DRAWDOWN_FROM_HIGH_WATER_MARK == 0.10
