"""Phase 30 — Position Monitoring nodes (spec Section 13).

    "A trade doesn't end when the order fills — build a persistent monitoring
     workflow."

        Position Open -> Monitor -> Decision
          Price · Stop · Take Profit · Funding · Volatility
          Liquidity · News · Market Regime · Portfolio Risk
                        -> HOLD | REDUCE | MODIFY | EXIT

    "Risk rules remain deterministic here too."

THIS IS NOT A SECOND STOP-LOSS
------------------------------
`agents/position_monitor.py` enforces the mechanical stop and target on every
tick, and it must stay the only thing that does. Two components deciding when to
exit on price would race, and the loser would report a close it did not cause.

The division is by SPEED and by KIND:

  * The monitor agent reacts to a PRICE crossing a LEVEL. Tick-rate, no I/O, no
    reasoning. It is what protects capital.
  * This graph reacts to CONDITIONS changing. It runs on a trigger, does network
    I/O, and asks whether the thesis still holds.

So `monitor_price_levels` REPORTS distance-to-stop as evidence and never fires
one. When price is already through a level, the decision node returns HOLD and
says the monitor agent has it — racing a faster component to a close it is
already performing would double-submit.

WHAT THE FOUR DECISIONS MEAN HERE
---------------------------------
  HOLD    nothing has changed enough to act on. The default, and the common case.
  MODIFY  the stop can be moved CLOSER. Never further — `tighten_stop` refuses,
          and it is the authority, not this node.
  REDUCE  a partial close. Travels the same ungated close path as an exit.
  EXIT    the thesis that justified the position no longer holds.

EXIT here means THESIS INVALIDATION, not "price went against us" — that is what
the stop is for, and duplicating it would give the position two stops at different
distances.
"""

from __future__ import annotations

import logging
import time
from typing import Any, Dict, List, Optional

from backend.core.risk_manager import (
    ATR_STOP_MULTIPLIER,
    MAX_PORTFOLIO_EXPOSURE_PCT,
)
from backend.graphs.contracts import NodeContract
from backend.graphs.registry import register_node
from backend.graphs.state import (
    MonitoredPosition,
    PositionDecision,
    SpecialistFinding,
    TradingState,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Thresholds. Every one is derived from a limit that already exists, so the set
# cannot contradict the entry-side rules.
# ---------------------------------------------------------------------------

# Profit, in units of the initial risk, at which the stop is moved to break-even.
#
# 1R is the standard point: the position has made as much as it was prepared to
# lose, so protecting the entry costs nothing that was not already at risk. Below
# 1R, moving the stop to break-even would tighten it inside the noise the ATR
# stop was sized to absorb, and the position would be stopped out of a thesis
# that was still intact.
TRAIL_TO_BREAKEVEN_R = 1.0

# Beyond this, the stop trails the peak by a fraction of the initial risk rather
# than sitting at break-even. Set above the break-even trigger so the two rules
# cannot both apply and produce different stops for the same position.
TRAIL_BEHIND_PEAK_R = 2.0
# How far behind the peak, in units of initial risk. 1.0 keeps a full risk unit of
# room, so an ordinary pullback does not close a working position.
TRAIL_DISTANCE_R = 1.0

# A position held this long without reaching 1R has not worked. Not a hard exit —
# it contributes to a REDUCE, because "this is not moving" is weaker evidence than
# "the thesis is wrong".
STALE_HOURS = 24.0

# Unrealised loss, as a fraction of the initial risk, at which deteriorating
# conditions justify reducing rather than waiting for the full stop. 0.5R means
# half the planned loss is already taken.
REDUCE_AT_ADVERSE_R = 0.5
# How much of the position a REDUCE closes. Half — enough to materially cut risk,
# not so much that it is an exit wearing another name.
REDUCE_FRACTION = 0.5


# ===========================================================================
# 1. Position snapshot
# ===========================================================================

def load_position(state: TradingState) -> Optional[Dict[str, Any]]:
    """Enrich the position the run was started for with live numbers.

    The position identity arrives on the state (put there by the runner from the
    monitor agent's own book). This node computes the derived figures — unrealised
    P&L, R multiple, hold time — from `market_data`, which was fetched once at the
    top of this run.

    R MULTIPLE IS THE UNIT EVERYTHING ELSE USES. Profit in dollars says nothing
    without the risk that bought it; profit in units of the entry-to-stop distance
    is directly comparable across symbols and position sizes, and it is the unit
    the trailing rules are expressed in.
    """
    position = state.get("monitored_position")
    if position is None:
        return {"unavailable": ["position monitoring (no position on the state)"]}

    snapshot = state.get("market_data")
    price = snapshot.price if snapshot else None

    if price is None or price <= 0:
        # Everything downstream is a function of current price. Reported rather
        # than substituted — a monitoring run that invented a price would produce
        # a confident HOLD or EXIT about a position it could not see.
        return {
            "unavailable": [
                f"position monitoring for {position.symbol} (no live price; "
                f"unrealised P&L, R multiple and every trailing rule are unavailable)"
            ]
        }

    sign = 1.0 if position.side == "buy" else -1.0
    enriched = MonitoredPosition(
        tar_id=position.tar_id,
        symbol=position.symbol,
        side=position.side,
        tab=position.tab,
        qty=position.qty,
        entry_price=position.entry_price,
        stop_loss=position.stop_loss,
        take_profit=position.take_profit,
        opened_at_ts=position.opened_at_ts,
        peak_price=position.peak_price,
        current_price=price,
    )

    if position.entry_price:
        move = (price - position.entry_price) * sign
        enriched.unrealised_pct = move / position.entry_price * 100.0
        if position.qty:
            enriched.unrealised_pnl = move * abs(position.qty)

        if position.stop_loss:
            initial_risk = abs(position.entry_price - position.stop_loss)
            if initial_risk > 0:
                enriched.r_multiple = move / initial_risk

    if position.opened_at_ts:
        enriched.held_seconds = max(0.0, time.time() - position.opened_at_ts)

    logger.debug(
        "Monitoring %s %s: price %.8g, %.2fR, %s held",
        position.side, position.symbol, price,
        enriched.r_multiple if enriched.r_multiple is not None else float("nan"),
        f"{enriched.held_seconds / 3600:.1f}h" if enriched.held_seconds else "unknown",
    )
    return {"monitored_position": enriched}


# ===========================================================================
# 2. Price / Stop / Take Profit  (3 of Section 13's 9 dimensions)
# ===========================================================================

def monitor_price_levels(state: TradingState) -> Optional[Dict[str, Any]]:
    """Where price sits relative to entry, stop and target.

    REPORTS ONLY. It never closes a position — see the module docstring. When
    price is already through a level, that fact is recorded so the decision node
    can defer to the monitor agent rather than racing it.
    """
    position = state.get("monitored_position")
    if position is None or position.current_price is None:
        return {
            "monitor_findings": [_absent("price", "no position or no live price")],
        }

    price = position.current_price
    evidence: List[str] = [
        f"price {price:.8g} vs entry {position.entry_price:.8g}"
        if position.entry_price else f"price {price:.8g}, entry unknown",
    ]

    if position.unrealised_pct is not None:
        evidence.append(f"unrealised {position.unrealised_pct:+.2f}%")
    if position.unrealised_pnl is not None:
        evidence.append(f"unrealised ${position.unrealised_pnl:+,.2f}")
    if position.r_multiple is not None:
        evidence.append(
            f"{position.r_multiple:+.2f}R (profit in units of the entry-to-stop "
            f"distance)"
        )
    if position.held_seconds is not None:
        evidence.append(f"held {position.held_seconds / 3600:.1f}h")

    findings = [
        SpecialistFinding(
            specialist="price",
            role="directional",
            available=True,
            stance="supports_long" if position.side == "buy" else "supports_short",
            # Conviction is the position's own progress, not a market read. A
            # position at +2R is working; that is evidence for leaving it alone.
            confidence=min(1.0, max(0.0, (position.r_multiple or 0.0) / 2.0)),
            evidence=evidence,
        ),
        _level_finding("stop", position, position.stop_loss, is_stop=True),
        _level_finding("take_profit", position, position.take_profit, is_stop=False),
    ]
    return {"monitor_findings": findings}


def _level_finding(
    name: str, position: MonitoredPosition, level: Optional[float], is_stop: bool
) -> SpecialistFinding:
    """Distance to a protective level, as a constraint.

    A constraint rather than a directional voter: how close the stop is does not
    argue for a side, it bounds how much room the position has left.
    """
    if level is None:
        return _absent(
            name,
            f"no {'stop-loss' if is_stop else 'take-profit'} is set on this position",
            role="constraint",
        )

    price = position.current_price
    distance = abs(price - level)
    pct = distance / price * 100.0 if price else None

    if position.side == "buy":
        through = price <= level if is_stop else price >= level
    else:
        through = price >= level if is_stop else price <= level

    evidence = [
        f"{'stop' if is_stop else 'target'} {level:.8g} is {distance:.8g} away"
        + (f" ({pct:.2f}%)" if pct is not None else "")
    ]
    if through:
        evidence.append(
            "PRICE IS ALREADY THROUGH THIS LEVEL — the position monitor agent "
            "enforces it on every tick and is closing or has closed the position. "
            "This graph must not also close it."
        )

    return SpecialistFinding(
        specialist=name,
        role="constraint",
        available=True,
        # A near stop is a real constraint on holding; a near target is not a
        # concern at all, so only the stop contributes one.
        concern=(
            min(1.0, max(0.0, 1.0 - (position.r_multiple or 0.0)))
            if is_stop and position.r_multiple is not None
            else 0.0
        ),
        evidence=evidence,
    )


# ===========================================================================
# 3. Funding / Volatility / Market Regime / Liquidity / News
#    (5 more of Section 13's 9 dimensions)
# ===========================================================================

def monitor_market_conditions(state: TradingState) -> Optional[Dict[str, Any]]:
    """Have the conditions that justified this position changed?

    Reads what the Phase 24 market nodes already fetched this run. Does not fetch:
    a second fetch could disagree with the snapshot the rest of the run reasoned
    over, and on a monitoring decision that would mean exiting on one price while
    reporting another.
    """
    position = state.get("monitored_position")
    regime = state.get("market_regime")
    technical = state.get("technical_analysis")
    sentiment = state.get("sentiment_analysis")

    findings: List[SpecialistFinding] = []
    side = position.side if position else None

    # --- Market Regime: the thesis-invalidation signal ---------------------
    if regime is None or regime.regime is None:
        findings.append(_absent("market_regime", "the regime could not be classified"))
    else:
        agrees = _regime_agrees(regime.regime, side)
        evidence = [f"regime is '{regime.regime}'"]
        if regime.trend_strength is not None:
            evidence.append(f"trend strength {regime.trend_strength:.3f}")
        if regime.confidence is not None:
            evidence.append(
                f"market-state coverage {regime.confidence:.2f} (coverage, not a forecast)"
            )
        if technical and technical.multi_timeframe_trend:
            evidence.append(f"multi-timeframe trend {technical.multi_timeframe_trend}")

        findings.append(SpecialistFinding(
            specialist="market_regime",
            role="directional",
            available=True,
            stance=(
                ("supports_long" if side == "buy" else "supports_short") if agrees is True
                else ("supports_short" if side == "buy" else "supports_long") if agrees is False
                else "neutral"
            ),
            confidence=0.0 if agrees is None else (regime.trend_strength or 0.5),
            evidence=evidence,
        ))

    # --- Volatility: a constraint on holding, not a direction --------------
    if regime is None or regime.volatility is None:
        findings.append(_absent("volatility", "volatility could not be classified",
                                role="constraint"))
    else:
        concern = {"LOW": 0.0, "MEDIUM": 0.2, "HIGH": 0.5}.get(regime.volatility, 0.3)
        evidence = [f"volatility regime {regime.volatility}"]
        if technical and technical.atr is not None and position and position.stop_loss \
                and position.entry_price:
            initial_risk = abs(position.entry_price - position.stop_loss)
            atr_stops = initial_risk / technical.atr if technical.atr > 0 else None
            if atr_stops is not None:
                evidence.append(
                    f"the stop is {atr_stops:.2f} ATR away; it was set at "
                    f"{ATR_STOP_MULTIPLIER} ATR, so volatility has "
                    f"{'FALLEN' if atr_stops > ATR_STOP_MULTIPLIER else 'RISEN'} since entry"
                )
                if atr_stops < ATR_STOP_MULTIPLIER * 0.6:
                    # The honest consequence: the stop is now tight relative to
                    # noise. Widening it is FORBIDDEN, so the only lever is size.
                    concern = max(concern, 0.6)
                    evidence.append(
                        "the stop is now tight relative to current noise. Widening it "
                        "is forbidden — it would exceed the approved risk — so the "
                        "only available response is to reduce size."
                    )
        findings.append(SpecialistFinding(
            specialist="volatility", role="constraint", available=True,
            concern=concern, evidence=evidence,
        ))

    # --- Funding: contrarian crowding, same treatment as Phase 26 ----------
    if sentiment is None or sentiment.funding_rate is None:
        findings.append(_absent("funding", "no funding rate was fetched this run"))
    else:
        funding = sentiment.funding_rate
        # Positive funding = longs pay = long side crowded. Holding a crowded side
        # is mild evidence against continuing to hold it.
        crowded_against = (funding > 0 and side == "buy") or (funding < 0 and side == "sell")
        findings.append(SpecialistFinding(
            specialist="funding", role="constraint", available=True,
            concern=min(0.4, abs(funding) * 200.0) if crowded_against else 0.0,
            evidence=[
                f"funding {funding:+.5f} — "
                + ("this position is on the crowded side, which pays to hold"
                   if crowded_against else "this position is on the side being paid")
            ],
        ))

    # --- Liquidity and News: no feed, same refusal as Phase 26 -------------
    findings.append(_absent(
        "liquidity",
        "no order-book depth feed is subscribed, so exit slippage on this position "
        "cannot be estimated — the size that could be exited at a given price is "
        "unknown",
        role="constraint",
    ))
    findings.append(_absent(
        "news",
        "no news feed is ingested, so event risk against this open position is "
        "unknown rather than absent. A scheduled unlock or listing would invalidate "
        "the thesis without any other dimension noticing",
    ))

    return {"monitor_findings": findings}


def _regime_agrees(regime: str, side: Optional[str]) -> Optional[bool]:
    """Does the regime support holding this side? None when it says nothing."""
    if side is None:
        return None
    lowered = regime.lower()
    if "bullish" in lowered:
        return side == "buy"
    if "bearish" in lowered:
        return side == "sell"
    # Ranging, choppy, or anything unclassified. Genuinely neutral for a held
    # position: a range neither confirms nor invalidates a directional thesis.
    return None


# ===========================================================================
# 4. Portfolio Risk (the 9th dimension)
# ===========================================================================

def monitor_portfolio_risk(state: TradingState) -> Optional[Dict[str, Any]]:
    """What this position means for the book as a whole.

    Reads `portfolio_state`, written by the Phase 26 portfolio specialist in an
    earlier superstep of this graph.
    """
    portfolio = state.get("portfolio_state")
    position = state.get("monitored_position")

    if portfolio is None:
        return {"monitor_findings": [_absent(
            "portfolio_risk",
            "no portfolio snapshot this run, so exposure is unknown rather than zero",
            role="constraint",
        )]}

    positions = portfolio.open_positions or []
    equity = portfolio.equity
    evidence: List[str] = [f"{len(positions)} open position(s) on the {portfolio.tab} book"]
    concern = 0.0

    total_notional = 0.0
    for pos in positions:
        try:
            total_notional += abs(float(pos["qty"])) * float(pos["avgCost"])
        except (KeyError, TypeError, ValueError):
            continue

    if equity and equity > 0:
        pct = total_notional / equity * 100.0
        evidence.append(
            f"total exposure ${total_notional:,.2f} ({pct:.1f}% of ${equity:,.2f} "
            f"equity, at entry cost not marked to market)"
        )
        if pct > MAX_PORTFOLIO_EXPOSURE_PCT:
            concern = max(concern, 0.8)
            evidence.append(
                f"exposure is ABOVE the {MAX_PORTFOLIO_EXPOSURE_PCT:.0f}% limit that "
                f"would have blocked opening this position"
            )
        elif pct > MAX_PORTFOLIO_EXPOSURE_PCT * 0.75:
            concern = max(concern, 0.4)
    else:
        evidence.append("equity unknown, so exposure cannot be expressed as a percentage")

    if position is not None and position.unrealised_pnl is not None and equity:
        drag = position.unrealised_pnl / equity * 100.0
        evidence.append(f"this position alone is {drag:+.2f}% of equity, unrealised")
        if drag < -2.0:
            concern = max(concern, 0.5)

    evidence.append(
        "correlated-cluster analysis not run here (owned by the CIO agent) and "
        "drawdown from the high-water mark not available here (owned by the CEO)"
    )

    return {"monitor_findings": [SpecialistFinding(
        specialist="portfolio_risk", role="constraint", available=True,
        concern=concern, evidence=evidence,
    )]}


def _absent(name: str, reason: str, role: str = "directional") -> SpecialistFinding:
    """A dimension that could not be evaluated. Never a neutral reading."""
    return SpecialistFinding(
        specialist=name, role=role, available=False,
        stance=None, confidence=None, concern=None,
        evidence=[], reason_unavailable=reason,
    )


# ===========================================================================
# 5. The decision — HOLD | REDUCE | MODIFY | EXIT
# ===========================================================================

# Section 13's nine dimensions, so a summary can assert coverage rather than
# counting whatever happened to be produced.
MONITOR_DIMENSIONS = (
    "price", "stop", "take_profit", "funding", "volatility",
    "liquidity", "news", "market_regime", "portfolio_risk",
)


def decide_position(state: TradingState) -> Optional[Dict[str, Any]]:
    """Weigh the nine dimensions into one action. Deterministic.

    "Risk rules remain deterministic here too." Every branch below is arithmetic
    on measured values, so an identical position under identical conditions always
    produces an identical action — which is what makes a past exit auditable and
    this rule backtestable.

    BRANCH ORDER IS THE SAFETY DESIGN, and it is ordered by who owns the outcome:

      1. Price already through a level -> HOLD, defer to the monitor agent. First,
         because racing a faster component to a close it is already performing
         would double-submit.
      2. Thesis invalidated            -> EXIT.
      3. Conditions deteriorated       -> REDUCE.
      4. Stop can be tightened         -> MODIFY.
      5. Otherwise                     -> HOLD.

    EXIT outranks MODIFY: if the thesis is gone, protecting a better price on a
    position that should not exist is the wrong action.
    """
    position = state.get("monitored_position")
    findings = list(state.get("monitor_findings") or [])

    if position is None:
        return {"unavailable": ["position decision (no position to decide on)"]}

    by_name = {f.specialist: f for f in findings}
    absent = [f.specialist for f in findings if not f.available]
    unavailable = [
        f"{f.specialist}: {f.reason_unavailable}"
        for f in findings if not f.available
    ]
    missing = [d for d in MONITOR_DIMENSIONS if d not in by_name]
    unavailable += [f"{d}: dimension did not report at all" for d in missing]

    evidence: List[str] = []
    for finding in findings:
        if finding.available:
            evidence.extend(f"{finding.specialist}: {e}" for e in finding.evidence)

    # --- 1. Defer to the monitor agent ------------------------------------
    for level in ("stop", "take_profit"):
        finding = by_name.get(level)
        if finding and finding.available and any(
            "ALREADY THROUGH THIS LEVEL" in e for e in finding.evidence
        ):
            return _emit(state, PositionDecision(
                action="HOLD",
                reason=(
                    f"price is already through the {level.replace('_', '-')}. The "
                    f"position monitor agent enforces levels on every tick and is "
                    f"closing this position; a second close from here would "
                    f"double-submit."
                ),
                evidence=evidence,
                unavailable=unavailable,
            ))

    # --- 2. Thesis invalidated -> EXIT -----------------------------------
    regime = by_name.get("market_regime")
    if regime is not None and regime.available and regime.signed_weight() != 0.0:
        favours_long = regime.signed_weight() > 0
        against = (position.side == "buy" and not favours_long) or \
                  (position.side == "sell" and favours_long)
        if against:
            return _emit(state, PositionDecision(
                action="EXIT",
                reason=(
                    f"thesis invalidated: the regime now reads against this "
                    f"{'long' if position.side == 'buy' else 'short'} "
                    f"(confidence {regime.confidence:.2f}). Exiting on a broken thesis "
                    f"rather than waiting for the stop, which is a price level and not "
                    f"a reason."
                ),
                evidence=evidence,
                unavailable=unavailable,
            ))

    # --- 3. Conditions deteriorated -> REDUCE -----------------------------
    #
    # Restricted to CONDITION_DIMENSIONS so the "deteriorating conditions" half of
    # this gate is independent of the "underwater" half. See that constant.
    binding, concern = _binding_constraint(by_name, only=CONDITION_DIMENSIONS)
    adverse = position.r_multiple is not None and position.r_multiple <= -REDUCE_AT_ADVERSE_R
    stale = (
        position.held_seconds is not None
        and position.held_seconds > STALE_HOURS * 3600
        and (position.r_multiple or 0.0) < TRAIL_TO_BREAKEVEN_R
    )

    if position.qty and (adverse or stale) and concern >= 0.5:
        why = []
        if adverse:
            why.append(
                f"already {position.r_multiple:+.2f}R against, so more than "
                f"{REDUCE_AT_ADVERSE_R}R of the planned loss is taken"
            )
        if stale:
            why.append(
                f"held {position.held_seconds / 3600:.1f}h without reaching "
                f"{TRAIL_TO_BREAKEVEN_R}R"
            )
        return _emit(state, PositionDecision(
            action="REDUCE",
            reduce_qty=abs(position.qty) * REDUCE_FRACTION,
            reason=(
                f"reducing {REDUCE_FRACTION * 100:.0f}%: " + "; ".join(why)
                + f", and the binding constraint is {binding} at {concern:.2f}. "
                f"The stop cannot be widened to accommodate this, so size is the "
                f"only lever."
            ),
            evidence=evidence,
            unavailable=unavailable,
        ))

    # --- 4. Stop can be tightened -> MODIFY -------------------------------
    proposed, note = _trail_stop(position)
    if proposed is not None:
        return _emit(state, PositionDecision(
            action="MODIFY",
            new_stop_loss=proposed,
            reason=note,
            evidence=evidence,
            unavailable=unavailable,
        ))

    # --- 5. HOLD ----------------------------------------------------------
    return _emit(state, PositionDecision(
        action="HOLD",
        reason=(
            f"nothing has changed enough to act on. "
            + (f"{position.r_multiple:+.2f}R, " if position.r_multiple is not None else "")
            + f"binding constraint {binding or 'none'}"
            + (f" at {concern:.2f}" if binding else "")
            + (f". {len(absent)} of {len(MONITOR_DIMENSIONS)} dimension(s) could not "
               f"be evaluated: {', '.join(absent)}" if absent else "")
        ),
        evidence=evidence,
        unavailable=unavailable,
    ))


# Constraints that are genuinely INDEPENDENT of the position's own P&L.
#
# `stop` and `price` are excluded, and that exclusion is the whole point. The stop
# dimension's concern is computed as `1 - r_multiple`, so a position at -0.55R
# automatically reports a stop concern of 1.0 — which means the REDUCE gate's
# "conditions have deteriorated" test was silently just restating "the position is
# underwater", and every position drifting to -0.5R would have been halved.
#
# That is the same double-counting trap as an orderflow specialist derived from
# candle direction (Phase 26): two names for one piece of evidence, so it gets
# counted twice and the threshold fires on half the evidence it appears to require.
#
# Turning a normal drawdown into forced selling at the worst point is precisely
# what a REDUCE rule must not do, so the second condition has to come from
# somewhere the first did not.
CONDITION_DIMENSIONS = ("volatility", "funding", "portfolio_risk", "liquidity")


def _binding_constraint(by_name: Dict[str, Any], only: Optional[tuple] = None) -> tuple:
    """The single worst constraint, by max() not by product.

    Same reasoning as the Phase 26 debate: the binding constraint binds, and
    multiplying several mild concerns would report three small doubts as one large
    one.

    `only` restricts which dimensions may bind. The REDUCE gate passes
    `CONDITION_DIMENSIONS` so its second condition is independent of its first.
    """
    name, worst = None, 0.0
    for finding in by_name.values():
        if only is not None and finding.specialist not in only:
            continue
        if finding.role != "constraint" or not finding.available:
            continue
        if finding.concern is not None and finding.concern > worst:
            name, worst = finding.specialist, finding.concern
    return name, worst


def _trail_stop(position: MonitoredPosition) -> tuple:
    """Propose a TIGHTER stop, or (None, note) when there is nothing to propose.

    Two rules, and they cannot both apply because the thresholds do not overlap:

      >= TRAIL_BEHIND_PEAK_R   trail TRAIL_DISTANCE_R behind the best price reached
      >= TRAIL_TO_BREAKEVEN_R  move to break-even

    Below 1R nothing is proposed. Tightening earlier would pull the stop inside the
    noise the ATR distance was sized to absorb, and the position would be stopped
    out of a thesis that was still intact — which is the failure a trailing stop is
    supposed to avoid, not cause.

    Only ever PROPOSES. `PositionMonitorAgent.tighten_stop` is the authority and
    refuses anything that is not tighter, so a bug here cannot widen a stop.
    """
    if position.r_multiple is None or position.entry_price is None \
            or position.stop_loss is None:
        return None, "no trailing rule applies: R multiple or levels unavailable"

    if position.r_multiple < TRAIL_TO_BREAKEVEN_R:
        return None, (
            f"no trailing rule applies at {position.r_multiple:+.2f}R (needs "
            f"{TRAIL_TO_BREAKEVEN_R}R; tightening earlier would pull the stop inside "
            f"the noise the ATR distance was sized to absorb)"
        )

    initial_risk = abs(position.entry_price - position.stop_loss)
    long = position.side == "buy"

    if position.r_multiple >= TRAIL_BEHIND_PEAK_R and position.peak_price is not None:
        offset = initial_risk * TRAIL_DISTANCE_R
        proposed = position.peak_price - offset if long else position.peak_price + offset
        label = (
            f"trailing {TRAIL_DISTANCE_R}R behind the "
            f"{'peak' if long else 'trough'} {position.peak_price:.8g}"
        )
    else:
        proposed = position.entry_price
        label = "moving the stop to break-even"

    tighter = proposed > position.stop_loss if long else proposed < position.stop_loss
    if not tighter:
        return None, (
            f"{label} would give {proposed:.8g}, which is not tighter than the current "
            f"stop {position.stop_loss:.8g} — proposing nothing rather than widening"
        )

    return proposed, (
        f"{position.r_multiple:+.2f}R reached, so {label}: stop "
        f"{position.stop_loss:.8g} -> {proposed:.8g}. Risk on this position drops; it "
        f"can never rise, because the monitor agent refuses a widened stop."
    )


def _emit(state: TradingState, decision: PositionDecision) -> Dict[str, Any]:
    position = state.get("monitored_position")
    logger.info(
        "Position decision for %s (%s %s): %s — %s",
        position.symbol if position else "?",
        position.side if position else "?",
        f"{position.r_multiple:+.2f}R" if position and position.r_multiple is not None else "?R",
        decision.action, decision.reason,
    )
    out: Dict[str, Any] = {"position_decision": decision}
    if decision.unavailable:
        out["unavailable"] = [f"monitor dimension {u}" for u in decision.unavailable]
    return out


# ===========================================================================
# Registration
# ===========================================================================

POSITION_SNAPSHOT_NODE = "position_snapshot"
MONITOR_NODES = (
    "monitor_price_levels",
    "monitor_market_conditions",
    "monitor_portfolio_risk",
)
# Named distinctly from the `position_decision` STATE KEY it writes. The two
# namespaces are separate, and using one name for both reads as if they were not.
POSITION_DECISION_NODE = "monitor_decision"


def register_monitoring_nodes() -> None:
    register_node(
        NodeContract(
            name=POSITION_SNAPSHOT_NODE,
            reads=("monitored_position", "market_data", "symbol"),
            writes=("monitored_position",),
            purpose="Enrich the tracked position with live P&L, R multiple and hold time",
            deterministic=True,
            phase=30,
        ),
        load_position,
    )

    register_node(
        NodeContract(
            name="monitor_price_levels",
            reads=("monitored_position", "symbol"),
            writes=("monitor_findings",),
            purpose="Price, stop and take-profit distances — reports levels, never fires one",
            deterministic=True,
            phase=30,
        ),
        monitor_price_levels,
    )

    register_node(
        NodeContract(
            name="monitor_market_conditions",
            reads=("monitored_position", "market_regime", "technical_analysis",
                   "sentiment_analysis", "symbol"),
            writes=("monitor_findings",),
            purpose="Regime, volatility, funding, liquidity and news against an open position",
            deterministic=True,
            phase=30,
        ),
        monitor_market_conditions,
    )

    register_node(
        NodeContract(
            name="monitor_portfolio_risk",
            reads=("monitored_position", "portfolio_state", "symbol"),
            writes=("monitor_findings",),
            purpose="What this position means for total exposure",
            deterministic=True,
            phase=30,
        ),
        monitor_portfolio_risk,
    )

    register_node(
        NodeContract(
            name=POSITION_DECISION_NODE,
            reads=("monitored_position", "monitor_findings", "symbol"),
            writes=("position_decision",),
            purpose=(
                "HOLD / REDUCE / MODIFY / EXIT from the nine dimensions. Deterministic; "
                "never closes a position and never widens a stop."
            ),
            deterministic=True,
            phase=30,
        ),
        decide_position,
    )
