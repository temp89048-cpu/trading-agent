"""Regression tests for the price cache's symbol filter.

THE BUG THESE EXIST FOR
-----------------------
`market_data.fetch_prices()` filtered tickers with `symbol.endswith("/USDT")`.
Under `defaultType='future'` ccxt keys futures tickers as `BASE/QUOTE:SETTLE`
(`BTC/USDT:USDT`), so that test matched **zero** of 585 USDT contracts. The price
cache stayed permanently empty, every `get_price()` fell back to 0.0, and the
function logged "Failed to fetch prices via CCXT after maximum retries" — a
network error message for a string-matching bug, which sent every diagnosis after
it in the wrong direction.

No test caught it because nothing asserted on the *shape* of what came back. These
do, with no network: the filter is exercised against a hand-built market/ticker
payload copied from a real `fetch_tickers()` response.
"""

import asyncio

import pytest

from backend.services.exchange_client import ExchangeClient


# Copied from a live binance futures `fetch_tickers()` + `load_markets()` response.
# The four rows are the four cases that matter.
MARKETS = {
    # The linear USDT perpetual — the one we want.
    "BTC/USDT:USDT": {
        "base": "BTC", "quote": "USDT", "settle": "USDT",
        "swap": True, "future": False, "linear": True, "expiry": None, "active": True,
    },
    "ETH/USDT:USDT": {
        "base": "ETH", "quote": "USDT", "settle": "USDT",
        "swap": True, "future": False, "linear": True, "expiry": None, "active": True,
    },
    # A DATED quarterly. Same base/quote, so it would collapse onto the same
    # 'BTC/USDT' key as the perpetual while trading at a different price (basis).
    "BTC/USDT:USDT-260626": {
        "base": "BTC", "quote": "USDT", "settle": "USDT",
        "swap": False, "future": True, "linear": True, "expiry": 1782460800000, "active": False,
    },
    # USDC-settled perpetual — a different collateral asset, not a USDT price.
    "BTC/USDC:USDC": {
        "base": "BTC", "quote": "USDC", "settle": "USDC",
        "swap": True, "future": False, "linear": True, "expiry": None, "active": True,
    },
    # Inverse (coin-margined) perpetual — quoted in USD, settled in BTC.
    "BTC/USD:BTC": {
        "base": "BTC", "quote": "USD", "settle": "BTC",
        "swap": True, "future": False, "linear": False, "expiry": None, "active": True,
    },
}

TICKERS = {
    "BTC/USDT:USDT": {"last": 77240.5},
    "ETH/USDT:USDT": {"last": 2418.35},
    "BTC/USDT:USDT-260626": {"last": 79100.0},
    "BTC/USDC:USDC": {"last": 77218.3},
    "BTC/USD:BTC": {"last": 77190.0},
}


class FakeCcxt:
    """The two methods the price path calls, plus the markets dict it reads."""

    def __init__(self, tickers=None, markets=None, raises=None):
        self.markets = MARKETS if markets is None else markets
        self._tickers = TICKERS if tickers is None else tickers
        self._raises = raises
        self.load_markets_calls = 0
        self.fetch_tickers_calls = 0

    async def load_markets(self):
        self.load_markets_calls += 1
        return self.markets

    async def fetch_tickers(self):
        self.fetch_tickers_calls += 1
        if self._raises:
            raise self._raises
        return self._tickers


def client_with(fake) -> ExchangeClient:
    """An ExchangeClient whose ccxt handle is the fake.

    Built without `__init__` so no real ccxt client is constructed and nothing
    reads the environment — these tests must not depend on USE_TESTNET or on a
    network route to Binance.
    """
    client = ExchangeClient.__new__(ExchangeClient)
    client.exchange = fake
    # Set the two attributes __init__ would have, so a future test touching
    # fetch_balance gets a real code path rather than an AttributeError.
    client.use_testnet = True
    client._warned_testnet_private = False
    return client


def run(coro):
    return asyncio.run(coro)


def test_keys_are_base_slash_quote_not_ccxt_contract_ids():
    """The regression itself: keys must be 'BTC/USDT', never 'BTC/USDT:USDT'.

    The rest of the system asks for `BTC/USDT` (see WATCH_SYMBOLS in the polymarket
    and trigger workers), so a contract-id key is a cache nothing can read.
    """
    prices = run(client_with(FakeCcxt()).fetch_usdt_perpetual_prices())

    assert prices == {"BTC/USDT": 77240.5, "ETH/USDT": 2418.35}
    assert all(":" not in key for key in prices)
    assert all("-" not in key for key in prices)


def test_the_original_filter_would_have_matched_nothing():
    """Documents why the old rule failed, so it is not reintroduced as 'simpler'."""
    assert not any(symbol.endswith("/USDT") for symbol in TICKERS)


def test_dated_future_is_excluded_so_it_cannot_overwrite_the_perpetual():
    prices = run(client_with(FakeCcxt()).fetch_usdt_perpetual_prices())
    # 79100.0 is the quarterly's price. If it appeared, BTC/USDT would carry a
    # basis-inflated number that looks like spot.
    assert prices["BTC/USDT"] == 77240.5


def test_usdc_and_inverse_contracts_are_excluded():
    prices = run(client_with(FakeCcxt()).fetch_usdt_perpetual_prices())
    assert set(prices) == {"BTC/USDT", "ETH/USDT"}


def test_none_last_is_skipped_not_stored_as_zero():
    """A contract that has not traded is 'not measured', not a price of zero.

    Storing 0.0 gives callers a number to divide by and to compare against a stop.
    """
    tickers = {"BTC/USDT:USDT": {"last": None}, "ETH/USDT:USDT": {"last": 2418.35}}
    prices = run(client_with(FakeCcxt(tickers=tickers)).fetch_usdt_perpetual_prices())
    assert prices == {"ETH/USDT": 2418.35}


@pytest.mark.parametrize("bad", [True, False, "77240.5", None, 0, -1])
def test_non_numeric_or_non_positive_last_is_skipped(bad):
    """`True` is an int in Python and `'77240.5'` survives float() — both banned."""
    tickers = {"BTC/USDT:USDT": {"last": bad}}
    prices = run(client_with(FakeCcxt(tickers=tickers)).fetch_usdt_perpetual_prices())
    assert prices == {}


def test_ticker_without_market_metadata_is_skipped_not_guessed():
    """No metadata means we cannot tell what instrument it is, so it is dropped.

    Falling back to parsing the symbol string is what produced the original bug.
    """
    fake = FakeCcxt(tickers={"WEIRD/USDT:USDT": {"last": 5.0}}, markets={})
    assert run(client_with(fake).fetch_usdt_perpetual_prices()) == {}


def test_returns_empty_dict_on_exception_rather_than_raising():
    fake = FakeCcxt(raises=RuntimeError("connection reset"))
    assert run(client_with(fake).fetch_usdt_perpetual_prices()) == {}


def test_empty_result_does_not_burn_the_retry_budget():
    """An empty result must not be retried — retrying a non-match changes nothing.

    The old loop retried it `MAX_RETRIES` times and then logged a network failure,
    which is how a filter bug came to look like an outage.
    """
    from backend.services import market_data

    fake = FakeCcxt(tickers={}, markets={})
    client = client_with(fake)
    market_data.get_exchange_client = lambda: client  # type: ignore[assignment]
    try:
        run(market_data.fetch_prices())
    finally:
        # Restore, or every later test in the session shares this stub.
        from backend.services.exchange_client import get_exchange_client
        market_data.get_exchange_client = get_exchange_client  # type: ignore[assignment]

    assert fake.fetch_tickers_calls == 1, "an empty result was retried"


def test_successful_fetch_replaces_the_cache_wholesale():
    """A merge would keep a stale price for a symbol no longer quoted.

    A stale price that looks live is worse than a missing one — it can pass a risk
    check and size a position.
    """
    from backend.services import market_data

    original = dict(market_data._prices)
    market_data._prices = {"DELISTED/USDT": 1.23}
    client = client_with(FakeCcxt())
    market_data.get_exchange_client = lambda: client  # type: ignore[assignment]
    try:
        run(market_data.fetch_prices())
        assert "DELISTED/USDT" not in market_data._prices
        assert market_data._prices == {"BTC/USDT": 77240.5, "ETH/USDT": 2418.35}
    finally:
        market_data._prices = original
        from backend.services.exchange_client import get_exchange_client
        market_data.get_exchange_client = get_exchange_client  # type: ignore[assignment]
