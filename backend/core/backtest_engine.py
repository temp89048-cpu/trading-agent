import asyncio
import logging
from typing import Dict, Any, List
from backend.services.market_data import fetch_klines
from backend.core.message_bus import MessageBus, get_message_bus
from backend.models.events import TickReceivedEvent

# Import agents to register
from backend.agents.market_intelligence import get_market_intelligence_agent
from backend.agents.supervisor_agent import get_supervisor
from backend.agents.execution_agent import ExecutionAgent

logger = logging.getLogger(__name__)

class HistoricalBacktestEngine:
    """
    Simulates the entire Agent OS over historical CCXT data.
    """
    def __init__(self, symbol: str, timeframe: str = "1m", limit: int = 1000):
        self.symbol = symbol
        self.timeframe = timeframe
        self.limit = limit
        # AN ISOLATED BUS, NOT THE GLOBAL ONE.
        #
        # This used to be `get_message_bus()` followed by
        # `self.bus._subscribers.clear()` — which unsubscribed the trigger worker, the
        # CRO, the execution agent and the position monitor from the LIVE bus. A
        # validation run silently disabled trading, and nothing surfaced it because
        # every component simply stopped receiving events (OPERATOR_GUIDE.md §6.4).
        #
        # A private instance means the simulation cannot touch live subscribers, and
        # there is nothing to clear.
        self.bus = MessageBus()

        # Initialize agents
        self.market_intelligence = get_market_intelligence_agent()
        self.supervisor = get_supervisor()
        self.execution = ExecutionAgent(simulation_mode=True)

        # REBIND, don't just subscribe.
        #
        # `BaseAgent.__init__` captures the bus, so `publish()` goes to whatever bus
        # the agent was CONSTRUCTED with. Two of these three are process singletons
        # already wired to the global bus — subscribing them here without rebinding
        # would have them consume simulated ticks and publish the resulting orders and
        # analyses onto the LIVE bus, which is worse than the original bug.
        #
        # `rebind_bus` returns the previous bus so it can be restored; see
        # `restore_agent_buses`, which `run()` calls in a `finally`.
        self._previous_buses = [
            (agent, agent.rebind_bus(self.bus))
            for agent in (self.market_intelligence, self.supervisor, self.execution)
        ]

        # State tracking
        self.peak_equity = 10000.0
        self.current_equity = 10000.0
        self.max_drawdown_pct = 0.0
        self.trades_executed = 0
        self.pnl = 0.0

    def restore_agent_buses(self) -> None:
        """Put every rebound agent back on the bus it came from. Idempotent.

        Called from `run()`'s `finally`, so an exception mid-simulation cannot leave a
        process singleton permanently pointed at a dead simulation bus — which would
        make the live agent publish into nothing and look simply broken, with no
        connection to the backtest that caused it.
        """
        while self._previous_buses:
            agent, previous = self._previous_buses.pop()
            agent.rebind_bus(previous)

    def _register_agent(self, agent):
        """Subscribe only. Prefer `rebind_bus` — see the note in `__init__` on why
        subscribing without rebinding leaks simulated events onto the live bus."""
        for event_type in agent.events_consumed:
            self.bus.subscribe(event_type, agent.handle_event)


    async def _on_order_filled(self, event):
        from backend.models.events import OrderFilledEvent
        if isinstance(event, OrderFilledEvent):
            self.trades_executed += 1
            # Mock PnL logic - assumes we bought at one price, sold at another.
            # Real backtester tracks open positions. For this PoC, we just track trade count.
            logger.info(f"[BACKTEST] Simulated Order Filled: {event.fill_quantity} {self.symbol} @ {event.fill_price}")

    async def run(self) -> Dict[str, Any]:
        logger.info(f"Starting backtest for {self.symbol} ({self.limit} candles on {self.timeframe})")
        
        # Hook up a listener to calculate equity/PNL
        self.bus.subscribe("ORDER_FILLED", self._on_order_filled)

        # try/finally so the rebound singletons are always restored. Without it an
        # exception here would leave the live market-intelligence agent and supervisor
        # publishing into a discarded simulation bus for the rest of the process's
        # life, with nothing to connect the symptom to the cause.
        try:
            # 1. Fetch historical data
            klines = await fetch_klines(self.symbol, self.timeframe, limit=self.limit)

            if not klines:
                return {"error": "Failed to fetch historical data."}

            logger.info(f"Fetched {len(klines)} historical candles.")

            # 2. Iterate and emit ticks
            for kline in klines:
                # Emit tick for the close price of each candle
                tick = TickReceivedEvent(
                    symbol=self.symbol,
                    price=kline["close"],
                    volume=kline["volume"],
                    exchange="ccxt_historical"
                )
                # The await will synchronously flush the event through all subscribed agents
                await self.bus.publish("TICK_RECEIVED", tick)

                # Allow event loop to process nested events (like SIGNAL_GENERATED -> TAR_APPROVED)
                await asyncio.sleep(0.001)

            return {
                "symbol": self.symbol,
                "candles_processed": len(klines),
                "trades_executed": self.trades_executed,
                "max_drawdown": self.max_drawdown_pct,
                "busIsolation": (
                    "this run used a private MessageBus and restored every rebound "
                    "agent afterwards, so it could not disturb live subscribers"
                ),
            }
        finally:
            self.restore_agent_buses()
