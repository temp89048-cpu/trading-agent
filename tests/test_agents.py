import pytest
from backend.agents.regime_agent import detect_market_regime
from backend.core.risk_manager import calculate_position_size
from backend.core.knowledge_graph import KnowledgeGraph

def test_regime_detection_insufficient_data():
    klines = [{"close": 100} for _ in range(10)]
    assert detect_market_regime(klines) == "Unknown"

def test_knowledge_graph_implications():
    kg = KnowledgeGraph()
    implications = kg.query_implications("High Funding")
    assert "High Liquidation Risk" in implications
    assert "Lower Position Size" in implications

def test_position_sizing_is_capped_by_available_cash():
    """The cash cap binds here, not the risk budget.

    This test previously asserted `qty == 0.02` from the reasoning
    "risk $20 / ATR 1000 = 0.02 BTC". That was wrong twice over, and the
    assertion was corrected to match the implementation rather than the
    implementation changed to match it:

      1. The stop is 1.5 x ATR (`ATR_STOP_MULTIPLIER`), not 1 x ATR, so the
         risk-based quantity is 20 / 1500 = 0.01333, not 20 / 1000 = 0.02.
      2. `calculate_position_size` then applies a hard cap of 50% of equity
         as notional, which the original expectation ignored entirely.

    Worth understanding rather than just asserting: risking 2% of equity
    behind a stop 2.5% away implies deploying 80% of equity as notional
    (2% / 2.5%). On a $1000 account that is $800, so the 50%-of-cash cap
    binds and reduces the position to $500 = 0.00833 BTC. For tight stops the
    cap will usually be the binding constraint, which is the intended
    behaviour: it stops a very tight stop from justifying an oversized
    position.
    """
    equity = 1000
    price = 60000
    atr = 1000

    qty_by_risk = (equity * 0.02) / (atr * 1.5)   # 0.01333... — risk budget
    qty_by_cash = (equity * 0.5) / price          # 0.00833... — cash cap
    assert qty_by_cash < qty_by_risk, "this test assumes the cash cap is the binding constraint"

    qty = calculate_position_size(equity, price, atr, 0.02)
    assert qty == pytest.approx(qty_by_cash)


def test_position_sizing_respects_the_risk_budget_when_cash_is_ample():
    """Isolates the risk-based branch, which the capped case above hides.

    With a stop far enough away, the risk budget is the binding constraint
    and the position is sized so that hitting the stop costs exactly
    `risk_per_trade` of equity — which is the whole point of the function.
    """
    equity = 100_000
    price = 100.0
    atr = 10.0        # stop distance 15.0, i.e. 15% away
    risk_pct = 0.02

    qty = calculate_position_size(equity, price, atr, risk_pct)

    # Not capped by cash at this equity level.
    assert qty < (equity * 0.5) / price
    # Hitting the stop loses exactly the risk budget.
    loss_at_stop = qty * (atr * 1.5)
    assert loss_at_stop == pytest.approx(equity * risk_pct)


def test_position_sizing_returns_zero_when_atr_is_unavailable():
    """No volatility estimate means no size — not an unbounded one."""
    assert calculate_position_size(1000, 60000, 0.0, 0.02) == 0.0
    assert calculate_position_size(1000, 0.0, 1000, 0.02) == 0.0
