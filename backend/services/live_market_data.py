import asyncio
import logging
import ccxt.pro as ccxtpro
from backend.core.message_bus import get_message_bus
from backend.models.events import TickReceivedEvent
from backend.core.config import settings

logger = logging.getLogger(__name__)

# In-memory cache for the latest prices
_live_prices = {}

async def _watch_ticker_loop(exchange, symbol, bus):
    """Watches a single ticker and publishes TICK_RECEIVED events."""
    while True:
        try:
            ticker = await exchange.watch_ticker(symbol)
            price = ticker.get('last')
            volume = ticker.get('baseVolume', 0.0)
            
            if price is not None:
                _live_prices[symbol] = price
                
                # Publish event
                event = TickReceivedEvent(
                    agent_id="live_market_data",
                    symbol=symbol,
                    price=price,
                    volume=volume,
                    exchange="binance"
                )
                await bus.publish(event.event_type, event)
                logger.debug(f"Live tick for {symbol}: {price}")
                
        except asyncio.CancelledError:
            break
        except Exception as e:
            logger.error(f"Error watching ticker {symbol}: {e}")
            await asyncio.sleep(5)  # Backoff before reconnecting

async def start_live_data_feed():
    """Starts the WebSocket connection for live market data."""
    logger.info("Starting live market data feed via ccxt.pro...")
    exchange = ccxtpro.binance({
        'enableRateLimit': True,
    })
    
    bus = get_message_bus()
    
    # We will watch a few standard pairs. This should ideally be configurable.
    symbols = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT']
    
    tasks = []
    for symbol in symbols:
        task = asyncio.create_task(_watch_ticker_loop(exchange, symbol, bus))
        tasks.append(task)
        
    try:
        await asyncio.gather(*tasks)
    except asyncio.CancelledError:
        logger.info("Live data feed cancelled.")
    finally:
        await exchange.close()

def get_live_price(symbol: str) -> float:
    """Returns the latest price from the live WebSocket cache."""
    return _live_prices.get(symbol, 0.0)
