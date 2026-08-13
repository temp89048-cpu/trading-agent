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
        """Subscribe to a specific EventType string, or WILDCARD_TOPIC for all."""
        if topic not in self._subscribers:
            self._subscribers[topic] = []
        self._subscribers[topic].append(callback)
        logger.debug(f"Subscribed to topic: {topic}")

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
