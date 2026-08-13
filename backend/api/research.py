"""Research API (`/api/research`) — spec Section 8.

Submits and retrieves research tasks/findings. Per spec Section 17,
*"Research never directly affects production"* — every route here is
read-only with respect to trading config. Nothing in this module writes to
risk settings or strategy selection; the backtest route computes a result
and returns it, and acting on that result is a separate, human-initiated
step (spec Section 12's approval gate).
"""

from typing import Any, Dict, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.core.backtest_engine import HistoricalBacktestEngine
from backend.services import research_store
from backend.services.ai_memory import generate_learning_report
from backend.tools.benchmark import run_benchmark

router = APIRouter()


class HypothesisStatusUpdate(BaseModel):
    status: str
    # Required for a human decision: a status change with no stated reason is
    # not reviewable later, and Section 12's gate is meant to be auditable.
    review_note: str = Field(..., min_length=1)


class FindingInput(BaseModel):
    finding: str = Field(..., min_length=1)
    confidence: float = Field(..., ge=0.0, le=1.0)



@router.get("/queue")
async def get_queue() -> Dict[str, Any]:
    """The research queue — spec Section 12's "Future Recommendations" surface.

    Everything here is understanding awaiting a human. `appliedAutomatically` is
    always 0 by construction, and is reported rather than assumed so an operator
    can verify it rather than trust a docstring.
    """
    return {"status": "success", **await research_store.queue_summary()}


@router.get("/hypotheses")
async def list_hypotheses(status: Optional[str] = None) -> Dict[str, Any]:
    """Hypotheses, optionally filtered by status."""
    if status and status not in research_store.VALID_STATUSES:
        raise HTTPException(
            status_code=422,
            detail=f"status must be one of {research_store.VALID_STATUSES}",
        )
    rows = await research_store.get_hypotheses(status)
    return {"status": "success", "count": len(rows), "hypotheses": rows}


@router.post("/hypotheses/{hypothesis_id}/status")
async def set_hypothesis_status(hypothesis_id: str, payload: HypothesisStatusUpdate) -> Dict[str, Any]:
    """Change a hypothesis's status. THIS IS THE HUMAN APPROVAL GATE.

    `set_by_human=True` is passed here and nowhere else in the codebase — this
    route is the only path by which a hypothesis can become validated, rejected,
    dismissed, or applied. Automated callers get a PermissionError from the
    store (spec Section 12's approval requirement, enforced rather than
    documented).

    Setting `applied` records that a human changed configuration THEMSELVES. It
    does not change any configuration: no code path in this system writes risk
    limits or strategy selection in response to a hypothesis.
    """
    try:
        record = await research_store.update_hypothesis_status(
            hypothesis_id,
            payload.status,
            payload.review_note,
            set_by_human=True,
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    if record is None:
        raise HTTPException(status_code=404, detail=f"no hypothesis with id {hypothesis_id}")

    return {
        "status": "success",
        "hypothesis": record,
        "configChanged": False,
        "note": (
            "Status recorded. No trading configuration was modified — if you intend to act on "
            "this hypothesis you must change the relevant setting yourself."
        ),
    }


@router.get("/tasks")
async def list_research_tasks(open_only: bool = False) -> Dict[str, Any]:
    rows = await research_store.get_research_tasks(open_only=open_only)
    return {"status": "success", "count": len(rows), "tasks": rows}


@router.post("/tasks/{task_id}/finding")
async def submit_finding(task_id: str, payload: FindingInput) -> Dict[str, Any]:
    """Attach a written finding to a research task.

    Spec Section 22.5 requires a written finding with a confidence score for
    every research task. A task cannot be closed without one — closing it empty
    would be indistinguishable from nobody having looked.
    """
    try:
        record = await research_store.record_finding(task_id, payload.finding, payload.confidence)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    if record is None:
        raise HTTPException(status_code=404, detail=f"no research task with id {task_id}")
    return {"status": "success", "task": record}


@router.get("/dashboard")
async def get_learning_dashboard():
    """
    Level 17: Learning Dashboard
    Returns the crunched statistics from the AI's historical memory.
    """
    report = generate_learning_report()
    if "error" in report:
        return {"status": "error", "message": report["error"]}
    return {"status": "success", "data": report}

@router.get("/benchmark")
async def get_benchmark():
    report = run_benchmark()
    return {"status": "success", "data": report}




class BacktestRequest(BaseModel):
    symbol: str
    timeframe: str = "1m"
    limit: int = 1000

@router.post("/run")
async def run_backtest(req: BacktestRequest) -> Dict[str, Any]:
    try:
        engine = HistoricalBacktestEngine(
            symbol=req.symbol,
            timeframe=req.timeframe,
            limit=req.limit
        )
        result = await engine.run()
        if "error" in result:
            raise HTTPException(status_code=400, detail=result["error"])
        return result
    except HTTPException:
        # Re-raised unchanged. Without this branch the `except Exception`
        # below caught our own 400 and re-wrapped it as a 500, turning
        # "you asked for a symbol with no data" into "the server broke".
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

