from typing import List, Callable, Any, Dict, Optional
from abc import ABC, abstractmethod
import datetime
import logging

from backend.core.message_bus import get_message_bus
from backend.models.events import EventType, BaseEvent

logger = logging.getLogger(__name__)


class BaseAgent(ABC):
    """
    Implementation of the Agent Contract Template (Section 5).
    Every agent must inherit from this and define its strict boundaries.

    WHAT CHANGED AND WHY
    --------------------
    Spec Section 5 lists sixteen fields and says *"Every single agent in the
    system — no exceptions — must be specified with all of these fields before
    it's built."* Three requirements from that list had no representation here:

      * `inputs`  — "what data/events it consumes"
      * `outputs` — "what data/events/decisions it produces"
      * the closing rule: *"Every agent must be able to explain every decision
        it makes — this is non-negotiable and applies even to agents that seem
        purely mechanical."*

    `inputs`/`outputs` are deliberately NOT the same as
    `events_consumed`/`events_published`. An agent reads klines from an HTTP
    API and writes rows to Postgres; neither is an event. Deriving one from
    the other would have made the contract look complete while omitting every
    non-event dependency — which is exactly the information you need when a
    data feed goes stale.

    They are abstract, like the other fields, rather than given defaults.
    A default would let a new agent inherit a blank contract silently; an
    abstract property means Python refuses to instantiate an agent that
    hasn't stated them.

    `category` is abstract too. It isn't in the spec's list, but
    `AgentDescriptor` requires it and the dashboard groups by it, so a default
    would file every agent under one heading.
    """

    # ---------------- Section 5 contract fields ----------------

    @property
    @abstractmethod
    def name(self) -> str:
        """The agent's name."""
        pass

    @property
    @abstractmethod
    def purpose(self) -> str:
        """One sentence — what this agent exists to do."""
        pass

    @property
    @abstractmethod
    def permissions(self) -> List[str]:
        """Exactly what it is and isn't allowed to do."""
        pass

    @property
    @abstractmethod
    def inputs(self) -> List[str]:
        """What data/events it consumes — including non-event sources.

        Name concrete sources (an API, a table, a store), not categories.
        "Market data" is not an input; "Binance 15m klines via
        services/market_data.fetch_klines" is.
        """
        pass

    @property
    @abstractmethod
    def outputs(self) -> List[str]:
        """What data/events/decisions it produces, including side effects.

        A database write is an output. So is a refusal to act — if the agent
        can decline, say so here, because "produced nothing" and "decided not
        to" are different results.
        """
        pass

    @property
    @abstractmethod
    def category(self) -> str:
        """One of: market-intelligence, strategy, risk, execution, learning, orchestration."""
        pass

    @property
    @abstractmethod
    def events_consumed(self) -> List[EventType]:
        """Which events this agent listens to."""
        pass

    @property
    @abstractmethod
    def events_published(self) -> List[EventType]:
        """Which events this agent is allowed to publish."""
        pass

    @property
    @abstractmethod
    def responsibilities(self) -> List[str]:
        """Bullet list of what it owns."""
        pass

    @property
    @abstractmethod
    def dependencies(self) -> List[str]:
        """Which other agents/services it relies on."""
        pass

    @property
    @abstractmethod
    def memory_ttl(self) -> str:
        """What it remembers and for how long."""
        pass

    @property
    @abstractmethod
    def knowledge_sources(self) -> List[str]:
        """What parts of the Knowledge Graph / DB it reads."""
        pass

    @property
    @abstractmethod
    def prompt_reference(self) -> str:
        """Link to its prompt file in 15_PROMPT_LIBRARY.md."""
        pass

    @property
    @abstractmethod
    def apis_used(self) -> List[str]:
        """Which internal/external APIs it calls."""
        pass

    @property
    @abstractmethod
    def database_tables(self) -> List[str]:
        """Which tables/collections it reads and writes."""
        pass

    @property
    @abstractmethod
    def metrics_reported(self) -> List[str]:
        """What it reports for evaluation."""
        pass

    @property
    @abstractmethod
    def failure_recovery_strategy(self) -> str:
        """What happens if it crashes, times out, or returns garbage —
        must degrade safely, never fail silently."""
        pass

    @property
    @abstractmethod
    def health_status(self) -> str:
        """How the system checks if this agent is alive and sane."""
        pass

    # ---------------- lifecycle ----------------

    def __init__(self):
        self.bus = get_message_bus()
        # Bounded decision log backing explain_decision(). Kept small
        # deliberately: this is an explainability buffer for "what did you
        # just do and why", not an audit trail. Durable history belongs in
        # the `decisions` table and core/audit.py, which survive a restart.
        self._decisions: List[Dict[str, Any]] = []
        self._max_decisions = 50
        self._setup_subscriptions()

    def _setup_subscriptions(self) -> None:
        """Automatically subscribes the agent to its consumed events."""
        for event_type in self.events_consumed:
            # We route the event to the handle_event method
            self.bus.subscribe(event_type, self.handle_event)
            logger.info(f"{self.name} subscribed to {event_type}")

    async def publish(self, event: BaseEvent) -> None:
        """Safely publishes an event, ensuring the agent has permission."""
        if event.event_type not in self.events_published:
            raise PermissionError(
                f"Agent {self.name} is not permitted to publish {event.event_type}. "
                f"Allowed: {self.events_published}"
            )
        await self.bus.publish(event.event_type, event)

    @abstractmethod
    async def handle_event(self, event: BaseEvent) -> None:
        """The main entry point for processing incoming events."""
        pass

    # ---------------- explainability (Section 5, non-negotiable) ----------------

    def record_decision(
        self,
        decision: str,
        rationale: str,
        evidence: Optional[Dict[str, Any]] = None,
        acted: bool = True,
    ) -> None:
        """Record a decision so `explain_decision()` can account for it.

        `acted=False` is for refusals, and recording them is the point. A log
        containing only the actions taken cannot answer "why didn't it trade
        that setup?", which is the question an operator asks most often — and
        a silent refusal is indistinguishable from a crash.
        """
        self._decisions.append(
            {
                "ts": datetime.datetime.utcnow().isoformat(),
                "agent": self.name,
                "decision": decision,
                "rationale": rationale,
                "evidence": evidence or {},
                "acted": acted,
            }
        )
        # Trim from the front so the newest are always retained.
        if len(self._decisions) > self._max_decisions:
            del self._decisions[: len(self._decisions) - self._max_decisions]

    def explain_decision(self, index: int = -1) -> Dict[str, Any]:
        """Explain a recorded decision — most recent by default.

        Returns an explicit "nothing recorded" result rather than an empty
        dict or None, so a caller cannot mistake "this agent has not decided
        anything yet" for "this agent has no explanation for what it did".
        """
        if not self._decisions:
            return {
                "agent": self.name,
                "explained": False,
                "reason": (
                    "No decision has been recorded by this agent yet. This is not a "
                    "missing explanation — the agent has not made a decision."
                ),
            }
        try:
            record = self._decisions[index]
        except IndexError:
            return {
                "agent": self.name,
                "explained": False,
                "reason": f"No decision at index {index}; {len(self._decisions)} recorded.",
            }
        return {"explained": True, **record}

    def decision_history(self) -> List[Dict[str, Any]]:
        """Every retained decision, oldest first."""
        return list(self._decisions)

    # ---------------- kernel registration ----------------

    def as_descriptor(self):
        """This agent's contract as an `AgentDescriptor` for the AgentOS kernel.

        Imported lazily to avoid a circular import: `core/agent_os` does not
        depend on this module today and shouldn't have to.
        """
        from backend.core.agent_os import AgentDescriptor

        return AgentDescriptor(
            id=self.agent_id,
            name=self.name,
            version=getattr(self, "version", "1.0.0"),
            description=self.purpose,
            capabilities=list(self.permissions),
            dependencies=[],
            category=self.category,
            priority=getattr(self, "priority", 50),
            # 0 = never scheduled by the tick loop. These agents are
            # event-driven; the kernel registration exists so they are
            # visible to health monitoring and the dashboard, not so they get
            # ticked. Registering them with a non-zero interval would have
            # the scheduler call a tick function they don't have.
            tickIntervalMs=0,
        )

    @property
    def agent_id(self) -> str:
        """Stable id derived from the class name, e.g. CROAgent -> cro_agent."""
        cls = type(self).__name__
        out = []
        for i, ch in enumerate(cls):
            if ch.isupper() and i > 0:
                out.append("_")
            out.append(ch.lower())
        return "".join(out)

    def register_with_kernel(self) -> None:
        """Register this agent with the AgentOS kernel.

        WHY THIS EXISTS: there were two disjoint registries. The nine
        BaseAgent subclasses were instantiated in `main.py` and held in a
        plain dict (`_active_base_agents`), while only the three tick-based
        agents called `get_agent_os().register(...)`. Everything that reads
        the kernel — `/api/monitoring`, `/api/ai/agents`, the frontend's
        AgentOSPanel, dependency-health gating — therefore saw 3 agents out
        of 12. Nine agents, including the CRO and the Supervisor, were
        completely invisible to health monitoring: if one of them died, no
        dashboard would show it.
        """
        from backend.core.agent_os import get_agent_os

        kernel = get_agent_os()
        kernel.register(self.as_descriptor(), tick_fn=None)
        # Event-driven agents are live as soon as they are subscribed; there
        # is no tick to wait for. Without this they'd sit at 'ready' forever
        # and read as not-running on every dashboard.
        agent = kernel.agents.get(self.agent_id)
        if agent is not None:
            agent.health.status = "running"
