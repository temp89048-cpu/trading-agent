import logging
from typing import Dict, Any, List
import os
from backend.core.agent_base import BaseAgent
from backend.models.events import (
    EventType,
    BaseEvent,
    OrderFilledEvent,
    PositionClosedEvent,
    ReflectionCompletedEvent,
)
from backend.core.db import get_db_pool
import datetime

logger = logging.getLogger(__name__)

async def analyze_reflection(receipt: Dict[str, Any]) -> str:
    """Write a reflection note for a closed trade — win or loss.

    TWO BUGS FIXED HERE.

    1. IT ASSUMED EVERY TRADE WAS A LOSS. It was named `analyze_mistake`, said
       "Strategies that failed" unconditionally, and ended with
       `f"We lost ${abs(pnl):.2f}"`. Spec Section 12 requires a reflection on
       every COMPLETED trade, not just losing ones — and since the Hypothesis
       agent now routes winners through here too, a profitable trade produced a
       note reading "We lost $120.00". Learning only from losses also biases the
       system toward explaining failure.

    2. IT LOGGED A CLAIM IT DIDN'T ACT ON. The LLM branch logged
       "LLM API Key found, skipping deterministic block in favor of LLM
       (Simulated)" while the actual call was commented out and the deterministic
       note was used regardless. So the log said the reflection came from a model
       when it did not. The branch now states plainly that no LLM path exists in
       the backend rather than implying one ran.

    The recommendation line is also no longer unconditional: it used to always
    advise decreasing confidence in the strategies involved, which on a winning
    trade is precisely backwards.
    """
    symbol = receipt.get("symbol", "UNKNOWN")
    side = receipt.get("side", "buy")
    pnl = float(receipt.get("pnl", 0.0))
    strategies = receipt.get("strategies", []) or []
    exit_reason = receipt.get("exit_reason")
    held = receipt.get("held_seconds")
    won = pnl >= 0

    parts: List[str] = []

    outcome = "gained" if won else "lost"
    parts.append(f"{symbol} {side.upper()} closed: {outcome} ${abs(pnl):.2f}.")

    if exit_reason:
        parts.append(f"Exit reason: {exit_reason}.")
    if held is not None:
        parts.append(f"Held {float(held):.0f}s.")

    if strategies:
        label = "Strategies active" if won else "Strategies active at the loss"
        parts.append(f"{label}: {', '.join(strategies)}.")

        # These read as observations rather than conclusions, because one trade
        # cannot establish which of several active strategies was responsible.
        if not won:
            if "trend" in strategies and "mean_reversion" not in strategies:
                parts.append(
                    "A trend entry that lost is consistent with the market mean-reverting shortly "
                    "after entry — worth checking against the regime at entry."
                )
            elif "breakout" in strategies:
                parts.append(
                    "A breakout entry that lost is consistent with a false breakout; the "
                    "false-breakout rate is the figure to check."
                )
    else:
        parts.append("No strategies were logged for this trade, so attribution is not possible.")

    # Directional, and only where the evidence supports it. A single trade is
    # weak evidence either way, which the wording reflects.
    if won:
        parts.append(
            "Recommendation: none from a single winning trade. Whether these conditions are "
            "repeatable is a question for the research queue, not a reason to weight up."
        )
    else:
        parts.append(
            "Recommendation: check whether losses cluster in this regime before changing any "
            "weighting. One loss is not evidence of a broken strategy."
        )

    reflection_note = " ".join(parts)

    # LLM path: not implemented in the backend, and said so rather than implied.
    if os.getenv("OPENAI_API_KEY"):
        logger.debug(
            "OPENAI_API_KEY is set, but the backend has no LLM reflection path — this note is "
            "deterministic. The model-backed reflection runs on the TypeScript side "
            "(lib/reflectionAgent.ts, prompt REFLECTION_V1)."
        )
            
    logger.info(f"Reflection Agent generated note for {symbol}: {reflection_note}")
    return reflection_note


# Kept so existing callers (`services/ai_memory`, and this module's own
# `_reflect_on_close`) keep working. The old name was part of the bug: calling
# it `analyze_mistake` is what made "every trade is a loss" feel natural.
analyze_mistake = analyze_reflection


class ReflectionAgent(BaseAgent):
    @property
    def name(self) -> str:
        return "Reflection Agent"

    @property
    def purpose(self) -> str:
        # "particularly losses" removed: Section 12 requires a reflection on
        # every completed trade, and learning only from losses biases the system
        # toward explaining failure.
        return "Analyzes every closed trade — win or loss — to produce a reflection the learning pipeline can build on."

    @property
    def permissions(self) -> List[str]:
        # Note what is absent: this agent may write memory but has no
        # permission to alter strategy or risk configuration. CLAUDE.md
        # invariant 5 — learning produces understanding, never a deployment.
        return ["READ_TRADES", "WRITE_MEMORY"]

    @property
    def inputs(self) -> List[str]:
        return [
            "POSITION_CLOSED events (real symbol, side, exit reason and realized P&L)",
            "ORDER_FILLED events (observed only; an opening fill produces no reflection)",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "REFLECTION_COMPLETED events carrying the lesson and a derived calibration delta",
            "Rows in the `reflections` table",
            "NO writes to strategy or risk configuration — deliberately outside its permissions",
        ]

    @property
    def category(self) -> str:
        return "learning"

    @property
    def events_consumed(self) -> List[EventType]:
        # REFLECTION_COMPLETED removed: this agent PUBLISHES that event, and
        # subscribing to its own output was both a latent feedback loop and
        # misleading in the contract — handle_event never acted on it.
        return ["POSITION_CLOSED", "ORDER_FILLED"]

    @property
    def events_published(self) -> List[EventType]:
        return ["REFLECTION_COMPLETED"]


    @property
    def responsibilities(self) -> List[str]:
        return ["Execute core duties as assigned."]

    @property
    def dependencies(self) -> List[str]:
        return ["MessageBus"]

    @property
    def memory_ttl(self) -> str:
        return "Ephemeral (process lifetime)"

    @property
    def knowledge_sources(self) -> List[str]:
        return ["Internal state"]

    @property
    def prompt_reference(self) -> str:
        return "REFLECTION_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return ["None"]

    @property
    def database_tables(self) -> List[str]:
        return ["None"]

    @property
    def metrics_reported(self) -> List[str]:
        return ["Uptime", "Events Processed"]

    @property
    def failure_recovery_strategy(self) -> str:
        return "Restart agent process"

    @property
    def health_status(self) -> str:
        return "Active"


    async def handle_event(self, event: BaseEvent) -> None:
        """Reflect on CLOSED positions only.

        WHAT THIS REPLACED. The previous implementation triggered on
        ORDER_FILLED — which fires when a position OPENS — and built its
        reflection from three hardcoded values:

            "symbol": "BTC/USDT",   # Mocking symbol since OrderFilledEvent
                                    # doesn't carry it (only tar_id)
            "side": "buy",
            "pnl": -50.0,           # Mock negative PNL to trigger reflection
            ...
            confidence_calibration_delta=-5.0

        So every reflection recorded a $50 loss on BTC/USDT for a trade that
        had just been entered and had no outcome yet. Two consequences beyond
        the obvious: the `reflections` table filled with fabricated losses,
        and those rows feed the win-rate the Confidence Agent calibrates
        against — so invented outcomes propagated into live position sizing.

        Reflection now waits for POSITION_CLOSED, which carries the real
        symbol, side and realized P&L as required fields. An opening fill
        produces no reflection, because an open position has not taught us
        anything yet.
        """
        if event.event_type == "POSITION_CLOSED" and isinstance(event, PositionClosedEvent):
            await self._reflect_on_close(event)
            return

        if event.event_type == "ORDER_FILLED" and isinstance(event, OrderFilledEvent):
            # An entry is not a lesson. Logged at debug so the absence of a
            # reflection here is explainable rather than mysterious.
            logger.debug(
                "Order %s filled for %s — no reflection generated: an opening fill has no "
                "outcome to learn from. Awaiting POSITION_CLOSED.",
                event.order_id,
                event.symbol,
            )
            return

    async def _reflect_on_close(self, event: PositionClosedEvent) -> None:
        receipt = {
            "symbol": event.symbol,
            "side": event.side,
            "pnl": event.realized_pnl,
            "entry_price": event.entry_price,
            "exit_price": event.exit_price,
            "quantity": event.quantity,
            "exit_reason": event.exit_reason,
            "strategies": list(event.strategies),
            "held_seconds": event.held_seconds,
        }

        note = await analyze_mistake(receipt)

        # Confidence calibration delta, derived rather than hardcoded. It used
        # to be a constant -5.0 on every trade, including winners — which
        # would drive calibration monotonically downward forever regardless of
        # actual performance. Sign follows the outcome; magnitude is capped so
        # one large trade can't dominate the series.
        delta = max(-5.0, min(5.0, event.realized_pnl / 100.0))

        rationale = (
            f"{event.symbol} {event.side} closed at {event.exit_price:.6g} from "
            f"{event.entry_price:.6g} ({event.exit_reason}), realized "
            f"{'+' if event.realized_pnl >= 0 else ''}{event.realized_pnl:.2f}."
        )
        self.record_decision("reflected", rationale, receipt, acted=True)

        await self._persist_reflection(event.trade_id, event.symbol, note)

        await self.publish(
            ReflectionCompletedEvent(
                trade_id=event.trade_id,
                pnl=event.realized_pnl,
                lesson_learned=note,
                confidence_calibration_delta=delta,
            )
        )

    async def _persist_reflection(self, trade_id: str, symbol: str, content: str):
        pool = get_db_pool()
        if not pool: return
        
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO reflections (trade_id, ts, symbol, content, exit_context_used)
                    VALUES ($1, $2, $3, $4, $5)
                    ON CONFLICT (trade_id) DO UPDATE SET content = $4
                    """,
                    trade_id, datetime.datetime.utcnow(), symbol, content, "Auto-generated reflection"
                )
        except Exception as e:
            logger.error(f"Failed to persist reflection for {trade_id}: {e}")

def get_reflection_agent() -> ReflectionAgent:
    return ReflectionAgent()
