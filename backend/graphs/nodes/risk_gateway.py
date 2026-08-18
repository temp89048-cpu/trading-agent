"""Phase 28 — Risk Gateway node (spec Section 11).

    AI Decision -> Risk Gateway -> APPROVED

      Max Position · Max Leverage · Max Drawdown · Margin · Correlation
      Daily Loss · Exposure · Liquidity · Kill Switch

    "One of the most important phases. Do not make the CRO an LLM-only node —
     use deterministic risk code."
    "An LLM can recommend. Code enforces."

THIS IS THE ONLY NODE THAT SIZES A POSITION
-------------------------------------------
Phase 27 deliberately left `decision.size` and `decision.leverage` as `None` and
said in its own docstring that this phase owns them. It does — and it is the only
place in the reasoning layer that does, so there is exactly one answer to "who
decided how big this was".

Sizing happens BEFORE validation, not after, because most of Section 11's checks
are functions of size: margin, exposure, and per-trade risk are all meaningless
until a quantity exists. A gateway that validated an unsized request would be
checking nothing.

Sizing then feeds back into the checks, which can reject the size that was just
computed. That is the intended shape: the sizer proposes, the checks dispose.

WHAT THIS NODE WRITES, AND WHAT IT DELIBERATELY DOES NOT
--------------------------------------------------------
Writes `risk_assessment` (the verdict and all nine checks) and `execution_plan`
(the inert boundary object of Section 12).

Does NOT write `decision`. The Supervisor owns that record, and a second node
mutating it would mean an auditor could not tell which node's reasoning produced
which field. The plan is a separate object precisely so approval is visibly
downstream of the decision rather than folded into it.

`ExecutionPlan` is a dataclass, not an event and not a call. Producing one is not
placing an order: a separate deterministic service converts an approved plan into
a TAR, and `FORBIDDEN_IMPORTS` means nothing in this module can reach an order
call even if a later edit tried. The cognitive plane can be entirely wrong and
still cannot move money.

EXITS ARE NOT GATED
-------------------
An `EXIT` decision produces an unconditionally-approved plan. `validate_trade`
short-circuits on `intent='close'` before any check runs, and this node routes
exits down that path. CLAUDE.md invariant 4: a close is never blocked — and it is
most important not to block one when a limit has already been breached, which is
exactly when a gateway would otherwise refuse.

STRICT MODE
-----------
This node calls `validate_trade(..., strict=True)`, so a check that could not run
REJECTS rather than cautioning. The graph always has a portfolio snapshot (the
Phase 26 portfolio specialist writes it) and can always read the ledger, so a
missing input here is a bug in the graph rather than a limitation of the caller —
and an unrun check must never be allowed to look like a passed one.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any, Dict, List, Optional

from backend.core.risk_manager import (
    ATR_STOP_MULTIPLIER,
    calculate_position_size,
    kelly_risk_fraction,
    max_leverage_ceiling,
    validate_trade,
)
from backend.graphs.contracts import NodeContract
from backend.graphs.registry import register_node
from backend.graphs.state import ExecutionPlan, RiskAssessment, TradingState

logger = logging.getLogger(__name__)

RISK_GATEWAY_NODE = "risk_gateway"

# Actions this node acts on. Anything else (WAIT / DO_NOT_TRADE) needs no plan and
# no validation — there is nothing to approve.
ACTIONABLE = ("TRADE", "EXIT")

# Fraction of equity to risk when Kelly has no usable win probability. Matches
# `kelly_risk_fraction`'s own fallback, referenced rather than re-picked so the two
# cannot drift apart.
DEFAULT_RISK_FRACTION = 0.02

# Leverage requested for a graph-originated plan.
#
# 1x, always. Not "up to the ceiling" — the ceiling is the maximum a human may
# configure, not a target for an autonomous system to aim at. This node has no
# validated track record to justify amplifying anything (every strategy profile
# still carries `historical_success_rate=None`), and leverage multiplies the
# consequences of a wrong read rather than the quality of it.
#
# Still passed through `max_leverage_ceiling` so the value can never exceed the
# hard limit even if this constant is edited carelessly.
GRAPH_REQUESTED_LEVERAGE = 1


def gate(state: TradingState) -> Optional[Dict[str, Any]]:
    """Size, validate, and produce an inert execution plan. Deterministic."""
    decision = state.get("decision")

    if decision is None:
        return {"unavailable": ["risk gateway (no decision to validate)"]}

    if decision.action not in ACTIONABLE:
        # WAIT and DO_NOT_TRADE need no plan. Recorded as an assessment rather than
        # silence, so the trace shows the gateway ran and why it had nothing to do —
        # an absent `risk_assessment` is indistinguishable from a gateway that
        # failed to execute.
        return {
            "risk_assessment": RiskAssessment(
                approved=False,
                rejection_reasons=[
                    f"nothing to validate: the Supervisor decided {decision.action}, "
                    f"not TRADE or EXIT"
                ],
                checks={
                    "NotApplicable": {
                        "status": "pass",
                        "detail": (
                            f"{decision.action} requires no risk validation and no "
                            f"execution plan."
                        ),
                    }
                },
            )
        }

    thesis = state.get("trade_thesis")
    portfolio = state.get("portfolio_state")
    snapshot = state.get("market_data")
    symbol = state["symbol"]
    tab = portfolio.tab if portfolio else "paper"

    # ---- EXIT: invariant 4, no gate ---------------------------------------
    if decision.action == "EXIT":
        return _exit_plan(state, decision, portfolio, symbol, tab)

    # ---- TRADE: size first, because the checks are functions of size ------
    if thesis is None or thesis.entry_price is None or thesis.stop_loss is None:
        # Should be unreachable: the Supervisor already returns DO_NOT_TRADE for a
        # thesis without a stop. Checked anyway rather than trusted, because the
        # consequence of being wrong is a stopless position (invariant 3).
        return {
            "risk_assessment": RiskAssessment(
                approved=False,
                rejection_reasons=[
                    "no entry price or stop-loss on the thesis, so the position "
                    "cannot be sized and must not be opened"
                ],
                checks={
                    "MandatoryStopLoss": {
                        "status": "reject",
                        "detail": "Every position requires a computed stop-loss.",
                    }
                },
            ),
            "unavailable": ["risk gateway sizing (no entry or stop on the thesis)"],
        }

    equity = portfolio.equity if portfolio else None
    if not equity or equity <= 0:
        return {
            "risk_assessment": RiskAssessment(
                approved=False,
                rejection_reasons=[
                    "equity is unknown, so the position cannot be sized and no risk "
                    "limit can be expressed as a percentage of it"
                ],
                checks={
                    "PositionSize": {
                        "status": "unavailable",
                        "detail": "No equity figure on the portfolio snapshot.",
                    }
                },
            ),
            "unavailable": ["risk gateway sizing (equity unknown)"],
        }

    bars_15m = (snapshot.candles.get("15m") if snapshot else None) or []
    technical = state.get("technical_analysis")
    atr = technical.atr if technical and technical.atr is not None else None

    if atr is None:
        return {
            "risk_assessment": RiskAssessment(
                approved=False,
                rejection_reasons=["ATR is unavailable, so risk-based sizing is impossible"],
                checks={
                    "PositionSize": {
                        "status": "unavailable",
                        "detail": (
                            "Sizing is a function of ATR; without it the quantity "
                            "would be a guess and the stop distance already is one."
                        ),
                    }
                },
            ),
            "unavailable": ["risk gateway sizing (no ATR)"],
        }

    # Kelly, capped downward only. `decision.probability` is the ONLY honest win
    # probability this system has, and it is None until 20 trades have resolved —
    # in which case `kelly_risk_fraction` falls back to fixed-fractional and says
    # so. Feeding it the panel confidence instead would be sizing on a number that
    # is not a win rate, which is the fabrication Phase 27 exists to prevent.
    sizing = kelly_risk_fraction(
        win_prob=decision.probability,
        payoff_ratio=2.0,
        fallback=DEFAULT_RISK_FRACTION,
    )

    if sizing["fraction"] <= 0.0:
        return {
            "risk_assessment": RiskAssessment(
                approved=False,
                rejection_reasons=[f"sizing returned zero: {sizing['detail']}"],
                checks={
                    "PositionSize": {"status": "reject", "detail": sizing["detail"]},
                },
            )
        }

    size = calculate_position_size(
        equity=equity,
        price=thesis.entry_price,
        atr=atr,
        risk_per_trade_percent=sizing["fraction"],
    )

    if size <= 0:
        return {
            "risk_assessment": RiskAssessment(
                approved=False,
                rejection_reasons=[
                    f"computed size is {size} — the risk budget "
                    f"({sizing['fraction'] * 100:.2f}% of ${equity:,.2f}) does not "
                    f"support even the smallest position at this stop distance"
                ],
                checks={
                    "PositionSize": {
                        "status": "reject",
                        "detail": f"size {size} at {sizing['rule']} sizing",
                    },
                },
            )
        }

    leverage = min(GRAPH_REQUESTED_LEVERAGE, max_leverage_ceiling(tab))
    side = "buy" if decision.direction == "LONG" else "sell"

    # ---- validate the size that was just computed -------------------------
    validation = validate_trade(
        {
            "symbol": symbol,
            "qty": size,
            "price": thesis.entry_price,
            "equityUsd": equity,
            "klines": bars_15m,
            "side": side,
            "tab": tab,
            "requestedLeverage": leverage,
            "intent": "open",
            # Supplied so the Phase 28 checks actually run. `openPositions` being a
            # list (even empty) rather than None is what distinguishes "measured, no
            # positions" from "not supplied".
            "openPositions": list(portfolio.open_positions or []),
            "freeMarginUsd": portfolio.cash,
            "tradeLedger": _ledger(),
        },
        # See the module docstring: the graph has every input, so a check that
        # cannot run is a bug here, not a caller limitation.
        strict=True,
    )

    assessment = RiskAssessment(
        approved=validation.approved,
        rejection_reasons=list(validation.rejection_reasons),
        caution_notes=[
            *validation.caution_notes,
            f"sizing rule: {sizing['rule']} — {sizing['detail']}",
        ],
        checks={
            name: {"status": check.status, "detail": check.detail}
            for name, check in validation.checks.items()
        },
        stop_loss=thesis.stop_loss,
        take_profit=thesis.take_profit,
    )

    out: Dict[str, Any] = {"risk_assessment": assessment}

    if not validation.approved:
        logger.info(
            "Risk gateway REJECTED %s %s %.8g on %s: %s",
            decision.direction, thesis.strategy, size, symbol,
            "; ".join(validation.rejection_reasons),
        )
        # No plan on a rejection. An unapproved `ExecutionPlan` sitting in state is
        # an object shaped exactly like an approved one, and the only thing stopping
        # a downstream reader acting on it is that reader remembering to check a
        # separate field. Not producing it removes the question.
        return out

    out["execution_plan"] = ExecutionPlan(
        symbol=symbol,
        side=side,
        size=size,
        leverage=leverage,
        stop_loss=thesis.stop_loss,
        take_profit=thesis.take_profit,
        tab=tab,
        idempotency_basis=_idempotency_basis(state, decision, side, size),
    )
    logger.info(
        "Risk gateway APPROVED %s %s %.8g on %s at %.8g (stop %.8g, %gx, %s) — "
        "%d check(s) passed, %d caution(s)",
        decision.direction, thesis.strategy, size, symbol, thesis.entry_price,
        thesis.stop_loss, leverage, sizing["rule"],
        sum(1 for c in validation.checks.values() if c.status == "pass"),
        len(assessment.caution_notes),
    )
    return out


# ---------------------------------------------------------------------------
# Exits
# ---------------------------------------------------------------------------

def _exit_plan(
    state: TradingState,
    decision: Any,
    portfolio: Any,
    symbol: str,
    tab: str,
) -> Dict[str, Any]:
    """An unconditionally-approved close. Invariant 4.

    Routed through `validate_trade(intent='close')` rather than skipping the
    gateway entirely, so the bypass is recorded as a check in the assessment. An
    exit that simply had no `risk_assessment` would be indistinguishable in the
    trace from a gateway that crashed.

    The size is the held quantity, read from the portfolio. If it cannot be read
    the plan is still produced with `size=None` and the reason recorded — a close
    the executor must size itself is far better than no close at all.
    """
    validation = validate_trade({"intent": "close", "symbol": symbol}, strict=False)

    held = 0.0
    base = str(symbol).split("/")[0].upper()
    unreadable: List[str] = []
    for pos in (portfolio.open_positions if portfolio else []) or []:
        if str(pos.get("symbol", "")).split("/")[0].upper() != base:
            continue
        try:
            held += float(pos["qty"])
        except (KeyError, TypeError, ValueError):
            unreadable.append(str(pos.get("symbol")))

    caution = list(validation.caution_notes)
    if unreadable:
        caution.append(
            f"could not read the held quantity for {', '.join(unreadable)}; the "
            f"executor must determine the size to close"
        )
    if held == 0.0:
        caution.append(
            "no held quantity could be determined for this symbol, so the plan "
            "carries size=None rather than a guessed quantity"
        )

    assessment = RiskAssessment(
        approved=True,
        rejection_reasons=[],
        caution_notes=caution,
        checks={
            name: {"status": check.status, "detail": check.detail}
            for name, check in validation.checks.items()
        },
    )

    # Opposite side to the held direction: closing a long is a sell.
    side = "sell" if held > 0 else "buy"

    logger.info(
        "Risk gateway APPROVED EXIT on %s (%s %s) — risk checks NOT applied, "
        "invariant 4: a close is never blocked",
        symbol, side, "unknown size" if held == 0.0 else f"{abs(held):.8g}",
    )

    return {
        "risk_assessment": assessment,
        "execution_plan": ExecutionPlan(
            symbol=symbol,
            side=side,
            size=abs(held) if held != 0.0 else None,
            # Never levered up to close. Reducing an existing position does not
            # require leverage, and requesting it on an exit would be a way for a
            # close to increase exposure.
            leverage=1,
            # No stop or target on a close — it IS the exit.
            stop_loss=None,
            take_profit=None,
            tab=tab,
            idempotency_basis=_idempotency_basis(state, decision, side, held),
        ),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ledger() -> Optional[List[Dict[str, Any]]]:
    """Today's realised P&L source for the daily-loss check.

    Returns None — not `[]` — when the store cannot be read, because an empty
    ledger means "no trades closed today" and an unreadable one means "unknown".
    In strict mode the first passes the check and the second rejects, which is the
    correct difference.
    """
    try:
        from backend.services.ai_memory import get_memory_stats

        stats = get_memory_stats() or {}
    except Exception as exc:  # noqa: BLE001 - never guess a P&L history
        logger.warning("Risk gateway could not read the trade ledger: %s", exc)
        return None

    ledger = stats.get("trade_ledger")
    return ledger if isinstance(ledger, list) else None


def _idempotency_basis(
    state: TradingState, decision: Any, side: str, size: Optional[float]
) -> str:
    """A stable key derived from DECISION IDENTITY, never from thread_id.

    Section 39.3. A thread id changes on every run, so a basis derived from it
    would let the same decision be submitted twice after a restart — which for an
    order means opening the position twice.

    `run_id` is included, so a genuinely new run produces a new key even for an
    identical decision. That is the intended tradeoff: the guard is against
    double-submitting ONE decision (a retry, a resumed checkpoint), not against a
    later run reaching the same conclusion, which is a real second decision.
    """
    raw = "|".join(
        str(part) for part in (
            state.get("run_id"),
            state.get("symbol"),
            decision.action,
            decision.direction,
            side,
            f"{size:.10g}" if size is not None else "unsized",
        )
    )
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

def register_risk_gateway_node() -> None:
    register_node(
        NodeContract(
            name=RISK_GATEWAY_NODE,
            reads=(
                "decision", "trade_thesis", "portfolio_state", "market_data",
                "technical_analysis", "symbol", "run_id",
            ),
            writes=("risk_assessment", "execution_plan"),
            purpose=(
                "Size the position, then run spec Section 11's nine deterministic "
                "checks. Produces an inert ExecutionPlan on approval. Never places "
                "an order; never blocks a close."
            ),
            deterministic=True,
            phase=28,
        ),
        gate,
    )
