import asyncio
import logging
from typing import Callable, Dict, List, Any
from pydantic import BaseModel, ValidationError

# Import the new strongly-typed events
from backend.models.events import (
    BaseEvent,
    EventType
)

logger = logging.getLogger(__name__)

# Subscribing to this topic receives EVERY published event. Spec Section 20
# requires that "everything must be observable", and the alternative — making
# each observer enumerate all 18 EventType values — silently misses any event
# type added later, which is exactly when an observability gap matters most.
WILDCARD_TOPIC = "*"


class MessageBus:
    """
    Level 20: Event-Driven Architecture (Section 6 implementation)
    A centralized pub/sub system enabling microservice decoupling.
    Agents can broadcast strongly-typed events and other agents can listen.
    """
    def __init__(self):
        # We route by EventType string, e.g. 'TICK_RECEIVED'
        self._subscribers: Dict[str, List[Callable]] = {}

    def subscribe(self, topic: str, callback: Callable) -> None:
        """Subscribe to a specific EventType string, or WILDCARD_TOPIC for all.

        IDEMPOTENT. Subscribing the same callable to the same topic twice is a no-op.

        WHY, RATHER THAN APPENDING BLINDLY
        ----------------------------------
        Handling one event twice with the same handler is never what anyone wants, and
        the consequences here are not cosmetic: the supervisor would evaluate every
        signal twice and could submit two trade requests for one decision.

        This codebase already treats double-subscription as dangerous and guards
        against it by hand in several places — `analysis._subscribed`,
        `execution_service._subscribed`, and `trigger_worker.subscribe`, whose
        docstring spells out that "subscribing twice would evaluate every tick twice,
        and the second evaluation would see the baseline the first one just reset — so
        half the triggers would silently vanish rather than duplicate, which is the
        harder bug to notice".

        Those guards are per-caller, so each new subscriber has to remember. The
        hazard belongs here instead.

        Found via `BaseAgent.rebind_bus`: restoring a simulation-rebound agent
        re-subscribed it on the global bus, taking `DEBATE_CONCLUDED` from one handler
        to two. Nothing raised.
        """
        if topic not in self._subscribers:
            self._subscribers[topic] = []
        if callback in self._subscribers[topic]:
            # Debug, not warning: an idempotent re-subscribe is the normal result of a
            # guard doing its job, and warning on it would train people to ignore it.
            logger.debug("Already subscribed to %s; not duplicating.", topic)
            return
        self._subscribers[topic].append(callback)
        logger.debug(f"Subscribed to topic: {topic}")

    def unsubscribe(self, topic: str, callback: Callable) -> bool:
        """Remove one subscription. Returns True if it was there.

        Added for `BaseAgent.rebind_bus`, and it turned out to be the missing half of
        the §6.4 fix rather than a convenience.

        Rebinding an agent to a simulation bus without unsubscribing it from the
        global one left it subscribed to BOTH. So during a backtest a live
        `TICK_RECEIVED` still reached the market-intelligence agent, which then
        published its result to the SIMULATION bus — live analysis silently stopped
        working for the duration and the simulation was polluted with live data. That
        is the same class of cross-contamination §6.4 was about, arriving from the
        other direction.

        Empty topic lists are removed, so `len(_subscribers)` stays an honest count of
        topics that actually have listeners. A monitoring view reading it would
        otherwise report topics served by nobody.
        """
        handlers = self._subscribers.get(topic)
        if not handlers or callback not in handlers:
            return False
        handlers.remove(callback)
        if not handlers:
            del self._subscribers[topic]
        logger.debug("Unsubscribed from topic: %s", topic)
        return True

    async def publish(self, topic: str, payload: Any) -> None:
        """
        Publishes an event. If it's a Pydantic model (BaseEvent),
        it gets passed directly. If it's a dict, we try to parse it.
        """
        if isinstance(payload, dict):
            logger.warning(f"Warning: publishing raw dict on {topic} instead of strong BaseEvent. Make sure you use the models in backend.models.events")

        # Topic subscribers first, then wildcard observers. Ordered this way
        # so a monitoring/WebSocket observer can never delay or fail ahead of
        # the agent that actually has to act on the event.
        callbacks = list(self._subscribers.get(topic, ()))
        if topic != WILDCARD_TOPIC:
            callbacks += list(self._subscribers.get(WILDCARD_TOPIC, ()))

        for callback in callbacks:
            try:
                if asyncio.iscoroutinefunction(callback):
                    await callback(payload)
                else:
                    callback(payload)
            except Exception as e:
                # Swallowed per-callback so one broken subscriber can't stop
                # the others from seeing the event. Logged with the callback
                # name because "Error executing callback" alone gave no way
                # to tell WHICH subscriber failed.
                logger.error(
                    "Error in subscriber %s for topic %s: %s",
                    getattr(callback, "__qualname__", repr(callback)),
                    topic,
                    e,
                )

_bus = MessageBus()

def get_message_bus() -> MessageBus:
    return _bus
