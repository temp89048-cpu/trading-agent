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
        # See fetch_balance: the testnet private-call refusal is permanent, so it is
        # reported once rather than on every 30-second poll.
        self._warned_testnet_private = False

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
            # DO NOT RELY ON TESTNET AS THE SAFETY GATE.
            #
            # Binance has DEPRECATED futures testnet via ccxt's sandbox mode.
            # Observed at runtime on 2026-08-13:
            #
            #   "binance testnet/sandbox mode is not supported for futures
            #    anymore ... consider using the demo trading instead"
            #
            # So with defaultType='future', sandbox mode no longer gives a
            # working paper venue — private calls (fetch_balance, and therefore
            # any order) fail rather than executing against a test account.
            #
            # It fails CLOSED, which is the right direction: ccxt raises instead
            # of quietly routing to mainnet. But an operator who believes
            # "USE_TESTNET=true protects me" is relying on something that no
            # longer functions. The real gate is LIVE_TRADING=false, which puts
            # the ExecutionAgent in simulation mode and makes no exchange calls
            # at all.
            logger.warning(
                "Initialized CCXT Binance FUTURES with sandbox mode requested — but Binance "
                "no longer supports futures testnet through ccxt, so private calls will FAIL. "
                "Do not treat USE_TESTNET as the safety gate; LIVE_TRADING=false is the gate "
                "that actually prevents exchange orders."
            )
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
        """Fetch free balance. Returns None when it cannot be read.

        THE TESTNET REFUSAL IS LOGGED ONCE, NOT ON EVERY POLL. With
        `USE_TESTNET=true` and `defaultType='future'`, ccxt refuses every private
        call because Binance dropped futures testnet support — a permanent,
        already-understood condition, not an incident. It was being logged at ERROR
        each time, and `/api/exchange/status` is polled every 30 seconds by the UI,
        so a known non-problem was burying real errors in the same stream.

        Genuine failures (auth, margin, an outage) still log at ERROR every time,
        because those are worth seeing repeatedly.
        """
        try:
            return await self.exchange.fetch_balance()
        except Exception as e:
            message = str(e)
            testnet_unsupported = self.use_testnet and "sandbox" in message.lower()

            if testnet_unsupported:
                if not self._warned_testnet_private:
                    self._warned_testnet_private = True
                    logger.warning(
                        "Balance is UNAVAILABLE, and will stay unavailable: USE_TESTNET=true "
                        "puts ccxt in sandbox mode, which Binance no longer supports for "
                        "futures. This is expected and is not an outage. Set USE_TESTNET=false "
                        "to read a real balance — LIVE_TRADING=false remains the gate that "
                        "prevents orders. Logged once; further occurrences are suppressed. (%s)",
                        message,
                    )
                return None

            logger.error("Error fetching balance: %s", e)
            return None

    async def fetch_tickers(self) -> dict:
        """Fetch all tickers, keyed the way ccxt keys them.

        For `defaultType='future'` those keys are CONTRACT ids, not spot pairs:
        `BTC/USDT:USDT` for the linear perpetual, `BTC/USDT:USDT-260626` for a
        dated quarterly. Callers wanting the system's `BASE/QUOTE` convention
        should use `fetch_usdt_perpetual_prices()` instead — see the bug recorded
        there.
        """
        try:
            tickers = await self.exchange.fetch_tickers()
            return tickers
        except Exception as e:
            logger.error(f"Error fetching tickers: {e}")
            return {}

    async def fetch_usdt_perpetual_prices(self) -> dict:
        """`{'BTC/USDT': 77240.5, ...}` for USDT-settled PERPETUALS only.

        WHY THIS EXISTS — A SILENT TOTAL FAILURE OF THE PRICE CACHE
        -----------------------------------------------------------
        `market_data.fetch_prices()` filtered tickers with
        `symbol.endswith("/USDT")`. Under `defaultType='future'` ccxt keys every
        futures ticker as `BASE/QUOTE:SETTLE`, so that test matched **zero** of
        585 USDT contracts. The price cache stayed permanently empty, and because
        the surrounding retry loop only stored a result when the filtered dict was
        non-empty, it exhausted its retries and logged
        "Failed to fetch prices via CCXT after maximum retries" — a NETWORK error
        message for a string-matching bug. Every diagnosis it invited (check the
        network, check testnet, check credentials) was aimed at the wrong thing;
        `fetch_tickers` had been succeeding the whole time.

        FILTERS ON TYPED MARKET METADATA, NOT ON THE SYMBOL STRING. That is what
        made the original wrong, and a corrected string rule would still be
        guessing at ccxt's formatting. `swap` distinguishes a perpetual from a
        dated future, `linear` from an inverse (coin-margined) contract, and
        `settle` names the collateral. Getting any of those wrong returns a real
        price for the wrong instrument, which is worse than no price.

        DATED FUTURES ARE EXCLUDED DELIBERATELY. `BTC/USDT:USDT-260626` would
        collapse onto the same `BTC/USDT` key as the perpetual but trades at a
        different price (basis), so whichever iterated last would win at random.
        Several are also `active: False`.

        Returns `{}` on failure or when nothing matched — never a partial cache
        presented as complete. The caller distinguishes the two cases.
        """
        try:
            # Needed for the metadata this filters on. ccxt caches it, so the
            # cost is paid once rather than per poll.
            await self.exchange.load_markets()
            tickers = await self.exchange.fetch_tickers()
        except Exception as e:
            logger.error("Error fetching perpetual prices: %s", e)
            return {}

        prices: dict = {}
        skipped_no_market = 0
        skipped_not_perpetual = 0
        skipped_no_last = 0

        for symbol, ticker in tickers.items():
            market = self.exchange.markets.get(symbol)
            if not market:
                skipped_no_market += 1
                continue
            if not (
                market.get("swap")
                and market.get("linear")
                and market.get("settle") == "USDT"
                and not market.get("expiry")
            ):
                skipped_not_perpetual += 1
                continue

            last = ticker.get("last")
            # A bool is an int in Python, and a str would sail through float().
            # `last` is None on a contract that has not traded — that is "not
            # measured", not a price of zero, so it is skipped rather than stored
            # as 0.0 for something else to divide by.
            if isinstance(last, bool) or not isinstance(last, (int, float)):
                skipped_no_last += 1
                continue
            if last <= 0:
                skipped_no_last += 1
                continue

            prices[f"{market['base']}/{market['quote']}"] = float(last)

        if not prices:
            # Loud, and specific about which filter emptied it, because the
            # previous version of this failure was indistinguishable from an
            # outage for months.
            logger.error(
                "fetch_tickers returned %d tickers but NONE were usable USDT perpetuals "
                "(%d had no market metadata, %d were not linear USDT perpetuals, "
                "%d had no usable last price). The price cache is empty — this is a "
                "filter mismatch, not a network failure.",
                len(tickers),
                skipped_no_market,
                skipped_not_perpetual,
                skipped_no_last,
            )
        else:
            logger.debug(
                "Resolved %d USDT perpetual prices from %d tickers.", len(prices), len(tickers)
            )
        return prices

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
