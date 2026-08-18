"""Exchange instrument rules — lot size, tick size, minimum notional.

Phase 29 / spec Section 12. This closes the gap Phase 28's live run exposed:

    plan: buy 367.41575011279235 @ 1x

No exchange accepts that quantity. Binance futures publishes a `stepSize` per
symbol, and an order whose quantity is not a multiple of it is rejected — or, on
some venues, silently truncated. The silent case is the dangerous one: the
position then is not the size the risk checks approved, and every downstream
number (margin, exposure, per-trade risk) describes a position that was never
opened.

WHY ROUNDING IS ALWAYS DOWN
---------------------------
`round_down_to_step` never rounds up, not even when up is nearer. Rounding up
increases the position beyond the size the Risk Gateway approved, which means the
per-trade risk limit was computed against one number and the exchange filled
another. Rounding down can only reduce risk below what was approved, which is
always acceptable.

The consequence is deliberate: a quantity that rounds down to zero, or below the
venue minimum, is a REFUSAL rather than a bumped-up order. Sizing up to reach a
minimum is the exchange dictating risk, which is the wrong way round.

WHY UNAVAILABLE RULES BLOCK REAL MONEY BUT NOT PAPER
----------------------------------------------------
The paper book (`services/portfolio_store`) has no lot size — it stores whatever
quantity it is given, so rounding is meaningless there and its absence harms
nothing.

For real money, not knowing the step size means not knowing whether the order
will be accepted at the size that was approved. So `InstrumentRules.unavailable`
is a hard block on the `real` tab and a no-op on `paper`. That asymmetry is the
point: it fails closed exactly where the consequence is real.

NETWORK
-------
`load_markets()` is a PUBLIC ccxt call — no API key, no private endpoint, so it
works even with `LIVE_TRADING=false` and no credentials. It is cached for the
process lifetime because instrument rules change on the order of months, and
fetching them per order would put a network round-trip on the execution path.
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# Rules change rarely (venue listings, occasional precision changes), so a
# process-lifetime cache is appropriate. Restarting picks up changes.
_cache: Dict[str, "InstrumentRules"] = {}
_markets_loaded = False
_load_failed_reason: Optional[str] = None


@dataclass(frozen=True)
class InstrumentRules:
    """What the venue will accept for one symbol.

    Frozen: these are facts about an exchange, not settings. Code holding a
    reference must not be able to widen what it is allowed to submit.
    """

    symbol: str
    # Quantity must be a multiple of this. None when unknown.
    step_size: Optional[float] = None
    # Smallest acceptable quantity. None when unknown.
    min_qty: Optional[float] = None
    # Price must be a multiple of this. None when unknown.
    tick_size: Optional[float] = None
    # Smallest acceptable quantity x price. None when unknown.
    min_notional: Optional[float] = None
    # Set when the rules could NOT be fetched. A non-None value here means every
    # numeric field above is unknown rather than absent-and-fine.
    unavailable: Optional[str] = None

    @property
    def known(self) -> bool:
        return self.unavailable is None and self.step_size is not None


def round_down_to_step(quantity: float, step: Optional[float]) -> float:
    """Largest multiple of `step` that is <= `quantity`. Never rounds up.

    Returns the quantity unchanged when `step` is None or non-positive — the
    caller is responsible for deciding whether an unknown step is acceptable, and
    silently rounding to a guessed precision here would be worse than not
    rounding at all.
    """
    if not step or step <= 0 or quantity <= 0:
        return quantity

    # Computed via floor on the ratio rather than `quantity - (quantity % step)`,
    # which accumulates float error on small steps (0.001 is common) and can land
    # one step below the correct value.
    steps = math.floor(quantity / step + 1e-9)
    rounded = steps * step

    # Re-quantise to the step's own decimal places. floor(x/step)*step reintroduces
    # binary-float noise — 3 * 0.1 is 0.30000000000000004, and an exchange
    # comparing against its own decimal step rejects that.
    decimals = _decimals_of(step)
    return round(rounded, decimals)


def round_down_to_tick(price: float, tick: Optional[float]) -> float:
    """Price quantised to the venue tick. Same rounding rule and reasoning.

    NOTE for the caller: rounding a STOP price down is only conservative for a
    SHORT. For a long, a lower stop is further away and therefore MORE risk than
    approved. `execution_service` handles the direction; this function only does
    arithmetic, and doing the direction here would hide it.
    """
    return round_down_to_step(price, tick)


def _decimals_of(step: float) -> int:
    """Decimal places implied by a step size. 0.001 -> 3, 1.0 -> 0."""
    text = f"{step:.12f}".rstrip("0")
    if "." not in text:
        return 0
    return len(text.split(".", 1)[1])


async def get_rules(symbol: str) -> InstrumentRules:
    """Instrument rules for one symbol, cached. Never raises.

    Returns an `InstrumentRules` with `unavailable` set on any failure rather than
    propagating — the caller decides what an unknown rule means, and for the paper
    book it means nothing.
    """
    global _markets_loaded, _load_failed_reason

    if symbol in _cache:
        return _cache[symbol]

    if _load_failed_reason is not None:
        # Do not retry per order. A venue that failed once will usually fail again
        # immediately, and retrying would put a timeout on every execution.
        return InstrumentRules(symbol=symbol, unavailable=_load_failed_reason)

    try:
        from backend.services.exchange_client import get_exchange_client

        client = get_exchange_client()
        exchange = client.exchange
        if not _markets_loaded:
            # PUBLIC endpoint: no API key required, so this works with
            # LIVE_TRADING=false and no credentials configured.
            await exchange.load_markets()
            _markets_loaded = True
        market = exchange.market(symbol)
    except Exception as exc:  # noqa: BLE001 - a guessed lot size is worse than none
        _load_failed_reason = f"could not load instrument rules: {exc}"
        logger.warning("Instrument rules unavailable for %s: %s", symbol, exc)
        return InstrumentRules(symbol=symbol, unavailable=_load_failed_reason)

    rules = _from_ccxt_market(symbol, market)
    _cache[symbol] = rules
    logger.info(
        "Instrument rules for %s: step=%s minQty=%s tick=%s minNotional=%s",
        symbol, rules.step_size, rules.min_qty, rules.tick_size, rules.min_notional,
    )
    return rules


def _from_ccxt_market(symbol: str, market: Dict[str, Any]) -> InstrumentRules:
    """Extract what we need from a ccxt market dict.

    ccxt normalises `precision.amount` to either a step size (Binance style) or a
    number of decimal places depending on the venue's `precisionMode`. Both are
    handled: a value < 1 is treated as a step, an integer >= 1 as decimal places.
    Guessing wrong in either direction produces a quantity the venue rejects, so
    both readings are supported rather than assuming Binance's.
    """
    precision = market.get("precision") or {}
    limits = market.get("limits") or {}

    step = _as_step(precision.get("amount"))
    tick = _as_step(precision.get("price"))

    amount_limits = limits.get("amount") or {}
    cost_limits = limits.get("cost") or {}

    min_qty = _as_float(amount_limits.get("min"))
    min_notional = _as_float(cost_limits.get("min"))

    # Binance publishes stepSize under limits.amount.min for some symbols where
    # precision.amount is a decimal count. Falling back keeps a usable step rather
    # than reporting the rules as unknown when one of the two forms is present.
    if step is None and min_qty is not None:
        step = min_qty

    if step is None:
        return InstrumentRules(
            symbol=symbol,
            min_qty=min_qty,
            tick_size=tick,
            min_notional=min_notional,
            unavailable=(
                "the venue published no amount precision or minimum for this symbol, "
                "so a valid quantity cannot be computed"
            ),
        )

    return InstrumentRules(
        symbol=symbol,
        step_size=step,
        min_qty=min_qty,
        tick_size=tick,
        min_notional=min_notional,
    )


def _as_step(value: Any) -> Optional[float]:
    """Interpret a ccxt precision value as a step size."""
    number = _as_float(value)
    if number is None or number <= 0:
        return None
    if number >= 1 and float(number).is_integer():
        # A decimal-places count (precisionMode = DECIMAL_PLACES). 3 -> 0.001.
        return 10.0 ** -int(number)
    return number


def _as_float(value: Any) -> Optional[float]:
    try:
        if value is None:
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


def quantise_quantity(
    quantity: float, rules: InstrumentRules, price: Optional[float] = None
) -> Tuple[Optional[float], str]:
    """Round a quantity to a submittable value, or refuse.

    Returns `(quantity, note)` where a None quantity means REFUSE and the note says
    why. The note is always populated, including on success, because "367.4157 was
    submitted as 367.415" is information an audit record needs.
    """
    if not rules.known:
        return quantity, (
            f"quantity NOT quantised: {rules.unavailable}. Safe on the paper book, "
            f"which has no lot size; the caller must block real money."
        )

    rounded = round_down_to_step(quantity, rules.step_size)

    if rounded <= 0:
        return None, (
            f"quantity {quantity:.10g} rounds DOWN to 0 at step {rules.step_size:g}. "
            f"Refusing rather than rounding up, which would exceed the approved size."
        )

    if rules.min_qty is not None and rounded < rules.min_qty:
        return None, (
            f"quantity {rounded:.10g} is below the venue minimum {rules.min_qty:g}. "
            f"Refusing rather than sizing up to reach it — that would let the "
            f"exchange dictate risk instead of the risk checks."
        )

    if price is not None and rules.min_notional is not None:
        notional = rounded * price
        if notional < rules.min_notional:
            return None, (
                f"notional ${notional:,.2f} ({rounded:.10g} x {price:.8g}) is below "
                f"the venue minimum ${rules.min_notional:,.2f}. Refusing rather than "
                f"increasing size to reach it."
            )

    if rounded == quantity:
        return rounded, f"quantity {rounded:.10g} already matches step {rules.step_size:g}"

    return rounded, (
        f"quantity rounded DOWN {quantity:.10g} -> {rounded:.10g} at step "
        f"{rules.step_size:g} (never up: up would exceed the approved size)"
    )


def reset_cache() -> None:
    """For tests, and for an operator who needs to pick up a relisting."""
    global _markets_loaded, _load_failed_reason
    _cache.clear()
    _markets_loaded = False
    _load_failed_reason = None
