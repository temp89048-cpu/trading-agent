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

# The legacy analyze_reflection function has been replaced by the LangGraph
# reflection_graph.py, which maintains determinism but executes as a proper graph.

# Kept so existing callers (`services/ai_memory`, and this module's own
# `_reflect_on_close`) keep working, but modified to invoke the graph.
async def analyze_mistake(receipt: Dict[str, Any]) -> str:
    from backend.graphs.reflection_graph import get_reflection_graph

    # Compiled ONCE and reused. It was rebuilt per call, which costs a full LangGraph
    # compile each time — the same waste that made `vote_strategies` 78% compile
    # overhead before it was measured. Rarer here (once per closed trade) but free to
    # fix.
    app = get_reflection_graph()

    # NO thread_id is passed, and that is a correction rather than a simplification.
    #
    # It used to pass `config={"configurable": {"thread_id": f"reflection_{trade_id}"}}`
    # with the comment "ensures we don't cross-contaminate state across trades". That
    # is not what a thread_id does. It selects a CHECKPOINT thread — and this graph is
    # compiled with no checkpointer, so the id was inert. Every `ainvoke` already
    # starts from the state passed in, so isolation came from that, not from the
    # config.
    #
    # A comment claiming a safety property the code does not provide is worse than no
    # comment: it stops the next reader from checking.
    final_state = await app.ainvoke({"trade_receipt": receipt})
    
    lesson = final_state.get("lesson", "No lesson generated.")
    logger.info(f"Reflection Graph generated note for {receipt.get('symbol')}: {lesson}")
    return lesson


# Confidence calibration bounds. Capped so one large trade cannot dominate the
# series — an uncapped delta would let a single outsized win push calibration far
# enough that the next several trades could not correct it.
CALIBRATION_CAP = 5.0
# Dollars of realised P&L per point of calibration movement.
CALIBRATION_SCALE = 100.0


def calibration_delta(realized_pnl: float) -> float:
    """Confidence calibration movement from one closed trade.

    Shared by `ReflectionAgent` and `graphs/reflection_graph.py`. It lived inline in
    both, copied verbatim — and this number feeds `ConfidenceAgent`, which feeds
    position sizing, so two copies that could drift is a real hazard rather than a
    tidiness point.

    It replaced a constant `-5.0` applied to every trade including winners, which
    drove calibration monotonically downward forever regardless of performance.

    A KNOWN LIMITATION, stated rather than hidden: this is driven by P&L MAGNITUDE,
    not by whether the prediction was correct. A lucky win on a wrong-direction read
    still raises confidence. Spec Section 16's example ties calibration to
    prediction correctness ("Prediction: Correct · Entry: Too early"), which needs
    the predicted direction recorded at entry and compared at close — that data is
    not currently carried on `POSITION_CLOSED`. Fixing it properly means extending
    that event, not adjusting this formula.
    """
    return max(-CALIBRATION_CAP, min(CALIBRATION_CAP, realized_pnl / CALIBRATION_SCALE))


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

        # Extracted to `calibration_delta` below and shared with
        # `graphs/reflection_graph.py`, which had copied the expression verbatim.
        # Two copies of a rule that feeds position sizing is one too many.
        delta = calibration_delta(event.realized_pnl)

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
