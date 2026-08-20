"""Phase 32b — the streaming feed.

The tests are shaped around the claims a websocket feed invites you to make falsely:

  * that it replaces the poller (it cannot — `expected_price` needs a whole event
    partition and `watch_ticker` is per-outcome);
  * that it improves the signal (it cannot — persisting every tick would shrink the
    volatility baseline from a week to hours, so persistence is throttled);
  * that it needs a `websockets` dependency (it does not — ccxt implements the venue's
    non-standard keepalive).

What it genuinely buys is trigger latency, and that is what is asserted.
"""

from __future__ import annotations

import asyncio
import pathlib
import time

import pytest

from backend.services import polymarket_registry as registry
from backend.services import polymarket_store as store
from backend.workers import polymarket_worker as pw


@pytest.fixture
def flag_on(monkeypatch):
    monkeypatch.setenv("POLYMARKET_ENABLED", "true")
    return True


@pytest.fixture
def tmp_store(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(store, "SERIES_FILE", str(tmp_path / "series.json"))
    monkeypatch.setattr(store, "MARKETS_FILE", str(tmp_path / "markets.json"))
    monkeypatch.setattr(store, "SNAPSHOT_FILE", str(tmp_path / "snapshots.json"))
    return tmp_path


@pytest.fixture
def stream():
    pw.reset_polymarket_stream()
    yield pw.PolymarketStreamFeed()
    pw.reset_polymarket_stream()


@pytest.fixture
def isolated_bus(monkeypatch):
    """A real `MessageBus` with no other subscribers.

    Same reason as in `test_polymarket_worker.py`: publishing `TRIGGER_FIRED` with
    `acted=True` onto the GLOBAL bus reaches the analysis graph's subscriber, which
    starts a real reasoning run and retries market-data fetches against the blocked
    network until the suite times out.
    """
    from backend.core import message_bus

    fresh = message_bus.MessageBus()
    monkeypatch.setattr(message_bus, "_bus", fresh)
    monkeypatch.setattr(message_bus, "get_message_bus", lambda: fresh)
    return fresh


def _ticker(last, bid=None, ask=None, volume=100_000.0):
    return {
        "last": last,
        "bid": last - 0.005 if bid is None else bid,
        "ask": last + 0.005 if ask is None else ask,
        "quoteVolume": volume,
        "openInterest": 50_000.0,
    }


async def _confirm(symbol, outcome, market="M"):
    await store.save_mapping(symbol, outcome, market=market,
                             role=registry.ROLE_DIRECTIONAL,
                             classification_reason="test")
    await store.confirm_mapping(symbol, outcome, True, set_by_human=True)


# ===========================================================================
# The three false claims
# ===========================================================================

def test_the_stream_does_not_replace_the_poller():
    """`expected_price` needs every bucket of a mutually-exclusive event at once, and
    `watch_ticker` is per-outcome. A stream of one bucket's midpoint cannot produce a
    partition, so snapshots still come from the REST poller."""
    import ast

    src = pathlib.Path("backend/workers/polymarket_worker.py").read_text(encoding="utf-8")
    tree = ast.parse(src)

    stream_cls = next(
        n for n in ast.walk(tree)
        if isinstance(n, ast.ClassDef) and n.name == "PolymarketStreamFeed"
    )
    calls = {
        n.func.attr for n in ast.walk(stream_cls)
        if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute)
    }
    # It must NOT write snapshots or compute expected prices.
    assert "save_signal_snapshot" not in calls
    assert "expected_price" not in calls
    assert "buckets_from_event" not in calls
    # It DOES record probabilities and evaluate triggers.
    assert "record_probability" in calls
    assert "evaluate_prediction_market" in calls


def test_persistence_is_throttled_to_the_stores_resolution():
    """Persisting every tick would blow through MAX_POINTS_PER_OUTCOME (a week at
    5-minute resolution) in hours, and the z-score's baseline would then cover the
    last few hours instead of the last week — worse, not better."""
    assert pw.STREAM_PERSIST_INTERVAL_SECONDS == store.SERIES_RESOLUTION_SECONDS


def test_no_websockets_dependency_is_needed():
    """ccxt implements the Polymarket CLOB market channel including the venue's
    text-PING-every-10s keepalive. An earlier draft of the integration plan claimed
    `websockets` had to be declared; that was wrong."""
    import ast

    tree = ast.parse(
        pathlib.Path("backend/workers/polymarket_worker.py").read_text(encoding="utf-8")
    )
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[0] for a in node.names)
    assert "websockets" not in imported

    requirements = pathlib.Path("requirements.txt").read_text(encoding="utf-8")
    assert "websockets" not in requirements

    # And the keepalive really is ccxt's job.
    import inspect

    from ccxt.prediction import polymarket

    assert "'ping'" in inspect.getsource(polymarket.describe)


# ===========================================================================
# Startup conditions
# ===========================================================================

async def test_the_stream_does_not_start_when_disabled(monkeypatch, stream, tmp_store):
    monkeypatch.setenv("POLYMARKET_ENABLED", "false")  # explicit "false", not delenv:
    # `.env` now sets this flag, and `services/exchange_client` calls `load_dotenv()` at
    # import time. `load_dotenv` does not override an existing var but DOES set an
    # absent one — so a lazy import after `delenv` silently restored the value from
    # `.env` and the flag-off tests saw 9 specialists. An explicit "false" survives it.

    class _Client:
        calls = 0

        def is_available(self):
            _Client.calls += 1
            return True

    await stream.start(client=_Client())
    assert stream.stats()["following"] == []
    assert _Client.calls == 0, "the flag must be checked before the adapter"


async def test_the_stream_reports_an_unavailable_adapter(flag_on, stream, tmp_store):
    class _Client:
        def is_available(self):
            return False

        def unavailable_reason(self):
            return "ccxt too old"

    await stream.start(client=_Client())
    assert stream.stats()["following"] == []


async def test_no_confirmed_mapping_means_nothing_to_follow(flag_on, stream, tmp_store):
    """Not an error. Until a human confirms a mapping there is nothing to follow, and
    that is the expected state."""
    class _Client:
        def is_available(self):
            return True

        def unavailable_reason(self):
            return None

    await stream.start(client=_Client())
    assert stream.stats()["following"] == []


async def test_an_unconfirmed_mapping_is_not_followed(flag_on, stream, tmp_store):
    """Following discovery's guess would spend a subscription and fire triggers on a
    market nobody has attested is about this instrument."""
    await store.save_mapping("BTC/USDT", "A:YES", market="M",
                             role=registry.ROLE_DIRECTIONAL,
                             classification_reason="test")

    class _Client:
        def is_available(self):
            return True

        def unavailable_reason(self):
            return None

        async def watch_ticker(self, outcome):
            await asyncio.sleep(10)

    await stream.start(client=_Client())
    try:
        assert stream.stats()["following"] == []
    finally:
        await stream.stop()


async def test_confirmed_outcomes_are_followed(flag_on, stream, tmp_store):
    await _confirm("BTC/USDT", "A:YES")
    await _confirm("ETH/USDT", "B:YES")

    class _Client:
        def is_available(self):
            return True

        def unavailable_reason(self):
            return None

        async def watch_ticker(self, outcome):
            await asyncio.sleep(10)

    await stream.start(client=_Client())
    try:
        assert sorted(stream.stats()["following"]) == ["A:YES", "B:YES"]
    finally:
        await stream.stop()


# ===========================================================================
# Update handling
# ===========================================================================

async def test_a_ticker_without_a_midpoint_is_ignored(flag_on, stream, tmp_store):
    """`PredictionTicker.last` is the midpoint. Without one there is no probability to
    record — and storing a fabricated one is what `record_probability` refuses."""
    await _confirm("BTC/USDT", "A:YES")

    for bad in ({}, {"last": None}, {"last": "0.5"}, {"last": True}, "not a dict"):
        await stream._on_ticker("A:YES", bad)  # type: ignore[arg-type]

    assert await store.get_series("A:YES") == []
    assert stream.points_persisted == 0


async def test_the_first_update_persists_and_the_next_is_throttled(
    flag_on, stream, tmp_store, isolated_bus,
):
    await _confirm("BTC/USDT", "A:YES")

    await stream._on_ticker("A:YES", _ticker(0.40))
    assert stream.points_persisted == 1

    # Immediately again — inside the throttle window.
    await stream._on_ticker("A:YES", _ticker(0.55))
    assert stream.points_persisted == 1
    assert len(await store.get_series("A:YES")) == 1


async def test_the_trigger_is_evaluated_on_every_update_even_when_throttled(
    flag_on, stream, tmp_store, isolated_bus,
):
    """THE POINT OF THE STREAM. Persistence is throttled to protect the retention
    window; trigger evaluation is not, because that is the latency this buys."""
    await _confirm("BTC/USDT", "A:YES")

    await stream._on_ticker("A:YES", _ticker(0.40))
    await stream._on_ticker("A:YES", _ticker(0.41))
    await stream._on_ticker("A:YES", _ticker(0.42))

    assert stream.points_persisted == 1
    assert stream.triggers_evaluated == 3


async def test_an_un_confirmed_mapping_stops_attribution_mid_stream(
    flag_on, stream, tmp_store, isolated_bus,
):
    """The symbol is read from the store per update rather than cached at subscribe
    time: an operator can withdraw a confirmation while the stream is running, and a
    cached symbol would keep firing triggers for a market whose attribution had been
    revoked."""
    await _confirm("BTC/USDT", "A:YES")
    await stream._on_ticker("A:YES", _ticker(0.40))
    assert stream.triggers_evaluated == 1

    await store.confirm_mapping("BTC/USDT", "A:YES", False)
    await stream._on_ticker("A:YES", _ticker(0.60))
    assert stream.triggers_evaluated == 1, "attribution must stop with the confirmation"


async def test_a_large_unusual_move_publishes_a_trigger(
    flag_on, stream, tmp_store, isolated_bus,
):
    """End to end: stream update -> trigger -> real bus."""
    from backend.graphs.triggers import reset_trigger_evaluator

    reset_trigger_evaluator()
    await _confirm("BTC/USDT", "A:YES")

    received = []

    async def handler(event):
        received.append(event)

    isolated_bus.subscribe("TRIGGER_FIRED", handler)

    # Seed a volatility baseline with varied steps, inside the signal window.
    now = time.time()
    for i in range(30):
        await store.record_probability(
            "A:YES", 0.30 + 0.001 * i + (0.0003 if i % 2 else -0.0003),
            ts=now - (30 - i) * 60.0,
        )

    # First update establishes the trigger baseline; the second is the move.
    await stream._on_ticker("A:YES", _ticker(0.33))
    await stream._on_ticker("A:YES", _ticker(0.45))

    assert received, "a large, unusual move should have published a trigger"
    assert received[-1].kind == "prediction_market_shift"


# ===========================================================================
# Lifecycle
# ===========================================================================

async def test_a_failing_subscription_backs_off_rather_than_spinning(
    flag_on, stream, tmp_store,
):
    await _confirm("BTC/USDT", "A:YES")
    attempts = []

    class _Client:
        def is_available(self):
            return True

        def unavailable_reason(self):
            return None

        async def watch_ticker(self, outcome):
            attempts.append(time.time())
            raise RuntimeError("connection reset")

    await stream.start(client=_Client())
    await asyncio.sleep(0.05)
    await stream.stop()

    # It retried, and it did not spin: the initial backoff is seconds, so a 50ms
    # window admits at most one or two attempts.
    assert attempts
    assert len(attempts) <= 2, f"backoff is not being applied: {len(attempts)} attempts"
    assert stream.reconnects >= 1


async def test_a_client_that_cannot_stream_stops_the_task_rather_than_retrying(
    flag_on, stream, tmp_store,
):
    """`watch_ticker` returning None means the ccxt build has no streaming support.
    Retrying forever against a method that does not exist would log a warning every
    two seconds for the life of the process."""
    calls = []

    class _Client:
        def is_available(self):
            return True

        def unavailable_reason(self):
            return None

        async def watch_ticker(self, outcome):
            calls.append(outcome)
            return None

    await _confirm("BTC/USDT", "A:YES")
    await stream.start(client=_Client())
    await asyncio.sleep(0.05)
    await stream.stop()

    assert len(calls) == 1, f"should stop after one None, got {len(calls)}"
    assert stream.reconnects == 0


async def test_stopping_cancels_and_awaits_every_task(flag_on, stream, tmp_store):
    """An un-awaited cancelled task logs "Task exception was never retrieved" at
    interpreter shutdown, which reads as a crash during an otherwise clean stop."""
    await _confirm("BTC/USDT", "A:YES")
    await _confirm("ETH/USDT", "B:YES")

    class _Client:
        def is_available(self):
            return True

        def unavailable_reason(self):
            return None

        async def watch_ticker(self, outcome):
            await asyncio.sleep(30)

    await stream.start(client=_Client())
    tasks = list(stream._tasks.values())
    assert len(tasks) == 2

    await stream.stop()
    assert stream.stats()["following"] == []
    assert all(t.done() for t in tasks)


def test_the_stats_state_what_the_stream_does_and_does_not_do(stream):
    meaning = stream.stats()["meaning"]
    assert "LATENCY only" in meaning
    assert "REST poller" in meaning
    assert "throttled" in meaning


# ===========================================================================
# Wiring and read-only
# ===========================================================================

def test_the_stream_is_started_and_stopped_by_the_lifespan():
    """The stream owns one task per outcome internally, so it must be started
    directly rather than appended to `worker_tasks` — cancelling a single wrapper
    would leave the children running."""
    import inspect

    import backend.main as main

    src = inspect.getsource(main.lifespan)
    assert "get_polymarket_stream" in src
    assert "await polymarket_stream.start()" in src
    assert "await polymarket_stream.stop()" in src
    assert "worker_tasks.append(asyncio.create_task(polymarket_stream" not in src


def test_the_watch_allowlist_is_separate_from_the_read_allowlist():
    """`_call`'s retry-with-backoff is right for a one-shot REST read and wrong for a
    subscription, so the two must not share a code path. Keeping them apart also lets
    the `_call` allowlist stay "fetch_ only", which is verifiable at a glance."""
    from backend.services.polymarket_client import _READ_METHODS, _WATCH_METHODS

    assert _WATCH_METHODS == {"watch_ticker"}
    assert not (_READ_METHODS & _WATCH_METHODS)
    for method in _READ_METHODS:
        assert method.startswith("fetch_")


def test_watch_ticker_does_not_go_through_the_retry_path():
    """ccxt reconnects internally; an outer retry loop would stack a second reconnect
    strategy on top of it.

    AST, not a text search — and this test is the reason to say so. The first version
    asserted `"_call" not in inspect.getsource(...)`, and it matched the method's own
    docstring, which begins "NOT ROUTED THROUGH `_call`". That is the fourth time in
    this project that grepping source for a forbidden literal has matched the comment
    documenting the rule, and it happened here despite two other tests in this same
    file carrying a comment warning about it.

    The lesson has now been paid for often enough to state plainly: a text search
    cannot distinguish prose about a rule from a breach of it, and the failure mode is
    that authors stop documenting the rule.
    """
    import ast
    import inspect

    from backend.services.polymarket_client import PolymarketClient

    tree = ast.parse(inspect.getsource(PolymarketClient.watch_ticker).strip())
    called = {
        node.func.attr for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
    }
    referenced = {
        node.id for node in ast.walk(tree) if isinstance(node, ast.Name)
    }

    assert "_call" not in called, "watch_ticker must not use the retry path"
    assert "_MAX_RETRIES" not in referenced
    # It must still go through the guarded lazy constructor, so the no-credentials
    # posture applies to the streaming path too.
    assert "_get" in called


def test_the_stream_cannot_reach_an_order_call():
    import ast

    from backend.graphs.contracts import FORBIDDEN_IMPORTS

    tree = ast.parse(
        pathlib.Path("backend/workers/polymarket_worker.py").read_text(encoding="utf-8")
    )
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)
    assert not (imported & set(FORBIDDEN_IMPORTS))

    for node in ast.walk(tree):
        if isinstance(node, ast.Attribute):
            assert node.attr not in {
                "create_order", "create_orders", "cancel_order", "cancel_all_orders",
                "fetch_balance", "fetch_positions",
            }, node.attr
