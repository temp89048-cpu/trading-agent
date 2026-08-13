"""Integration tests over the real MessageBus: can a trade reach the exchange
without passing every gate?

Spec Section 8: *"the Execution API is a hard chokepoint — no agent talks to
an exchange directly, ever."* Spec Section 22.9 asks specifically for tests
that try to get an agent to bypass the CRO veto. These drive real events
through the real bus and assert on what the ExecutionAgent actually does.
"""

import uuid

import pytest

from backend.agents.cro_agent import CROAgent
from backend.agents.execution_agent import ExecutionAgent
from backend.core import system_state
from backend.core.message_bus import WILDCARD_TOPIC, MessageBus, get_message_bus
from backend.models.events import (
    TarApprovedEvent,
    TarRejectedEvent,
    TarSubmittedEvent,
    TickReceivedEvent,
)


@pytest.fixture(autouse=True)
def _clean_bus_and_state(monkeypatch):
    """Each test gets a private bus, so subscriptions from one test can't
    deliver events into another."""
    fresh = MessageBus()
    monkeypatch.setattr("backend.core.message_bus._bus", fresh)
    system_state.resume("test setup")
    yield fresh
    system_state.resume("test teardown")


def _tar_approved(**overrides):
    base = dict(
        tar_id=uuid.uuid4(),
        symbol="BTC/USDT",
        direction="LONG",
        approved_size=0.01,
        approved_leverage=1,
        cro_rationale="test",
        stop_loss=59_000.0,
        take_profit=62_000.0,
        tab="paper",
    )
    base.update(overrides)
    return TarApprovedEvent(**base)


def _tar_submitted(**overrides):
    base = dict(
        symbol="BTC/USDT",
        direction="LONG",
        requested_size=0.01,
        requested_leverage=1,
        strategy="test",
        supervisor_rationale="test",
        stop_loss=59_000.0,
        take_profit=62_000.0,
        entry_price=60_000.0,
        tab="paper",
    )
    base.update(overrides)
    return TarSubmittedEvent(**base)


# ---------------------------------------------------------------------------
# The kill switch must stop the component that actually places orders
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_execution_refuses_an_approved_tar_while_paused():
    """The hole this closes: /emergency-stop set a flag that only
    trading_agent.py read, so the ExecutionAgent kept routing approved TARs
    straight through an active emergency stop."""
    agent = ExecutionAgent(simulation_mode=True)
    # Give it a price so a fill would otherwise be possible.
    await agent.handle_event(
        TickReceivedEvent(symbol="BTC/USDT", price=60_000.0, volume=10.0, exchange="test")
    )

    filled = []
    get_message_bus().subscribe("ORDER_FILLED", lambda e: filled.append(e))

    system_state.pause("test")
    await agent.handle_event(_tar_approved())
    assert filled == [], "An approved TAR must not execute while the system is paused."

    system_state.resume("test")
    await agent.handle_event(_tar_approved())
    assert len(filled) == 1, "After resume, execution should proceed normally."


@pytest.mark.asyncio
async def test_execution_refuses_while_emergency_stopped():
    agent = ExecutionAgent(simulation_mode=True)
    await agent.handle_event(
        TickReceivedEvent(symbol="BTC/USDT", price=60_000.0, volume=10.0, exchange="test")
    )
    filled = []
    get_message_bus().subscribe("ORDER_FILLED", lambda e: filled.append(e))

    system_state.trigger_emergency_stop("test")
    await agent.handle_event(_tar_approved())
    assert filled == []


# ---------------------------------------------------------------------------
# No fabricated fills
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_simulation_without_an_observed_price_does_not_invent_one():
    """A simulated fill at price 0.0 would poison every downstream P&L
    figure, so the agent aborts instead of filling."""
    agent = ExecutionAgent(simulation_mode=True)  # no tick delivered
    filled = []
    get_message_bus().subscribe("ORDER_FILLED", lambda e: filled.append(e))

    await agent.handle_event(_tar_approved(symbol="NEVER/SEEN"))
    assert filled == [], "No price observed means no fill may be reported."


@pytest.mark.asyncio
async def test_fill_price_matches_the_observed_price_in_simulation():
    agent = ExecutionAgent(simulation_mode=True)
    await agent.handle_event(
        TickReceivedEvent(symbol="BTC/USDT", price=60_000.0, volume=10.0, exchange="test")
    )
    filled = []
    get_message_bus().subscribe("ORDER_FILLED", lambda e: filled.append(e))

    await agent.handle_event(_tar_approved())
    assert len(filled) == 1
    assert filled[0].fill_price == 60_000.0
    assert filled[0].exchange == "simulated_exchange"


# ---------------------------------------------------------------------------
# The CRO veto
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_cro_rejects_leverage_above_the_ceiling_and_publishes_no_approval():
    """25x must be vetoed. Previously the CRO's cap was a bare `> 5`."""
    cro = CROAgent()
    approvals, rejections = [], []
    bus = get_message_bus()
    bus.subscribe("TAR_APPROVED", lambda e: approvals.append(e))
    bus.subscribe("TAR_REJECTED", lambda e: rejections.append(e))

    await cro.handle_event(_tar_submitted(requested_leverage=25, tab="real"))

    assert approvals == [], "A TAR above the leverage ceiling must never be approved."
    assert len(rejections) == 1
    assert rejections[0].rule_breached == "MAX_LEVERAGE_LIMIT"


@pytest.mark.asyncio
async def test_cro_rejects_an_inverted_stop_loss_on_a_long():
    """A stop above entry on a long is not a protective stop."""
    cro = CROAgent()
    approvals, rejections = [], []
    bus = get_message_bus()
    bus.subscribe("TAR_APPROVED", lambda e: approvals.append(e))
    bus.subscribe("TAR_REJECTED", lambda e: rejections.append(e))

    await cro.handle_event(_tar_submitted(stop_loss=61_000.0, entry_price=60_000.0, direction="LONG"))

    assert approvals == []
    assert rejections[0].rule_breached == "INVALID_STOP_LOSS"


@pytest.mark.asyncio
async def test_cro_rejects_an_inverted_stop_loss_on_a_short():
    cro = CROAgent()
    approvals, rejections = [], []
    bus = get_message_bus()
    bus.subscribe("TAR_APPROVED", lambda e: approvals.append(e))
    bus.subscribe("TAR_REJECTED", lambda e: rejections.append(e))

    await cro.handle_event(_tar_submitted(stop_loss=59_000.0, entry_price=60_000.0, direction="SHORT"))

    assert approvals == []
    assert rejections[0].rule_breached == "INVALID_STOP_LOSS"


@pytest.mark.asyncio
async def test_cro_refuses_rather_than_assuming_a_hundred_thousand_dollar_balance():
    """The VaR check used `total_equity = 100000.0` hardcoded, so the limit
    was meaningless for any real account — and for this repo's actual
    $2-to-$5 capital-target mission it was off by five orders of magnitude.
    With unknown equity it must now refuse, not assume."""
    cro = CROAgent()
    approvals, rejections = [], []
    bus = get_message_bus()
    bus.subscribe("TAR_APPROVED", lambda e: approvals.append(e))
    bus.subscribe("TAR_REJECTED", lambda e: rejections.append(e))

    # The 'real' book in portfolio_store has no cash figure, so equity is unknown.
    await cro.handle_event(_tar_submitted(tab="real"))

    assert approvals == []
    assert rejections[0].rule_breached == "UNKNOWN_EQUITY"


# ---------------------------------------------------------------------------
# The agent contract's publish permission
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_an_agent_cannot_publish_an_event_it_did_not_declare():
    """BaseAgent.publish raises PermissionError for undeclared event types.
    This is what stops an agent from forging a TAR_APPROVED to reach
    Execution without the CRO."""
    agent = ExecutionAgent(simulation_mode=True)
    assert "TAR_APPROVED" not in agent.events_published

    with pytest.raises(PermissionError):
        await agent.publish(_tar_approved())


@pytest.mark.asyncio
async def test_wildcard_subscriber_observes_every_event():
    """Spec Section 20: everything must be observable."""
    seen = []
    bus = get_message_bus()
    bus.subscribe(WILDCARD_TOPIC, lambda e: seen.append(e))

    agent = ExecutionAgent(simulation_mode=True)
    await agent.handle_event(
        TickReceivedEvent(symbol="BTC/USDT", price=60_000.0, volume=1.0, exchange="test")
    )
    await agent.handle_event(_tar_approved())

    kinds = {getattr(e, "event_type", None) for e in seen}
    assert "ORDER_ROUTED" in kinds
    assert "ORDER_FILLED" in kinds
