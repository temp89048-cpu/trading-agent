"""Read-only catalog endpoints — the three the frontend brief listed as BLOCKED.

    GET /api/catalog/orders       fill records derived from the trade log
    GET /api/catalog/strategies   strategy profiles + planned, with real gating
    GET /api/catalog/replay       traced runs available to step through

WHY THESE EXIST
---------------
`REPLACE-FRONTEND-WITH-REFERENCE-UI.md` §7 step 3: when a page's data is
foundational and missing, propose the minimal backend addition, isolated and
clearly documented. Three routes were BLOCKED with the data already in the process
and no way to reach it.

STRICTLY READ-ONLY, AND ENFORCED
--------------------------------
No POST/PUT/DELETE, and no import of anything in
`graphs.contracts.FORBIDDEN_IMPORTS`. `tests/test_catalog_api.py` asserts both by
AST. This module can be deleted without changing a single decision the agent makes.

THREE WRONG ASSUMPTIONS THE FIRST DRAFT MADE — recorded because each would have
shipped an endpoint returning nothing while looking correct:

  1. `core/audit.get_audit_log()` does not exist; the export is `get_audit_trail()`,
     and the `audit_logs` table holds **decisions** (symbol, decision, confidence,
     reasoning) — not orders or fills. So `/orders` derives from the TRADE log
     instead, which is where fills actually live.
  2. `graphs/tracing.list_traces()` does not exist. It is `list_recent_runs()`.
  3. `STRATEGY_PROFILES` is a **List[StrategyProfile]**, not a dict — `.items()`
     would have raised on the first call.

WHAT `/orders` REALLY IS — AND A FOURTH WRONG ASSUMPTION, MINE
--------------------------------------------------------------
The first version of this docstring said *"this backend has no order store"* and
that slippage and latency are *"not recorded on a trade"*. **Both were wrong, and I
asserted them without checking.**

  * Postgres has a `trades` table with thousands of agent-written fills, each
    carrying `origin_tag` and `exchange_order_id`, and `/api/execution` already
    served it. Reading `.data/trades.json` instead meant this endpoint showed the
    *browser's* manual trades — four rows — while describing itself as the fill
    record of a system that had made thousands.
  * `execution_quality` records `slippage_bps` and `latency_ms` per `order_id`. It
    was declared in `db/schema.sql` and had **never been created**, because
    `init_db` applied the schema only when `trades` was absent. So the numbers were
    not "unrecorded"; the writes were failing against a missing table.

TWO BOOKS, AND THEY ARE BOTH REAL. This is not a bug to collapse:

    Postgres `trades`      — what the BACKEND AGENT executed (this endpoint)
    `.data/trades.json`    — what the BROWSER did (manual paper trades, /api/trades)

They are different actors, so they are reported separately and labelled. `source`
in the response says which one answered.

`slippageBps` and `latencyMs` stay `null` when unmeasured — never 0.0, which would
read as a perfect fill. This project has already been bitten by exactly that.
"""

from __future__ import annotations

import json
import logging
import os
import sqlite3
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Query

from backend.core.db import get_db_pool

logger = logging.getLogger(__name__)

router = APIRouter()

_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
_TRADES_FILE = os.path.join(_ROOT, ".data", "trades.json")


# ===========================================================================
# Orders (derived from fills)
# ===========================================================================

@router.get("/orders")
async def orders(
    limit: int = Query(100, ge=1, le=500),
    tab: Optional[str] = Query(None),
) -> Dict[str, Any]:
    """Fill records, newest first — the AGENT's book, from Postgres.

    Joins `execution_quality` for slippage and latency, which are recorded per
    `order_id` rather than on the trade row. `LEFT JOIN`, deliberately: a fill with
    no quality row must still appear with `null` metrics, rather than being filtered
    out by an inner join into a shorter list that looks complete.

    Falls back to `.data/trades.json` (the BROWSER's manual trades) only when there
    is no database pool, and says so in `source` — a page that silently swapped
    books would report a different actor's trades under the same heading.
    """
    pool = get_db_pool()
    db_error: Optional[str] = None

    if pool is not None:
        try:
            async with pool.acquire() as conn:
                fetched = await conn.fetch(
                    """
                    SELECT t.id, t.ts, t.symbol, t.side, t.qty, t.price, t.pnl, t.tab,
                           t.origin_tag, t.exchange_order_id,
                           q.slippage_bps, q.latency_ms, q.fully_filled, q.filled_qty
                      FROM trades t
                      LEFT JOIN execution_quality q ON q.order_id = t.exchange_order_id
                     WHERE ($1::text IS NULL OR t.tab = $1)
                     ORDER BY t.ts DESC
                     LIMIT $2
                    """,
                    tab,
                    limit,
                )
                total = await conn.fetchval(
                    "SELECT count(*) FROM trades WHERE ($1::text IS NULL OR tab = $1)", tab
                )
                measured = await conn.fetchval(
                    "SELECT count(*) FROM execution_quality WHERE slippage_bps IS NOT NULL"
                )

            rows = [
                {
                    "id": r["id"],
                    # ms since epoch, matching every other timestamp the frontend reads.
                    "ts": r["ts"].timestamp() * 1000 if r["ts"] else None,
                    "symbol": r["symbol"],
                    "side": r["side"],
                    "qty": float(r["qty"]) if r["qty"] is not None else None,
                    "price": float(r["price"]) if r["price"] is not None else None,
                    "pnl": float(r["pnl"]) if r["pnl"] is not None else None,
                    "tab": r["tab"],
                    "originTag": r["origin_tag"],
                    "exchangeOrderId": r["exchange_order_id"],
                    # A partial fill must be visible, not left for the caller to infer
                    # from a qty comparison it would have to make itself.
                    "status": "FILLED" if r["fully_filled"] is not False else "PARTIALLY_FILLED",
                    "filledQty": float(r["filled_qty"]) if r["filled_qty"] is not None else None,
                    # null, never 0.0 — an unmeasured fill is not a perfect fill.
                    "slippageBps": float(r["slippage_bps"]) if r["slippage_bps"] is not None else None,
                    "latencyMs": float(r["latency_ms"]) if r["latency_ms"] is not None else None,
                    "orderType": None,
                }
                for r in fetched
            ]

            return {
                "orders": rows,
                "count": len(rows),
                "totalStored": int(total or 0),
                "source": "postgres:trades",
                "isDerived": False,
                "reasonUnavailable": None,
                "meaning": (
                    "The backend agent's executed fills, from the Postgres `trades` table. "
                    "Every row is a completed fill: there is no resting-order store, which is "
                    "why `status` is FILLED or PARTIALLY_FILLED and never PENDING. This is a "
                    "DIFFERENT book from /api/trades, which holds manual trades made in the browser."
                ),
                "qualityMeasured": int(measured or 0),
                "notRecorded": {
                    "orderType": "market/limit is not stored on a trade row",
                    "slippageBps": (
                        "null where execution_quality has no row or no reference price. "
                        + str(int(measured or 0))
                        + " order(s) carry a measured value. Rows written before the "
                        "execution_quality table existed have none — it was declared in "
                        "db/schema.sql but never created, because init_db applied the schema "
                        "only when `trades` was absent."
                    ),
                    "latencyMs": "same source and same caveat as slippageBps",
                },
            }
        except Exception as exc:
            # Fall through to the JSON store, but say what failed. Returning an empty
            # list here would read as "no orders" rather than "the query broke".
            logger.error("Reading orders from Postgres failed: %s", exc)
            db_error = str(exc)

    # ---- Fallback: the browser's manual trade log, clearly labelled ----
    rows = []
    reason: Optional[str] = None
    try:
        if os.path.exists(_TRADES_FILE):
            with open(_TRADES_FILE, encoding="utf-8") as fh:
                raw = json.load(fh)
            trades = raw if isinstance(raw, list) else raw.get("trades", [])
        else:
            trades = []
            reason = "no trade log exists yet — nothing has been filled"
    except (json.JSONDecodeError, OSError) as exc:
        trades = []
        reason = "the trade log could not be read: " + str(exc)

    for t in trades:
        if not isinstance(t, dict):
            continue
        if tab and t.get("tab") != tab:
            continue
        rows.append(
            {
                "id": t.get("id"),
                "ts": t.get("ts"),
                "symbol": t.get("symbol"),
                "side": t.get("side"),
                "qty": t.get("qty"),
                "price": t.get("price"),
                "pnl": t.get("pnl"),
                "tab": t.get("tab"),
                "originTag": t.get("originTag") or "manual-click",
                "exchangeOrderId": None,
                "status": "FILLED",
                "filledQty": t.get("qty"),
                "slippageBps": None,
                "latencyMs": None,
                "orderType": None,
            }
        )

    rows.sort(key=lambda r: r.get("ts") or 0, reverse=True)

    if reason is None:
        reason = (
            "the Postgres query failed (" + str(db_error) + ") — showing the browser's "
            "manual trade log instead, which is a DIFFERENT book"
            if db_error
            else "no database pool — showing the browser's manual trade log, which is a "
            "DIFFERENT book from the agent's fills"
        )

    return {
        "orders": rows[:limit],
        "count": min(len(rows), limit),
        "totalStored": len(rows),
        "source": "json:.data/trades.json",
        "isDerived": True,
        "reasonUnavailable": reason,
        "meaning": (
            "FALLBACK SOURCE: these are manual trades made in the browser, not the backend "
            "agent's fills. The agent's book lives in Postgres and is unavailable right now, "
            "so this is not a subset of it — it is a different set of trades by a different actor."
        ),
        "qualityMeasured": 0,
        "notRecorded": {
            "slippageBps": "the JSON store carries no execution-quality data at all",
            "latencyMs": "the JSON store carries no execution-quality data at all",
            "orderType": "market/limit is not stored",
        },
    }


# ===========================================================================
# Strategies
# ===========================================================================

@router.get("/strategies")
async def strategies() -> Dict[str, Any]:
    """Strategy profiles, their regime gating, and what is planned but unbuilt.

    `historical_success_rate` is the profile's OWN honest field — the dataclass
    documents `None = not established`. It is passed straight through rather than
    substituted with a computed win rate, because trade records carry no strategy
    tag and computing one would attribute one strategy's results to another.
    """
    profiles: List[Dict[str, Any]] = []
    planned: List[Dict[str, Any]] = []
    reason: Optional[str] = None

    try:
        from backend.algorithms import strategy_profiles as sp

        # A LIST of dataclasses, not a dict.
        for p in sp.STRATEGY_PROFILES:
            profiles.append({
                "name": p.name,
                "agent": p.agent,
                "bestConditions": p.best_conditions,
                "worstConditions": p.worst_conditions,
                "expectedHoldingTime": p.expected_holding_time,
                "riskProfile": p.risk_profile,
                "indicatorsUsed": list(p.indicators_used or []),
                "entryLogic": p.entry_logic,
                "exitLogic": p.exit_logic,
                "positionSizingRule": p.position_sizing_rule,
                "activeRegimes": list(p.active_regimes or []),
                # `None` means not established, and the dataclass says so.
                "historicalSuccessRate": p.historical_success_rate,
                "confidenceRules": p.confidence_rules,
                "portfolioRules": p.portfolio_rules,
                "failureModes": list(p.failure_modes or []),
                "selfEvaluation": p.self_evaluation,
            })

        for name, why in sorted(getattr(sp, "PLANNED_STRATEGIES", {}).items()):
            planned.append({"name": name, "reasonNotImplemented": why})
    except Exception as exc:  # noqa: BLE001
        reason = f"strategy profiles could not be read: {exc}"

    return {
        "strategies": profiles,
        "planned": planned,
        "implementedCount": len(profiles),
        "plannedCount": len(planned),
        "reasonUnavailable": reason,
        "successRateMeaning": (
            "`historicalSuccessRate: null` means NOT ESTABLISHED, which is the profile's "
            "own documented value — not a rate of zero. Live per-strategy win rate and "
            "profit factor are not returned at all: trade records carry no strategy tag, "
            "so computing them would attribute one strategy's results to another"
        ),
        "plannedMeaning": (
            "planned strategies are named with the reason each is unbuilt rather than "
            "omitted. A strategy that silently does not exist is indistinguishable from "
            "one that exists and never fires"
        ),
    }


# ===========================================================================
# Replay
# ===========================================================================

@router.get("/replay")
async def replay(limit: int = Query(50, ge=1, le=200)) -> Dict[str, Any]:
    """Traced runs that can be stepped through, newest first.

    A replay here is re-reading a RECORDED trace, not re-executing the graph.
    Re-execution would call the market-data layer again and reason over a different
    market than the original decision — the replay-divergence hazard
    `graphs/state.py` documents, and the reason `market_data` is written exactly
    once per run.
    """
    runs: List[Dict[str, Any]] = []
    reason: Optional[str] = None

    try:
        from backend.graphs.tracing import list_recent_runs

        traces = list_recent_runs(limit=limit)
    except Exception as exc:  # noqa: BLE001
        traces = []
        reason = f"the trace store could not be read: {exc}"

    for d in traces or []:
        if not isinstance(d, dict):
            continue
        runs.append({
            "runId": d.get("run_id"),
            "graph": d.get("graph"),
            "symbol": d.get("symbol"),
            "trigger": d.get("trigger"),
            "startedAt": d.get("started_at"),
            "finishedAt": d.get("finished_at"),
            "outcome": d.get("outcome"),
            "stepCount": len(d.get("nodes") or []),
            "durationMs": d.get("durationMs"),
            "noDecisionReason": d.get("no_decision_reason"),
        })

    return {
        "runs": runs,
        "count": len(runs),
        "reasonUnavailable": reason,
        "replayMeaning": (
            "stepping a RECORDED trace, not re-executing the graph. Re-execution would "
            "re-fetch market data and reason over a different market than the original "
            "decision, so the replay would silently diverge from the run it claims to "
            "reproduce"
        ),
        "stepSource": "GET /api/graphs/runs/{run_id} returns the per-node detail for one run",
    }


@router.get("")
async def catalog() -> Dict[str, Any]:
    """What this router exposes, and the honest limit of each."""
    return {
        "endpoints": {
            "/api/catalog/orders": "fills derived from the trade log; no order book exists",
            "/api/catalog/strategies": "profiles + planned; no per-strategy performance",
            "/api/catalog/replay": "traced runs available to step through",
        },
        "readOnly": True,
        "meaning": (
            "these exist only because the data was already in the process with no way to "
            "reach it. Nothing here decides anything and no route accepts a write — the "
            "module can be deleted without changing a single agent decision"
        ),
    }
