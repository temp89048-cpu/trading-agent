"""AI API (`/api/ai`) — spec Section 8: *"Routes reasoning requests to the
correct model/agent."*

WHAT THIS FILE USED TO BE
------------------------
Three unrelated files concatenated under one name: an agent task store
(duplicating `api/agents.py`), the missions CRUD routes (now
`api/missions.py`), and this header — with `os`, `json`, `uuid`, `Dict`,
`List`, `Any`, `Body`, `Mission` and `mission_store` all used but never
imported. It raised `NameError` on import, which took `backend.main` down
with it. Rewritten to be only the AI API.

WHAT IT DOES AND DOES NOT DO
----------------------------
The "routes to the correct agent" half is implemented: the agent registry
knows every agent's declared capabilities (spec Section 5's contract), so
resolving "who owns this capability" is a real, deterministic lookup.

The "routes to the correct model" half is **not implemented**, and this
module returns HTTP 501 for it rather than a plausible-looking answer. There
is no LLM client in the backend — no model is configured, and no agent
exposes a generic `reason()` entry point (they are event-driven via
`BaseAgent.handle_event`). A `/reason` route that returned invented
reasoning text would be exactly the failure mode CLAUDE.md invariant 6
forbids: a fabricated output that reads as a real one. `docs/README.md`
states the same rule for documentation — mark it not-implemented instead of
describing it as if it exists.
"""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from backend.core.agent_os import get_agent_os

logger = logging.getLogger(__name__)

router = APIRouter()


class ReasoningRequest(BaseModel):
    capability: str
    symbol: Optional[str] = None
    context: Dict[str, Any] = {}


@router.get("/agents", response_model=List[Dict[str, Any]])
async def list_agents() -> List[Dict[str, Any]]:
    """Every registered agent's contract, plus live health.

    This is the explainability surface for spec Section 5 — *"Every agent
    must be able to explain every decision it makes."* An operator can read
    exactly what each agent claims to do, what it depends on, and whether it
    is currently healthy.
    """
    kernel = get_agent_os()
    out = []
    for agent in kernel.agents.values():
        d = agent.descriptor
        out.append(
            {
                "id": d.id,
                "name": d.name,
                "version": d.version,
                "description": d.description,
                "category": d.category,
                "capabilities": d.capabilities,
                "dependencies": d.dependencies,
                "priority": d.priority,
                "tickIntervalMs": d.tickIntervalMs,
                "health": agent.health.model_dump(),
            }
        )
    return out


@router.get("/agents/{agent_id}", response_model=Dict[str, Any])
async def get_agent(agent_id: str) -> Dict[str, Any]:
    """One agent's contract and health."""
    kernel = get_agent_os()
    agent = kernel.agents.get(agent_id)
    if agent is None:
        raise HTTPException(status_code=404, detail=f"no agent registered with id {agent_id}")
    return {
        **agent.descriptor.model_dump(),
        "health": agent.health.model_dump(),
    }


@router.post("/route", response_model=Dict[str, Any])
async def route_reasoning_request(req: ReasoningRequest) -> Dict[str, Any]:
    """Resolve which agent owns a capability. Does NOT invoke it.

    Deterministic registry lookup — no model call, so nothing here can
    hallucinate. Returns every match rather than silently picking one, and
    reports each candidate's health so the caller can see that the owning
    agent is (for example) in an error state instead of getting a confident
    answer from a dead agent.
    """
    kernel = get_agent_os()
    matches = [
        {
            "id": a.descriptor.id,
            "name": a.descriptor.name,
            "priority": a.descriptor.priority,
            "status": a.health.status,
            "healthy": a.health.status in ("ready", "running"),
        }
        for a in kernel.agents.values()
        if req.capability in a.descriptor.capabilities
    ]
    matches.sort(key=lambda m: m["priority"])

    if not matches:
        # 404, not an empty 200: "no agent has this capability" is a
        # different fact from "an agent handled it and found nothing", and
        # collapsing the two hides a misconfiguration.
        raise HTTPException(
            status_code=404,
            detail=(
                f"no registered agent declares capability '{req.capability}'. "
                f"Known capabilities: "
                f"{sorted({c for a in kernel.agents.values() for c in a.descriptor.capabilities})}"
            ),
        )

    return {
        "status": "success",
        "capability": req.capability,
        "symbol": req.symbol,
        "candidates": matches,
        "selected": matches[0]["id"],
        "healthyCandidates": [m["id"] for m in matches if m["healthy"]],
        # Stated in the response, not just in a docstring, so a caller can't
        # mistake a routing result for a reasoning result.
        "invoked": False,
        "note": (
            "Routing only — the selected agent was NOT invoked. Model "
            "invocation is not implemented; see POST /api/ai/reason."
        ),
    }


@router.post("/reason")
async def reason(req: ReasoningRequest) -> Dict[str, Any]:
    """Not implemented — returns 501.

    Deliberately fails rather than returning invented reasoning. See the
    module docstring: no LLM client is configured in the backend and no
    agent exposes a generic reasoning entry point, so any response this
    route could produce today would be fabricated.

    To implement honestly it needs: a configured model provider, a prompt
    from the versioned prompt library (spec Section 9), and a recorded
    request/response pair for audit (spec Section 16's requirement that
    external reasoning be recorded and attributed).
    """
    raise HTTPException(
        status_code=501,
        detail=(
            "Model invocation is not implemented. No LLM provider is configured in "
            "the backend and no agent exposes a generic reason() entry point, so "
            "this route cannot return a real answer and will not return a fake "
            "one. Use POST /api/ai/route to resolve which agent owns a capability."
        ),
    )
