"""Dashboard API (`/api/dashboard`) — spec Section 8, feeds the Executive
Operations Dashboard, plus a WebSocket that streams every bus event.

WHAT WAS BROKEN HERE
--------------------
1. `logging` was used at module level (twice) but never imported, so
   importing this module raised `NameError` — and `main.py` imports it, so
   the whole backend failed to start.
2. `get_message_bus` and `get_portfolio` were used but never imported.
3. The WebSocket bridge was written against a *different* MessageBus than
   the one in `core/message_bus.py`: it called
   `await bus.subscribe("*", "websocket_bridge")` and awaited a queue, but
   the real `subscribe(topic, callback)` is synchronous, takes a callback,
   returns None, and has no wildcard. The bridge could never have delivered
   an event. It is now a callback subscription against the real API, using
   the wildcard support added to MessageBus for this purpose.
4. `@router.on_event("startup")` does not work on an `APIRouter` — those
   handlers are only honoured on the `FastAPI` app, and `on_event` itself is
   deprecated in favour of lifespan. The bridge is now started from
   `main.py`'s lifespan via `start_event_bridge()`.
5. It held its own `_SYSTEM_STATE` dict with `/pause`, `/resume` and
   `/emergency-stop` routes, duplicating what `api/admin.py` owns. Two
   copies of a kill switch means pausing through one endpoint leaves readers
   of the other still trading. Those routes now live only in `api/admin.py`,
   over the single source of truth in `core/system_state.py`.
"""

import asyncio
import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.core.message_bus import WILDCARD_TOPIC, get_message_bus
from backend.core.system_state import snapshot as system_state_snapshot
from backend.services.portfolio_store import get_portfolio

logger = logging.getLogger(__name__)

router = APIRouter()


class ConnectionManager:
    def __init__(self) -> None:
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info("WebSocket client connected. Total: %d", len(self.active_connections))

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
            logger.info("WebSocket client disconnected. Total: %d", len(self.active_connections))

    async def broadcast(self, message: Dict[str, Any]) -> None:
        # Iterate over a copy: `disconnect` mutates the list, and a send
        # failure mid-loop would otherwise skip the following connection.
        disconnected = []
        for connection in list(self.active_connections):
            try:
                await connection.send_json(message)
            except Exception as e:
                logger.debug("Dropping WebSocket client after send error: %s", e)
                disconnected.append(connection)
        for conn in disconnected:
            self.disconnect(conn)


manager = ConnectionManager()

_bridge_subscribed = False


def _event_to_dict(payload: Any) -> Dict[str, Any]:
    """Best-effort JSON-safe dict for a bus payload.

    Handles both Pydantic `BaseEvent`s (the intended shape) and raw dicts
    (which `MessageBus.publish` still permits, warning when it happens).
    """
    if hasattr(payload, "model_dump"):
        # mode="json" so UUID and datetime fields become strings rather than
        # objects that send_json would choke on.
        try:
            return payload.model_dump(mode="json")
        except Exception:
            return {"raw": str(payload)}
    if isinstance(payload, dict):
        return payload
    return {"raw": str(payload)}


async def _on_any_event(payload: Any) -> None:
    """Wildcard subscriber: forward every bus event to all WebSocket clients."""
    if not manager.active_connections:
        return  # nothing to serialize for
    await manager.broadcast(_event_to_dict(payload))


def start_event_bridge() -> None:
    """Subscribe the WebSocket bridge to the bus. Idempotent.

    Called from `main.py`'s lifespan. Guarded because subscribing twice
    would deliver every event to every client twice — and in a reload-driven
    dev loop that is easy to do by accident.
    """
    global _bridge_subscribed
    if _bridge_subscribed:
        return
    get_message_bus().subscribe(WILDCARD_TOPIC, _on_any_event)
    _bridge_subscribed = True
    logger.info("WebSocket bridge subscribed to all MessageBus events")


@router.websocket("/agent-events")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            # The client isn't expected to send anything; awaiting a receive
            # is how we detect disconnection.
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)
    except Exception as e:
        logger.debug("WebSocket closed with error: %s", e)
        manager.disconnect(websocket)


@router.get("")
async def get_dashboard() -> Dict[str, Any]:
    """Portfolio plus kill-switch state, for the operations dashboard."""
    portfolio = await get_portfolio()
    state = system_state_snapshot()
    return {
        "status": "success",
        "portfolio": portfolio,
        "system": {
            "isPaused": state["is_paused"],
            "emergencyStop": state["emergency_stop"],
            # Exits are never gated — see core/system_state.py.
            "exitsAllowed": True,
        },
        "wsClients": len(manager.active_connections),
    }


@router.get("/portfolio")
async def get_current_portfolio() -> Dict[str, Any]:
    """Current portfolio. Kept as a distinct route from `GET ""` because the
    previous version exposed the portfolio at the router root and callers may
    already depend on the bare path."""
    return await get_portfolio()
