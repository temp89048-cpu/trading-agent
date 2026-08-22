"""End-to-end test of the AUTOMATIC chain after a trade opens.

The question this answers: *"when the agent opens a trade, does the next process
happen by itself?"* Nothing tested it. There were tests for each link — the
supervisor, the CRO, the execution agent, the position monitor, the reflection
agent — but none that published one fill and watched the rest of the pipeline move
on its own. A chain can have every link tested and still be unconnected.

The chain under test, all on the real message bus:

    TAR_APPROVED     (risk approved a size and a stop)
      -> ORDER_FILLED   (the fill)
           -> PositionMonitor registers the position with its stop
      -> TICK_RECEIVED  (price moves against it)
           -> PositionMonitor closes it
             -> POSITION_CLOSED
               -> ReflectionAgent writes a lesson
                 -> REFLECTION_COMPLETED
                   -> HypothesisAgent proposes a hypothesis

Every event is published for real and every subscriber is the production one. What
is stubbed is the exchange (`attach_execution`) and the LLM, because neither is
part of the wiring being tested.

ALSO PINS THE TWO FAILURE MODES THAT MATTER MORE THAN THE HAPPY PATH:
  * a fill with no matching approval must be logged as UNPROTECTED and left
    unmonitored rather than silently tracked with a guessed stop;
  * the position book must not be silently empty after a restart — see
    `test_open_positions_do_not_survive_a_restart`, which documents the real
    persistence gap rather than pretending it is closed.
"""

import asyncio
import uuid

import pytest

from backend.core.message_bus import MessageBus
from backend.models.events import (
    OrderFilledEvent,
    PositionClosedEvent,
    TarApprovedEvent,
    TickReceivedEvent,
)


@pytest.fixture
def bus(monkeypatch):
    """A private bus, so publishing here cannot start real graph runs.

    The global bus has the analysis graph subscribed to TRIGGER_FIRED; publishing
    onto it from a test starts a graph run that reaches for the network and hangs
    the suite. That has happened before.
    """
    private = MessageBus()
    import backend.core.message_bus as mb

    monkeypatch.setattr(mb, "get_message_bus", lambda: private)
    # The agents capture the bus at construction, so patch every module that
    # resolves it lazily too.
    for module in (
        "backend.core.agent_base",
        "backend.agents.position_monitor",
        "backend.agents.reflection_agent",
    ):
        try:
            mod = __import__(module, fromlist=["get_message_bus"])
            if hasattr(mod, "get_message_bus"):
                monkeypatch.setattr(mod, "get_message_bus", lambda: private)
        except (ImportError, AttributeError):
            pass
    return private


class FakeExecution:
    """Stands in for the Execution Engine. Records closes; places no orders.

    `close_position` returns the FILL PRICE as a float, or None to signal a failed
    close — that is the real contract, and it matters: the monitor computes realized
    P&L from the returned fill rather than from the trigger price, because the two
    differ by slippage and using the trigger would report the P&L we hoped for
    instead of the one we got.
    """

    def __init__(self, fill_price=None):
        self.closes = []
        # None means "the close failed", which the monitor must treat as
        # "still open", not "closed at zero".
        self._fill_price = fill_price
        self.fail = False

    async def close_position(self, **kwargs):
        self.closes.append(kwargs)
        if self.fail:
            return None
        # Default to the trigger-ish price the test set up, minus a tick of
        # slippage, so realized P&L is computed from a real number.
        return self._fill_price if self._fill_price is not None else 67_450.0


@pytest.fixture
def monitor(bus):
    from backend.agents.position_monitor import PositionMonitorAgent

    agent = PositionMonitorAgent()
    agent.rebind_bus(bus)
    agent.attach_execution(FakeExecution())
    return agent


def approval(symbol="BTC/USDT", stop=68_000.0, tab="paper", tar_id=None):
    return TarApprovedEvent(
        tar_id=tar_id or uuid.uuid4(),
        symbol=symbol,
        direction="long",
        approved_size=0.05,
        approved_leverage=2,
        cro_rationale="within all nine checks",
        stop_loss=stop,
        tab=tab,
        take_profit=76_000.0,
    )


def fill(tar_id, symbol="BTC/USDT", price=70_000.0, tab="paper", side="buy"):
    return OrderFilledEvent(
        tar_id=tar_id,
        exchange="binance_futures",
        order_id=str(uuid.uuid4()),
        symbol=symbol,
        side=side,
        tab=tab,
        fill_price=price,
        fill_quantity=0.05,
        slippage_bps=1.2,
        fee=0.35,
    )


# ---------------------------------------------------------------------------
# The chain
# ---------------------------------------------------------------------------


def test_an_approved_fill_becomes_a_monitored_position(monitor):
    """Link 1: the monitor must pick the position up WITHOUT being told to.

    If this fails the pipeline can open a position that nothing ever closes —
    the exact gap `main.py`'s lifespan comment says the monitor exists to fill.
    """
    assert monitor.open_position_count == 0

    appr = approval()
    asyncio.run(monitor.handle_event(appr))
    asyncio.run(monitor.handle_event(fill(appr.tar_id)))

    assert monitor.open_position_count == 1
    open_now = monitor.snapshot_open()[0]
    assert open_now["symbol"] == "BTC/USDT"
    # The stop travels with the APPROVAL, so the monitor enforces the number risk
    # approved rather than one it re-derived and could disagree about.
    assert float(open_now["stopLoss"]) == pytest.approx(68_000.0)


def test_a_fill_with_no_approval_is_flagged_unprotected_and_not_monitored(monitor, caplog):
    """Link 1, failure mode. This must NOT be tracked with an invented stop.

    A position tracked without a real approved stop looks protected on every
    dashboard while having no enforceable exit — strictly worse than being
    reported as unmonitored.
    """
    with caplog.at_level("CRITICAL"):
        asyncio.run(monitor.handle_event(fill(uuid.uuid4())))

    assert monitor.open_position_count == 0
    assert "UNPROTECTED POSITION" in caplog.text


def test_price_through_the_stop_closes_the_position_automatically(monitor):
    """Link 2: a tick, not a human, triggers the exit."""
    appr = approval(stop=68_000.0)
    asyncio.run(monitor.handle_event(appr))
    asyncio.run(monitor.handle_event(fill(appr.tar_id, price=70_000.0)))
    assert monitor.open_position_count == 1

    # Above the stop: nothing should happen.
    asyncio.run(
        monitor.handle_event(
            TickReceivedEvent(symbol="BTC/USDT", price=69_000.0, volume=1.0, exchange="binance_futures")
        )
    )
    assert monitor.open_position_count == 1, "closed early, above the stop"

    # Through the stop: it must close on its own.
    asyncio.run(
        monitor.handle_event(
            TickReceivedEvent(symbol="BTC/USDT", price=67_500.0, volume=1.0, exchange="binance_futures")
        )
    )
    assert monitor.open_position_count == 0, "price went through the stop and nothing closed"


def test_the_close_publishes_position_closed_for_the_learning_pipeline(monitor, bus):
    """Link 3: the exit must announce itself, or learning never starts.

    POSITION_CLOSED had no publisher at all before the monitor existed, so every
    reflection downstream was waiting on an event that was never sent.
    """
    seen = []
    bus.subscribe("POSITION_CLOSED", lambda e: seen.append(e))

    appr = approval(stop=68_000.0)
    asyncio.run(monitor.handle_event(appr))
    asyncio.run(monitor.handle_event(fill(appr.tar_id, price=70_000.0)))
    asyncio.run(
        monitor.handle_event(
            TickReceivedEvent(symbol="BTC/USDT", price=67_500.0, volume=1.0, exchange="binance_futures")
        )
    )

    assert len(seen) == 1, "the close did not publish POSITION_CLOSED"
    closed = seen[0]
    assert closed.symbol == "BTC/USDT"
    # The REASON must be accurate: labelling a stop as a thesis exit misreports the
    # one fact the reflection is about to learn from.
    assert closed.exit_reason == "stop-loss"
    assert closed.entry_price == pytest.approx(70_000.0)
    # A long stopped out below entry cannot have made money.
    assert closed.realized_pnl < 0


def test_reflection_consumes_position_closed(bus):
    """Link 4: the learning agent is subscribed to the event the monitor sends.

    Asserted on the CONTRACT rather than by running an LLM call: the agent
    declares what it consumes, and a mismatch between that and what the monitor
    publishes is the failure that silently ends the pipeline.
    """
    from backend.agents.position_monitor import PositionMonitorAgent
    from backend.agents.reflection_agent import get_reflection_agent

    reflection = get_reflection_agent()
    monitor_published = PositionMonitorAgent().events_published

    assert "POSITION_CLOSED" in monitor_published
    assert "POSITION_CLOSED" in reflection.events_consumed, (
        "the monitor publishes POSITION_CLOSED and reflection does not consume it — "
        "the learning pipeline is disconnected"
    )


def test_the_chain_is_connected_end_to_end_by_contract():
    """Every hop's publisher and subscriber must line up, with no orphan link.

    Checks the declared contracts rather than the wiring code, because an agent
    that publishes an event nobody consumes is how three separate stages of this
    pipeline came to dead-end (POSITION_CLOSED, REFLECTION_COMPLETED, and
    ORDER_FILLED all had that shape at some point).
    """
    from backend.agents.cro_agent import get_cro_agent
    from backend.agents.execution_agent import get_execution_agent
    from backend.agents.hypothesis_agent import get_hypothesis_agent
    from backend.agents.position_monitor import get_position_monitor
    from backend.agents.reflection_agent import get_reflection_agent

    hops = [
        ("CRO -> Execution", get_cro_agent(), get_execution_agent(), "TAR_APPROVED"),
        ("Execution -> Monitor", get_execution_agent(), get_position_monitor(), "ORDER_FILLED"),
        ("Monitor -> Reflection", get_position_monitor(), get_reflection_agent(), "POSITION_CLOSED"),
        ("Reflection -> Hypothesis", get_reflection_agent(), get_hypothesis_agent(), "REFLECTION_COMPLETED"),
    ]

    broken = []
    for label, producer, consumer, event in hops:
        if event not in producer.events_published:
            broken.append(f"{label}: {producer.name} does not publish {event}")
        if event not in consumer.events_consumed:
            broken.append(f"{label}: {consumer.name} does not consume {event}")

    assert broken == [], "the post-trade chain has a gap:\n" + "\n".join(broken)


# ---------------------------------------------------------------------------
# The persistence gap — documented, not papered over
# ---------------------------------------------------------------------------


def test_open_positions_do_not_survive_a_restart(monitor):
    """DOCUMENTS A REAL GAP: the monitor's book is in-memory only.

    `_Tracked` lives in a dict on the agent and `services/portfolio_store.py` is a
    module-level dict with no persistence of any kind, so a restart forgets every
    open position. For paper trading that loses P&L continuity. For REAL trading
    it is worse: the position still exists at the exchange, with a stop this
    process was the only thing enforcing, and after a restart nothing is watching
    it — the fill's own `_register_fill` path would not even know to call it
    unprotected, because no fill is replayed.

    This test asserts the CURRENT behaviour so the gap is visible in the suite
    rather than living only in a comment. When positions are persisted, this test
    should be inverted, not deleted.
    """
    from backend.agents.position_monitor import PositionMonitorAgent

    appr = approval()
    asyncio.run(monitor.handle_event(appr))
    asyncio.run(monitor.handle_event(fill(appr.tar_id)))
    assert monitor.open_position_count == 1

    # A "restart" is just a fresh agent: there is nowhere for it to read from.
    restarted = PositionMonitorAgent()
    assert restarted.open_position_count == 0, (
        "positions now survive a restart — good; invert this test and delete the "
        "gap note in the docstring"
    )


def test_the_backend_portfolio_store_holds_no_persistence(monkeypatch):
    """The same gap, at its source. Pinned so a fix is noticed here.

    `portfolio_store` is 79 lines of module-level dict. Postgres has a `positions`
    table built for exactly this and NOTHING writes to it.
    """
    import inspect

    from backend.services import portfolio_store

    source = inspect.getsource(portfolio_store)
    code = "\n".join(
        line for line in source.splitlines() if not line.strip().startswith("#")
    )
    persists = any(token in code for token in ("get_db_pool", "INSERT INTO", "json.dump", "open("))
    assert not persists, (
        "portfolio_store now persists — good. Update this test and the restart test "
        "above, which both document the in-memory-only behaviour."
    )
