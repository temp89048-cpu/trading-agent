"""Supervisor AI — the arbitration layer (spec Section 22.7).

The Supervisor is the only agent that may submit a Trade Authorization
Request (TAR). It never executes: it hands an approved decision to the CRO,
which may veto, and only then does Execution see it.

WHAT WAS WRONG BEFORE
---------------------
`handle_event` built every TAR like this:

    tar = TarSubmittedEvent(
        symbol=event.symbol,
        direction="LONG",          # Hardcoded for this simple event chain demo
        requested_size=0.1,
        requested_leverage=1,
        ...
    )

So regardless of what the Debate concluded, every trade was a LONG; the size
was a constant 0.1 units of whatever the symbol was (0.1 BTC and 0.1 DOGE
are not comparable risks); and there was no stop-loss anywhere in the chain,
which made CLAUDE.md invariant 3 unenforceable downstream — Execution simply
had no stop to attach.

WHAT IT DOES NOW — AND WHEN IT REFUSES
--------------------------------------
It consumes DEBATE_CONCLUDED to learn the actual direction and confidence,
then treats STRESS_TESTED as the final gate. It submits a TAR only when it
can state, from real data, all of: a direction, an entry price, a computed
stop, and a size derived from that stop. Any one of those missing is a
refusal to submit, not a default value — a fabricated direction or an
invented stop is worse than no trade, because it looks like a decision.

Every refusal is logged with the specific missing input, so "why did nothing
trade?" has an answer (spec Section 5: every agent must explain every
decision).
"""

import datetime
import logging
import uuid
from typing import Any, Dict, List, Optional

from backend.core.agent_base import BaseAgent
from backend.core.config import settings
from backend.core.db import get_db_pool
from backend.core.risk_manager import (
    ATR_STOP_MULTIPLIER,
    ATR_TARGET_MULTIPLIER,
    calculate_atr,
    calculate_position_size,
    compute_stop_loss_take_profit,
    kelly_risk_fraction,
    max_leverage_ceiling,
    validate_trade,
)
from backend.core.system_state import may_open_new_position
from backend.models.events import (
    BaseEvent,
    DebateConcludedEvent,
    EventType,
    StressTestedEvent,
    TarRejectedEvent,
    TarSubmittedEvent,
)
from backend.services.market_data import fetch_klines, get_price
from backend.services.portfolio_store import get_portfolio

logger = logging.getLogger(__name__)

# ATR needs `period + 1` candles (14 + 1). Ask for more than the minimum so a
# short feed hiccup doesn't take the stop calculation offline, but treat
# anything under the true minimum as "no stop available".
KLINE_LIMIT = 100
MIN_KLINES_FOR_ATR = 15

# A debate conclusion older than this is not used. A direction derived from
# market conditions half an hour ago is not evidence about now, and silently
# acting on a stale one is how a system ends up trading yesterday's thesis.
DEBATE_STALENESS_SECONDS = 600


class SupervisorAgent(BaseAgent):
    def __init__(self) -> None:
        # symbol -> most recent debate conclusion
        self._debates: Dict[str, Dict[str, Any]] = {}
        super().__init__()

    @property
    def name(self) -> str:
        return "Supervisor AI"

    @property
    def purpose(self) -> str:
        return "Orchestrates all specialized agents. No single agent can execute directly; the Supervisor is the final authority to generate a TAR."

    @property
    def permissions(self) -> List[str]:
        # Note what is absent: no EXECUTE_TRADES. The Supervisor hands
        # approved decisions to the CRO and never touches the exchange.
        return ["READ_MARKET_DATA", "READ_PORTFOLIO", "INVOKE_DEBATE", "SUBMIT_TAR"]

    @property
    def inputs(self) -> List[str]:
        return [
            "DEBATE_CONCLUDED events (trade direction and confidence)",
            "STRESS_TESTED events (the final gate)",
            "15m klines via services/market_data.fetch_klines (for ATR / stop derivation)",
            "Live price via services/market_data.get_price",
            "Portfolio equity via services/portfolio_store.get_portfolio",
            "Operator kill switch via core/system_state",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "TAR_SUBMITTED events carrying direction, size, leverage, stop-loss and tab",
            "Rows in the `decisions` table with outcome 'pending-approval'",
            "Rows in the `decisions` table with outcome 'declined' — every refusal is recorded, "
            "so 'why didn't it trade?' has an answer",
        ]

    @property
    def category(self) -> str:
        return "orchestration"

    @property
    def events_consumed(self) -> List[EventType]:
        # DEBATE_CONCLUDED added: without it the Supervisor had no source for
        # trade direction, which is why direction was hardcoded to LONG.
        #
        # TAR_REJECTED added: the CRO published it and NOBODY consumed it, so a
        # vetoed trade vanished. The Supervisor — the agent that submitted the
        # TAR — never learned its request was refused, and the rejection never
        # reached the decision record. Spec Section 22.3 requires the breached
        # rule to be logged "to the trade's explainability record"; without a
        # consumer that record was never updated.
        return ["DEBATE_CONCLUDED", "STRESS_TESTED", "TAR_REJECTED"]

    @property
    def events_published(self) -> List[EventType]:
        return ["TAR_SUBMITTED"]

    @property
    def responsibilities(self) -> List[str]:
        return [
            "Arbitrate between specialist agents, weighing evidence and confidence rather than taking a simple vote.",
            "Produce a structured decision record for every decision, including refusals.",
            "Submit TARs to the CRO. Never execute, never bypass the CRO veto.",
        ]

    @property
    def dependencies(self) -> List[str]:
        return ["MessageBus", "MarketData", "PortfolioStore", "RiskManager"]

    @property
    def memory_ttl(self) -> str:
        return f"Debate conclusions cached in-process for {DEBATE_STALENESS_SECONDS}s; decisions persisted to the `decisions` table indefinitely."

    @property
    def knowledge_sources(self) -> List[str]:
        return ["Debate conclusions (event bus)", "Market klines", "Portfolio state"]

    @property
    def prompt_reference(self) -> str:
        return "SUPERVISOR_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return ["Market data (klines, price)"]

    @property
    def database_tables(self) -> List[str]:
        return ["decisions (write)"]

    @property
    def metrics_reported(self) -> List[str]:
        return ["TARs submitted", "Refusals by cause", "Events processed"]

    @property
    def failure_recovery_strategy(self) -> str:
        return (
            "Fails closed: any missing input (no debate, no price, no stop, unknown equity) "
            "results in no TAR being submitted rather than a TAR built from defaults."
        )

    @property
    def health_status(self) -> str:
        return "Active"

    # -----------------------------------------------------------------
    async def handle_event(self, event: BaseEvent) -> None:
        if event.event_type == "DEBATE_CONCLUDED" and isinstance(event, DebateConcludedEvent):
            self._debates[event.symbol] = {
                "direction": event.winning_direction,
                "confidence": event.consensus_confidence,
                "participants": event.participants,
                "rationale": event.supervisor_rationale,
                "ts": event.timestamp,
            }
            logger.debug(
                "Supervisor recorded debate for %s: %s @ %.1f%% confidence",
                event.symbol,
                event.winning_direction,
                event.consensus_confidence,
            )
            return

        if event.event_type == "TAR_REJECTED" and isinstance(event, TarRejectedEvent):
            await self._note_rejection(event)
            return

        if event.event_type == "STRESS_TESTED" and isinstance(event, StressTestedEvent):
            await self._consider_trade(event)

    async def _note_rejection(self, event: TarRejectedEvent) -> None:
        """Record that the CRO vetoed a TAR this agent submitted.

        The Supervisor does not retry, argue, or resubmit — the CRO's veto is
        final (spec Section 22.7: "You never bypass the CRO's veto"). This
        exists so the veto is recorded against the decision rather than
        disappearing, and so the operator can see how often and why the risk
        layer is refusing trades. A rising rejection rate for one rule is a
        signal that the Supervisor's sizing or the strategy is misconfigured.
        """
        rationale = f"CRO vetoed this TAR. Rule breached: {event.rule_breached}. {event.cro_rationale}"
        logger.info("Supervisor acknowledged CRO veto of TAR %s (%s)", event.tar_id, event.rule_breached)
        self.record_decision(
            "vetoed-by-cro",
            rationale,
            {"tar_id": str(event.tar_id), "rule_breached": event.rule_breached},
            acted=False,
        )
        await self._update_decision_outcome(str(event.tar_id), "rejected-by-risk", rationale)

    async def _update_decision_outcome(self, decision_id: str, outcome: str, rationale: str) -> None:
        """Update an existing decision row in place.

        An UPDATE rather than a second INSERT: the TAR already has a row with
        outcome 'pending-approval', and inserting another would make one
        decision look like two in every count and rate calculation.
        """
        pool = get_db_pool()
        if not pool:
            return
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    "UPDATE decisions SET outcome = $2, rationale = $3 WHERE id = $1",
                    decision_id,
                    outcome,
                    rationale,
                )
        except Exception as e:
            logger.error("Failed to update decision %s: %s", decision_id, e)

    async def _refuse(self, symbol: str, cause: str) -> None:
        """Record and log a decision NOT to trade.

        Refusals are persisted alongside approvals. A decision log that only
        contains the trades that happened cannot answer "why didn't it act
        on that setup?", which is the question an operator asks most often.
        """
        logger.info("Supervisor declined to submit a TAR for %s: %s", symbol, cause)
        await self._persist_decision(
            decision_id=str(uuid.uuid4()),
            symbol=symbol,
            side="buy",
            qty=0.0,
            price=0.0,
            outcome="declined",
            rationale=f"No TAR submitted: {cause}",
        )

    async def _consider_trade(self, event: StressTestedEvent) -> None:
        symbol = event.symbol

        if not event.passed:
            await self._refuse(symbol, f"failed stress tests ({event.results})")
            return

        # Operator kill switch. Checked here as well as in Execution, because
        # the cheapest place to stop is before a TAR enters the pipeline.
        if not may_open_new_position():
            await self._refuse(symbol, "system is paused or emergency-stopped by the operator")
            return

        # --- direction: from the debate, never assumed ------------------
        debate = self._debates.get(symbol)
        if debate is None:
            await self._refuse(
                symbol,
                "no debate conclusion available for this symbol, so trade direction is unknown "
                "(previously this defaulted to LONG)",
            )
            return

        age = (datetime.datetime.utcnow() - debate["ts"].replace(tzinfo=None)).total_seconds()
        if age > DEBATE_STALENESS_SECONDS:
            await self._refuse(
                symbol,
                f"the only debate conclusion for this symbol is {age:.0f}s old "
                f"(limit {DEBATE_STALENESS_SECONDS}s)",
            )
            return

        direction = debate["direction"]
        if direction not in ("LONG", "SHORT"):
            await self._refuse(symbol, f"debate concluded {direction} — no directional trade to make")
            return
            
        side = "buy" if direction == "LONG" else "sell"

        # --- price: real, or nothing ------------------------------------
        price = get_price(symbol)
        if price <= 0:
            await self._refuse(symbol, "no live price available (market data feed returned 0)")
            return

        # --- stop: computed from real volatility, or nothing ------------
        klines = await fetch_klines(symbol, "15m", limit=KLINE_LIMIT)
        if len(klines) < MIN_KLINES_FOR_ATR:
            await self._refuse(
                symbol,
                f"only {len(klines)} candle(s) available, need {MIN_KLINES_FOR_ATR} to compute ATR "
                f"and therefore a stop-loss",
            )
            return
            
        # --- PHASE 38 & 39: Regime Detection and Dynamic Thresholding -----
        from backend.agents.regime_agent import detect_market_regime
        from backend.algorithms.dynamic_thresholding import get_required_confidence, get_regime_risk_multiplier
        
        regime = detect_market_regime(klines)
        required_confidence = get_required_confidence(regime)
        
        if debate.get("confidence", 0) < required_confidence:
            await self._refuse(symbol, f"Confidence {debate.get('confidence', 0):.2f} does not meet the threshold {required_confidence:.2f} required for regime '{regime}'")
            return
            
        # --- PHASE 37: Bayesian Expected Value Evaluation ------------------
        from backend.algorithms.bayesian_engine import calculate_trade_probabilities
        bayesian_probs = calculate_trade_probabilities(debate)
        if bayesian_probs["expected_value"] <= 0:
            await self._refuse(symbol, f"Bayesian evaluation rejected trade: Expected Value is {bayesian_probs['expected_value']:.3f} (P(Profit)={bayesian_probs['p_profit']:.2f})")
            return
        # Record the probabilities into the debate dict so it can be logged downstream
        debate["bayesian_probs"] = bayesian_probs

        atr = calculate_atr(klines)
        sltp = compute_stop_loss_take_profit(price, atr, side)
        if sltp is None:
            await self._refuse(symbol, f"ATR computed as {atr}, so no stop-loss could be derived")
            return

        # --- size: from the stop distance and real equity ---------------
        tab = settings.execution_tab
        portfolio = await get_portfolio()
        equity = self._equity_for(portfolio, tab)
        if equity <= 0:
            await self._refuse(
                symbol,
                f"equity for the '{tab}' tab is unknown, so a risk-based position size "
                f"cannot be computed",
            )
            return

        # --- PHASE 40: Position Sizing AI -----------------------------
        from backend.core.risk_manager import calculate_dynamic_risk
        
        regime_multiplier = get_regime_risk_multiplier(regime)
        base_risk = settings.RISK_PER_TRADE
        ev = bayesian_probs["expected_value"]
        
        final_risk_fraction = calculate_dynamic_risk(base_risk, regime_multiplier, ev)

        if final_risk_fraction <= 0:
            await self._refuse(symbol, f"dynamic sizing returned zero risk for EV {ev:.3f} in regime {regime}")
            return

        size = calculate_position_size(equity, price, atr, final_risk_fraction)
        if size <= 0:
            await self._refuse(
                symbol,
                f"risk-based sizing returned {size} for equity ${equity:.2f} at ATR {atr:.6g} "
                f"— the smallest position consistent with the risk budget rounds to zero",
            )
            return

        # --- CIO: correlated-exposure cap (spec Section 18) -------------
        # Consulted BEFORE the TAR is built, so a correlated trade is sized
        # down here rather than rejected downstream. The CRO keeps the final
        # veto; this is an allocation constraint, not a second approval.
        from backend.agents.cio_agent import get_cio_agent

        exposure = await get_cio_agent().check_exposure(
            symbol=symbol, side=side, proposed_notional=size * price, equity=equity
        )
        if not exposure["allowed"]:
            await self._refuse(symbol, f"CIO exposure limit: {exposure['detail']}")
            return
        if exposure["max_notional"] < size * price:
            # Size down to the permitted notional rather than declining.
            reduced = exposure["max_notional"] / price
            logger.info(
                "CIO reduced %s position from %.8g to %.8g units: %s",
                symbol, size, reduced, exposure["detail"],
            )
            size = reduced
            if size <= 0:
                await self._refuse(symbol, f"CIO exposure limit leaves no room: {exposure['detail']}")
                return

        # This path requests no leverage. Clamped to the ceiling regardless,
        # so the value in the TAR can never exceed it even if this changes.
        requested_leverage = min(1, max_leverage_ceiling(tab))

        # --- final risk validation before the CRO ----------------------
        # Run here as well as in the CRO so a TAR that cannot pass basic
        # checks is never submitted. The CRO remains the authority; this is
        # not a substitute for its veto.
        validation = validate_trade(
            {
                "qty": size,
                "price": price,
                "equityUsd": equity,
                "klines": klines,
                "side": side,
                "tab": tab,
                "requestedLeverage": requested_leverage,
            }
        )
        if not validation.approved:
            await self._refuse(symbol, "pre-submission risk checks failed: " + "; ".join(validation.rejection_reasons))
            return

        rationale = (
            f"Debate concluded {direction} at {debate['confidence']:.0f}% confidence "
            f"({', '.join(debate['participants']) or 'no participants recorded'}); "
            f"stress tests passed; stop at {sltp['stopLoss']:.6g} "
            f"({abs(price - sltp['stopLoss']) / price * 100:.2f}% away). "
            f"Sizing [{sizing['rule']}]: {sizing['detail']} of ${equity:.2f} equity."
        )

        tar = TarSubmittedEvent(
            symbol=symbol,
            direction=direction,
            requested_size=size,
            requested_leverage=requested_leverage,
            strategy="Event-Driven Multi-Agent Pipeline",
            supervisor_rationale=rationale,
            stop_loss=sltp["stopLoss"],
            take_profit=sltp["takeProfit"],
            entry_price=price,
            tab=tab,
        )
        logger.info("Supervisor submitting TAR %s: %s %s %s @ %s", tar.tar_id, direction, size, symbol, price)

        await self._persist_decision(
            decision_id=str(tar.tar_id),
            symbol=symbol,
            side=side,
            qty=size,
            price=price,
            outcome="pending-approval",
            rationale=rationale,
        )
        await self.publish(tar)

    @staticmethod
    def _measured_win_rate() -> Optional[float]:
        """Win rate from the real trade ledger, or None below a usable sample.

        None rather than a default, because `kelly_risk_fraction` treats None as
        "use the fixed fraction" — a made-up win rate would feed Kelly a number
        nobody measured, and Kelly is at its most dangerous when its probability
        estimate is optimistic.
        """
        try:
            from backend.services.ai_memory import get_memory_stats

            stats = (get_memory_stats() or {}).get("global_stats") or {}
        except Exception:
            return None

        total = stats.get("total_trades") or 0
        wins = stats.get("wins") or 0
        # 20 trades is not a statistical threshold, it is a floor to stop a
        # three-win streak reading as a 100% win rate.
        if total < 20:
            return None
        return wins / total

    @staticmethod
    def _equity_for(portfolio: Dict[str, Any], tab: str) -> float:
        """Equity for a tab: cash plus the marked value of open positions.

        Returns 0.0 for the real tab when no cash figure is declared. That is
        deliberate — it makes the Supervisor refuse rather than size a real
        trade against an assumed balance. The real tab has no `cash` key in
        `portfolio_store` today, so real-money sizing needs an operator-
        declared starting capital first (the same gap the TypeScript side
        closed with TradingControls' realStartingCapitalUsd).
        """
        book = portfolio.get(tab) or {}
        cash = book.get("cash")
        if cash is None:
            return 0.0
        equity = float(cash)
        for pos in book.get("positions", []):
            live = get_price(pos.get("symbol", ""))
            # Fall back to entry cost only for marking existing holdings —
            # this is not inventing a price, it is stating the position at
            # book value when no live quote is available.
            mark = live if live > 0 else float(pos.get("avgCost", 0.0))
            equity += float(pos.get("qty", 0.0)) * mark
        return equity

    async def _persist_decision(
        self,
        decision_id: str,
        symbol: str,
        side: str,
        qty: float,
        price: float,
        outcome: str,
        rationale: str,
    ) -> None:
        pool = get_db_pool()
        if not pool:
            return
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO decisions (id, ts, symbol, side, tab, origin_tag, requested_qty, requested_price, outcome, urgency, rationale)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    """,
                    decision_id,
                    datetime.datetime.utcnow(),
                    symbol,
                    side,
                    # Was hardcoded 'real'; now reflects the actual execution
                    # mode so the decision log doesn't label paper decisions
                    # as real ones.
                    settings.execution_tab,
                    "agent-plan",
                    qty,
                    price,
                    outcome,
                    "normal",
                    rationale,
                )
        except Exception as e:
            logger.error(f"Failed to persist decision: {e}")


# Export an instance or a factory
def get_supervisor() -> SupervisorAgent:
    return SupervisorAgent()


async def request_trade_authorization(
    task_id: str, task: Dict[str, Any], symbol: str, price: float, intended_side: str
) -> Dict[str, Any]:
    """Authorization path for the task-based `trading_agent.py`.

    THIS USED TO BE A RUBBER STAMP. Verbatim:

        return {
            "approved": True,
            "optimal_qty": task.get("qty", 0.1),
            "tp_sl": {"takeProfit": price * 1.05, "stopLoss": price * 0.95},
            "receipt": "Legacy Approval Stub",
        }

    It approved every trade unconditionally and handed back a fabricated
    ±5% stop and target that had nothing to do with the instrument's actual
    volatility — on a stablecoin pair a 5% stop is never hit, on a small-cap
    it is hit by noise. `trading_agent.py` then wrote those numbers to
    `dynamic_sl_price` and traded against them.

    It now runs the real risk pipeline and returns `approved: False` with a
    reason when any required input is missing.
    """
    if not may_open_new_position():
        return {
            "approved": False,
            "reason": "system is paused or emergency-stopped by the operator",
            "optimal_qty": 0.0,
            "tp_sl": None,
            "receipt": "Blocked: operator kill switch active",
        }

    if price <= 0:
        return {
            "approved": False,
            "reason": "no live price available",
            "optimal_qty": 0.0,
            "tp_sl": None,
            "receipt": "Blocked: no price",
        }

    tab = task.get("tab") or settings.execution_tab
    klines = await fetch_klines(symbol, "15m", limit=KLINE_LIMIT)
    if len(klines) < MIN_KLINES_FOR_ATR:
        return {
            "approved": False,
            "reason": f"only {len(klines)} candle(s) available; need {MIN_KLINES_FOR_ATR} to compute a stop-loss",
            "optimal_qty": 0.0,
            "tp_sl": None,
            "receipt": "Blocked: no computable stop-loss",
        }

    atr = calculate_atr(klines)
    sltp = compute_stop_loss_take_profit(price, atr, intended_side)
    if sltp is None:
        return {
            "approved": False,
            "reason": f"ATR computed as {atr}; no stop-loss could be derived",
            "optimal_qty": 0.0,
            "tp_sl": None,
            "receipt": "Blocked: no computable stop-loss",
        }

    portfolio = await get_portfolio()
    equity = SupervisorAgent._equity_for(portfolio, tab)
    if equity <= 0:
        return {
            "approved": False,
            "reason": f"equity for the '{tab}' tab is unknown; cannot size by risk",
            "optimal_qty": 0.0,
            "tp_sl": None,
            "receipt": "Blocked: unknown equity",
        }

    size = calculate_position_size(equity, price, atr, settings.RISK_PER_TRADE)
    requested_leverage = min(float(task.get("leverage") or 1), max_leverage_ceiling(tab))

    validation = validate_trade(
        {
            "qty": size,
            "price": price,
            "equityUsd": equity,
            "klines": klines,
            "side": intended_side,
            "tab": tab,
            "requestedLeverage": requested_leverage,
        }
    )
    if not validation.approved:
        return {
            "approved": False,
            "reason": "; ".join(validation.rejection_reasons),
            "optimal_qty": 0.0,
            "tp_sl": None,
            "receipt": "Blocked by risk checks: " + "; ".join(validation.rejection_reasons),
        }

    return {
        "approved": True,
        "optimal_qty": size,
        "tp_sl": {"takeProfit": sltp["takeProfit"], "stopLoss": sltp["stopLoss"]},
        "requested_leverage": requested_leverage,
        "receipt": (
            f"Approved for task {task_id}: {size:.8g} {symbol} at {price}, stop {sltp['stopLoss']:.6g} "
            f"(ATR {atr:.6g}), risking {settings.RISK_PER_TRADE * 100:.1f}% of ${equity:.2f} equity, "
            f"leverage {requested_leverage}x (ceiling {max_leverage_ceiling(tab)}x)."
        ),
    }
