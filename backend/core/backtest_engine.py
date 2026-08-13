import asyncio
import logging
from typing import Dict, Any, List
from backend.services.market_data import fetch_klines
from backend.core.message_bus import get_message_bus
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
        self.bus = get_message_bus()
        
        # We need a clean bus for the simulation if it's run concurrently, 
        # but for simplicity, we assume one backtest runs at a time or we use the global bus.
        # Clear existing subscribers for safety
        self.bus._subscribers.clear()
        
        # Initialize agents
        self.market_intelligence = get_market_intelligence_agent()
        self.supervisor = get_supervisor()
        self.execution = ExecutionAgent(simulation_mode=True)
        
        # Register them to the bus
        self._register_agent(self.market_intelligence)
        self._register_agent(self.supervisor)
        self._register_agent(self.execution)
        
        # State tracking
        self.peak_equity = 10000.0
        self.current_equity = 10000.0
        self.max_drawdown_pct = 0.0
        self.trades_executed = 0
        self.pnl = 0.0

    def _register_agent(self, agent):
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
            "max_drawdown": self.max_drawdown_pct
        }
