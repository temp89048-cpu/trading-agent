"""Missions API (`/api/missions`).

These routes were physically inside `api/ai.py`, which had three unrelated
files concatenated into it (an agent task store, these mission routes, and
an "AI API" header) with about eight missing imports — so none of it could
run. Moved here intact rather than deleted: `services/mission_store.py` and
`models/types.py`'s `Mission` are both real, complete implementations, and
the routes are the only way to reach them.

`MissionType` includes `'capital-target'`, which is how a user states a goal
like "grow $500 into $5000". Per CLAUDE.md that mission type deliberately
has no deadline and only ever produces advisory caution notes — never a hard
rule and never a sizing override — because a hard deadline on a financial
target pushes the system toward unsafe risk-taking to hit the number. These
routes store and report progress; they do not size trades.
"""

from typing import Any, Dict, List

from fastapi import APIRouter, Body, HTTPException

from backend.models.types import Mission
from backend.services import mission_store

router = APIRouter()


@router.get("", response_model=List[Dict[str, Any]])
async def get_missions() -> List[Dict[str, Any]]:
    """Every mission."""
    return await mission_store.get_missions()


@router.post("", response_model=Dict[str, Any])
async def create_mission(mission: Mission) -> Dict[str, Any]:
    """Create or replace a full mission (upsert by `id`)."""
    await mission_store.save_mission(mission)
    return {"status": "success", "mission_id": mission.id}


@router.patch("", response_model=Dict[str, Any])
async def update_mission(
    id: str = Body(...),
    status: str = Body(None),
    progress: Dict[str, Any] = Body(None),
    checkpoints: List[Dict[str, Any]] = Body(None),
) -> Dict[str, Any]:
    """Partial update. Only the fields actually supplied are written."""
    updates: Dict[str, Any] = {}
    if status is not None:
        updates["status"] = status
    if progress is not None:
        updates["progress"] = progress
    if checkpoints is not None:
        updates["checkpoints"] = checkpoints

    if not updates:
        raise HTTPException(
            status_code=422,
            detail="no updatable field supplied (expected one of: status, progress, checkpoints)",
        )

    # update_mission_partial is a no-op for an unknown id, which would
    # otherwise return success for a mission that was never written.
    missions = await mission_store.update_mission_partial(id, updates)
    if not any(m.get("id") == id for m in missions):
        raise HTTPException(status_code=404, detail=f"no mission with id {id}")
    return {"status": "success", "mission_id": id, "updated": sorted(updates)}


@router.delete("", response_model=Dict[str, Any])
async def delete_mission(id: str) -> Dict[str, Any]:
    """Delete a mission by id."""
    await mission_store.delete_mission(id)
    return {"status": "success", "mission_id": id}
