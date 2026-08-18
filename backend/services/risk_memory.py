"""Risk Memory — spec Section 15 (Phase 32), store 6 of 7.

Historical risk events — every CRO approval and veto — so the system can learn
which trades get blocked instead of re-proposing them.

THREE BUGS FIXED IN THE SECTION 14-41 AUDIT
-------------------------------------------
1. It imported `backend.core.database`, which does not exist. The module is
   `backend.core.db`. The whole file was therefore unimportable, so Risk Memory —
   one of Section 15's seven required stores — did not work at all, and
   `memory_manager` caught the ImportError and recorded it as merely
   "unavailable".

2. Both queries selected `created_at`. `db/schema.sql`'s `risk_events` table has
   no such column; it is `timestamp`. So even with the import fixed, every query
   would have raised — and been swallowed.

3. `except Exception: return []` made a broken query indistinguishable from "no
   risk events have ever occurred". For THIS store that is the worst possible
   confusion: an empty list reads as "this system has never had a trade blocked",
   which is the most reassuring answer available and was, in fact, produced by a
   typo. Failures now return None so the caller can tell the two apart.

WHY IT STILL RETURNS NOTHING ON MOST DEPLOYMENTS
-----------------------------------------------
`db/schema.sql` is a Postgres target that is not provisioned by default (see
CLAUDE.md). With no pool, this store honestly reports itself unavailable rather
than empty. `agents/cro_agent.py` IS a real writer, so the store becomes live the
moment Postgres is configured — it is not reading a table nobody fills.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from backend.core.db import get_db_pool

logger = logging.getLogger(__name__)

# Column names, referenced once each so a schema change breaks in one place rather
# than in two queries that could drift apart.
_COLUMNS = "event_id, tar_id, decision, rule_breached, rationale, timestamp"


class RiskMemory:
    """Read-only access to the `risk_events` log.

    Every method returns `None` on failure and a list on success, INCLUDING an
    empty list. `None` means "could not read"; `[]` means "read it, there are
    none". Collapsing those was bug 3 above.
    """

    @staticmethod
    async def get_recent_risk_events(limit: int = 50) -> Optional[List[Dict[str, Any]]]:
        """The most recent risk events, newest first. None when unreadable."""
        pool = get_db_pool()
        if pool is None:
            logger.debug(
                "Risk memory unavailable: no database pool. The risk_events table "
                "lives in Postgres, which is not provisioned by default."
            )
            return None

        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    f"SELECT {_COLUMNS} FROM risk_events "
                    f"ORDER BY timestamp DESC LIMIT $1",
                    limit,
                )
            return [dict(r) for r in rows]
        except Exception as exc:  # noqa: BLE001
            # Logged at ERROR and returned as None, never as []. A query that fails
            # must not look like a clean history.
            logger.error("Risk memory query failed: %s", exc)
            return None

    @staticmethod
    async def get_risk_events_by_rule(
        rule_breached: str, limit: int = 10
    ) -> Optional[List[Dict[str, Any]]]:
        """Past events for one specific rule, e.g. 'Leverage limit exceeded'."""
        pool = get_db_pool()
        if pool is None:
            return None

        try:
            async with pool.acquire() as conn:
                rows = await conn.fetch(
                    f"SELECT {_COLUMNS} FROM risk_events "
                    f"WHERE rule_breached = $1 ORDER BY timestamp DESC LIMIT $2",
                    rule_breached,
                    limit,
                )
            return [dict(r) for r in rows]
        except Exception as exc:  # noqa: BLE001
            logger.error("Risk memory query by rule failed: %s", exc)
            return None
