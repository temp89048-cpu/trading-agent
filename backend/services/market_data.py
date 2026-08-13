import logging
import asyncio
from backend.core.config import settings
from backend.services.live_market_data import get_live_price
from backend.services.exchange_client import get_exchange_client

logger = logging.getLogger(__name__)

_prices = {}

async def fetch_prices():
    global _prices
    client = get_exchange_client()
    max_retries = settings.MAX_RETRIES
    for attempt in range(max_retries):
        try:
            tickers = await client.fetch_tickers()
            new_prices = {}
            for symbol, ticker in tickers.items():
                if symbol.endswith("/USDT"):
                    new_prices[symbol] = ticker.get("last", 0.0)
            if new_prices:
                _prices = new_prices
                logger.debug(f"Fetched {len(_prices)} prices via CCXT")
                return
        except Exception as e:
            wait_time = 2 ** attempt
            logger.warning(f"Error fetching prices (attempt {attempt+1}/{max_retries}): {e}. Retrying in {wait_time}s...")
            await asyncio.sleep(wait_time)
            
    logger.error("Failed to fetch prices via CCXT after maximum retries.")

def get_price(symbol: str) -> float:
    # First try the live websocket feed
    live_price = get_live_price(symbol)
    if live_price > 0:
        return live_price
    # Fallback to the old polled HTTP cache if WS doesn't have it
    return _prices.get(symbol, 0.0)

async def fetch_klines(symbol: str, interval: str, limit: int = 100) -> list:
    """
    Fetch historical klines via CCXT with exponential backoff.
    """
    client = get_exchange_client()
    max_retries = settings.MAX_RETRIES
    
    for attempt in range(max_retries):
        try:
            # CCXT fetch_ohlcv returns: [ [timestamp, open, high, low, close, volume], ... ]
            ohlcv_data = await client.fetch_ohlcv(symbol, interval, limit=limit)
            
            klines = []
            for k in ohlcv_data:
                klines.append({
                    "openTime": k[0],
                    "open": float(k[1]),
                    "high": float(k[2]),
                    "low": float(k[3]),
                    "close": float(k[4]),
                    "volume": float(k[5]),
                    "closeTime": k[0] + 60000 # Approximation, CCXT does not return closeTime directly
                })
            return klines
        except Exception as e:
            wait_time = 2 ** attempt
            logger.warning(f"Error fetching klines for {symbol} (attempt {attempt+1}/{max_retries}): {e}. Retrying in {wait_time}s...")
            await asyncio.sleep(wait_time)
            
    logger.error(f"Failed to fetch klines for {symbol} after maximum retries.")
    return []
