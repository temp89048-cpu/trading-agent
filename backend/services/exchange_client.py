import ccxt.async_support as ccxt
import os
import logging
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

class ExchangeClient:
    def __init__(self):
        self.exchange = None
        self._initialize_exchange()

    def _initialize_exchange(self):
        api_key = os.getenv("BINANCE_API_KEY", "")
        secret = os.getenv("BINANCE_SECRET", "")
        # Defaults to testnet. The default for anything that can move real
        # money is the safe value — an operator has to opt IN to mainnet by
        # setting USE_TESTNET=false, never fall into it by omission.
        use_testnet = os.getenv("USE_TESTNET", "true").lower() == "true"

        self._api_key = api_key
        self._secret = secret
        self.use_testnet = use_testnet

        # Note: If no keys are provided, CCXT will still initialize, but it will fail on private endpoints
        self.exchange = ccxt.binance({
            'apiKey': api_key,
            'secret': secret,
            'enableRateLimit': True,
            # The rest of the system calls this venue "binance_futures"
            # (execution_agent.py's exchange_name, docs' "cryptocurrency
            # futures markets"). Without defaultType the client defaults to
            # spot, so orders would have gone to a different market than
            # every log line and audit record claimed.
            'options': {'defaultType': 'future'},
        })

        if use_testnet:
            self.exchange.set_sandbox_mode(True)
            logger.info("Initialized CCXT Exchange Client (Binance Futures TESTNET)")
        else:
            logger.warning(
                "Initialized CCXT Exchange Client (Binance Futures LIVE — "
                "USE_TESTNET=false). Orders placed through this client use REAL FUNDS."
            )

    def has_credentials(self) -> bool:
        """True when both key and secret are present.

        Checked before placing an order so a missing key produces one clear
        refusal rather than a ccxt auth exception from inside the library.
        """
        return bool(self._api_key and self._secret)

    async def fetch_balance(self):
        """Fetch free balance."""
        try:
            balance = await self.exchange.fetch_balance()
            return balance
        except Exception as e:
            logger.error(f"Error fetching balance: {e}")
            return None

    async def fetch_tickers(self) -> dict:
        """Fetch all tickers."""
        try:
            tickers = await self.exchange.fetch_tickers()
            return tickers
        except Exception as e:
            logger.error(f"Error fetching tickers: {e}")
            return {}

    async def fetch_ohlcv(self, symbol: str, timeframe: str = '1h', limit: int = 100) -> list:
        """Fetch OHLCV candles for a symbol."""
        try:
            ohlcv = await self.exchange.fetch_ohlcv(symbol, timeframe, limit=limit)
            return ohlcv
        except Exception as e:
            logger.error(f"Error fetching OHLCV for {symbol}: {e}")
            return []

    async def create_market_order(self, symbol: str, side: str, amount: float, client_order_id: str | None = None):
        """Create a market order. Returns the ccxt order dict, or None on failure.

        RETURNS None ON FAILURE — IT DOES NOT INVENT A FILL.
        ------------------------------------------------------
        This method used to catch every exception and return a fabricated
        order: a random uuid, `"status": "closed"`, and a hardcoded
        `"price": 60000.0`. The caller (`agents/execution_agent.py`) could
        not distinguish that from a real fill, so it published
        `OrderFilledEvent` and wrote a row into `trades` with `tab='real'`.
        A rejected order — bad credentials, insufficient margin, symbol not
        found, exchange down — became a successful $60,000 BTC fill in the
        P&L and the audit trail.

        That is precisely CLAUDE.md invariant 6 ("never fabricate market
        data — no invented prices, fills, or indicator values") and it is
        worse than a crash, because a crash is visible. Returning None is
        honest: the caller already checks for it and aborts.

        `client_order_id` is forwarded to the exchange as the idempotency
        key (spec Section 19: "a retried order must never produce a
        duplicate fill"). The exchange rejects a repeat of an id it has
        already filled, which is what makes a retry safe.
        """
        if not self.has_credentials():
            # Fail before calling out, with a reason the operator can act on.
            # Without this, a missing key surfaced as a generic ccxt auth
            # error from deep inside the library.
            logger.error(
                "Refusing to place a %s order for %s: no exchange API credentials "
                "configured (BINANCE_API_KEY / BINANCE_SECRET are empty).",
                side,
                symbol,
            )
            return None

        params = {}
        if client_order_id:
            params["clientOrderId"] = client_order_id

        try:
            # CCXT format: base/quote (e.g., BTC/USDT)
            order = await self.exchange.create_market_order(
                symbol,
                side.lower(),
                amount,
                params=params,
            )
            return order
        except Exception as e:
            logger.error(
                "Order REJECTED for %s %s %s (clientOrderId=%s): %s. "
                "No position was opened. Returning None — no fill is being reported.",
                side,
                amount,
                symbol,
                client_order_id,
                e,
            )
            return None

    async def close(self):
        if self.exchange:
            await self.exchange.close()

# Singleton instance
_exchange_client_instance = None

def get_exchange_client() -> ExchangeClient:
    global _exchange_client_instance
    if _exchange_client_instance is None:
        _exchange_client_instance = ExchangeClient()
    return _exchange_client_instance
