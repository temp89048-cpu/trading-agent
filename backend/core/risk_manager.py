from typing import Dict, Any, List, Optional
from pydantic import BaseModel
import logging

from backend.algorithms.risk import half_kelly_criterion, volatility_adjusted_size

logger = logging.getLogger(__name__)

class RiskCheck(BaseModel):
    status: str  # 'pass', 'warn', 'reject'
    detail: str

class RiskValidation(BaseModel):
    approved: bool
    rejection_reasons: List[str]
    caution_notes: List[str]
    checks: Dict[str, RiskCheck]
    stop_loss_take_profit: Optional[Dict[str, float]] = None

def calculate_atr(klines: List[Dict[str, Any]], period: int = 14) -> float:
    """Calculates Average True Range for volatility measurement."""
    if len(klines) < period + 1:
        return 0.0
        
    true_ranges = []
    for i in range(1, len(klines)):
        current_high = klines[i]["high"]
        current_low = klines[i]["low"]
        prev_close = klines[i-1]["close"]
        
        tr1 = current_high - current_low
        tr2 = abs(current_high - prev_close)
        tr3 = abs(current_low - prev_close)
        
        true_ranges.append(max(tr1, tr2, tr3))
        
    # Simple moving average of TR
    recent_trs = true_ranges[-period:]
    return sum(recent_trs) / len(recent_trs) if recent_trs else 0.0

def calculate_position_size(equity: float, price: float, atr: float, risk_per_trade_percent: float = 0.02) -> float:
    """
    Volatility-Based Sizing Agent:
    Calculates the exact quantity to buy so that if the Stop Loss (1.5 * ATR) is hit,
    the account only loses `risk_per_trade_percent` of total equity.
    """
    if atr <= 0 or price <= 0:
        return 0.0

    # Delegates the risk-per-unit arithmetic to
    # `algorithms/risk.volatility_adjusted_size` instead of repeating it. Both
    # functions existed and computed the same thing independently — the library
    # one had no callers at all (spec Section 20: "never duplicate logic").
    stop_loss = price - (atr * ATR_STOP_MULTIPLIER)
    qty = volatility_adjusted_size(
        equity=equity,
        risk_fraction=risk_per_trade_percent,
        entry_price=price,
        stop_loss=stop_loss,
    )

    # Sanity check: don't allow buying more than 50% of buying power in a single trade
    max_qty_by_cash = (equity * 0.5) / price

    return min(qty, max_qty_by_cash)


def kelly_risk_fraction(
    win_prob: Optional[float],
    payoff_ratio: float = 2.0,
    fallback: float = 0.02,
) -> Dict[str, Any]:
    """Risk fraction from half-Kelly, or the fixed-fractional fallback.

    Spec Section 10 requires the Kelly Criterion, specifically *"fractional /
    half-Kelly, not full Kelly — full Kelly is too aggressive for uncertain
    probability estimates."* `algorithms/risk.half_kelly_criterion` implemented
    exactly that and had **zero callers** anywhere in the backend, so sizing was
    purely fixed-fractional and the required algorithm was dead code.

    Returns a dict rather than a bare float so the caller can log WHICH sizing
    rule applied. A position sized at 2% because Kelly said so and one sized at
    2% because Kelly was unavailable are different decisions with the same
    number, and an explainability record that cannot tell them apart is not
    much of a record.

    Half-Kelly is used, never full, and the result is additionally capped at the
    fixed-fractional default. Kelly assumes the win probability is *known*; ours
    is estimated from a modest sample, and Kelly's sizing is famously brutal
    when the estimate is optimistic — a 60%-win-rate estimate that is really 50%
    turns a growth-optimal bet into a slow ruin. Capping at the conservative
    fixed fraction means Kelly can only ever make us size DOWN, never up.
    """
    if win_prob is None or not (0.0 < win_prob < 1.0):
        return {
            "fraction": fallback,
            "rule": "fixed-fractional",
            "detail": (
                f"No usable win-probability estimate ({win_prob!r}), so the fixed "
                f"{fallback * 100:.1f}% risk fraction applies. Kelly was not used."
            ),
        }

    kelly_half = half_kelly_criterion(win_prob, payoff_ratio)

    if kelly_half <= 0:
        # Kelly says this edge is negative — the honest size is zero.
        return {
            "fraction": 0.0,
            "rule": "kelly-negative-edge",
            "detail": (
                f"Half-Kelly is {kelly_half:.4f} at a {win_prob * 100:.1f}% win rate and "
                f"{payoff_ratio:.1f}:1 payoff — the edge is negative, so the correct size is zero."
            ),
        }

    # Capped downward only, never upward.
    chosen = min(kelly_half, fallback)
    return {
        "fraction": chosen,
        "rule": "half-kelly" if chosen < fallback else "fixed-fractional (kelly capped)",
        "detail": (
            f"Half-Kelly {kelly_half * 100:.2f}% at a {win_prob * 100:.1f}% win rate and "
            f"{payoff_ratio:.1f}:1 payoff; capped at the {fallback * 100:.1f}% fixed fraction, "
            f"so risking {chosen * 100:.2f}%."
        ),
    }

ATR_STOP_MULTIPLIER = 1.5
ATR_TARGET_MULTIPLIER = 3.0


def compute_stop_loss_take_profit(price: float, atr: float, side: str) -> Optional[Dict[str, float]]:
    """Volatility-based stop and target. Returns None when ATR is unavailable.

    SL = 1.5 ATR, TP = 3.0 ATR (1:2 risk/reward).

    WHY None INSTEAD OF A 1% FALLBACK
    ---------------------------------
    This used to do `if atr == 0: atr = price * 0.01` — inventing a 1%
    volatility estimate whenever the real one couldn't be computed (too few
    candles, a stale feed, a symbol with no history). That silently produced
    a confident-looking stop derived from a number nobody measured. On a
    quiet pair 1% is a mile away; on a volatile one it is inside the noise
    and gets taken out immediately. Either way the position's actual risk
    was not what the stop implied, and the caller had no way to tell.

    CLAUDE.md invariant 3 requires that a position with no computable stop is
    *rejected*, not given a guessed one, and invariant 6 forbids inventing
    indicator values. Returning None makes the caller handle the real
    situation: there is not enough data to size this trade's risk, so it
    must not be taken.
    """
    if atr <= 0 or price <= 0:
        return None

    if side == 'buy':
        return {
            "stopLoss": price - (atr * ATR_STOP_MULTIPLIER),
            "takeProfit": price + (atr * ATR_TARGET_MULTIPLIER),
        }
    return {
        "stopLoss": price + (atr * ATR_STOP_MULTIPLIER),
        "takeProfit": price - (atr * ATR_TARGET_MULTIPLIER),
    }

# ---------------------------------------------------------------------------
# The leverage ceiling.
#
# These are deliberately MODULE CONSTANTS, not fields on a config object or
# a request dict. They mirror lib/riskManager.ts's ABSOLUTE_MAX_LEVERAGE and
# exist for the same reason (CLAUDE.md invariant 2): if the ceiling lived in
# configuration, then a setting, an agent, or a high-confidence signal could
# raise it, and the one limit that must hold unconditionally would be exactly
# the one that bends under pressure. A leveraged futures position can be
# liquidated by a single-digit-percent adverse move, so this is enforced
# mechanically rather than left to judgment.
#
# Do NOT move these into Settings, a RiskConfig, or a database column.
#
# The values match the TypeScript side on purpose. Two different ceilings for
# the same account (the CRO agent previously used a bare `> 5` check) means
# the effective limit depends on which code path a trade happens to take.
# ---------------------------------------------------------------------------
ABSOLUTE_MAX_LEVERAGE = 3        # real money
ABSOLUTE_MAX_LEVERAGE_PAPER = 10  # paper trading


def max_leverage_ceiling(tab: str) -> int:
    """The hard ceiling for a tab. Anything not explicitly 'paper' is treated
    as real — an unrecognized tab must not get the more permissive limit."""
    return ABSOLUTE_MAX_LEVERAGE_PAPER if tab == "paper" else ABSOLUTE_MAX_LEVERAGE


def check_leverage(requested_leverage: float, tab: str = "real") -> RiskCheck:
    """Ceiling check. Runs before any stop-distance math, so a very tight
    stop cannot compute its way past the ceiling."""
    ceiling = max_leverage_ceiling(tab)
    if requested_leverage > ceiling:
        return RiskCheck(
            status="reject",
            detail=(
                f"{requested_leverage}x exceeds the hard {ceiling}x leverage ceiling "
                f"for the '{tab}' tab. This ceiling is not operator-configurable and "
                f"cannot be raised by any agent or confidence level."
            ),
        )
    return RiskCheck(status="pass", detail=f"{requested_leverage}x is within the {ceiling}x ceiling")


def validate_trade(request: Dict[str, Any]) -> RiskValidation:
    """
    Risk Manager Agent: Evaluates a trade against the central risk rules.

    A missing input is a REJECTION, not a skipped check. Previously, if
    `klines` was empty the ATR came out as 0, which made both the
    stop-exposure check and the liquidity check quietly not run — and since
    approval was `len(reasons) == 0`, a trade with no market data at all was
    approved with two of its three risk checks silently absent. Absence of
    evidence was being read as evidence of safety. Each check below now
    records an explicit 'reject' when it cannot be evaluated.
    """
    reasons: List[str] = []
    caution: List[str] = []
    checks: Dict[str, RiskCheck] = {}

    qty = request.get("qty", 0)
    price = request.get("price", 0)
    equity = request.get("equityUsd", 0)
    klines = request.get("klines", [])
    tab = request.get("tab", "real")
    requested_leverage = request.get("requestedLeverage", 1) or 1

    # Calculate Risk Metrics
    atr = calculate_atr(klines) if klines else 0.0
    trade_value = qty * price
    sltp = compute_stop_loss_take_profit(price, atr, request.get("side", "buy"))

    # 0. Leverage ceiling — checked FIRST and independently of everything
    #    else, so no other input can influence it.
    checks["Leverage"] = check_leverage(requested_leverage, tab)
    if checks["Leverage"].status == "reject":
        reasons.append(checks["Leverage"].detail)

    # 1. Mandatory stop-loss (CLAUDE.md invariant 3). No computable stop =>
    #    no trade. This is the check whose absence let a stopless position
    #    through before.
    if sltp is None:
        checks["MandatoryStopLoss"] = RiskCheck(
            status="reject",
            detail=(
                f"No stop-loss could be computed: ATR is unavailable "
                f"({len(klines)} candle(s) supplied, need at least 15). A position "
                f"without a computed stop is rejected rather than opened with a "
                f"guessed one."
            ),
        )
        reasons.append("No stop-loss could be computed (insufficient candle history)")
    else:
        checks["MandatoryStopLoss"] = RiskCheck(
            status="pass",
            detail=f"Stop at {sltp['stopLoss']:.6g}, target at {sltp['takeProfit']:.6g}",
        )

    # 2. Position Size Check
    if equity <= 0:
        checks["PositionSize"] = RiskCheck(
            status="reject",
            detail="Equity is unknown (<= 0), so position size cannot be checked against it.",
        )
        reasons.append("Equity unknown — position size cannot be validated")
    elif trade_value > equity * 0.5:
        checks["PositionSize"] = RiskCheck(status="reject", detail="Position size exceeds 50% of equity (Max Exposure breached)")
        reasons.append("Position size exceeds 50% of equity")
    else:
        checks["PositionSize"] = RiskCheck(status="pass", detail="Position size acceptable")

    # 3. Drawdown / stop-loss exposure. Only meaningful once a stop exists.
    if sltp is not None and qty > 0 and equity > 0:
        sl_distance = abs(price - sltp["stopLoss"])
        potential_loss = sl_distance * qty
        loss_percent = (potential_loss / equity) * 100

        if loss_percent > 3.0:  # Hard limit: never risk more than 3% on one trade
            checks["DrawdownExposure"] = RiskCheck(status="reject", detail=f"Potential loss ({loss_percent:.2f}%) exceeds 3% hard limit")
            reasons.append(f"Trade SL exposure is too high ({loss_percent:.2f}%)")
        else:
            checks["DrawdownExposure"] = RiskCheck(status="pass", detail=f"Risk exposure acceptable ({loss_percent:.2f}%)")
    else:
        checks["DrawdownExposure"] = RiskCheck(
            status="reject",
            detail="Cannot compute stop-loss exposure without a stop, a quantity, and known equity.",
        )
        if "No stop-loss could be computed (insufficient candle history)" not in reasons:
            reasons.append("Stop-loss exposure could not be computed")

    # 4. Liquidity
    if not klines:
        checks["Liquidity"] = RiskCheck(
            status="reject",
            detail="No candle data supplied, so liquidity cannot be assessed.",
        )
        reasons.append("Liquidity could not be assessed (no candle data)")
    else:
        recent = klines[-5:]
        avg_volume = sum(k.get("volume", 0) for k in recent) / len(recent)
        if avg_volume < 10:  # Extremely low volume
            checks["Liquidity"] = RiskCheck(status="reject", detail="Volume too low, slippage risk high")
            reasons.append("Low liquidity")
        else:
            checks["Liquidity"] = RiskCheck(status="pass", detail="Liquidity acceptable")

    return RiskValidation(
        approved=len(reasons) == 0,
        # Deduped: several checks can fail for the same root cause (no
        # candles => no ATR => no stop => no exposure figure), and repeating
        # one reason three times makes the rejection look broader than it is.
        rejection_reasons=list(dict.fromkeys(reasons)),
        caution_notes=caution,
        checks=checks,
        stop_loss_take_profit=sltp,
    )
