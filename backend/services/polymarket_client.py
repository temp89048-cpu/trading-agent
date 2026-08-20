"""Polymarket read-only client — Phase 32, `POLYMARKET_INTEGRATION_PLAN.md` §3.

Wraps `ccxt.prediction.polymarket`. Fetches prediction-market probabilities and
nothing else: no orders, no balances, no positions.

WHY THIS IS A WRAPPER AND NOT A DIRECT IMPORT
---------------------------------------------
`polymarket.md` §1/§3 assumes a hand-written REST client, a hand-written
WebSocket client, custom rate limiting and a raw-JSON field mapping against
`lastTradePrice` / `bestBid` / `bestAsk`. None of that is needed: `ccxt` — already
a declared dependency of this project and already the abstraction
`services/exchange_client.py` uses for Binance — ships a native-async Polymarket
adapter with unified typed structures.

So this module exists for one reason, and it is a safety reason:

    THE SAME ccxt CLASS THAT READS PROBABILITIES CAN ALSO PLACE ORDERS.

`ccxt.prediction.polymarket` exposes `create_order`, `create_orders`,
`cancel_order`, `cancel_all_orders`, `fetch_balance` and `fetch_positions`
alongside the read methods. Importing that class directly wherever a probability
is needed would put an order-placing object in the hands of every caller —
including, eventually, something under `graphs/`, where the whole point of
`contracts.FORBIDDEN_IMPORTS` is that no reasoning module can reach an order call.

Trading on Polymarket would also be a second execution venue, which breaks
CLAUDE.md invariant 1 (`components/Supervisor.tsx`'s `reviewAndExecute()` is the
single execution path for every AI-originated trade) and sits entirely outside
`ABSOLUTE_MAX_LEVERAGE`, the mandatory-stop rule and the Risk Gateway.

Three independent guards, because any one alone is a single point of failure:

  1. **The raw exchange object is never returned or exposed.** There is no
     accessor for it, and `_exchange` is created lazily inside this module.
  2. **No credentials are ever passed to the constructor.** Every private
     endpoint therefore fails closed even if guard 1 were somehow bypassed.
  3. **An AST test** (`tests/test_polymarket.py`) asserts no order symbol appears
     anywhere in the Polymarket modules.

HONEST FAILURE, NOT PLAUSIBLE FAILURE
-------------------------------------
Every method returns `None` (or `[]`) on failure and never a stale or invented
number. This is the same discipline `exchange_client.create_market_order`
documents at length after it once caught every exception and returned a
fabricated $60,000 BTC fill that reached the P&L and the audit trail.

It matters more here than usual, because the whole value of the downstream
`specialist_prediction` node is that `available=False` means something. A client
that returned the last-known probability on a network error would make the
specialist report a live view of a market it had lost contact with.

NOTHING HERE DECIDES ANYTHING
-----------------------------
Pure I/O. No thresholds, no signals, no direction. Those live in
`algorithms/prediction_market.py` (deterministic, pure, unit-tested) per
CLAUDE.md's "pure logic in lib/, side effects in components/" split, which the
Python side mirrors as `algorithms/` vs `services/`.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Import guard
# ---------------------------------------------------------------------------
#
# `from ccxt.prediction import polymarket` binds a CLASS, not a module: the
# package's `__init__` sets the attribute `polymarket` to the class and thereby
# shadows the submodule of the same name. So
#
#     import ccxt.prediction.polymarket as m; m.polymarket   # AttributeError
#
# This bit during planning and is worth the comment. Note also that `ccxt.pro`
# does NOT expose polymarket and `ccxt.async_support.prediction` does not exist —
# the async class is reached through `ccxt.prediction` despite that reading like
# the synchronous namespace. Verified against ccxt 4.5.73:
#
#     fetch_ticker / fetch_markets / watch_order_book -> all coroutines
#     mro: polymarket -> PredictionExchange -> BaseExchange -> ImplicitAPI
#
# Guarded rather than a bare import because the `Prediction*` types are recent.
# An older ccxt must degrade to "unavailable, here is why" rather than breaking
# the import of anything that touches this module — the backend imports a lot at
# startup and a hard failure here would take down unrelated routes.
try:  # pragma: no cover - exercised by the availability test
    from ccxt.prediction import polymarket as _PolymarketExchange

    _IMPORT_ERROR: Optional[str] = None
except Exception as exc:  # noqa: BLE001
    _PolymarketExchange = None  # type: ignore[assignment]
    _IMPORT_ERROR = (
        f"ccxt does not provide a Polymarket prediction-market adapter in this "
        f"installation ({exc}). Requires ccxt >= 4.5.73, which declares the "
        f"Prediction* unified types."
    )

UNAVAILABLE_REASON_NO_ADAPTER = (
    "no Polymarket adapter is available: ccxt must be >= 4.5.73 for "
    "ccxt.prediction.polymarket and its Prediction* unified types"
)

# ccxt's own rate limiter is used (`enableRateLimit`), and the adapter declares
# `rateLimit: 100` (ms between calls) for Polymarket. Restating Polymarket's
# published per-endpoint limits here — polymarket.md §3 quotes ~300/10s Gamma and
# ~1500/10s CLOB /book — would create a second limiter that could disagree with
# ccxt's, and then two answers to "why was this call delayed".
_MAX_RETRIES = 3

# A read that has not returned in this long is treated as failed. Polymarket reads
# sit on the trigger path, and a hung HTTP call there stalls the poller for every
# other market it was about to check.
_TIMEOUT_MS = 10_000


class PolymarketClient:
    """Read-only access to Polymarket prediction markets.

    Every method returns `None`/`[]` on failure. Callers MUST treat that as "not
    measured" and never as a neutral or zero value.
    """

    def __init__(self) -> None:
        self._exchange: Any = None
        self._lock = asyncio.Lock()

    # -- availability -----------------------------------------------------

    @staticmethod
    def is_available() -> bool:
        """True when the ccxt adapter could be imported. Says nothing about
        network reachability — an available client can still fail every call."""
        return _PolymarketExchange is not None

    @staticmethod
    def unavailable_reason() -> Optional[str]:
        return None if _PolymarketExchange is not None else (
            _IMPORT_ERROR or UNAVAILABLE_REASON_NO_ADAPTER
        )

    # -- lifecycle --------------------------------------------------------

    async def _get(self) -> Any:
        """Lazily construct the exchange. NEVER returned to a caller.

        Lazy because constructing it at import time would mean every module that
        imports this one pays for it, and because `is_available()` must be
        answerable without side effects.
        """
        if self._exchange is not None:
            return self._exchange

        async with self._lock:
            # Re-check inside the lock: two concurrent first calls would otherwise
            # each build an exchange and one would leak an unclosed session.
            if self._exchange is not None:
                return self._exchange
            if _PolymarketExchange is None:
                return None

            # NO CREDENTIALS. Deliberately. See the module docstring, guard 2:
            # this is what makes every private endpoint fail closed rather than
            # relying on nobody calling one.
            self._exchange = _PolymarketExchange({
                "enableRateLimit": True,
                "timeout": _TIMEOUT_MS,
            })
            logger.info(
                "Polymarket read-only client initialised (ccxt adapter, no "
                "credentials configured — private endpoints will fail closed)"
            )
            return self._exchange

    async def close(self) -> None:
        """Release the HTTP session. Safe to call when never opened."""
        if self._exchange is None:
            return
        try:
            await self._exchange.close()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Error closing the Polymarket client: %s", exc)
        finally:
            self._exchange = None

    # -- the one call path ------------------------------------------------

    async def _call(self, method: str, *args: Any, **kwargs: Any) -> Optional[Any]:
        """Invoke one read method with retry. Returns None on failure.

        Every public method routes through here so retry, backoff, timeout
        handling and the honest-None contract are defined exactly once. A method
        that called ccxt directly would be the one that eventually forgot to
        return None.

        `2 ** attempt` backoff mirrors `services/market_data.fetch_klines` rather
        than inventing a second retry style for the same class of problem.
        """
        if method not in _READ_METHODS:
            # Defence in depth behind the AST test. A typo'd or malicious method
            # name cannot reach the exchange even though `_call` is generic —
            # without this, `_call("create_order", ...)` would work.
            raise ValueError(
                f"'{method}' is not a permitted Polymarket read method. This client "
                f"is read-only by design: {sorted(_READ_METHODS)}"
            )

        exchange = await self._get()
        if exchange is None:
            logger.debug("Polymarket %s skipped: %s", method, self.unavailable_reason())
            return None

        fn = getattr(exchange, method, None)
        if fn is None:
            logger.error(
                "The installed ccxt Polymarket adapter has no '%s'. Not falling "
                "back to a different method — a silent substitution would return "
                "a different measurement than the caller asked for.", method,
            )
            return None

        for attempt in range(_MAX_RETRIES):
            try:
                return await fn(*args, **kwargs)
            except Exception as exc:  # noqa: BLE001
                last = attempt == _MAX_RETRIES - 1
                if last:
                    # ERROR, not warning, and it names the consequence: a caller
                    # reading the log needs to know the signal is now unmeasured
                    # rather than neutral.
                    logger.error(
                        "Polymarket %s failed after %d attempts: %s. Returning None "
                        "— the value is UNMEASURED, not zero and not unchanged.",
                        method, _MAX_RETRIES, exc,
                    )
                    return None
                wait = 2 ** attempt
                logger.warning(
                    "Polymarket %s failed (attempt %d/%d): %s. Retrying in %ds.",
                    method, attempt + 1, _MAX_RETRIES, exc, wait,
                )
                await asyncio.sleep(wait)
        return None

    # -- reads ------------------------------------------------------------

    async def fetch_status(self) -> Optional[Dict[str, Any]]:
        """Venue status. The cheapest reachability probe available."""
        return await self._call("fetch_status")

    async def fetch_events(
        self,
        query: Optional[str] = None,
        tags: Optional[List[str]] = None,
        limit: int = 20,
        status: str = "active",
        sort: str = "volume",
    ) -> List[Dict[str, Any]]:
        """Search prediction-market events. Returns [] on failure.

        ccxt requires a scope (`query`, `queries`, `tags`, `eventId` or `slug`);
        an unscoped browse is `fetch_markets()` instead. Params are named
        explicitly here rather than passed through as a dict so a caller cannot
        smuggle arbitrary ccxt params — including ones that would change the call
        into something other than a read.

        Returns `[]` and NOT None on failure, because a caller iterating events
        should find nothing rather than crash. The distinction between "no
        matching markets" and "the search failed" is preserved in the log, and
        callers that need it should call `fetch_status` first.
        """
        params: Dict[str, Any] = {"limit": limit, "status": status, "sort": sort}
        if query:
            params["query"] = query
        if tags:
            params["tags"] = list(tags)
        if not query and not tags:
            # ccxt raises without a scope. Refusing here gives a caller the actual
            # reason instead of a ccxt ArgumentsRequired from inside the library.
            logger.error(
                "fetch_events needs a scope (query or tags). ccxt requires one; use "
                "fetch_markets() for an unscoped top-volume browse."
            )
            return []

        result = await self._call("fetch_events", params)
        return result if isinstance(result, list) else []

    async def fetch_markets(self) -> List[Dict[str, Any]]:
        """All markets, each with its outcomes nested. Returns [] on failure."""
        result = await self._call("fetch_markets")
        return result if isinstance(result, list) else []

    async def fetch_ticker(self, outcome: str) -> Optional[Dict[str, Any]]:
        """Current mid, best bid/ask and open interest for one outcome token.

        `outcome` is a ccxt unified outcome handle (e.g. `"BTC_ABOVE_130K:YES"`)
        or a raw outcome token id.
        """
        return await self._call("fetch_ticker", outcome)

    async def fetch_order_book(self, outcome: str) -> Optional[Dict[str, Any]]:
        """The CLOB book for one outcome token."""
        return await self._call("fetch_order_book", outcome)

    async def fetch_open_interest(self, outcome: str) -> Optional[Dict[str, Any]]:
        return await self._call("fetch_open_interest", outcome)

    async def watch_ticker(self, outcome: str) -> Optional[Dict[str, Any]]:
        """Await the NEXT streamed ticker for one outcome. None on failure.

        Phase 32b. ccxt implements the Polymarket CLOB market channel itself, including
        the venue's non-standard keepalive — `describe()['streaming']` declares a text
        "PING" every 10 seconds, which has no protocol-level ping/pong equivalent. That
        is why `polymarket.md` §3's hand-written reconnect logic, watchdog and
        `websockets` dependency are all unnecessary.

        The ticker is SYNTHETIC: ccxt derives `mid = (bid + ask) / 2` from order-book
        snapshots and deltas. So it is a quote midpoint, not a traded price, and it can
        move on a one-sided quote change with no trade behind it. `move_confidence`
        already discounts a wide spread for exactly this reason.

        NOT ROUTED THROUGH `_call`. That method retries with backoff, which is right
        for a one-shot REST read and wrong for a subscription: ccxt reconnects
        internally, and an outer retry loop would stack a second reconnect strategy on
        top of it. The caller's loop owns failure handling — see
        `PolymarketStreamFeed._follow`.
        """
        exchange = await self._get()
        if exchange is None:
            return None

        fn = getattr(exchange, "watch_ticker", None)
        if fn is None:
            logger.error(
                "The installed ccxt Polymarket adapter has no watch_ticker; the "
                "streaming feed cannot run. The REST poller is unaffected."
            )
            return None
        return await fn(outcome)

    async def fetch_ohlcv(
        self,
        outcome: str,
        timeframe: str = "5m",
        since: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> List[List[Any]]:
        """Probability history, bucketed into OHLCV candles by ccxt.

        Returns the SAME shape `services/market_data.fetch_klines` normalises for
        price candles — `[ts, open, high, low, close, volume]` — so probability
        history reuses the existing candle convention rather than introducing a
        second one. The "price" in these candles is a probability in 0..1.

        Timeframes the adapter declares: 1m, 5m, 1h, 6h, 1d. `5m` by default
        because that is the resolution `polymarket_store` retains.
        """
        result = await self._call("fetch_ohlcv", outcome, timeframe, since, limit)
        return result if isinstance(result, list) else []


# The complete set of methods this client may invoke. Enforced in `_call`, and
# asserted by the AST test to contain nothing order-shaped.
#
# Kept as an explicit allowlist rather than a denylist of order methods: a
# denylist silently permits whatever a future ccxt release adds, and this class
# already carries `create_order`, `cancel_order` and `fetch_balance`.
_READ_METHODS = frozenset({
    "fetch_status",
    "fetch_events",
    "fetch_markets",
    "fetch_ticker",
    "fetch_order_book",
    "fetch_open_interest",
    "fetch_ohlcv",
})

# Streaming reads, kept SEPARATE from `_READ_METHODS` rather than added to it.
#
# `_call`'s retry-with-backoff is correct for a one-shot REST read and wrong for a
# subscription, so the two must not share a code path. Listing them apart also keeps
# the allowlist check in `_call` meaningful: it can stay "fetch_ only", which is a
# rule a reader can verify at a glance, instead of an exception list.
_WATCH_METHODS = frozenset({
    "watch_ticker",
})


# ---------------------------------------------------------------------------
# Singleton
# ---------------------------------------------------------------------------
#
# One client per process, matching `exchange_client.get_exchange_client`. ccxt
# holds an HTTP session and a rate-limit clock; two instances would each keep
# their own clock and together exceed the limit ccxt was configured to respect.

_instance: Optional[PolymarketClient] = None


def get_polymarket_client() -> PolymarketClient:
    global _instance
    if _instance is None:
        _instance = PolymarketClient()
    return _instance


async def close_polymarket_client() -> None:
    """For shutdown and for tests. Leaves the singleton reconstructable."""
    global _instance
    if _instance is not None:
        await _instance.close()
        _instance = None
