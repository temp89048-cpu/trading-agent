"""Agent task store + HTTP surface (`/api/agents`).

Three modules already imported `_tasks` / `save_tasks` from here
(`agents/trading_agent.py`, `agents/portfolio_agent.py`,
`api/dashboard.py`) but the module never existed, so importing any of them
raised ImportError — and because `main.py` imports `register_trading_agent`
at line 6, that killed backend startup entirely. This is that missing
module, written to the contract those three call sites already assume:

    _tasks: Dict[str, dict]   # task_id -> task
    save_tasks() -> None      # persist the whole store

PERSISTENCE
-----------
JSON at `tasks_db.json` in the repo root, which is what
`docker-compose.yml` already bind-mounts into the container
(`./tasks_db.json:/app/tasks_db.json`) — so the path is chosen to match
existing infrastructure rather than inventing a second location.

Writes go to a temp file and are then `os.replace`d over the target.
`os.replace` is atomic on both Windows and POSIX, so a crash mid-write
leaves the previous good file intact instead of a truncated one. The
scheduler calls `save_tasks()` from inside agent ticks while an HTTP
request may be writing at the same time, and a half-written task file
means losing track of open positions on restart.

SCHEMA
------
Deliberately schema-less passthrough: tasks are stored as whatever dict
they arrive as. The frontend's `AgentTask` (components/Agent.tsx) is
camelCase, while the backend adds some snake_case working fields
(`dynamic_tp_price`, `execution_plan`). Imposing a Pydantic model here
would need a full field mapping, and any field missing from that mapping
would be silently dropped on every round-trip — including
`currentEntryPrice`, which is how the tick loop knows a position is open.
Losing that field would make an open position invisible. When the two
sides' schemas are reconciled this should become a real model; until then
passthrough is the honest option, not the lazy one.
"""

import json
import logging
import os
import tempfile
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException

from backend.core.auth import require_write_auth

logger = logging.getLogger(__name__)

router = APIRouter()

# Repo root = backend/api/agents.py -> backend/api -> backend -> root
_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
TASKS_DB_PATH = os.path.join(_ROOT, "tasks_db.json")

# task_id -> task dict. Imported directly by the agents that tick over it.
# Rebinding this name would break those importers (they hold a reference to
# the original object), so every mutation below is in-place.
_tasks: Dict[str, Dict[str, Any]] = {}


def load_tasks() -> None:
    """Populate `_tasks` from disk. Safe to call when the file is absent."""
    if not os.path.exists(TASKS_DB_PATH):
        return
    try:
        with open(TASKS_DB_PATH, encoding="utf-8") as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError) as e:
        # Do NOT silently start with an empty store — that would look
        # identical to "no tasks yet" while actually having lost track of
        # open positions. Log loudly and leave _tasks empty so the operator
        # sees the discrepancy against the exchange.
        logger.error(
            "Could not read %s (%s). Starting with an EMPTY task store — "
            "any previously open agent positions are now untracked and must "
            "be reconciled against the exchange manually.",
            TASKS_DB_PATH,
            e,
        )
        return

    if not isinstance(data, dict):
        logger.error(
            "%s did not contain a JSON object (got %s). Ignoring it.",
            TASKS_DB_PATH,
            type(data).__name__,
        )
        return

    _tasks.clear()
    _tasks.update(data)
    logger.info("Loaded %d agent task(s) from %s", len(_tasks), TASKS_DB_PATH)


def save_tasks() -> None:
    """Atomically persist `_tasks`. Never raises — a failed save must not
    abort a trade that already happened on the exchange."""
    try:
        directory = os.path.dirname(TASKS_DB_PATH)
        fd, tmp_path = tempfile.mkstemp(dir=directory, prefix=".tasks_db.", suffix=".tmp")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                json.dump(_tasks, fh, indent=2, default=str)
            os.replace(tmp_path, TASKS_DB_PATH)
        except BaseException:
            # Clean up the temp file on any failure so repeated errors don't
            # litter the directory.
            if os.path.exists(tmp_path):
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
            raise
    except Exception as e:
        # Logged, not raised: callers are mid-tick right after a real
        # exchange fill. Losing the persistence write is bad; unwinding the
        # caller and skipping the rest of its bookkeeping is worse.
        logger.error("Failed to persist agent tasks to %s: %s", TASKS_DB_PATH, e)


# Load once at import so the agents that tick over `_tasks` see prior state.
load_tasks()


@router.get("/tasks")
async def list_tasks() -> List[Dict[str, Any]]:
    """Every task, as a JSON array.

    Returns an array (not the `{id: task}` map) because that is the shape
    the frontend consumes — `components/Agent.tsx` does `setTasks(data)`
    against `AgentTask[]`.
    """
    return list(_tasks.values())


@router.post("/tasks", dependencies=[Depends(require_write_auth)])
async def create_task(task: Dict[str, Any]) -> Dict[str, Any]:
    """Register a task created by the frontend.

    Uses the client-supplied `id` rather than generating one, so the
    frontend's optimistic local copy and this record are the same task. A
    server-generated id would leave the client tracking a task the backend
    has under a different key — two views of one position.
    """
    task_id = task.get("id")
    if not task_id:
        raise HTTPException(status_code=422, detail="task is missing required field 'id'")
    if task_id in _tasks:
        # Idempotent: a retried POST after a lost response must not create a
        # second task for the same intent (spec Section 19).
        logger.info("Task %s already exists — returning existing record.", task_id)
        return _tasks[task_id]

    # The frontend marks a new task 'starting'; it only becomes 'running'
    # once the backend has it, so a task that failed to register is visibly
    # stuck rather than appearing active.
    if task.get("status") == "starting":
        task["status"] = "running"

    _tasks[task_id] = task
    save_tasks()
    logger.info("Registered agent task %s (%s)", task_id, task.get("symbol"))
    return task


@router.delete("/tasks/{task_id}", dependencies=[Depends(require_write_auth)])
async def cancel_task(task_id: str) -> Dict[str, Any]:
    """Cancel a task. Does NOT close its open position.

    Cancelling stops the agent from opening anything further. Any position
    it currently holds is left open and still tracked, because silently
    market-closing a live position as a side effect of a cancel click is
    not something the operator asked for. Closing is an explicit action —
    see `POST /api/admin/emergency-stop` for the halt-everything path.
    """
    task = _tasks.get(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail=f"no task with id {task_id}")
    task["status"] = "cancelled"
    save_tasks()
    if task.get("currentEntryPrice"):
        logger.warning(
            "Task %s cancelled while holding an open position in %s "
            "(entry %s, qty %s). The position is still open and is no longer "
            "being managed by this task.",
            task_id,
            task.get("symbol"),
            task.get("currentEntryPrice"),
            task.get("currentQty"),
        )
    return task
