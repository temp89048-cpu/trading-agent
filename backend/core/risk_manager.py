from typing import Dict, Any, List, Optional
from pydantic import BaseModel
import logging

from backend.algorithms.risk import half_kelly_criterion, volatility_adjusted_size

logger = logging.getLogger(__name__)

class RiskCheck(BaseModel):
    # 'pass' | 'warn' | 'reject' | 'unavailable' | 'delegated'
    #
    # The last two were added in Phase 28 and NEITHER is the same as 'pass'. A check
    # that did not run must be distinguishable from one that ran and passed, because
    # the failure mode this module's docstring warns about is absence of evidence
    # being read as evidence of safety.
    #
    # They are separate statuses because they mean different things and imply
    # different fixes:
    #
    #   'unavailable' — an INPUT WAS NOT SUPPLIED. The check could run if the caller
    #                   passed the data. In `strict` mode this REJECTS, because a
    #                   caller that has the data and did not pass it is a bug.
    #
    #   'delegated'   — the check is STRUCTURALLY not computable here and a NAMED
    #                   component owns it, which has not objected. No caller can fix
    #                   this by passing more data: a per-request function has no
    #                   memory of a previous equity peak, and measuring cross-asset
    #                   correlation needs 180 candles per held symbol. Strict mode
    #                   reports it and does NOT reject.
    #
    # Collapsing the two was the first version of this, and it made strict mode
    # reject EVERY trade — `MaxDrawdown` is always structurally unmeasurable, so the
    # graph's gateway could never approve anything. Strict mode has to bite on
    # caller omissions without biting on facts about the architecture.
    status: str
    detail: str


# Statuses that never block. 'delegated' is here and 'unavailable' deliberately is
# not — see RiskCheck.
NON_BLOCKING_STATUSES = ("pass", "warn", "delegated")


# ---------------------------------------------------------------------------
# Portfolio-level limits (spec Section 11 / Phase 28).
#
# These are module constants for the same reason as the leverage ceiling: a limit
# that lives in configuration is a limit that a setting, an agent or a confident
# signal can raise, and these are the ones that must hold when the system is
# most convinced it should keep going.
#
# They are NOT tuned numbers. Each is derived from a limit that already existed,
# so the set stays internally consistent rather than nine independently-chosen
# thresholds that can contradict each other.
# ---------------------------------------------------------------------------

# One trade may risk at most 3% of equity (the existing per-trade limit below).
# 5% daily therefore allows one full stop-out plus part of a second before the
# day is over. Set ABOVE the per-trade limit deliberately: at or below it, a
# single losing trade taken within the rules would halt trading, which would make
# the per-trade limit unusable in practice.
MAX_DAILY_LOSS_PCT = 5.0

# One position may be at most 50% of equity in notional (the PositionSize check).
# 100% total is the direct generalisation — two maximum-size positions. Expressed
# in notional rather than margin so leverage cannot hide exposure: at 3x, 100%
# notional is only 33% of equity in margin, and a limit stated in margin would
# silently permit three times the market exposure.
MAX_PORTFOLIO_EXPOSURE_PCT = 100.0

# Required margin must be covered with room to spare. Using the last available
# dollar of margin means any adverse tick triggers a margin call before the
# stop-loss is reached — the position would be liquidated at the exchange's price
# rather than exited at ours, which makes the computed stop meaningless.
MARGIN_BUFFER_MULTIPLIER = 1.2

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


def calculate_dynamic_risk(
    base_risk: float, 
    regime_multiplier: float, 
    expected_value: float,
    max_risk: float = 0.05
) -> float:
    """
    Phase 40: Position Sizing AI
    Calculates the final risk fraction by scaling the base risk using the market regime 
    safety multiplier and the trade's expected value.
    """
    # EV Multiplier Scaling Curve
    if expected_value <= 0:
        ev_multiplier = 0.0
    elif expected_value <= 0.5:
        ev_multiplier = 0.5
    elif expected_value <= 1.0:
        ev_multiplier = 1.0
    elif expected_value <= 2.0:
        ev_multiplier = 1.25
    else:
        ev_multiplier = 1.5
        
    final_risk = base_risk * regime_multiplier * ev_multiplier
    
    # Cap the final risk to avoid over-leveraging
    return min(final_risk, max_risk)

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


# ---------------------------------------------------------------------------
# The five checks spec Section 11 names that this gateway did not have.
#
# Each is a standalone function so it can be unit-tested against its own inputs
# and so `validate_trade` reads as the list of checks the spec draws rather than
# as one long function where a check could be lost in a merge.
# ---------------------------------------------------------------------------

def check_kill_switch() -> RiskCheck:
    """Spec Section 11's "Kill Switch". Governance, not arithmetic.

    Reads `system_state`'s predicates rather than its snapshot dict, because a
    misspelled predicate is an ImportError while a misspelled dict key is a
    confident wrong answer — that exact bug shipped once in the Phase 26 risk
    specialist and reported "no governance block active" while the system was
    paused.

    Note this gates OPENING only. `validate_trade` short-circuits closes before
    reaching any check, because CLAUDE.md invariant 4 says an exit is never
    blocked — including by a kill switch, which is the case where it matters most.
    """
    from backend.core import system_state

    if system_state.is_emergency_stopped():
        return RiskCheck(
            status="reject",
            detail=(
                "EMERGENCY STOP is active. No new position may be opened. "
                "(Closing an existing position remains permitted and is not "
                "routed through this check.)"
            ),
        )
    if system_state.is_system_paused():
        return RiskCheck(
            status="reject",
            detail="System is PAUSED by the operator. No new position may be opened.",
        )
    if system_state.is_in_observation_mode():
        return RiskCheck(
            status="reject",
            detail=(
                f"System is in OBSERVATION MODE: {system_state.observation_reason()}. "
                f"Clearing it requires an explicit operator acknowledgement."
            ),
        )
    return RiskCheck(
        status="pass",
        detail="No governance block active (not paused, emergency-stopped or observing)",
    )


def check_max_drawdown() -> RiskCheck:
    """Spec Section 11's "Max Drawdown Check".

    The numeric drawdown from the high-water mark is owned by `CEOAgent`, which
    tracks the HWM across runs and enters observation mode when the 10% mandate is
    breached. A per-request function has no memory of a previous peak and cannot
    recompute it, so this check reads the CEO's VERDICT rather than inventing a
    second, differently-timed answer to the same question.

    Reported as 'delegated' rather than 'pass' when nothing has fired, because "the
    mandate has not tripped" is genuinely weaker than "drawdown was measured and is
    within limits" — the CEO only evaluates on its own schedule.

    'delegated' and not 'unavailable': no caller can fix this by passing more data,
    because a per-request function has no memory of a previous equity peak. Marking
    it 'unavailable' made strict mode reject every trade, since this check is
    ALWAYS unmeasurable here.
    """
    from backend.core import system_state

    if system_state.is_in_observation_mode():
        return RiskCheck(
            status="reject",
            detail=(
                f"The CEO's drawdown mandate has already fired: "
                f"{system_state.observation_reason()}"
            ),
        )
    return RiskCheck(
        status="delegated",
        detail=(
            "Drawdown from the high-water mark is tracked by the CEO agent, which has "
            "not fired its mandate. This is NOT a measurement of current drawdown — "
            "no HWM is reachable from a per-request check, so this is an absence of "
            "objection rather than a clean reading."
        ),
    )


def check_daily_loss(equity: float, ledger: Optional[List[Dict[str, Any]]]) -> RiskCheck:
    """Spec Section 11's "Daily Loss Check".

    Sums realised P&L from today's ledger entries. `ai_memory`'s trade ledger
    records an ISO-8601 UTC `timestamp` and a `pnl` per closed trade, so this is
    genuinely measurable rather than approximated.

    Compares date PREFIXES rather than parsing, because the ledger writes naive
    UTC isoformat strings and constructing tz-aware datetimes to compare against
    them would introduce an offset bug in the one check whose job is to stop a bad
    day getting worse.
    """
    if ledger is None:
        return RiskCheck(
            status="unavailable",
            detail="No trade ledger supplied, so today's realised loss is unknown.",
        )
    if equity <= 0:
        return RiskCheck(
            status="unavailable",
            detail="Equity is unknown, so a daily loss cannot be expressed as a percentage.",
        )

    import datetime

    today = datetime.datetime.now(datetime.timezone.utc).date().isoformat()
    todays = [
        entry for entry in ledger
        if str(entry.get("timestamp", ""))[:10] == today
    ]
    if not todays:
        return RiskCheck(
            status="pass",
            detail=f"No trades closed today ({today}), so no realised loss.",
        )

    realised = 0.0
    for entry in todays:
        try:
            realised += float(entry["pnl"])
        except (KeyError, TypeError, ValueError):
            continue

    loss_pct = (-realised / equity) * 100.0 if realised < 0 else 0.0

    if loss_pct > MAX_DAILY_LOSS_PCT:
        return RiskCheck(
            status="reject",
            detail=(
                f"Today's realised loss is ${-realised:,.2f} ({loss_pct:.2f}% of "
                f"${equity:,.2f} equity), exceeding the {MAX_DAILY_LOSS_PCT}% daily "
                f"limit across {len(todays)} closed trade(s). Stop for the day."
            ),
        )

    detail = (
        f"Today's realised P&L is ${realised:+,.2f} across {len(todays)} closed "
        f"trade(s)"
    )
    if loss_pct > MAX_DAILY_LOSS_PCT * 0.6:
        return RiskCheck(
            status="warn",
            detail=f"{detail} — {loss_pct:.2f}% of equity, approaching the "
                   f"{MAX_DAILY_LOSS_PCT}% daily limit.",
        )
    return RiskCheck(status="pass", detail=f"{detail}, within the "
                                           f"{MAX_DAILY_LOSS_PCT}% daily limit.")


def check_margin(
    notional: float,
    leverage: float,
    free_margin: Optional[float],
) -> RiskCheck:
    """Spec Section 11's "Margin Check".

    Required margin is notional / leverage, and free margin must cover it with a
    buffer. Without the buffer, any adverse tick triggers a margin call before the
    stop-loss is reached — the position gets liquidated at the exchange's price
    instead of exited at ours, which makes the computed stop meaningless. A stop
    that cannot actually be honoured is worse than no stop, because sizing was
    done against it.
    """
    if free_margin is None:
        return RiskCheck(
            status="unavailable",
            detail=(
                "Free margin is unknown (no cash figure supplied), so margin "
                "sufficiency cannot be checked."
            ),
        )
    if notional <= 0:
        return RiskCheck(
            status="unavailable",
            detail="Notional is zero or unknown, so required margin cannot be computed.",
        )

    lev = leverage if leverage and leverage > 0 else 1.0
    required = notional / lev
    needed = required * MARGIN_BUFFER_MULTIPLIER

    if free_margin < needed:
        return RiskCheck(
            status="reject",
            detail=(
                f"Insufficient margin: ${notional:,.2f} notional at {lev:g}x requires "
                f"${required:,.2f}, and ${needed:,.2f} is needed to keep the "
                f"{MARGIN_BUFFER_MULTIPLIER:g}x buffer that lets the stop-loss be hit "
                f"before a margin call. Only ${free_margin:,.2f} is free."
            ),
        )
    return RiskCheck(
        status="pass",
        detail=(
            f"${required:,.2f} required at {lev:g}x against ${free_margin:,.2f} free "
            f"({free_margin / required:.2f}x cover, {MARGIN_BUFFER_MULTIPLIER:g}x minimum)"
        ),
    )


def check_portfolio_exposure(
    equity: float,
    new_notional: float,
    open_positions: Optional[List[Dict[str, Any]]],
) -> RiskCheck:
    """Spec Section 11's "Exposure Check" — TOTAL, not this trade's.

    Distinct from `PositionSize`, which bounds one trade. The spec lists both
    separately and they genuinely differ: three positions each within the 50%
    single-trade limit are 150% of equity in aggregate, which the single-trade
    check cannot see.

    Existing positions are valued at ENTRY cost, not marked to market. This
    function is not given per-symbol prices and fetching them would be a second
    market-data path that could disagree with the snapshot the decision was made
    on. The detail string says which it is, so a reader is not left to guess.
    """
    if open_positions is None:
        return RiskCheck(
            status="unavailable",
            detail=(
                "Open positions were not supplied, so total portfolio exposure "
                "cannot be computed. This trade's own size was still checked."
            ),
        )
    if equity <= 0:
        return RiskCheck(
            status="unavailable",
            detail="Equity is unknown, so exposure cannot be expressed as a percentage.",
        )

    existing = 0.0
    for pos in open_positions:
        try:
            existing += abs(float(pos["qty"])) * float(pos["avgCost"])
        except (KeyError, TypeError, ValueError):
            continue

    total = existing + max(0.0, new_notional)
    pct = total / equity * 100.0

    if pct > MAX_PORTFOLIO_EXPOSURE_PCT:
        return RiskCheck(
            status="reject",
            detail=(
                f"Total exposure would be ${total:,.2f} ({pct:.1f}% of ${equity:,.2f} "
                f"equity) across {len(open_positions)} existing position(s) plus this "
                f"one, exceeding the {MAX_PORTFOLIO_EXPOSURE_PCT:.0f}% limit. "
                f"Existing positions valued at entry cost, not marked to market."
            ),
        )
    return RiskCheck(
        status="pass",
        detail=(
            f"Total exposure ${total:,.2f} ({pct:.1f}% of equity) is within the "
            f"{MAX_PORTFOLIO_EXPOSURE_PCT:.0f}% limit "
            f"({len(open_positions)} existing position(s) at entry cost)"
        ),
    )


def check_correlation(
    symbol: str,
    open_positions: Optional[List[Dict[str, Any]]],
) -> RiskCheck:
    """Spec Section 11's "Correlation Check".

    SPLIT HONESTLY INTO WHAT CAN AND CANNOT BE MEASURED HERE.

    * Same base asset — fully measurable and enforced. Adding to BTC while already
      holding BTC is concentration, not diversification, and needs no correlation
      matrix to establish.

    * Cross-asset correlation — NOT measured here. `CIOAgent` owns it and computes
      real Pearson correlations from 180 4h candles per held symbol. Doing that
      inside a synchronous risk check would add seconds of network I/O to every
      decision and duplicate a computation that already has an owner.

    The split matters because collapsing it either way is wrong. Reporting 'pass'
    would claim correlation was checked when only concentration was. Reporting
    'reject' whenever it cannot be measured would block every trade the moment a
    second unrelated position existed, which is not a risk position anyone chose.

    So: same-asset concentration rejects, and unmeasured cross-asset correlation
    returns 'delegated' with the CIO named — visible in every assessment, and not
    silently a pass. Not 'unavailable', because no caller can supply a correlation
    matrix to a synchronous function; the fix is a correlation cache the CIO does
    not currently expose, which is a real follow-up rather than a caller omission.
    """
    if open_positions is None:
        return RiskCheck(
            status="unavailable",
            detail="Open positions were not supplied, so correlation cannot be assessed.",
        )

    base = str(symbol).split("/")[0].upper()
    same = [
        p for p in open_positions
        if str(p.get("symbol", "")).split("/")[0].upper() == base
    ]
    others = [p for p in open_positions if p not in same]

    if same:
        return RiskCheck(
            status="reject",
            detail=(
                f"Already holding {len(same)} position(s) in {base}. Adding to the same "
                f"asset concentrates risk rather than diversifying it; close or resize "
                f"the existing exposure first."
            ),
        )

    if not others:
        return RiskCheck(
            status="pass",
            detail=(
                f"No existing {base} exposure and no other positions, so there is no "
                f"correlated exposure to assess."
            ),
        )

    return RiskCheck(
        status="delegated",
        detail=(
            f"No existing {base} exposure, but {len(others)} position(s) in other "
            f"assets could not be checked for correlation here. Cross-asset "
            f"correlation is owned by the CIO agent, which measures real Pearson "
            f"correlations from 4h candles per symbol; a synchronous check cannot do "
            f"that without a cache."
        ),
    )


def validate_trade(request: Dict[str, Any], strict: bool = False) -> RiskValidation:
    """THE risk gateway — spec Section 11's nine checks, in one place.

        "One of the most important phases. Do not make the CRO an LLM-only node —
         use deterministic risk code."
        "An LLM can recommend. Code enforces."

    Every check here is arithmetic or a governance read. Nothing consults a model.

    THE NINE CHECKS, AND WHERE EACH ONE IS
    --------------------------------------
        Max Position     -> `PositionSize`        (this trade vs 50% of equity)
        Max Leverage     -> `Leverage`            (un-overridable module ceiling)
        Max Drawdown     -> `MaxDrawdown`         (the CEO's HWM mandate)
        Margin           -> `Margin`              (required vs free, with buffer)
        Correlation      -> `Correlation`         (same-asset hard, cross-asset honest)
        Daily Loss       -> `DailyLoss`           (today's realised P&L)
        Exposure         -> `PortfolioExposure`   (TOTAL, not this trade)
        Liquidity        -> `Liquidity`           (volume proxy — see its detail)
        Kill Switch      -> `KillSwitch`          (pause / stop / observation)

    Plus `MandatoryStopLoss` and `PerTradeRisk`, which the spec's diagram folds
    into "Max Drawdown" but which are per-trade and needed regardless.

    A MISSING INPUT IS NOT A PASS
    -----------------------------
    Previously, if `klines` was empty the ATR came out as 0, which made both the
    stop-exposure check and the liquidity check quietly not run — and since
    approval was `len(reasons) == 0`, a trade with no market data at all was
    approved with two of its three risk checks silently absent. Absence of evidence
    was being read as evidence of safety.

    Phase 28 keeps that discipline and makes it explicit with a fourth status,
    `'unavailable'`, distinct from `'pass'`. Which of the two it means for approval
    depends on the caller:

    * `strict=False` (default) — an unavailable check is a CAUTION. The existing
      agent callers do not supply a portfolio or a ledger, and rejecting every
      trade they submit would take a working path offline rather than improve it.
      They still gain the four checks that need no extra input: kill switch, daily
      loss, drawdown mandate, and margin whenever cash is known.

    * `strict=True` — an unavailable check REJECTS. Used by the Phase 28 graph
      node, which always has a portfolio snapshot and a ledger. There, a missing
      input is a bug in the graph, not a limitation of the caller, and it must not
      be allowed to look like a pass.

    CLOSES ARE NOT GATED AT ALL
    ---------------------------
    `intent='close'` short-circuits before any check runs. CLAUDE.md invariant 4:
    a close is never blocked — not by pause, not by a risk check, not by a veto.
    Refusing to let someone exit a position they are already in is actively
    harmful, and it is most harmful precisely when a limit has been breached,
    which is exactly when a gateway would otherwise say no.
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
    symbol = request.get("symbol") or ""
    # None (not supplied) is deliberately distinct from [] (supplied and empty):
    # an empty book is a measurement, a missing one is not.
    open_positions = request.get("openPositions")
    ledger = request.get("tradeLedger")
    free_margin = request.get("freeMarginUsd")
    intent = str(request.get("intent") or "open").lower()

    # --- INVARIANT 4: closes bypass the gateway entirely -------------------
    if intent == "close":
        return RiskValidation(
            approved=True,
            rejection_reasons=[],
            caution_notes=[
                "Close request: risk checks were NOT applied. Exits are never "
                "blocked — not by pause, emergency stop, a breached limit or a "
                "veto. Refusing an exit traps the operator in a position, and it "
                "would do so precisely when a limit has already been breached."
            ],
            checks={
                "CloseBypass": RiskCheck(
                    status="pass",
                    detail=(
                        "intent='close' — approved without evaluation per CLAUDE.md "
                        "invariant 4."
                    ),
                )
            },
            stop_loss_take_profit=None,
        )

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

    # 3. Per-trade stop-loss exposure. Only meaningful once a stop exists.
    #
    #    Renamed from `DrawdownExposure` in Phase 28. The old name implied portfolio
    #    drawdown, which this is not and never was — it is the loss THIS trade takes
    #    if its stop is hit. Portfolio drawdown is now a separate `MaxDrawdown`
    #    check, and having two differently-scoped things share one name in a
    #    safety-critical module is how a reviewer concludes a limit is enforced
    #    when a different limit is.
    if sltp is not None and qty > 0 and equity > 0:
        sl_distance = abs(price - sltp["stopLoss"])
        potential_loss = sl_distance * qty
        loss_percent = (potential_loss / equity) * 100

        if loss_percent > 3.0:  # Hard limit: never risk more than 3% on one trade
            checks["PerTradeRisk"] = RiskCheck(status="reject", detail=f"Potential loss ({loss_percent:.2f}%) exceeds 3% hard limit")
            reasons.append(f"Trade SL exposure is too high ({loss_percent:.2f}%)")
        else:
            checks["PerTradeRisk"] = RiskCheck(status="pass", detail=f"Risk exposure acceptable ({loss_percent:.2f}%)")
    else:
        checks["PerTradeRisk"] = RiskCheck(
            status="reject",
            detail="Cannot compute stop-loss exposure without a stop, a quantity, and known equity.",
        )
        if "No stop-loss could be computed (insufficient candle history)" not in reasons:
            reasons.append("Stop-loss exposure could not be computed")

    # 4. Liquidity.
    #
    #    A VOLUME proxy, not order-book depth — this system subscribes no depth
    #    feed, which the Phase 26 liquidity specialist reports as unavailable for
    #    the same reason. Volume cannot bound slippage or fillable size; it only
    #    catches a pair nobody is trading at all. The detail says so rather than
    #    letting "Liquidity: pass" read as "this size is fillable".
    if not klines:
        checks["Liquidity"] = RiskCheck(
            status="reject",
            detail="No candle data supplied, so even the volume proxy cannot be computed.",
        )
        reasons.append("Liquidity could not be assessed (no candle data)")
    else:
        recent = klines[-5:]
        avg_volume = sum(k.get("volume", 0) for k in recent) / len(recent)
        if avg_volume < 10:  # Extremely low volume
            checks["Liquidity"] = RiskCheck(
                status="reject",
                detail=f"5-candle average volume {avg_volume:.2f} is effectively untraded",
            )
            reasons.append("Low liquidity")
        else:
            checks["Liquidity"] = RiskCheck(
                status="pass",
                detail=(
                    f"5-candle average volume {avg_volume:,.0f} — a TRADED-VOLUME "
                    f"proxy only. No order-book depth feed is subscribed, so this "
                    f"does NOT bound slippage or confirm this size is fillable."
                ),
            )

    # --- Phase 28: the five checks spec Section 11 names that were absent ---

    # 5. Kill switch (governance).
    checks["KillSwitch"] = check_kill_switch()

    # 6. Max drawdown (the CEO's HWM mandate).
    checks["MaxDrawdown"] = check_max_drawdown()

    # 7. Daily loss.
    checks["DailyLoss"] = check_daily_loss(equity, ledger)

    # 8. Margin. Falls back to equity as free margin when no cash figure was
    #    supplied, and SAYS SO — on a book with open positions, equity overstates
    #    free margin because some is already locked, so this is the optimistic
    #    direction and must not pass silently.
    notional = qty * price
    if free_margin is None and equity > 0 and not open_positions:
        checks["Margin"] = check_margin(notional, requested_leverage, equity)
        if checks["Margin"].status == "pass":
            checks["Margin"] = RiskCheck(
                status="warn",
                detail=(
                    checks["Margin"].detail
                    + " — free margin was ASSUMED equal to equity (no cash figure "
                      "supplied and no open positions reported)."
                ),
            )
    else:
        checks["Margin"] = check_margin(notional, requested_leverage, free_margin)

    # 9. Total portfolio exposure — distinct from PositionSize, which is this
    #    trade alone.
    checks["PortfolioExposure"] = check_portfolio_exposure(equity, notional, open_positions)

    # 10. Correlation.
    checks["Correlation"] = check_correlation(symbol, open_positions)

    # --- collect ------------------------------------------------------------
    for name, check in checks.items():
        if check.status == "reject" and check.detail not in reasons:
            # The four pre-existing checks already appended their own (shorter)
            # reasons above; this catches the Phase 28 additions without
            # duplicating those.
            if name in ("KillSwitch", "MaxDrawdown", "DailyLoss", "Margin",
                        "PortfolioExposure", "Correlation"):
                reasons.append(f"{name}: {check.detail}")
        elif check.status == "warn":
            caution.append(f"{name}: {check.detail}")
        elif check.status == "delegated":
            # Never blocks, in either mode. Always reported, so an assessment cannot
            # look like nine clean checks when two of them are somebody else's.
            caution.append(f"{name} DELEGATED: {check.detail}")
        elif check.status == "unavailable":
            if strict:
                # A missing input in strict mode is a bug in the caller, not a
                # limitation to tolerate. Rejecting is the only option that does not
                # let an unrun check look like a passed one.
                reasons.append(
                    f"{name} could not be evaluated and strict mode is on: {check.detail}"
                )
            else:
                caution.append(f"{name} NOT EVALUATED: {check.detail}")

    return RiskValidation(
        approved=len(reasons) == 0,
        # Deduped: several checks can fail for the same root cause (no
        # candles => no ATR => no stop => no exposure figure), and repeating
        # one reason three times makes the rejection look broader than it is.
        rejection_reasons=list(dict.fromkeys(reasons)),
        caution_notes=list(dict.fromkeys(caution)),
        checks=checks,
        stop_loss_take_profit=sltp,
    )
