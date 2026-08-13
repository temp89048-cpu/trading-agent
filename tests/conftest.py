"""Shared test fixtures, plus a network guard.

WHY THE NETWORK GUARD EXISTS
----------------------------
A test in `test_portfolio_controls.py` monkeypatched the portfolio store but
not `fetch_klines`, so `CIOAgent._returns_for` called the real ccxt client.
`services/market_data.fetch_klines` retries with exponential backoff
(`MAX_RETRIES` attempts, sleeping 1s, 2s, 4s), and this environment has no
route to the exchange APIs — so the suite went from 2 seconds to a 7-minute
timeout with no indication of why.

A hang is the worst failure mode for a test suite: it looks like an infra
problem rather than a bug in the test. This fixture converts an accidental
network call into an immediate, named failure.

It is autouse and applies to every test. A test that genuinely needs to reach
the network must ask for the `allow_network` fixture explicitly, which makes
that dependency visible in the test's signature rather than hidden in its call
graph.
"""

import socket
from typing import Any, Dict, List

import pytest


class _BlockedNetwork(RuntimeError):
    pass


# Loopback must stay open. On Windows, asyncio's ProactorEventLoop builds its
# internal self-pipe with `socket.socketpair()`, which falls back to a real
# TCP connection to 127.0.0.1 — so blocking every connect breaks the event
# loop itself and every async test errors during setup rather than running.
# Only non-loopback destinations are of interest here anyway: the bug this
# guards against is a test reaching api.binance.com.
_LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost", "0.0.0.0", ""}


def _is_loopback(address) -> bool:
    if isinstance(address, tuple) and address:
        return str(address[0]) in _LOOPBACK_HOSTS
    # AF_UNIX paths and anything unrecognised: treat as local, since the
    # failure mode being prevented is specifically a remote HTTP call.
    return True


def _guarded(original):
    def wrapper(self_or_addr, *args, **kwargs):
        # socket.socket.connect(self, address) vs socket.create_connection(address)
        if isinstance(self_or_addr, socket.socket):
            address = args[0] if args else None
            if not _is_loopback(address):
                raise _BlockedNetwork(
                    f"This test attempted a real network connection to {address}. Tests must "
                    f"stub their data sources — see tests/conftest.py. A real call retries with "
                    f"exponential backoff against an unreachable host, which hangs the suite "
                    f"instead of failing it. If a network call is genuinely intended, request "
                    f"the `allow_network` fixture."
                )
            return original(self_or_addr, *args, **kwargs)
        if not _is_loopback(self_or_addr):
            raise _BlockedNetwork(
                f"This test attempted a real network connection to {self_or_addr}. "
                f"See tests/conftest.py."
            )
        return original(self_or_addr, *args, **kwargs)

    return wrapper


@pytest.fixture(autouse=True)
def block_network(request, monkeypatch):
    """Fail fast on a real (non-loopback) network call.

    Covers two layers, because the socket layer alone is not enough:

    1. `socket.socket.connect` / `connect_ex` / `create_connection` — catches
       synchronous and ccxt-style calls.
    2. `httpx.AsyncClient.request` — async httpx on Windows goes through the
       proactor event loop's overlapped IO rather than `socket.connect`, so the
       socket patches never see it. A test asserting that a macro fetch
       degrades gracefully silently made a REAL request to api.alternative.me
       and got a live Fear & Greed value back, which is how this gap was found.
    """
    if "allow_network" in request.fixturenames:
        return
    monkeypatch.setattr(socket.socket, "connect", _guarded(socket.socket.connect))
    monkeypatch.setattr(socket.socket, "connect_ex", _guarded(socket.socket.connect_ex))
    monkeypatch.setattr(socket, "create_connection", _guarded(socket.create_connection))

    try:
        import httpx
    except ImportError:  # pragma: no cover - httpx is a declared dependency
        return

    async def _blocked_request(self, method, url, *args, **kwargs):
        raise _BlockedNetwork(
            f"This test attempted a real HTTP request: {method} {url}. Stub the client or the "
            f"function under test — see tests/conftest.py. Request `allow_network` if a live "
            f"call is genuinely intended."
        )

    monkeypatch.setattr(httpx.AsyncClient, "request", _blocked_request)


@pytest.fixture
def allow_network():
    """Opt out of the network block. Presence in a signature is the point."""
    return True


# ---------------------------------------------------------------------------
# Candle helpers
# ---------------------------------------------------------------------------

def make_candles(
    n: int = 120,
    base: float = 100.0,
    drift: float = 0.1,
    spread: float = 2.0,
    volume: float = 1000.0,
) -> List[Dict[str, Any]]:
    """Synthetic OHLCV with a genuine high/low range so ATR is non-zero.

    `drift` per candle gives a deterministic trend; a flat series would make
    every correlation and ATR calculation degenerate, which is a different test
    case (and one the code deliberately reports as unmeasurable).
    """
    out = []
    for i in range(n):
        close = base + i * drift
        out.append(
            {
                "openTime": i * 900_000,
                "open": close - drift,
                "high": close + spread,
                "low": close - spread,
                "close": close,
                "volume": volume,
            }
        )
    return out


def make_correlated_candles(n: int = 120, base: float = 50.0, sign: float = 1.0) -> List[Dict[str, Any]]:
    """A series whose returns correlate +1 (sign=1) or -1 (sign=-1) with
    `make_candles()`'s returns, for exercising the correlation threshold."""
    out = []
    for i in range(n):
        close = base + sign * i * 0.05
        out.append(
            {
                "openTime": i * 900_000,
                "open": close - sign * 0.05,
                "high": close + 1.0,
                "low": close - 1.0,
                "close": close,
                "volume": 500.0,
            }
        )
    return out


@pytest.fixture
def candles():
    return make_candles()
