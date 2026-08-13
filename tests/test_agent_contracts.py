"""Spec Section 5 — the agent contract, made checkable.

*"Every single agent in the system — no exceptions — must be specified with
all of these fields before it's built."*

A rule nobody can check is a rule nobody keeps, so these tests enforce it.
Two things they deliberately distinguish:

  * a field that was never stated  -> a contract violation
  * a field stated as empty        -> a valid answer

`database_tables == []` is the CORRECT contract for an agent that touches no
tables. Treating a falsy value as "missing" would push authors toward writing
something untrue to satisfy the check.
"""

import inspect
from typing import List

import pytest

from backend.core.agent_base import BaseAgent
from backend.core.agent_os import VALID_CATEGORIES, AgentDescriptor

# Section 5's field list, plus `name` and `category` which the runtime needs.
CONTRACT_FIELDS = [
    "name",
    "purpose",
    "permissions",
    "inputs",
    "outputs",
    "category",
    "events_consumed",
    "events_published",
    "responsibilities",
    "dependencies",
    "memory_ttl",
    "knowledge_sources",
    "prompt_reference",
    "apis_used",
    "database_tables",
    "metrics_reported",
    "failure_recovery_strategy",
    "health_status",
]

# Fields where an empty collection is a legitimate answer. `database_tables ==
# []` is the CORRECT contract for an agent that touches no tables; forcing a
# value would push authors toward writing something untrue.
#
# events_consumed / events_published are here because two agents legitimately
# have one of them empty, and both cases are deliberate:
#   * CEO AI publishes nothing — Observation Mode is enforced through
#     `may_open_new_position()`, which every gate already calls. An event would
#     only be honoured by agents that happened to subscribe.
#   * CIO AI consumes nothing — the Supervisor queries it directly before
#     sizing. An event-driven check would arrive after the TAR was built, which
#     is too late to size down.
# `test_agent_participates_in_the_system` below still requires each agent to be
# reachable one way or another, so this doesn't permit a fully inert agent.
MAY_BE_EMPTY = {
    "apis_used",
    "database_tables",
    "knowledge_sources",
    "permissions",
    "metrics_reported",
    "events_consumed",
    "events_published",
}


def _all_agents() -> List[BaseAgent]:
    """Instantiate every BaseAgent subclass.

    Instantiation is itself the strongest part of the test: `inputs`,
    `outputs` and `category` are abstract, so a subclass that hasn't declared
    them raises TypeError here rather than shipping a blank contract.
    """
    from backend.agents.ceo_agent import CEOAgent
    from backend.agents.cio_agent import CIOAgent
    from backend.agents.confidence_agent import ConfidenceAgent
    from backend.agents.cro_agent import CROAgent
    from backend.agents.debate_agent import DebateAgent
    from backend.agents.execution_agent import ExecutionAgent
    from backend.agents.hypothesis_agent import HypothesisAgent
    from backend.agents.market_intelligence import MarketIntelligenceAgent
    from backend.agents.portfolio_agent import PortfolioAgent
    from backend.agents.position_monitor import PositionMonitorAgent
    from backend.agents.reflection_agent import ReflectionAgent
    from backend.agents.simulation_agent import SimulationAgent
    from backend.agents.supervisor_agent import SupervisorAgent

    return [
        CEOAgent(),
        CIOAgent(),
        MarketIntelligenceAgent(),
        PortfolioAgent(),
        PositionMonitorAgent(),
        ReflectionAgent(),
        ExecutionAgent(simulation_mode=True),
        CROAgent(),
        SupervisorAgent(),
        DebateAgent(),
        ConfidenceAgent(),
        SimulationAgent(),
        HypothesisAgent(),
    ]


def test_section_4_chain_of_command_is_implemented():
    """Spec Section 4: CEO -> CIO -> CRO -> Research -> Supervisor -> Market ->
    Portfolio -> Execution -> Learning -> Memory -> Reflection -> Knowledge
    Graph -> Exchange.

    CEO and CIO were the only two links with no implementation at all.
    """
    names = {a.name for a in _all_agents()}
    for required in ("CEO AI", "CIO AI", "Chief Risk Officer AI", "Supervisor AI"):
        assert required in names, f"Section 4 chain is missing {required}"


def test_only_the_ceo_may_halt_trading():
    """The authority to stop the firm should sit in exactly one place."""
    holders = [a.name for a in _all_agents() if "HALT_TRADING" in a.permissions]
    assert holders == ["CEO AI"], f"HALT_TRADING held by: {holders}"


def test_ceo_cannot_place_or_approve_trades():
    """The ability to stop everything must not come bundled with the ability
    to start it."""
    from backend.agents.ceo_agent import CEOAgent

    ceo = CEOAgent()
    forbidden = {"ROUTE_ORDERS", "APPROVE_TAR", "SUBMIT_TAR", "CANCEL_ORDERS"}
    assert not (set(ceo.permissions) & forbidden)
    assert ceo.events_published == []


def test_cio_is_not_a_second_approval_authority():
    """Two agents that can both approve means neither is accountable."""
    from backend.agents.cio_agent import CIOAgent

    cio = CIOAgent()
    assert "APPROVE_TAR" not in cio.permissions
    assert "TAR_APPROVED" not in cio.events_published


def test_every_contract_field_is_abstract_on_the_base_class():
    """The enforcement mechanism itself. If a field stops being abstract, a
    new agent can inherit a blank contract without anyone noticing."""
    abstract = BaseAgent.__abstractmethods__
    for field in CONTRACT_FIELDS:
        assert field in abstract, (
            f"'{field}' is not abstract on BaseAgent, so a subclass could omit it silently."
        )


@pytest.mark.parametrize("agent", _all_agents(), ids=lambda a: type(a).__name__)
def test_agent_states_every_contract_field(agent):
    missing = []
    for field in CONTRACT_FIELDS:
        value = getattr(agent, field, None)
        if value is None:
            missing.append(f"{field}=None")
        elif isinstance(value, (list, tuple)) and not value and field not in MAY_BE_EMPTY:
            missing.append(f"{field}=[] (empty not allowed for this field)")
        elif isinstance(value, str) and not value.strip():
            missing.append(f"{field}='' (blank)")
    assert not missing, f"{agent.name} has an incomplete Section 5 contract: {missing}"


@pytest.mark.parametrize("agent", _all_agents(), ids=lambda a: type(a).__name__)
def test_agent_participates_in_the_system(agent):
    """Guard on the MAY_BE_EMPTY relaxation for the two event fields.

    An agent with no consumed events, no published events, and no permissions
    would be completely inert — registered, reporting healthy, and doing
    nothing. That is a worse failure than a crash because the dashboard shows
    it green. Each agent must be reachable via events or hold a permission that
    implies it is called directly.
    """
    reachable = bool(agent.events_consumed) or bool(agent.events_published) or bool(agent.permissions)
    assert reachable, (
        f"{agent.name} consumes nothing, publishes nothing, and holds no permissions — "
        f"it would run as an inert agent reporting healthy."
    )


@pytest.mark.parametrize("agent", _all_agents(), ids=lambda a: type(a).__name__)
def test_agent_category_is_valid(agent):
    """An unknown category means the agent runs but never appears on the
    dashboard — event_agent ('security') and research_agent ('research') were
    both invisible this way."""
    assert agent.category in VALID_CATEGORIES, (
        f"{agent.name} has category {agent.category!r}, not in {VALID_CATEGORIES}"
    )


@pytest.mark.parametrize("agent", _all_agents(), ids=lambda a: type(a).__name__)
def test_agent_can_explain_a_decision(agent):
    """Section 5: *"Every agent must be able to explain every decision it
    makes — this is non-negotiable and applies even to agents that seem purely
    mechanical."*"""
    before = agent.explain_decision()
    assert before["explained"] is False
    # "no decision yet" must be distinguishable from "no explanation available".
    assert "has not made a decision" in before["reason"]

    agent.record_decision("test-decision", "because the test said so", {"k": 1}, acted=True)
    after = agent.explain_decision()
    assert after["explained"] is True
    assert after["decision"] == "test-decision"
    assert after["rationale"] == "because the test said so"
    assert after["evidence"] == {"k": 1}
    assert after["agent"] == agent.name


@pytest.mark.parametrize("agent", _all_agents(), ids=lambda a: type(a).__name__)
def test_agent_records_refusals_not_just_actions(agent):
    """A decision log containing only actions cannot answer "why didn't it
    trade?" — and a silent refusal is indistinguishable from a crash."""
    agent.record_decision("declined", "no stop-loss computable", {}, acted=False)
    assert agent.explain_decision()["acted"] is False


def test_decision_log_is_bounded():
    """It's an explainability buffer, not an audit trail — unbounded growth in
    a 24/7 process is a leak."""
    agent = _all_agents()[0]
    for i in range(200):
        agent.record_decision(f"d{i}", "r", {}, acted=True)
    history = agent.decision_history()
    assert len(history) <= agent._max_decisions
    # Newest retained, oldest dropped.
    assert history[-1]["decision"] == "d199"


@pytest.mark.parametrize("agent", _all_agents(), ids=lambda a: type(a).__name__)
def test_agent_produces_a_valid_kernel_descriptor(agent):
    """Every agent must be registrable, or it can't be health-monitored."""
    descriptor = agent.as_descriptor()
    assert isinstance(descriptor, AgentDescriptor)
    assert descriptor.id
    assert descriptor.category in VALID_CATEGORIES
    # Event-driven agents have no tick function, so a non-zero interval would
    # make the scheduler try to call one.
    assert descriptor.tickIntervalMs == 0


def test_descriptor_rejects_an_invalid_category():
    """Guard on the validator itself."""
    with pytest.raises(Exception):
        AgentDescriptor(
            id="x",
            name="x",
            version="1.0.0",
            description="x",
            capabilities=[],
            dependencies=[],
            category="security",  # not a valid category
            priority=1,
            tickIntervalMs=0,
        )


# ---------------------------------------------------------------------------
# Execution authority (Section 8's chokepoint rule)
# ---------------------------------------------------------------------------

def test_only_the_execution_agent_may_route_orders():
    """Spec Section 8: *"the Execution API is a hard chokepoint — no agent
    talks to an exchange directly, ever."* Any other agent holding
    ROUTE_ORDERS would be a path around Risk."""
    holders = [a.name for a in _all_agents() if "ROUTE_ORDERS" in a.permissions]
    assert holders == ["Execution Engine"], (
        f"ROUTE_ORDERS must be held only by the Execution Engine, but is held by: {holders}"
    )


def test_only_the_execution_agent_publishes_order_events():
    """A second publisher of ORDER_FILLED could fake a fill into the learning
    pipeline without any order existing."""
    for agent in _all_agents():
        if agent.name == "Execution Engine":
            continue
        assert "ORDER_FILLED" not in agent.events_published, (
            f"{agent.name} may publish ORDER_FILLED — only Execution should."
        )
        assert "ORDER_ROUTED" not in agent.events_published


def test_only_the_cro_may_approve_a_tar():
    """The CRO's veto is only meaningful if nothing else can grant approval."""
    approvers = [a.name for a in _all_agents() if "TAR_APPROVED" in a.events_published]
    assert approvers == ["Chief Risk Officer AI"], (
        f"TAR_APPROVED must only be published by the CRO, but is published by: {approvers}"
    )


def test_only_the_supervisor_may_submit_a_tar():
    submitters = [a.name for a in _all_agents() if "TAR_SUBMITTED" in a.events_published]
    assert submitters == ["Supervisor AI"]


# Events that are published and intentionally have no agent consumer. These
# are observability records: the dashboard's wildcard WebSocket subscriber
# receives them, and no agent needs to act.
OBSERVABILITY_ONLY = {"ORDER_ROUTED"}

# Events published with no consumer that SHOULD have one. This is a gap list,
# not a design decision — it exists so the gap is visible and cannot silently
# grow. Shrink it; do not add to it without a stated reason.
#
# Both original entries have been removed as their consumers were built:
#   FEATURES_COMPUTED    -> the Debate agent now consumes it, so the Feature
#                           Engine stage is no longer computed and discarded.
#   REFLECTION_COMPLETED -> the Hypothesis agent now consumes it, closing spec
#                           Section 12's pipeline past the reflection.
# The set is empty, which is the goal state. `test_known_dead_ends_are_actually_dead_ends`
# keeps it honest if anything is added back.
KNOWN_DEAD_ENDS: set = set()


def test_no_new_dead_end_events():
    """Every published event should have a consumer, or a pipeline stage is a
    dead end.

    Asserts the dead-end set does not GROW rather than asserting it is empty —
    the two entries in KNOWN_DEAD_ENDS are real, documented gaps, and pretending
    otherwise by adding them to an "intentionally terminal" list would hide
    them. TAR_REJECTED was in this set until the Supervisor was wired to
    consume it: the CRO's veto was being published to nobody.
    """
    agents = _all_agents()
    published = {e for a in agents for e in a.events_published}
    consumed = {e for a in agents for e in a.events_consumed}
    orphans = published - consumed - OBSERVABILITY_ONLY - KNOWN_DEAD_ENDS
    assert not orphans, (
        f"new dead-end event(s) published but consumed by nobody: {sorted(orphans)}. "
        f"Either wire a consumer or add to KNOWN_DEAD_ENDS with a reason."
    )


def test_cro_veto_is_consumed():
    """Regression guard: a vetoed trade must not vanish."""
    agents = _all_agents()
    consumers = [a.name for a in agents if "TAR_REJECTED" in a.events_consumed]
    assert consumers, "TAR_REJECTED has no consumer — a CRO veto would go unrecorded."


def test_known_dead_ends_are_actually_dead_ends():
    """Keeps the gap list honest. Once something in KNOWN_DEAD_ENDS gains a
    consumer it must be removed from the list, or the list stops describing
    reality and starts excusing it."""
    agents = _all_agents()
    consumed = {e for a in agents for e in a.events_consumed}
    stale = KNOWN_DEAD_ENDS & consumed
    assert not stale, (
        f"{sorted(stale)} now has a consumer — remove it from KNOWN_DEAD_ENDS."
    )
