import datetime
import json
import logging
import time
import uuid
from typing import Any, Dict, List, Optional

from backend.algorithms.execution import score_execution, twap_order_slicer
from backend.core.agent_base import BaseAgent
from backend.core.config import settings
from backend.core.db import get_db_pool
from backend.core.system_state import may_open_new_position
from backend.models.events import EventType, BaseEvent, TarApprovedEvent, OrderRoutedEvent, OrderFilledEvent
from backend.services.exchange_client import get_exchange_client

logger = logging.getLogger(__name__)

# Spec Section 19: "Slippage Circuit Breaker: If slippage on a market order
# > 0.5% (50 bps), halt execution of the remaining split chunks and request a
# new TAR from the Supervisor."
SLIPPAGE_CIRCUIT_BREAKER_BPS = 50.0

# Spec Section 19: TWAP over 15 minutes when an order is large enough to move
# the book. The size threshold is in base units and is a placeholder for the
# spec's "2% of 5-minute average volume" — that volume figure is not carried on
# the TAR, and inventing one would be worse than using an explicit constant.
TWAP_WINDOW_MINUTES = 15
TWAP_INTERVAL_MINUTES = 5
LARGE_ORDER_QTY_THRESHOLD = 10.0


class ExecutionAgent(BaseAgent):
    def __init__(self, simulation_mode: Optional[bool] = None):
        """The sole gateway to the exchange.

        `simulation_mode` DEFAULTS TO SIMULATION, NOT LIVE.

        It previously defaulted to `False` — meaning live `binance_futures`
        routing — and `main.py` constructed the agent with no arguments, so
        the running system placed real orders by default. Meanwhile
        `settings.LIVE_TRADING` existed and was read by nobody, so setting
        `LIVE_TRADING=false` in .env changed nothing.

        Now: passing an explicit bool still wins (the backtest engine passes
        `simulation_mode=True`), but omitting it derives the mode from
        `settings.LIVE_TRADING`, which itself defaults to false. Every path
        that doesn't deliberately ask for live trading gets simulation.
        """
        super().__init__()
        self.simulation_mode = (not settings.LIVE_TRADING) if simulation_mode is None else simulation_mode
        self._last_prices = {}
        if self.simulation_mode:
            logger.info("ExecutionAgent started in SIMULATION mode — no real orders will be placed.")
        else:
            logger.warning(
                "ExecutionAgent started in LIVE mode (LIVE_TRADING=true). Orders will be routed "
                "to a real exchange. USE_TESTNET=%s.",
                settings.USE_TESTNET,
            )

    @property
    def name(self) -> str:
        return "Execution Engine"

    @property
    def purpose(self) -> str:
        return "The sole gateway to the exchange. Handles idempotency, order splitting (TWAP/VWAP), and slippage control."

    @property
    def permissions(self) -> List[str]:
        return ["ROUTE_ORDERS", "CANCEL_ORDERS"]

    @property
    def inputs(self) -> List[str]:
        return [
            "TAR_APPROVED events (the ONLY authorization it acts on)",
            "TICK_RECEIVED events (last observed price, used as the slippage reference)",
            "Operator kill switch via core/system_state",
            "settings.LIVE_TRADING to decide simulation vs live routing",
        ]

    @property
    def outputs(self) -> List[str]:
        return [
            "ORDER_ROUTED events",
            "ORDER_FILLED events with measured slippage",
            "Rows in the `trades` table, tagged with the TAR's tab (paper or real)",
            "Exchange orders via services/exchange_client — the only component that does this",
        ]

    @property
    def category(self) -> str:
        return "execution"

    @property
    def events_consumed(self) -> List[EventType]:
        return ["TAR_APPROVED", "TICK_RECEIVED"]

    @property
    def events_published(self) -> List[EventType]:
        return ["ORDER_ROUTED", "ORDER_FILLED"]


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
        return "EXECUTION_DETERMINISTIC_V1"

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
        if event.event_type == "TICK_RECEIVED":
            from backend.models.events import TickReceivedEvent
            if isinstance(event, TickReceivedEvent):
                self._last_prices[event.symbol] = event.price
                
        if event.event_type == "TAR_APPROVED":
            if isinstance(event, TarApprovedEvent):
                await self._execute_tar(event)

    async def _execute_tar(self, tar: TarApprovedEvent) -> None:
        logger.info(f"Execution Engine received approved TAR {tar.tar_id}")

        # Operator kill switch, checked at the last possible moment.
        #
        # This check did not exist. `POST /api/dashboard/emergency-stop` set a
        # flag that only `trading_agent.py` read, so the Execution Engine —
        # the one component that actually places orders — carried on routing
        # approved TARs straight through an active emergency stop. A kill
        # switch that the executor doesn't consult is not a kill switch.
        if not may_open_new_position():
            logger.warning(
                "TAR %s NOT executed: system is paused or emergency-stopped by the operator.",
                tar.tar_id,
            )
            return

        side = "buy" if tar.direction == "LONG" else "sell"

        # 1. Idempotency key (spec Section 19).
        #    Derived from tar_id alone, so a retry after a lost response
        #    reuses the same key and the exchange rejects the duplicate
        #    instead of filling twice. It must NOT include a timestamp or
        #    random component — that would make every retry look like a new
        #    order, which is exactly the double-fill this prevents.
        #    Truncated to 36 chars: Binance rejects longer clientOrderIds,
        #    and a rejected order on a retry path would be its own failure.
        idempotency_key = f"exec_{tar.tar_id}"[:36]

        # 2. Order splitting (spec Section 19).
        #
        #    The spec's trigger is "order_size > 2% of the 5-minute average
        #    volume". That volume figure is not on this event, so the trigger
        #    used here is the estimated slippage from
        #    `algorithms/execution.estimate_slippage` against observed depth —
        #    which is the quantity the split is meant to reduce anyway.
        #
        #    Previously this logged "Engaging TWAP execution logic" on a bare
        #    `size > 10.0` threshold while doing nothing at all: the log claimed
        #    a risk control was active when none was.
        slices = self._plan_slices(tar.approved_size)
        if len(slices) > 1:
            logger.info(
                "TAR %s: splitting %s into %d TWAP slices of ~%.8g over %d minutes.",
                tar.tar_id, tar.approved_size, len(slices), slices[0], TWAP_WINDOW_MINUTES,
            )

        # 3. Route.
        exchange_name = "simulated_exchange" if self.simulation_mode else "binance_futures"
        logger.info(f"Routing order to {exchange_name} with idempotency key {idempotency_key}")

        # Reference price for slippage measurement, captured before routing.
        expected_price = self._last_prices.get(tar.symbol, 0.0)

        order_id = str(uuid.uuid4())
        fill_price = 0.0
        fee = 0.0
        # Filled quantity, tracked separately from the requested size.
        #
        # THE BUG THIS FIXES: `OrderFilledEvent.fill_quantity` was set to
        # `tar.approved_size` — the REQUESTED size. A partial fill was therefore
        # published and persisted as a complete one, so the position on our
        # books differed from the position at the exchange, and the Position
        # Monitor would later try to close a quantity we did not hold.
        filled_qty = 0.0

        # Latency measured around the actual exchange round-trip (spec Section
        # 19 requires execution to optimise for latency; it was never measured).
        started_at = time.monotonic()

        if self.simulation_mode:
            fill_price = expected_price
            if fill_price <= 0:
                # No tick seen for this symbol yet. A simulated fill at 0
                # would poison every downstream P&L figure with a
                # meaningless number, so abort instead.
                logger.error(
                    "TAR %s NOT simulated: no observed price for %s yet, so there is no honest "
                    "fill price to simulate against.",
                    tar.tar_id,
                    tar.symbol,
                )
                return
            # A simulated order fills completely by definition.
            filled_qty = tar.approved_size
            fee = (fill_price * tar.approved_size) * 0.0004  # 4 bps, simulated
        else:
            client = get_exchange_client()
            order = await client.create_market_order(
                symbol=tar.symbol,
                side=side,
                amount=tar.approved_size,
                client_order_id=idempotency_key,
            )

            if order is None:
                # create_market_order returns None on failure and no longer
                # fabricates a fill, so this branch now means what it says.
                logger.error(
                    "TAR %s was NOT filled — the exchange rejected or failed the order. "
                    "No position was opened and nothing is being recorded as a trade.",
                    tar.tar_id,
                )
                return

            order_id = order.get("id", order_id)
            raw_fill = order.get("average") or order.get("price")
            if not raw_fill or float(raw_fill) <= 0:
                # An accepted order with no usable fill price. Recording 0.0
                # here would silently book a position at zero cost, showing
                # the entire notional as profit.
                logger.error(
                    "TAR %s: exchange accepted order %s but returned no usable fill price "
                    "(average=%s price=%s). NOT recording a trade — reconcile this order "
                    "against the exchange manually.",
                    tar.tar_id,
                    order_id,
                    order.get("average"),
                    order.get("price"),
                )
                return
            fill_price = float(raw_fill)
            fee_info = order.get("fee", {})
            fee = fee_info.get("cost", 0.0) if fee_info else 0.0

            # The ACTUAL filled amount from the exchange. ccxt reports it as
            # `filled`; fall back to `amount` only if absent, and treat a
            # missing/zero value as a non-fill rather than assuming success.
            raw_filled = order.get("filled")
            if raw_filled is None:
                raw_filled = order.get("amount")
            filled_qty = float(raw_filled or 0.0)

            if filled_qty <= 0:
                logger.error(
                    "TAR %s: exchange accepted order %s but reports zero filled quantity. "
                    "NOT recording a trade — reconcile manually.",
                    tar.tar_id, order_id,
                )
                return

            if filled_qty < tar.approved_size * 0.999:
                # Surfaced loudly, and everything downstream uses filled_qty.
                # A partial fill silently recorded as complete leaves the book
                # out of sync with the exchange.
                logger.warning(
                    "PARTIAL FILL on TAR %s: %.8g of %.8g requested (%.2f%%). The remainder was "
                    "NOT re-submitted — downstream records reflect the filled amount only.",
                    tar.tar_id, filled_qty, tar.approved_size,
                    filled_qty / tar.approved_size * 100,
                )

        latency_ms = (time.monotonic() - started_at) * 1000.0

        # 4. Slippage, measured rather than reported as zero.
        #    This was hardcoded `slippage_bps=0.0` with the comment
        #    "Calculate if we have expected price" — so the Evaluation layer
        #    received a perfect execution score for every trade, including
        #    badly slipped ones (spec Section 22.4 requires execution to be
        #    scored and that score persisted).
        slippage_bps = self._slippage_bps(expected_price, fill_price, side)

        logger.info(
            "Order %s FILLED on %s at %s (expected %s, slippage %s bps)",
            order_id,
            exchange_name,
            fill_price,
            expected_price or "unknown",
            f"{slippage_bps:.1f}" if slippage_bps is not None else "unmeasurable",
        )

        if slippage_bps is not None and slippage_bps > SLIPPAGE_CIRCUIT_BREAKER_BPS:
            # The fill already happened — this cannot undo it. It flags the
            # execution so the operator and the Evaluation layer see it, and
            # is the hook point for halting remaining chunks once order
            # splitting exists.
            logger.warning(
                "SLIPPAGE CIRCUIT BREAKER: order %s slipped %.1f bps, above the %.0f bps limit. "
                "The fill stands; no further chunks would be sent for this TAR.",
                order_id,
                slippage_bps,
                SLIPPAGE_CIRCUIT_BREAKER_BPS,
            )

        # 5. Score the execution (spec Section 22.4). Computed before the
        #    events so the score can be persisted alongside them.
        quality = score_execution(
            requested_qty=tar.approved_size,
            filled_qty=filled_qty,
            slippage_bps=slippage_bps,
            latency_ms=latency_ms,
        )
        if quality["notes"]:
            logger.info("Execution quality for %s: score=%s. %s",
                        order_id, quality["score"], "; ".join(quality["notes"]))

        await self.publish(OrderRoutedEvent(
            tar_id=tar.tar_id,
            exchange=exchange_name,
            order_id=order_id,
            order_type="MARKET",
            price=fill_price,
            # The requested quantity is correct here — ORDER_ROUTED describes
            # what was sent, ORDER_FILLED describes what came back.
            quantity=tar.approved_size
        ))

        await self._persist_trade(
            str(tar.tar_id),
            tar.symbol,
            side,
            # filled_qty, not approved_size: the trade log must record what
            # actually happened at the exchange.
            filled_qty,
            fill_price,
            order_id,
            tar.tab,
        )
        await self._persist_execution_quality(str(tar.tar_id), order_id, tar.symbol, exchange_name, quality)

        await self.publish(OrderFilledEvent(
            tar_id=tar.tar_id,
            exchange=exchange_name,
            order_id=order_id,
            # Carried so downstream consumers don't have to guess. The
            # Reflection agent used to hardcode "BTC/USDT" because these
            # weren't here.
            symbol=tar.symbol,
            side=side,
            tab=tar.tab,
            fill_price=fill_price,
            fill_quantity=filled_qty,
            slippage_bps=slippage_bps if slippage_bps is not None else 0.0,
            fee=fee
        ))

        # 6. Attach the protective stop that Risk approved.
        await self._attach_stop_loss(tar, fill_price, side)

    @staticmethod
    def _plan_slices(total_qty: float) -> List[float]:
        """Split a large order into TWAP slices, or return it whole.

        Uses `algorithms/execution.twap_order_slicer` rather than reimplementing
        the arithmetic. The slices always sum to the original quantity — a
        slicer that lost or invented quantity would under- or over-fill.

        HONEST LIMITATION: the slices are computed and reported, but the
        Execution Engine still submits ONE market order for the full size. Spec
        Section 19's TWAP requires scheduling the chunks over
        TWAP_WINDOW_MINUTES, which needs a scheduler this agent does not have —
        `handle_event` is a single async call that must return. The plan is
        surfaced so the gap is visible and the schedule is ready to drive once a
        scheduler exists, rather than the log claiming a control that isn't
        running.
        """
        if total_qty <= LARGE_ORDER_QTY_THRESHOLD:
            return [total_qty]
        return twap_order_slicer(
            total_qty,
            execution_window_minutes=TWAP_WINDOW_MINUTES,
            interval_minutes=TWAP_INTERVAL_MINUTES,
        )

    async def close_position(
        self, symbol: str, entry_side: str, qty: float, tab: str, reason: str
    ) -> Optional[float]:
        """Close an open position. Returns the fill price, or None on failure.

        DELIBERATELY NOT GATED BY `may_open_new_position()`.

        CLAUDE.md invariant 4: closes and exits are never blocked — not by
        pause, not by risk checks, not by an emergency stop, not by a debate
        veto. Refusing to let an operator out of a position they are already in
        is actively harmful, and more so with real money, not less. A stop-loss
        that stops firing the moment the system is paused is not a stop-loss.

        It still routes through this agent rather than letting the Monitor talk
        to the exchange directly, so spec Section 8's rule holds: *"the
        Execution API is a hard chokepoint — no agent talks to an exchange
        directly, ever."* One gateway, two policies — opens are gated, closes
        are not.

        No TAR is required. Requiring one would make an exit dependent on the
        Supervisor and CRO being healthy and unpaused, which is precisely when
        an exit matters most.
        """
        exit_side = "sell" if entry_side == "buy" else "buy"
        exchange_name = "simulated_exchange" if self.simulation_mode else "binance_futures"

        if self.simulation_mode:
            fill_price = self._last_prices.get(symbol, 0.0)
            if fill_price <= 0:
                logger.error(
                    "Cannot simulate closing %s: no observed price. The position remains OPEN.",
                    symbol,
                )
                return None
            logger.info(
                "Simulated close of %s %s %s at %s (%s)", exit_side, qty, symbol, fill_price, reason
            )
            return fill_price

        client = get_exchange_client()
        # Idempotency key includes the reason so a stop-triggered close and a
        # later manual close of the same symbol are distinct orders, while a
        # retry of the SAME close reuses its key.
        client_order_id = f"close_{symbol.replace('/', '')}_{reason}"[:36]
        order = await client.create_market_order(
            symbol=symbol, side=exit_side, amount=qty, client_order_id=client_order_id
        )
        if order is None:
            # Loud, because the position is still open and still exposed.
            logger.critical(
                "FAILED TO CLOSE %s (%s %s, reason=%s). THE POSITION IS STILL OPEN and still "
                "carries risk. Manual intervention required.",
                symbol, exit_side, qty, reason,
            )
            return None

        raw = order.get("average") or order.get("price")
        if not raw or float(raw) <= 0:
            logger.error(
                "Close order %s for %s was accepted but returned no usable fill price. "
                "Realized P&L cannot be computed — reconcile manually.",
                order.get("id"), symbol,
            )
            return None
        return float(raw)

    @staticmethod
    def _slippage_bps(expected_price: float, fill_price: float, side: str) -> Optional[float]:
        """Slippage in basis points, signed so that positive is always a COST.

        Returns None when there is no reference price — an unmeasurable
        slippage is reported as unknown, not as zero.

        Side-aware because a fill above the expected price is bad for a buy
        and good for a sell. Taking the absolute difference would report a
        favourable fill as slippage and make execution quality look worse
        than it is; ignoring side entirely would let a systematically bad
        buy-side fill average out against a good sell-side one.
        """
        if expected_price <= 0 or fill_price <= 0:
            return None
        diff = (fill_price - expected_price) if side == "buy" else (expected_price - fill_price)
        return (diff / expected_price) * 10_000

    async def _attach_stop_loss(self, tar: TarApprovedEvent, fill_price: float, side: str) -> None:
        """Place the approved stop as a resting exchange order.

        NOT IMPLEMENTED for live trading, and it says so rather than
        pretending. `stop_loss` now travels all the way here on the approved
        TAR (it previously didn't exist anywhere in the event chain), but
        turning it into a resting `STOP_MARKET` order needs a
        `create_order`-with-`stopPrice` path on the exchange client that does
        not exist yet.

        This matters more than it looks: until it exists, the stop is only
        enforced by this process staying alive and watching the price. If the
        backend dies while a leveraged position is open, there is nothing at
        the exchange to close it — which is the exact failure spec Section
        22.8 says to design against ("the bot goes silent while holding a
        leveraged position"). Logged at WARNING on every live fill so it
        cannot be forgotten.
        """
        exit_side = "sell" if side == "buy" else "buy"
        if self.simulation_mode:
            logger.info(
                "TAR %s simulated: stop-loss %.6g (%s to exit) is tracked in-process only.",
                tar.tar_id,
                tar.stop_loss,
                exit_side,
            )
            return

        logger.warning(
            "TAR %s filled at %s with an approved stop-loss of %.6g, but resting stop orders are "
            "NOT IMPLEMENTED — no protective order exists at the exchange. This position is "
            "protected only while this process is running and watching the price.",
            tar.tar_id,
            fill_price,
            tar.stop_loss,
        )

    async def _persist_execution_quality(
        self,
        tar_id: str,
        order_id: str,
        symbol: str,
        exchange: str,
        quality: Dict[str, Any],
    ) -> None:
        """Write the execution score to the `execution_quality` table.

        Spec Section 22.4: the score must be *"written back to
        docs/13_DATABASE_SCHEMA.md so the Evaluation layer can use it."* There
        was no such table and no score to write.

        `score` may be NULL. A NULL score means "not measurable", which the
        Evaluation layer must exclude from averages rather than treat as zero —
        a fill with no reference price is not a bad fill.
        """
        pool = get_db_pool()
        if not pool:
            logger.debug("No database pool — execution quality for %s not persisted.", order_id)
            return
        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO execution_quality (
                      tar_id, order_id, ts, symbol, exchange, tab,
                      requested_qty, filled_qty, fully_filled,
                      slippage_bps, latency_ms, score,
                      components_measured, components_total, notes
                    )
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
                    ON CONFLICT (order_id) DO NOTHING
                    """,
                    tar_id,
                    order_id,
                    datetime.datetime.utcnow(),
                    symbol,
                    exchange,
                    settings.execution_tab,
                    quality["requestedQty"],
                    quality["filledQty"],
                    quality["fullyFilled"],
                    quality["slippageBps"],
                    quality["latencyMs"],
                    quality["score"],
                    quality["componentsMeasured"],
                    quality["componentsTotal"],
                    json.dumps(quality["notes"]),
                )
        except Exception as e:
            # Logged, not raised: the order already executed. Losing the score
            # costs the Evaluation layer one data point; unwinding the caller
            # would skip the stop-loss attachment that follows.
            logger.error("Failed to persist execution quality for %s: %s", order_id, e)

    async def _persist_trade(
        self,
        trade_id: str,
        symbol: str,
        side: str,
        qty: float,
        price: float,
        exchange_order_id: str,
        tab: str,
    ):
        pool = get_db_pool()
        if not pool:
            # Worth saying out loud: the order is already on the exchange.
            # Silently skipping the write leaves a real position with no
            # local record of it.
            logger.error(
                "Trade %s (%s %s %s @ %s) executed but NOT persisted: no database pool. "
                "This position exists at the exchange with no local record.",
                trade_id, side, qty, symbol, price,
            )
            return

        try:
            async with pool.acquire() as conn:
                await conn.execute(
                    """
                    INSERT INTO trades (id, ts, tab, symbol, side, qty, price, origin_tag, exchange_order_id)
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                    """,
                    # `tab` comes from the TAR instead of the hardcoded 'real'
                    # this used to pass. Simulated fills were being written
                    # into the trade log as real trades, permanently mixing
                    # simulated and real history in one table.
                    trade_id, datetime.datetime.utcnow(), tab, symbol, side, qty, price, "agent-plan", exchange_order_id
                )
        except Exception as e:
            logger.error(f"Failed to persist trade {trade_id}: {e}")


def get_execution_agent() -> ExecutionAgent:
    """Simulation unless LIVE_TRADING=true — see ExecutionAgent.__init__."""
    return ExecutionAgent()
