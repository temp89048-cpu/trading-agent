"""Hypothesis and research-task store — spec Section 12's missing middle.

Section 12's required pipeline:

    Trade -> Reflection -> Research Queue -> Hypothesis -> Backtest
          -> Walk-Forward Test -> Paper Trading -> Evaluation
          -> Human Approval -> Production

and the path it forbids:

    Loss -> AI rewrites strategy -> Live Trading

The backend implemented the first arrow and then stopped: `REFLECTION_COMPLETED`
was published and consumed by nobody, so a lesson was stored and went nowhere.
`agents/hypothesis_agent.py` was a two-function scaffold whose bodies were
`pass` and `return []`. This module is the queue those stages need.

SCHEMA PARITY WITH THE TYPESCRIPT SIDE
--------------------------------------
`lib/hypothesisStore.server.ts` already models this well, so the statuses here
are deliberately identical rather than a parallel invention — the same record
should mean the same thing whichever half of the system wrote it:

    proposed  -> generated automatically, no human action yet
    dismissed -> a human decided it isn't worth testing
    validated -> a human tested it and it held up
    rejected  -> a human tested it and it did not
    applied   -> a human, having validated it, changed the config THEMSELVES

WHY `applied` IS A RECORD AND NOT AN ACTION
------------------------------------------
Nothing in this module or in `agents/hypothesis_agent.py` writes to risk
config, strategy selection, or the leverage ceiling. `applied` exists so a
human can record that they made a change; setting it changes nothing on its
own. That is CLAUDE.md invariant 5 — learning produces understanding, it does
not deploy. `tests/test_learning_pipeline.py` asserts no learning module
imports anything that could write trading configuration.
"""

import asyncio
import json
import logging
import os
import tempfile
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(_ROOT, ".data")
HYPOTHESES_FILE = os.path.join(DATA_DIR, "hypotheses.json")
RESEARCH_TASKS_FILE = os.path.join(DATA_DIR, "research_tasks.json")

VALID_STATUSES = ("proposed", "dismissed", "validated", "rejected", "applied")

# Statuses only a human may set. Enforced in `update_hypothesis_status`, not
# just documented, so an automated caller cannot promote its own hypothesis.
HUMAN_ONLY_STATUSES = ("validated", "rejected", "applied", "dismissed")

# Serialises writes. Two agents reacting to the same reflection could otherwise
# read-modify-write concurrently and lose one of the records.
_lock = asyncio.Lock()


def _read(path: str) -> List[Dict[str, Any]]:
    if not os.path.exists(path):
        return []
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError) as e:
        # Loud, and returns empty rather than raising: losing the research queue
        # is bad but must not take down the trading path that triggered the write.
        logger.error("Could not read %s (%s). Treating as empty.", path, e)
        return []


def _write(path: str, rows: List[Dict[str, Any]]) -> None:
    """Atomic write — temp file then os.replace, which is atomic on Windows and
    POSIX. A crash mid-write leaves the previous good file rather than a
    truncated one."""
    os.makedirs(DATA_DIR, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=DATA_DIR, prefix=".research.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            json.dump(rows, fh, indent=2, default=str)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            try:
                os.unlink(tmp)
            except OSError:
                pass
        raise


# ---------------------------------------------------------------------------
# Hypotheses
# ---------------------------------------------------------------------------

async def get_hypotheses(status: Optional[str] = None) -> List[Dict[str, Any]]:
    rows = _read(HYPOTHESES_FILE)
    if status:
        rows = [r for r in rows if r.get("status") == status]
    return rows


async def add_hypothesis(
    trade_id: str,
    symbol: str,
    claim: str,
    suggested_test: str,
    validation_plan: List[str],
    evidence: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """Record a new hypothesis with status 'proposed'.

    Returns None if one already exists for this trade. One reflection produces
    one hypothesis: without this check, a replayed or redelivered
    REFLECTION_COMPLETED event would fill the queue with duplicates of the same
    claim, and the operator reviewing it could not tell how many distinct
    lessons there actually were.
    """
    async with _lock:
        rows = _read(HYPOTHESES_FILE)
        if any(r.get("tradeId") == trade_id for r in rows):
            logger.debug("Hypothesis for trade %s already exists — not duplicating.", trade_id)
            return None

        now = datetime.utcnow().isoformat()
        record = {
            "id": uuid.uuid4().hex,
            "tradeId": trade_id,
            "ts": now,
            "updatedAt": now,
            "symbol": symbol,
            "claim": claim,
            "suggestedTest": suggested_test,
            # Spec Section 12 requires a Validation Plan alongside every
            # hypothesis — "how the hypothesis will be tested before trusting
            # it". A claim with no test plan is an opinion.
            "validationPlan": validation_plan,
            "evidence": evidence,
            "status": "proposed",
            "reviewNote": None,
            # Recorded explicitly so an audit never has to infer it.
            "appliedAutomatically": False,
        }
        rows.append(record)
        _write(HYPOTHESES_FILE, rows)
        logger.info("Hypothesis recorded for %s (trade %s): %s", symbol, trade_id, claim)
        return record


async def update_hypothesis_status(
    hypothesis_id: str,
    status: str,
    review_note: Optional[str],
    set_by_human: bool = False,
) -> Optional[Dict[str, Any]]:
    """Change a hypothesis's status.

    `set_by_human` must be True for any status in HUMAN_ONLY_STATUSES. This is
    the enforcement point for spec Section 12's approval gate: an automated
    caller cannot mark its own hypothesis validated and thereby present it as
    reviewed. The flag is set only by the HTTP route an operator drives.
    """
    if status not in VALID_STATUSES:
        raise ValueError(f"status must be one of {VALID_STATUSES}, got {status!r}")

    if status in HUMAN_ONLY_STATUSES and not set_by_human:
        raise PermissionError(
            f"status '{status}' may only be set by a human operator. Automated code may not "
            f"validate, reject, dismiss, or apply its own hypothesis. Spec Section 12: "
            f"'Learning improves understanding - it does not, by itself, deploy anything.'"
        )

    async with _lock:
        rows = _read(HYPOTHESES_FILE)
        for i, row in enumerate(rows):
            if row.get("id") == hypothesis_id:
                rows[i] = {
                    **row,
                    "status": status,
                    "reviewNote": review_note,
                    "updatedAt": datetime.utcnow().isoformat(),
                }
                _write(HYPOTHESES_FILE, rows)
                logger.info("Hypothesis %s -> %s (%s)", hypothesis_id, status, review_note or "no note")
                return rows[i]
    return None


# ---------------------------------------------------------------------------
# Research tasks
# ---------------------------------------------------------------------------

async def get_research_tasks(open_only: bool = False) -> List[Dict[str, Any]]:
    rows = _read(RESEARCH_TASKS_FILE)
    if open_only:
        rows = [r for r in rows if r.get("status") == "open"]
    return rows


async def add_research_tasks(
    hypothesis_id: Optional[str],
    trade_id: str,
    symbol: str,
    tasks: List[str],
) -> List[Dict[str, Any]]:
    """Queue research tasks (spec Section 12's "Research Tasks" artifact)."""
    if not tasks:
        return []
    async with _lock:
        rows = _read(RESEARCH_TASKS_FILE)
        existing = {(r.get("tradeId"), r.get("question")) for r in rows}
        now = datetime.utcnow().isoformat()
        created = []
        for question in tasks:
            if (trade_id, question) in existing:
                continue
            record = {
                "id": uuid.uuid4().hex,
                "hypothesisId": hypothesis_id,
                "tradeId": trade_id,
                "symbol": symbol,
                "question": question,
                "status": "open",
                "ts": now,
                "finding": None,
            }
            rows.append(record)
            created.append(record)
        if created:
            _write(RESEARCH_TASKS_FILE, rows)
            logger.info("Queued %d research task(s) for %s", len(created), symbol)
        return created


async def record_finding(task_id: str, finding: str, confidence: float) -> Optional[Dict[str, Any]]:
    """Attach a written finding to a research task.

    Spec Section 22.5: *"Every research task must produce a written finding with
    a confidence score and enough detail for a human to independently verify
    it."* Closing a task without a finding is not allowed — a task marked done
    with nothing recorded is indistinguishable from one nobody looked at.
    """
    if not finding.strip():
        raise ValueError("a finding is required to close a research task")

    async with _lock:
        rows = _read(RESEARCH_TASKS_FILE)
        for i, row in enumerate(rows):
            if row.get("id") == task_id:
                rows[i] = {
                    **row,
                    "status": "answered",
                    "finding": finding,
                    "confidence": max(0.0, min(1.0, confidence)),
                    "answeredAt": datetime.utcnow().isoformat(),
                }
                _write(RESEARCH_TASKS_FILE, rows)
                return rows[i]
    return None


async def queue_summary() -> Dict[str, Any]:
    """Counts by status, for the dashboard."""
    hypotheses = _read(HYPOTHESES_FILE)
    tasks = _read(RESEARCH_TASKS_FILE)
    by_status = {s: sum(1 for h in hypotheses if h.get("status") == s) for s in VALID_STATUSES}
    return {
        "hypotheses": {"total": len(hypotheses), "byStatus": by_status},
        "researchTasks": {
            "total": len(tasks),
            "open": sum(1 for t in tasks if t.get("status") == "open"),
            "answered": sum(1 for t in tasks if t.get("status") == "answered"),
        },
        # Surfaced because it is the number that matters for Section 12: how
        # much understanding is waiting on a human, and none of it is live.
        "awaitingHumanReview": by_status.get("proposed", 0),
        "appliedAutomatically": 0,
        "note": (
            "Nothing in this queue affects live trading. A hypothesis reaching production "
            "requires an explicit human action outside this system."
        ),
    }
