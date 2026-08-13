import numpy as np

def half_kelly_criterion(win_prob: float, payoff_ratio: float) -> float:
    """
    Calculates the Half-Kelly criterion for position sizing.
    win_prob: Estimated probability of success (0.0 to 1.0)
    payoff_ratio: Expected reward / risk ratio (e.g. 2.0 for risking $1 to make $2)
    Returns fraction of portfolio to risk (capped at 0.25 max for safety).
    """
    if win_prob <= 0 or payoff_ratio <= 0:
        return 0.0
    
    # Kelly % = W - [(1 - W) / R]
    kelly = win_prob - ((1.0 - win_prob) / payoff_ratio)
    
    if kelly <= 0:
        return 0.0
        
    half_kelly = kelly / 2.0
    
    # Hard safety cap
    return min(half_kelly, 0.25)

def volatility_adjusted_size(equity: float, risk_fraction: float, entry_price: float, stop_loss: float) -> float:
    """
    Calculates absolute position size based on distance to stop loss.
    """
    risk_amount = equity * risk_fraction
    price_risk = abs(entry_price - stop_loss)
    
    if price_risk == 0:
        return 0.0
        
    position_size = risk_amount / price_risk
    return position_size

# Ruin threshold: 20% of starting equity remaining.
#
# Not 50%. An account down 80% needs a 5x return to recover and is finished in
# practice, but stopping the simulation at 50% overstates ruin — a 50%
# drawdown is survivable and recoverable. Using one shared constant also stops
# two callers disagreeing about what "ruin" means, which is what happened when
# `agents/simulation_agent.py` wrote its own simulation using 0.2 while this
# function used 0.5.
RUIN_EQUITY_FRACTION = 0.20

# Fixed seed. A stress test that returns a different verdict on a re-run of
# identical inputs cannot be audited, reproduced in a backtest, or used as a
# gate — "it passed last time" becomes untestable. The previous version called
# `np.random.normal` with no seed, so the same trade could pass or fail
# depending on the draw.
DEFAULT_SEED = 20240813


def monte_carlo_simulation(
    returns: list[float],
    num_simulations: int = 1000,
    periods: int = 100,
    seed: int = DEFAULT_SEED,
) -> dict:
    """Monte Carlo over historical returns: probability of ruin and expected
    maximum drawdown.

    Returns `available: False` when there is no return history rather than
    `prob_of_ruin: 0.0`. The old behaviour claimed a zero probability of ruin
    for a strategy it had no data about — the most dangerous possible default,
    because a caller gating on `prob_of_ruin <= threshold` would pass every
    untested strategy.

    Key names are also now consistent. The empty path returned `max_drawdown`
    while the success path returned `expected_max_drawdown`, so any caller
    reading the latter hit a KeyError exactly when data was missing.
    """
    if not returns:
        return {
            "available": False,
            "reason": "no return history supplied — probability of ruin is unknown, not zero",
            "prob_of_ruin": None,
            "expected_max_drawdown": None,
        }

    returns_arr = np.array(returns, dtype=float)
    mean = float(np.mean(returns_arr))
    std = float(np.std(returns_arr))

    if std == 0:
        # A constant return series has no distribution to sample. Reported
        # rather than simulated, since np.random.normal with std=0 would
        # produce a single deterministic path and present it as a distribution.
        return {
            "available": False,
            "reason": f"all {len(returns)} returns are identical ({mean}); no variance to simulate",
            "prob_of_ruin": None,
            "expected_max_drawdown": None,
        }

    rng = np.random.default_rng(seed)
    simulated_paths = rng.normal(mean, std, (num_simulations, periods))

    # Cumulative equity per path, starting from 1.0
    cumulative_returns = np.cumprod(1 + simulated_paths, axis=1)

    ruined_paths = np.any(cumulative_returns < RUIN_EQUITY_FRACTION, axis=1)
    prob_of_ruin = float(np.mean(ruined_paths))

    peak = np.maximum.accumulate(cumulative_returns, axis=1)
    drawdowns = (peak - cumulative_returns) / peak
    expected_max_drawdown = float(np.mean(np.max(drawdowns, axis=1)))
    worst_max_drawdown = float(np.max(drawdowns))

    return {
        "available": True,
        "prob_of_ruin": prob_of_ruin,
        "expected_max_drawdown": expected_max_drawdown,
        # The average worst-case understates the tail. Both are reported so a
        # caller can gate on whichever is appropriate.
        "worst_max_drawdown": worst_max_drawdown,
        "simulations": num_simulations,
        "periods": periods,
        "ruin_threshold": RUIN_EQUITY_FRACTION,
        "seed": seed,
    }


def monte_carlo_trade_sequence(
    risk_fraction: float,
    win_prob: float = 0.5,
    payoff_ratio: float = 2.0,
    num_simulations: int = 2000,
    trades_per_simulation: int = 200,
    seed: int = DEFAULT_SEED,
) -> dict:
    """Monte Carlo over a sequence of win/loss outcomes rather than a return series.

    This is the shape a pre-trade stress test needs: it has a risk fraction, an
    estimated win rate and a payoff ratio, but no historical return series for
    a position that hasn't been taken yet.

    Added here rather than left in `agents/simulation_agent.py`, which had
    written its own copy — spec Section 20's engineering principles say "never
    duplicate logic", and two independent ruin simulations will eventually
    disagree about whether the same strategy is survivable.

    Defaults are deliberately unflattering: 50% win rate at 2:1 is roughly what
    the 1.5-ATR stop / 3.0-ATR target in `core/risk_manager` implies BEFORE
    costs. Assuming any edge beyond that would make the stress test
    rubber-stamp the strategy it exists to test.
    """
    if risk_fraction <= 0 or not (0.0 < win_prob < 1.0) or payoff_ratio <= 0:
        return {
            "available": False,
            "reason": (
                f"invalid inputs (risk_fraction={risk_fraction}, win_prob={win_prob}, "
                f"payoff_ratio={payoff_ratio})"
            ),
            "prob_of_ruin": None,
            "expected_max_drawdown": None,
        }

    rng = np.random.default_rng(seed)
    # Vectorised: draw all outcomes at once rather than looping in Python.
    wins = rng.random((num_simulations, trades_per_simulation)) < win_prob
    step = np.where(wins, 1.0 + risk_fraction * payoff_ratio, 1.0 - risk_fraction)
    equity = np.cumprod(step, axis=1)

    ruined = np.any(equity < RUIN_EQUITY_FRACTION, axis=1)
    prob_of_ruin = float(np.mean(ruined))

    peak = np.maximum.accumulate(equity, axis=1)
    drawdowns = (peak - equity) / peak
    expected_max_drawdown = float(np.mean(np.max(drawdowns, axis=1)))
    worst_max_drawdown = float(np.max(drawdowns))

    return {
        "available": True,
        "prob_of_ruin": prob_of_ruin,
        "expected_max_drawdown": expected_max_drawdown,
        "worst_max_drawdown": worst_max_drawdown,
        "simulations": num_simulations,
        "trades_per_simulation": trades_per_simulation,
        "risk_fraction": risk_fraction,
        "assumed_win_rate": win_prob,
        "assumed_payoff_ratio": payoff_ratio,
        "ruin_threshold": RUIN_EQUITY_FRACTION,
        "seed": seed,
    }
