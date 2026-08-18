"""Phase 29 / spec Section 12 — the Execution Service and instrument rules.

    "LangGraph generates an execution request; execution happens OUTSIDE
     LangGraph."

This module is the TRUST BOUNDARY: upstream of it everything is inert, and here an
inert object becomes a live instruction. So the tests are ordered by consequence.

1. **It submits, it never approves.** A service that could approve its own
   submission would make the CRO decorative. `TarApprovedEvent` must be
   unreachable from here.

2. **A close never goes through the CRO.** The CRO can publish TAR_REJECTED, so
   routing an exit through the TAR chain would let a risk agent block a close —
   invariant 4, violated by the component whose job is preventing losses.

3. **Rounding is always DOWN.** Rounding up means the exchange fills a larger
   position than the risk checks approved. A quantity that rounds to below the
   venue minimum is a refusal, not a bumped-up order.

4. **Duplicates are refused before validation.** Checking idempotency last would
   mean a valid plan delivered twice was submitted twice — for an order, that is
   opening the position twice.
"""

from __future__ import annotations

import asyncio

import pytest

from backend.core import system_state
from backend.models.events import ExecutionPlanReadyEvent
from backend.services import execution_service as svc
from backend.services.instrument_rules import (
    InstrumentRules,
    quantise_quantity,
    round_down_to_step,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    system_state.resume("test setup")
    if system_state.is_in_observation_mode():
        system_state.exit_observation_mode("test setup")
    svc.reset_for_tests()
    # Off by default, matching production. Tests that need submission opt in.
    monkeypatch.delenv(svc.ENV_ENABLE, raising=False)
    yield
    svc.reset_for_tests()
    system_state.resume("test teardown")
    if system_state.is_in_observation_mode():
        system_state.exit_observation_mode("test teardown")


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setenv(svc.ENV_ENABLE, "true")


@pytest.fixture(autouse=True)
def _known_rules(monkeypatch):
    """Instrument rules without a network call. Overridden where a test needs
    unknown or unusual rules."""
    async def fake(symbol):
        return InstrumentRules(symbol=symbol, step_size=0.001, min_qty=0.001,
                               tick_size=0.01, min_notional=5.0)

    monkeypatch.setattr(svc, "get_rules", fake)


class FakeAgent:
    """Stands in for `ExecutionAgent`. Records what it was asked to do."""

    def __init__(self, fill=101.5):
        self.closes = []
        self._fill = fill

    async def close_position(self, symbol, entry_side, qty, tab, reason):
        self.closes.append({"symbol": symbol, "entry_side": entry_side,
                            "qty": qty, "tab": tab, "reason": reason})
        return self._fill


def _plan(**over) -> ExecutionPlanReadyEvent:
    payload = {
        "symbol": "BTC/USDT",
        "intent": "open",
        "side": "buy",
        "tab": "paper",
        "idempotency_basis": "basis-" + str(over.pop("_n", 1)),
        "size": 0.5,
        "leverage": 1,
        "stop_loss": 98.0,
        "take_profit": 104.0,
        "entry_price": 100.0,
        "run_id": "run-1",
        "strategy": "Trend",
        "rationale": "test",
    }
    payload.update(over)
    return ExecutionPlanReadyEvent(**payload)


def _close(**over) -> ExecutionPlanReadyEvent:
    """Overrides REPLACE the close defaults rather than being passed alongside them,
    so a caller can flip `side` without a duplicate-keyword TypeError."""
    base = {"intent": "close", "side": "sell", "stop_loss": None,
            "take_profit": None, "entry_price": None}
    base.update(over)
    return _plan(**base)


def _run(event, agent=None):
    service = svc.ExecutionService(execution_agent=agent)
    return asyncio.run(service.handle_plan(event))


# ===========================================================================
# 1. IT SUBMITS. IT NEVER APPROVES.
# ===========================================================================

def test_the_service_cannot_reach_an_approval_or_an_exchange():
    """Rule 0 at import level, and the CRO's authority at import level.

    The service is allowed to import the execution chokepoint — that is why it
    lives in services/ and not graphs/. It is NOT allowed to construct an approval
    or call an exchange.
    """
    import ast
    import pathlib

    src = pathlib.Path("backend/services/execution_service.py").read_text(encoding="utf-8")
    imported = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.ImportFrom):
            imported.update(a.name for a in node.names)
        elif isinstance(node, ast.Import):
            imported.update(a.name.split(".")[-1] for a in node.names)

    forbidden_here = {
        "TarApprovedEvent",   # only the CRO may construct one
        "create_market_order",
        "close_position",     # must go through the agent instance, not directly
        "get_exchange_client",
        "buy_paper",
        "sell_paper",
        "update_portfolio",
    }
    assert not (imported & forbidden_here), (
        f"execution_service imports {sorted(imported & forbidden_here)} — a service "
        f"that can approve its own submission makes the CRO decorative"
    )


def test_an_approved_open_publishes_a_tar_submission_not_an_approval(enabled):
    published = []

    class Bus:
        async def publish(self, topic, payload):
            # (topic, payload) — matching the real MessageBus. The first version of
            # these doubles took a single argument, so they accepted a call the real
            # bus would have rejected with a TypeError.
            published.append(payload)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        receipt = _run(_plan())
    finally:
        mb.get_message_bus = original

    assert receipt.accepted is True
    assert receipt.outcome == "submitted"
    assert len(published) == 1
    assert published[0].event_type == "TAR_SUBMITTED", (
        "only the CRO may publish TAR_APPROVED"
    )
    assert published[0].direction == "LONG"
    assert published[0].stop_loss == 98.0
    assert receipt.tar_id
    assert any("SUBMISSION, not an approval" in n for n in receipt.notes)


def test_a_short_plan_submits_as_short(enabled):
    published = []

    class Bus:
        async def publish(self, topic, payload):
            # (topic, payload) — matching the real MessageBus. The first version of
            # these doubles took a single argument, so they accepted a call the real
            # bus would have rejected with a TypeError.
            published.append(payload)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        _run(_plan(side="sell", stop_loss=102.0, take_profit=96.0))
    finally:
        mb.get_message_bus = original

    assert published[0].direction == "SHORT"


def test_both_publishers_call_the_real_bus_with_its_real_signature(enabled):
    """Regression test for a bug the doubles above HID.

    `MessageBus.publish` takes `(topic, payload)`. Both new publishers were written
    as `publish(event)`, and every test double in this file accepted a single
    argument — so the suite passed while the real call raised `TypeError`. Worse,
    both call sites swallow exceptions by design (a bus failure must not fail a
    reasoning run), so the failure was invisible: it only surfaced in an
    end-to-end run where nothing arrived on the bus.

    This test subscribes to the REAL bus. A signature mismatch cannot hide from it.
    """
    from backend.core.message_bus import get_message_bus

    received = []

    async def collect(event):
        received.append(event)

    bus = get_message_bus()
    bus.subscribe("TAR_SUBMITTED", collect)
    bus.subscribe("EXECUTION_PLAN_READY", collect)

    # 1. The execution service's TAR publish.
    receipt = _run(_plan(idempotency_basis="real-bus-1"))
    assert receipt.outcome == "submitted", receipt.reasons
    assert any(e.event_type == "TAR_SUBMITTED" for e in received), (
        "nothing reached the real bus — check the publish() signature"
    )

    # 2. The graph runner's plan publish.
    from backend.graphs.analysis import _publish_plan
    from backend.graphs.state import (
        ExecutionPlan,
        RiskAssessment,
        TriggerReason,
        new_state,
    )

    st = new_state("r", "BTC/USDT",
                   TriggerReason(kind="manual", symbol="BTC/USDT", detail="d"), 0.0)
    st["execution_plan"] = ExecutionPlan(symbol="BTC/USDT", side="buy", size=0.5,
                                         leverage=1, stop_loss=98.0, tab="paper",
                                         idempotency_basis="real-bus-2")
    st["risk_assessment"] = RiskAssessment(approved=True)
    asyncio.run(_publish_plan(st))

    assert any(e.event_type == "EXECUTION_PLAN_READY" for e in received), (
        "the graph's plan publish did not reach the real bus"
    )


# ===========================================================================
# 2. A CLOSE NEVER GOES THROUGH THE CRO — invariant 4
# ===========================================================================

def test_a_close_goes_straight_to_the_agent_and_publishes_no_tar():
    """The CRO can publish TAR_REJECTED. Routing an exit through the TAR chain
    would let a risk agent block a close, and it would do so precisely when a
    limit has been breached."""
    published = []

    class Bus:
        async def publish(self, topic, payload):
            # (topic, payload) — matching the real MessageBus. The first version of
            # these doubles took a single argument, so they accepted a call the real
            # bus would have rejected with a TypeError.
            published.append(payload)

    agent = FakeAgent()
    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        receipt = _run(_close(), agent=agent)
    finally:
        mb.get_message_bus = original

    assert receipt.accepted is True
    assert receipt.outcome == "closed"
    assert published == [], "a close must not submit a TAR"
    assert len(agent.closes) == 1
    assert agent.closes[0]["symbol"] == "BTC/USDT"


def test_a_close_is_routed_while_the_submission_flag_is_off():
    """A flag that gated opens is a safety feature. The same flag gating closes
    would trap the operator in positions while it was off."""
    assert svc.execution_enabled() is False
    agent = FakeAgent()
    receipt = _run(_close(), agent=agent)

    assert receipt.outcome == "closed"
    assert len(agent.closes) == 1
    assert any(svc.ENV_ENABLE in n for n in receipt.notes)


def test_a_close_is_routed_while_emergency_stopped():
    system_state.trigger_emergency_stop("drawdown breach")
    agent = FakeAgent()
    assert _run(_close(), agent=agent).outcome == "closed"
    assert len(agent.closes) == 1


def test_a_close_is_routed_while_paused():
    system_state.pause("operator request")
    agent = FakeAgent()
    assert _run(_close(), agent=agent).outcome == "closed"


def test_a_close_is_not_blocked_by_a_missing_stop_loss():
    """An open without a stop is refused. A close has no stop by definition, and
    requiring one would make every exit impossible."""
    agent = FakeAgent()
    receipt = _run(_close(stop_loss=None), agent=agent)
    assert receipt.outcome == "closed"


def test_closing_a_long_inverts_the_side_for_the_agent():
    """`close_position` wants the ENTRY side; the plan carries the CLOSING side."""
    agent = FakeAgent()
    _run(_close(side="sell"), agent=agent)
    assert agent.closes[0]["entry_side"] == "buy", "closing with a sell means a long was held"

    agent2 = FakeAgent()
    _run(_close(side="buy", idempotency_basis="basis-2"), agent=agent2)
    assert agent2.closes[0]["entry_side"] == "sell"


def test_a_failed_close_is_retryable_rather_than_marked_handled():
    """Marking the basis as handled would make the retry look like a duplicate, and
    the position would stay open forever."""
    class Failing(FakeAgent):
        async def close_position(self, **kwargs):
            return None

    service = svc.ExecutionService(execution_agent=Failing())
    first = asyncio.run(service.handle_plan(_close()))
    assert first.accepted is False
    assert any("still open" in r for r in first.reasons)

    # The SAME basis again must not be refused as a duplicate.
    agent = FakeAgent()
    service.attach_agent(agent)
    second = asyncio.run(service.handle_plan(_close()))
    assert second.outcome == "closed", "a failed close must remain retryable"


def test_a_close_with_no_attached_agent_is_a_wiring_failure_and_retryable():
    service = svc.ExecutionService(execution_agent=None)
    receipt = asyncio.run(service.handle_plan(_close()))

    assert receipt.accepted is False
    assert any("wiring failure" in r for r in receipt.reasons)

    service.attach_agent(FakeAgent())
    assert asyncio.run(service.handle_plan(_close())).outcome == "closed"


def test_a_close_with_no_quantity_refuses_rather_than_guessing():
    agent = FakeAgent()
    receipt = _run(_close(size=None), agent=agent)
    assert receipt.accepted is False
    assert agent.closes == []
    assert any("guess" in r for r in receipt.reasons)


# ===========================================================================
# 3. ROUNDING IS ALWAYS DOWN
# ===========================================================================

def test_round_down_never_rounds_up_even_when_up_is_nearer():
    """Rounding up means the exchange fills a larger position than the risk checks
    approved — the per-trade limit was computed against one number and filled at
    another."""
    assert round_down_to_step(0.0009999, 0.001) == pytest.approx(0.0)
    assert round_down_to_step(1.9999, 1.0) == pytest.approx(1.0)
    assert round_down_to_step(367.41575011279235, 0.001) == pytest.approx(367.415)


def test_rounding_avoids_binary_float_noise():
    """`floor(x/step)*step` reintroduces noise — 3 * 0.1 is 0.30000000000000004,
    and an exchange comparing against its own decimal step rejects that."""
    assert round_down_to_step(0.35, 0.1) == 0.3
    assert repr(round_down_to_step(0.35, 0.1)) == "0.3"
    assert round_down_to_step(0.7, 0.1) == 0.7


def test_the_phase_28_size_becomes_submittable():
    """The concrete gap Phase 28's live run exposed: `buy 367.41575011279235`."""
    rules = InstrumentRules(symbol="BTC/USDT", step_size=0.001, min_qty=0.001,
                            tick_size=0.01, min_notional=5.0)
    size, note = quantise_quantity(367.41575011279235, rules, price=137.0)

    assert size == pytest.approx(367.415)
    assert "rounded DOWN" in note
    assert "never up" in note


def test_a_quantity_that_rounds_to_zero_is_refused_not_bumped_up():
    rules = InstrumentRules(symbol="X/USDT", step_size=1.0, min_qty=1.0)
    size, note = quantise_quantity(0.4, rules)
    assert size is None
    assert "rounds DOWN to 0" in note
    assert "would exceed the approved size" in note


def test_a_quantity_below_the_venue_minimum_is_refused_not_sized_up():
    """Sizing up to reach a minimum lets the exchange dictate risk instead of the
    risk checks."""
    rules = InstrumentRules(symbol="X/USDT", step_size=0.001, min_qty=0.01)
    size, note = quantise_quantity(0.005, rules)
    assert size is None
    assert "below the venue minimum" in note
    assert "dictate risk" in note


def test_a_notional_below_the_venue_minimum_is_refused():
    rules = InstrumentRules(symbol="X/USDT", step_size=0.001, min_qty=0.001,
                            min_notional=100.0)
    size, note = quantise_quantity(0.5, rules, price=10.0)
    assert size is None
    assert "below the venue minimum" in note


def test_an_already_aligned_quantity_is_reported_as_unchanged():
    rules = InstrumentRules(symbol="X/USDT", step_size=0.001, min_qty=0.001)
    size, note = quantise_quantity(0.5, rules)
    assert size == pytest.approx(0.5)
    assert "already matches step" in note


def test_unknown_rules_pass_the_quantity_through_and_say_so():
    rules = InstrumentRules(symbol="X/USDT", unavailable="venue unreachable")
    size, note = quantise_quantity(0.123456789, rules)
    assert size == pytest.approx(0.123456789)
    assert "NOT quantised" in note
    assert "must block real money" in note


def test_unknown_rules_block_real_money_but_not_paper(monkeypatch, enabled):
    """The paper book has no lot size, so an unknown step harms nothing there. For
    real money, not knowing the step means not knowing the order will be accepted
    at the size that was approved."""
    async def unknown(symbol):
        return InstrumentRules(symbol=symbol, unavailable="venue unreachable")

    monkeypatch.setattr(svc, "get_rules", unknown)

    published = []

    class Bus:
        async def publish(self, topic, payload):
            # (topic, payload) — matching the real MessageBus. The first version of
            # these doubles took a single argument, so they accepted a call the real
            # bus would have rejected with a TypeError.
            published.append(payload)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        paper = _run(_plan(tab="paper"))
        svc.reset_for_tests()
        real = _run(_plan(tab="real", idempotency_basis="basis-real"))
    finally:
        mb.get_message_bus = original

    assert paper.outcome == "submitted", "paper has no lot size to violate"
    assert real.accepted is False
    assert any("real-money order refused" in r for r in real.reasons)
    assert any("silently truncate" in r for r in real.reasons)


def test_a_decimal_places_precision_is_read_as_a_step():
    """ccxt normalises `precision.amount` to a step OR a decimal count depending on
    the venue. Guessing wrong either way produces a rejected quantity."""
    from backend.services.instrument_rules import _from_ccxt_market

    as_step = _from_ccxt_market("A/B", {"precision": {"amount": 0.001},
                                        "limits": {"amount": {"min": 0.001}}})
    as_decimals = _from_ccxt_market("A/B", {"precision": {"amount": 3},
                                            "limits": {"amount": {"min": 0.001}}})
    assert as_step.step_size == pytest.approx(0.001)
    assert as_decimals.step_size == pytest.approx(0.001)


def test_a_market_with_no_precision_at_all_is_unavailable_not_guessed():
    from backend.services.instrument_rules import _from_ccxt_market

    rules = _from_ccxt_market("A/B", {"precision": {}, "limits": {}})
    assert rules.known is False
    assert rules.unavailable


# ===========================================================================
# 4. DUPLICATES ARE REFUSED BEFORE VALIDATION
# ===========================================================================

def test_the_same_basis_is_refused_the_second_time(enabled):
    published = []

    class Bus:
        async def publish(self, topic, payload):
            # (topic, payload) — matching the real MessageBus. The first version of
            # these doubles took a single argument, so they accepted a call the real
            # bus would have rejected with a TypeError.
            published.append(payload)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        service = svc.ExecutionService()
        first = asyncio.run(service.handle_plan(_plan()))
        second = asyncio.run(service.handle_plan(_plan()))
    finally:
        mb.get_message_bus = original

    assert first.outcome == "submitted"
    assert second.outcome == "duplicate"
    assert second.accepted is False
    assert len(published) == 1, "one decision must produce at most one TAR"
    assert "opening the position twice" in second.reasons[0]


def test_the_duplicate_check_runs_before_validation():
    """Checking it last would mean a valid plan delivered twice was submitted twice.

    Asserted structurally: a duplicate of a plan that would ALSO fail validation
    must report 'duplicate', proving the order of the two checks.
    """
    service = svc.ExecutionService()
    first = asyncio.run(service.handle_plan(_plan(stop_loss=None)))
    assert first.outcome == "refused", "no stop-loss must be refused"

    second = asyncio.run(service.handle_plan(_plan(stop_loss=None)))
    assert second.outcome == "duplicate", (
        "the duplicate check must run before validation, or a redelivered plan "
        "would be revalidated and could be submitted twice"
    )


def test_different_bases_are_both_handled(enabled):
    published = []

    class Bus:
        async def publish(self, topic, payload):
            # (topic, payload) — matching the real MessageBus. The first version of
            # these doubles took a single argument, so they accepted a call the real
            # bus would have rejected with a TypeError.
            published.append(payload)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        service = svc.ExecutionService()
        asyncio.run(service.handle_plan(_plan(idempotency_basis="a")))
        asyncio.run(service.handle_plan(_plan(idempotency_basis="b")))
    finally:
        mb.get_message_bus = original

    assert len(published) == 2


# ===========================================================================
# Boundary re-validation
# ===========================================================================

def test_an_open_without_a_stop_loss_is_refused_at_the_boundary():
    """Invariant 3, re-checked here. The gateway already checks it; a boundary that
    trusts its input is not a boundary."""
    receipt = _run(_plan(stop_loss=None))
    assert receipt.accepted is False
    assert any("Every position requires a computed stop" in r for r in receipt.reasons)


def test_a_stop_on_the_wrong_side_of_entry_is_refused():
    """Worse than no stop: it would trigger immediately, or never. The gateway
    derives both from ATR so this should be impossible — which is why it is worth
    asserting at the boundary rather than assuming."""
    long_bad = _run(_plan(side="buy", stop_loss=101.0, entry_price=100.0))
    assert long_bad.accepted is False
    assert any("trigger immediately" in r for r in long_bad.reasons)

    svc.reset_for_tests()
    short_bad = _run(_plan(side="sell", stop_loss=99.0, entry_price=100.0,
                           idempotency_basis="basis-s"))
    assert short_bad.accepted is False


def test_leverage_over_the_ceiling_is_refused_at_the_boundary():
    """Invariant 2, re-checked so the ceiling holds even for a plan built by
    something that skipped the gateway entirely."""
    from backend.core.risk_manager import ABSOLUTE_MAX_LEVERAGE

    receipt = _run(_plan(tab="real", leverage=ABSOLUTE_MAX_LEVERAGE + 1))
    assert receipt.accepted is False
    assert any("hard" in r and "ceiling" in r for r in receipt.reasons)


def test_a_kill_switch_engaged_after_approval_still_blocks_the_open():
    """The last moment a pause can take effect. The gateway checked it when the
    decision was made; an operator may have hit stop in between."""
    system_state.pause("operator hit pause after the gateway approved")
    receipt = _run(_plan())

    assert receipt.accepted is False
    assert any("execution boundary" in r for r in receipt.reasons)


def test_an_open_with_no_size_is_refused():
    receipt = _run(_plan(size=None))
    assert receipt.accepted is False
    assert any("no size" in r for r in receipt.reasons)


def test_boundary_revalidation_is_not_a_rerun_of_all_nine_gateway_checks():
    """It deliberately re-checks only invariants that hold regardless of market
    state. Re-running the portfolio checks could DISAGREE with the gateway on a
    moving market, and it is not obvious which answer should win."""
    import inspect

    src = inspect.getsource(svc._revalidate_open)
    for portfolio_check in ("check_daily_loss", "check_portfolio_exposure",
                            "check_correlation", "check_margin"):
        assert portfolio_check not in src


# ===========================================================================
# The dry-run gate
# ===========================================================================

def test_the_submission_flag_defaults_to_off():
    assert svc.execution_enabled() is False


def test_the_flag_is_read_at_call_time_not_import_time(monkeypatch):
    """A module-level constant would freeze the value at first import, so an
    operator flipping it would see no effect until a restart."""
    assert svc.execution_enabled() is False
    monkeypatch.setenv(svc.ENV_ENABLE, "true")
    assert svc.execution_enabled() is True
    monkeypatch.setenv(svc.ENV_ENABLE, "false")
    assert svc.execution_enabled() is False


def test_a_dry_run_validates_and_quantises_but_publishes_nothing():
    """Off, the whole chain is observable without a graph run being able to submit."""
    published = []

    class Bus:
        async def publish(self, topic, payload):
            # (topic, payload) — matching the real MessageBus. The first version of
            # these doubles took a single argument, so they accepted a call the real
            # bus would have rejected with a TypeError.
            published.append(payload)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        receipt = _run(_plan(size=0.5004))
    finally:
        mb.get_message_bus = original

    assert receipt.outcome == "dry-run"
    assert receipt.accepted is False
    assert published == []
    assert receipt.submitted_size == pytest.approx(0.5), "it still quantised"
    assert any(svc.ENV_ENABLE in n for n in receipt.notes)


def test_a_dry_run_still_refuses_an_invalid_plan():
    """The flag controls submission, not validation. A plan that would be refused
    must be refused in dry-run too, or the dry run reports a false positive."""
    receipt = _run(_plan(stop_loss=None))
    assert receipt.outcome == "refused"


# ===========================================================================
# Robustness
# ===========================================================================

def test_the_service_never_raises_into_the_bus_subscriber():
    """This runs from a subscriber; an exception here would propagate into the
    publisher's task and could take down the loop delivering every other event."""
    class Broken:
        symbol = "BTC/USDT"
        intent = "open"
        idempotency_basis = "b"
        # Missing every other attribute.

    receipt = _run(Broken())
    assert receipt.accepted is False
    assert receipt.outcome == "refused"
    assert any("execution service error" in r for r in receipt.reasons)


def test_a_receipt_is_always_produced_even_on_refusal():
    """A refusal with no record is indistinguishable from a plan that never
    arrived, and "why didn't that trade happen?" is what this object answers."""
    receipt = _run(_plan(stop_loss=None))
    assert receipt.as_dict()["outcome"] == "refused"
    assert receipt.as_dict()["reasons"]
    assert receipt.as_dict()["idempotencyBasis"]


def test_the_event_requires_an_intent_with_no_default():
    """An open and a close take completely different paths downstream, so a
    defaulted intent would decide the most safety-critical routing question in
    this system by omission."""
    import pydantic

    with pytest.raises(pydantic.ValidationError):
        ExecutionPlanReadyEvent(
            symbol="BTC/USDT", side="buy", tab="paper",
            idempotency_basis="x",
        )


# ===========================================================================
# The graph side
# ===========================================================================

def test_the_graph_publishes_no_plan_without_an_approval():
    """Guarded on BOTH the plan existing and the assessment approving, so a future
    change that starts producing rejected plans cannot turn this into a submission
    path by accident."""
    from backend.graphs.analysis import _publish_plan
    from backend.graphs.state import (
        ExecutionPlan,
        RiskAssessment,
        TriggerReason,
        new_state,
    )

    published = []

    class Bus:
        async def publish(self, topic, payload):
            # (topic, payload) — matching the real MessageBus. The first version of
            # these doubles took a single argument, so they accepted a call the real
            # bus would have rejected with a TypeError.
            published.append(payload)

    st = new_state("r", "BTC/USDT",
                   TriggerReason(kind="manual", symbol="BTC/USDT", detail="d"), 0.0)
    st["execution_plan"] = ExecutionPlan(symbol="BTC/USDT", side="buy", size=0.5,
                                         leverage=1, stop_loss=98.0, tab="paper",
                                         idempotency_basis="x")
    st["risk_assessment"] = RiskAssessment(approved=False)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        asyncio.run(_publish_plan(st))
        assert published == [], "a plan without an approval must not reach the boundary"

        st["risk_assessment"] = RiskAssessment(approved=True)
        asyncio.run(_publish_plan(st))
        assert len(published) == 1
        assert published[0].event_type == "EXECUTION_PLAN_READY"
        assert published[0].intent == "open"
    finally:
        mb.get_message_bus = original


def test_the_graph_marks_an_exit_decision_as_a_close():
    from backend.graphs.analysis import _publish_plan
    from backend.graphs.state import (
        ExecutionPlan,
        RiskAssessment,
        TradeDecision,
        TriggerReason,
        new_state,
    )

    published = []

    class Bus:
        async def publish(self, topic, payload):
            # (topic, payload) — matching the real MessageBus. The first version of
            # these doubles took a single argument, so they accepted a call the real
            # bus would have rejected with a TypeError.
            published.append(payload)

    st = new_state("r", "BTC/USDT",
                   TriggerReason(kind="manual", symbol="BTC/USDT", detail="d"), 0.0)
    st["decision"] = TradeDecision(action="EXIT", direction="LONG")
    st["execution_plan"] = ExecutionPlan(symbol="BTC/USDT", side="sell", size=0.5,
                                         leverage=1, tab="paper",
                                         idempotency_basis="x")
    st["risk_assessment"] = RiskAssessment(approved=True)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        asyncio.run(_publish_plan(st))
    finally:
        mb.get_message_bus = original

    assert published[0].intent == "close"


def test_a_bus_failure_does_not_fail_the_analysis_run():
    """The plan is already in the final state and the trace; a failed publish loses
    the execution attempt, not the reasoning."""
    from backend.graphs.analysis import _publish_plan
    from backend.graphs.state import (
        ExecutionPlan,
        RiskAssessment,
        TriggerReason,
        new_state,
    )

    class Bus:
        async def publish(self, topic, payload):
            raise RuntimeError("bus down")

    st = new_state("r", "BTC/USDT",
                   TriggerReason(kind="manual", symbol="BTC/USDT", detail="d"), 0.0)
    st["execution_plan"] = ExecutionPlan(symbol="BTC/USDT", side="buy", size=0.5,
                                         leverage=1, stop_loss=98.0, tab="paper",
                                         idempotency_basis="x")
    st["risk_assessment"] = RiskAssessment(approved=True)

    import backend.core.message_bus as mb
    original = mb.get_message_bus
    mb.get_message_bus = lambda: Bus()
    try:
        asyncio.run(_publish_plan(st))  # must not raise
    finally:
        mb.get_message_bus = original


def test_the_plan_is_published_from_the_runner_not_from_a_node():
    """A node that published would make emitting an execution request part of
    reasoning, and a future node could emit one mid-graph before the gateway ran."""
    import inspect
    import pathlib

    from backend.graphs import analysis

    assert "_publish_plan" in inspect.getsource(analysis.run_analysis_graph)

    nodes_dir = pathlib.Path("backend/graphs/nodes")
    for path in nodes_dir.glob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "ExecutionPlanReadyEvent" not in text, (
            f"{path.name} references the execution event — publishing belongs to the "
            f"graph runner, after the gateway has run"
        )
