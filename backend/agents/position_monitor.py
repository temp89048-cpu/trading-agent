"""Position Monitor — the "Monitor" stage of spec Section 6's chain.

    ... -> Supervisor -> Risk -> Execution -> **Monitor** -> Reflection -> Learning ...

THE GAP THIS FILLS
------------------
The event pipeline could OPEN a position and had nothing that ever closed one.

  * `TarApprovedEvent.stop_loss` travelled all the way to the Execution Engine,
    which logged it and moved on. No component compared price against it.
  * `PositionClosedEvent` was consumed by the CEO (equity tracking) and the
    Reflection agent (learning) but published by nobody, so both were dead.
  * `workers/monitor_worker.py` looked like the missing piece but was entirely
    mocked — `open_positions = [{"symbol": "BTC-USDT", "pnl_pct": -2.5}]`
    hardcoded, its publish call commented out — and `main.py` never started it.

So a position opened through the event chain was held forever, with a stop that
existed only as a number in a log line. Spec Section 22.8 names this exact
failure: *"the worst case is not 'the bot makes a bad trade' but 'the bot goes
silent while holding a leveraged position'."*

HOW IT KNOWS THE STOP
---------------------
Two events are needed and neither carries everything:
  * TAR_APPROVED  -> tar_id, stop_loss, take_profit, tab
  * ORDER_FILLED  -> tar_id, symbol, side, fill_price, fill_quantity

They are joined on `tar_id`. A fill whose TAR was never seen is tracked as an
UNPROTECTED position and logged as critical rather than quietly ignored — an
untracked open position is the thing this agent exists to prevent.

IN-PROCESS ONLY — STATED PLAINLY
--------------------------------
This is a soft stop: it fires only while this process is running and receiving
ticks. It is NOT a resting order at the exchange. If the backend dies, nothing
closes the position. That remains the single highest-value reliability gap in
the system, and this agent narrows it (from "nothing watches at all" to
"something watches while we're up") without closing it.
"""

import datetime
import logging
from typing import Any, Dict, List, Optional, Tuple

from backend.core.agent_base import BaseAgent
from backend.models.events import (
    BaseEvent,
    EventType,
    OrderFilledEvent,
    PositionClosedEvent,
    TarApprovedEvent,
    TickReceivedEvent,
)

logger = logging.getLogger(__name__)


class _Tracked:
    """One open position being watched."""

    __slots__ = (
        "tar_id", "symbol", "side", "tab", "qty", "entry_price",
        "stop_loss", "take_profit", "opened_at", "peak_price",
    )

    def __init__(self, **kw):
        for k in self.__slots__:
            setattr(self, k, kw.get(k))


class PositionMonitorAgent(BaseAgent):
    version = "1.0.0"
    priority = 15  # after execution, before learning

    def __init__(self, execution_agent=None) -> None:
        # tar_id -> stop/target, captured at approval and joined to the fill.
        self._pending: Dict[str, Dict[str, Any]] = {}
        # tar_id -> tracked open position
        self._open: Dict[str, _Tracked] = {}
        self._execution = execution_agent
        # Guards against a re-entrant close: a tick can arrive while an await
        # on the exchange is in flight, and without this the same position
        # would be closed twice.
        self._closing: set = set()
        super().__init__()

    # ---------------- contract ----------------

    @property
    def name(self) -> str:
        return "Position Monitor"

    @property
    def purpose(self) -> str:
        return "Watches every open position against its approved stop-loss and take-profit, closes it when either is reached, and reports the realized outcome."

    @property
    def permissions(self) -> List[str]:
        # CLOSE_POSITIONS but not ROUTE_ORDERS: it may exit a position, never
        # enter one. The distinction is what stops a monitoring loop from
        # becoming a second entry path that bypasses Risk.
        return ["READ_MARKET_DATA", "CLOSE_POSITIONS"]

    @property
    def inputs(self) -> List[str]:
        return [
            "TAR_APPROVED events (stop-loss and take-profit, keyed by tar_id)",
            "ORDER_FILLED events (entry price, quantity, symbol, side)",
            "TICK_RECEIVED events (current price, to compare against the stop)",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "POSITION_CLOSED events with real realized P&L and a specific exit_reason",
            "Market close orders via the Execution Engine's close_position()",
            "Critical log lines for a fill with no matching TAR (an unprotected position)",
        ]

    @property
    def category(self) -> str:
        return "execution"

    @property
    def events_consumed(self) -> List[EventType]:
        return ["TAR_APPROVED", "ORDER_FILLED", "TICK_RECEIVED"]

    @property
    def events_published(self) -> List[EventType]:
        return ["POSITION_CLOSED"]

    @property
    def responsibilities(self) -> List[str]:
        return [
            "Join TAR_APPROVED to ORDER_FILLED so every position has a known stop.",
            "Compare each tick against stop and target, and close on breach.",
            "Report realized P&L and WHY the position closed, not just that it did.",
            "Flag any filled position it cannot protect.",
        ]

    @property
    def dependencies(self) -> List[str]:
        return ["MessageBus", "ExecutionAgent (for the close path)"]

    @property
    def memory_ttl(self) -> str:
        return (
            "Open positions held in-process only, for the life of the position. NOT persisted — "
            "a restart loses the watch list, which is why this is a soft stop and not a "
            "substitute for a resting exchange order."
        )

    @property
    def knowledge_sources(self) -> List[str]:
        return ["Approved TARs", "Order fills", "Live ticks"]

    @property
    def prompt_reference(self) -> str:
        return "POSITION_MONITOR_DETERMINISTIC_V1"

    @property
    def apis_used(self) -> List[str]:
        return ["Exchange market orders, via ExecutionAgent.close_position"]

    @property
    def database_tables(self) -> List[str]:
        return []

    @property
    def metrics_reported(self) -> List[str]:
        return ["Open positions watched", "Closes by exit reason", "Unprotected fills detected"]

    @property
    def failure_recovery_strategy(self) -> str:
        return (
            "A failed close leaves the position tracked and retries on the next tick — it is NOT "
            "dropped from the watch list, because an untracked open position is the failure this "
            "agent exists to prevent. A restart loses the watch list entirely; that limitation is "
            "documented rather than hidden."
        )

    @property
    def health_status(self) -> str:
        return "Active"

    # ---------------- behaviour ----------------

    def attach_execution(self, execution_agent) -> None:
        """Wire the close path after construction (main.py builds both)."""
        self._execution = execution_agent

    @property
    def open_position_count(self) -> int:
        return len(self._open)

    # ------------------------------------------------------------------
    # Phase 30 / spec Section 13 — read and modify, for the monitoring graph
    # ------------------------------------------------------------------

    def snapshot_open(self) -> List[Dict[str, Any]]:
        """Plain-dict view of every watched position.

        THIS AGENT IS THE SINGLE SOURCE OF TRUTH ON WHAT IS OPEN, and the
        monitoring graph reads through here rather than keeping its own book. Two
        books would disagree after a restart, and the one that must be right is the
        one enforcing the stop.

        Returns copies, not `_Tracked` objects: a caller holding a reference could
        otherwise assign `pos.stop_loss` directly and bypass `tighten_stop`'s
        widen-refusal, which is the one rule in this phase that must not be
        bypassable.
        """
        out: List[Dict[str, Any]] = []
        for pos in self._open.values():
            out.append({
                "tarId": pos.tar_id,
                "symbol": pos.symbol,
                "side": pos.side,
                "tab": pos.tab,
                "qty": pos.qty,
                "entryPrice": pos.entry_price,
                "stopLoss": pos.stop_loss,
                "takeProfit": pos.take_profit,
                "openedAtTs": pos.opened_at.timestamp() if pos.opened_at else None,
                "peakPrice": pos.peak_price,
            })
        return out

    def tighten_stop(self, tar_id: str, new_stop: float) -> Tuple[bool, str]:
        """Move a stop CLOSER to price. Refuses to move it further away.

        THE MOST IMPORTANT RULE IN PHASE 30.

        Widening a stop increases risk beyond what the Risk Gateway approved and
        sized the position against. The per-trade risk limit was computed from the
        entry-to-stop distance, so moving the stop away silently invalidates that
        computation — the position now risks more than 3% of equity while every
        record still says it risks 3%.

        It is also the specific mechanism by which a small loss becomes a large
        one: "give it room to breathe" is a widened stop, and a stop that can be
        widened when price approaches it is not a stop at all.

        So this is a one-way ratchet, enforced here rather than trusted to callers.
        The monitoring graph REQUESTS a new stop; this method decides.

        Returns `(applied, reason)`. A refusal is not an error — a trailing rule
        that proposes a stop already worse than the current one is ordinary.
        """
        pos = self._open.get(tar_id)
        if pos is None:
            return False, f"no open position with tar_id {tar_id} is being monitored"

        if new_stop is None or new_stop <= 0:
            return False, f"refusing a non-positive stop ({new_stop!r})"

        current = pos.stop_loss
        if current is None:
            # A tracked position with no stop should be impossible — `_register_fill`
            # requires an approved stop. Accepting one here anyway is strictly safer
            # than leaving it unprotected, and it is logged loudly.
            pos.stop_loss = new_stop
            logger.warning(
                "Position %s had NO stop; set to %s. This should be unreachable — "
                "_register_fill requires an approved stop.",
                pos.symbol, new_stop,
            )
            return True, f"position had no stop; set to {new_stop:.8g}"

        # 'buy' means a long: a HIGHER stop is tighter. 'sell' is the mirror.
        tighter = new_stop > current if pos.side == "buy" else new_stop < current

        if not tighter:
            return False, (
                f"refused: {new_stop:.8g} is not tighter than the current "
                f"{current:.8g} for a {'long' if pos.side == 'buy' else 'short'}. "
                f"Widening a stop increases risk beyond what was approved and sized "
                f"against — this is a one-way ratchet."
            )

        # A stop already through the current price would close instantly at whatever
        # the next tick is. That is not a tightened stop, it is a market exit
        # disguised as one, and it must be requested as an EXIT so it is recorded as
        # a decision rather than as a stop-out.
        if pos.side == "buy" and pos.peak_price is not None and new_stop >= pos.peak_price:
            return False, (
                f"refused: {new_stop:.8g} is at or above the peak price "
                f"{pos.peak_price:.8g}, so it would fire on the next tick. Request an "
                f"EXIT instead of disguising one as a stop."
            )
        if pos.side == "sell" and pos.peak_price is not None and new_stop <= pos.peak_price:
            return False, (
                f"refused: {new_stop:.8g} is at or below the trough price "
                f"{pos.peak_price:.8g}, so it would fire on the next tick. Request an "
                f"EXIT instead of disguising one as a stop."
            )

        pos.stop_loss = new_stop
        logger.info(
            "Tightened stop on %s %s: %.8g -> %.8g (entry %s)",
            pos.side, pos.symbol, current, new_stop, pos.entry_price,
        )
        self.record_decision(
            "stop-tightened",
            f"{pos.symbol} stop moved {current:.8g} -> {new_stop:.8g} (tighter only).",
            {"tarId": tar_id, "previousStop": current, "newStop": new_stop},
            acted=True,
        )
        return True, f"stop tightened {current:.8g} -> {new_stop:.8g}"

    async def handle_event(self, event: BaseEvent) -> None:
        if isinstance(event, TarApprovedEvent):
            self._pending[str(event.tar_id)] = {
                "stop_loss": event.stop_loss,
                "take_profit": event.take_profit,
                "tab": event.tab,
            }
            return

        if isinstance(event, OrderFilledEvent):
            self._register_fill(event)
            return

        if isinstance(event, TickReceivedEvent):
            await self._check_price(event.symbol, event.price)
            return

    def _register_fill(self, event: OrderFilledEvent) -> None:
        tar_id = str(event.tar_id)
        approved = self._pending.pop(tar_id, None)

        if approved is None:
            # A fill with no matching approval. Loud, not silent: this position
            # is open and has no stop this agent can enforce.
            logger.critical(
                "UNPROTECTED POSITION: %s %s %s filled at %s (order %s) with no matching "
                "TAR_APPROVED, so no stop-loss is known and this position will NOT be "
                "monitored. Close it manually or restart the pipeline.",
                event.side, event.fill_quantity, event.symbol, event.fill_price, event.order_id,
            )
            self.record_decision(
                "unprotected-fill",
                f"{event.symbol} filled with no approved stop — not monitorable.",
                {"orderId": event.order_id, "tarId": tar_id},
                acted=False,
            )
            return

        tracked = _Tracked(
            tar_id=tar_id,
            symbol=event.symbol,
            side=event.side,
            tab=approved["tab"],
            qty=event.fill_quantity,
            entry_price=event.fill_price,
            stop_loss=approved["stop_loss"],
            take_profit=approved["take_profit"],
            opened_at=datetime.datetime.utcnow(),
            peak_price=event.fill_price,
        )
        self._open[tar_id] = tracked
        logger.info(
            "Monitoring %s %s %s from %s (stop %s, target %s). %d position(s) watched.",
            event.side, event.fill_quantity, event.symbol, event.fill_price,
            approved["stop_loss"], approved["take_profit"], len(self._open),
        )
        self.record_decision(
            "monitoring",
            f"Watching {event.symbol} from {event.fill_price} with stop {approved['stop_loss']}.",
            {"tarId": tar_id, "stopLoss": approved["stop_loss"], "takeProfit": approved["take_profit"]},
            acted=True,
        )

    async def _check_price(self, symbol: str, price: float) -> None:
        if price <= 0:
            return  # a zero tick is missing data, not a price collapse

        # Snapshot the keys: closing mutates self._open mid-iteration.
        for tar_id in list(self._open.keys()):
            pos = self._open.get(tar_id)
            if pos is None or pos.symbol != symbol or tar_id in self._closing:
                continue

            if pos.side == "buy":
                pos.peak_price = max(pos.peak_price, price)
                hit_stop = pos.stop_loss is not None and price <= pos.stop_loss
                hit_target = pos.take_profit is not None and price >= pos.take_profit
            else:
                pos.peak_price = min(pos.peak_price, price)
                hit_stop = pos.stop_loss is not None and price >= pos.stop_loss
                hit_target = pos.take_profit is not None and price <= pos.take_profit

            if not hit_stop and not hit_target:
                continue

            # Stop takes precedence when a single tick spans both levels. A
            # candle that gapped through the stop AND the target is far more
            # likely to have hit the stop first, and assuming the favourable
            # one would systematically overstate performance.
            reason = "stop-loss" if hit_stop else "take-profit"
            await self._close(pos, price, reason)

    async def _close(self, pos: _Tracked, trigger_price: float, reason: str) -> None:
        if self._execution is None:
            logger.critical(
                "%s hit for %s at %s but no Execution Engine is attached — the position is "
                "STILL OPEN and cannot be closed by this agent.",
                reason, pos.symbol, trigger_price,
            )
            return

        self._closing.add(pos.tar_id)
        try:
            fill_price = await self._execution.close_position(
                symbol=pos.symbol,
                entry_side=pos.side,
                qty=pos.qty,
                tab=pos.tab,
                reason=reason,
            )

            if fill_price is None:
                # Kept in the watch list on purpose — see
                # failure_recovery_strategy. Dropping it would leave an open
                # position with nothing watching it.
                logger.error(
                    "Close of %s failed (%s at %s). Position REMAINS TRACKED and will be "
                    "retried on the next tick.",
                    pos.symbol, reason, trigger_price,
                )
                return

            # Realized P&L from the ACTUAL fill, not the trigger price. The two
            # differ by slippage, and using the trigger would report the P&L we
            # hoped for rather than the one we got.
            sign = 1 if pos.side == "buy" else -1
            realized = (fill_price - pos.entry_price) * pos.qty * sign
            held = (datetime.datetime.utcnow() - pos.opened_at).total_seconds()

            self._open.pop(pos.tar_id, None)

            logger.info(
                "Closed %s at %s (%s, triggered at %s): realized %+.2f after %.0fs. "
                "%d position(s) still watched.",
                pos.symbol, fill_price, reason, trigger_price, realized, held, len(self._open),
            )
            self.record_decision(
                f"closed-{reason}",
                f"{pos.symbol} closed at {fill_price} ({reason}), realized {realized:+.2f}.",
                {
                    "entryPrice": pos.entry_price,
                    "exitPrice": fill_price,
                    "triggerPrice": trigger_price,
                    "realizedPnl": realized,
                    "heldSeconds": held,
                },
                acted=True,
            )

            await self.publish(
                PositionClosedEvent(
                    trade_id=pos.tar_id,
                    symbol=pos.symbol,
                    side=pos.side,
                    tab=pos.tab,
                    entry_price=pos.entry_price,
                    exit_price=fill_price,
                    quantity=pos.qty,
                    realized_pnl=realized,
                    exit_reason=reason,
                    held_seconds=held,
                )
            )
        finally:
            self._closing.discard(pos.tar_id)


def get_position_monitor() -> PositionMonitorAgent:
    return PositionMonitorAgent()
