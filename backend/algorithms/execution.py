import math
from typing import Any, Dict, List, Optional

def twap_order_slicer(total_qty: float, execution_window_minutes: int, interval_minutes: int = 5) -> list[float]:
    """
    Time-Weighted Average Price (TWAP) order slicer.
    Breaks a large order into smaller chunks to minimize slippage.
    """
    if execution_window_minutes <= interval_minutes:
        return [total_qty]
        
    num_slices = math.floor(execution_window_minutes / interval_minutes)
    if num_slices <= 0:
        return [total_qty]
        
    slice_qty = total_qty / num_slices
    return [slice_qty] * num_slices

def estimate_slippage(order_qty: float, orderbook_liquidity_at_price: float) -> float:
    """
    Estimates percentage slippage based on order size vs available liquidity at best bid/ask.
    """
    if orderbook_liquidity_at_price <= 0:
        return 1.0 # 100% slippage / failure

    ratio = order_qty / orderbook_liquidity_at_price

    # Simplified empirical model: 1% slippage for every 10% of liquidity consumed
    slippage = (ratio * 0.1)

    return slippage


# Thresholds for grading an execution. Chosen so "good" means "unremarkable" —
# a scoring scale where most fills land at the top tells you nothing.
GOOD_SLIPPAGE_BPS = 5.0
POOR_SLIPPAGE_BPS = 50.0    # matches the Section 19 circuit breaker
GOOD_LATENCY_MS = 500.0
POOR_LATENCY_MS = 5_000.0


def score_execution(
    requested_qty: float,
    filled_qty: float,
    slippage_bps: Optional[float],
    latency_ms: Optional[float],
) -> Dict[str, Any]:
    """Grade one execution on fill completeness, slippage and latency.

    Spec Section 22.4: *"Every execution must be scored (latency, slippage, fill
    quality) and that score written back ... so the Evaluation layer can use
    it."* None of the three was being captured: slippage was hardcoded to 0.0,
    latency was never measured, and fill quantity was reported as the REQUESTED
    quantity so a partial fill scored as complete.

    Returns `score: None` when there is nothing measurable, rather than 0 or
    100. A missing measurement is not a bad execution and must not be averaged
    in as one — the TypeScript side (`lib/executionQuality.ts`) takes the same
    position for the same reason.

    Component scores are 0-100 and the overall score is their mean over the
    components that could actually be measured, so a fill with no reference
    price is graded on what is known rather than penalised for what isn't.
    """
    components: Dict[str, Optional[float]] = {}
    notes: List[str] = []

    # --- fill completeness -------------------------------------------
    if requested_qty <= 0:
        components["fill"] = None
        notes.append("requested quantity is zero or negative — fill completeness not scorable")
    else:
        ratio = filled_qty / requested_qty
        components["fill"] = max(0.0, min(100.0, ratio * 100.0))
        if ratio < 0.999:
            notes.append(
                f"PARTIAL FILL: {filled_qty:.8g} of {requested_qty:.8g} requested "
                f"({ratio * 100:.2f}%)"
            )
        elif ratio > 1.001:
            # Over-fill is rare but must be surfaced, not clamped away: the
            # position on the book is larger than intended.
            notes.append(
                f"OVER-FILL: {filled_qty:.8g} filled against {requested_qty:.8g} requested"
            )

    # --- slippage ----------------------------------------------------
    if slippage_bps is None:
        components["slippage"] = None
        notes.append("slippage not measurable (no reference price)")
    else:
        # Favourable slippage (negative = a better price than expected) scores
        # full marks rather than above 100 — beating the reference is good, but
        # it is luck, not execution quality worth rewarding beyond the cap.
        if slippage_bps <= GOOD_SLIPPAGE_BPS:
            components["slippage"] = 100.0
        elif slippage_bps >= POOR_SLIPPAGE_BPS:
            components["slippage"] = 0.0
            notes.append(f"slippage {slippage_bps:.1f} bps at or beyond the {POOR_SLIPPAGE_BPS:.0f} bps limit")
        else:
            span = POOR_SLIPPAGE_BPS - GOOD_SLIPPAGE_BPS
            components["slippage"] = 100.0 * (1.0 - (slippage_bps - GOOD_SLIPPAGE_BPS) / span)

    # --- latency -----------------------------------------------------
    if latency_ms is None:
        components["latency"] = None
        notes.append("latency not measured")
    else:
        if latency_ms <= GOOD_LATENCY_MS:
            components["latency"] = 100.0
        elif latency_ms >= POOR_LATENCY_MS:
            components["latency"] = 0.0
            notes.append(f"latency {latency_ms:.0f}ms at or beyond {POOR_LATENCY_MS:.0f}ms")
        else:
            span = POOR_LATENCY_MS - GOOD_LATENCY_MS
            components["latency"] = 100.0 * (1.0 - (latency_ms - GOOD_LATENCY_MS) / span)

    measured = [v for v in components.values() if v is not None]
    overall = (sum(measured) / len(measured)) if measured else None

    return {
        "score": round(overall, 2) if overall is not None else None,
        "components": {k: (round(v, 2) if v is not None else None) for k, v in components.items()},
        # Named so the Evaluation layer can weight a fully-measured score above
        # one derived from a single component.
        "componentsMeasured": len(measured),
        "componentsTotal": len(components),
        "requestedQty": requested_qty,
        "filledQty": filled_qty,
        "fullyFilled": requested_qty > 0 and abs(filled_qty - requested_qty) / requested_qty < 0.001,
        "slippageBps": slippage_bps,
        "latencyMs": latency_ms,
        "notes": notes,
    }
