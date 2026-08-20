"""Polymarket API — Phase 37. Read-only, plus the one human gate.

WHY THIS ROUTER EXISTS AT ALL, GIVEN THE FEATURE MAY BE OFF
----------------------------------------------------------
One endpoint here is not optional: `POST /mappings/confirm`.

`polymarket_store.confirm_mapping` refuses to set `confirmed` without
`set_by_human=True`, and that flag is only meaningful if there is a route a person
actually drives. Without an HTTP surface the gate would be enforceable in principle
and unreachable in practice, so no mapping could ever be confirmed and the
directional specialist could never run — a safety check that also happens to make
the feature impossible is not a safety check, it is a bug.

The same reasoning `research_store.HUMAN_ONLY_STATUSES` follows: the flag is set by
the route an operator drives, and by nothing else.

WHAT THE READ ENDPOINTS ARE FOR
-------------------------------
`components/PolymarketPanel.tsx` reads them, and an operator can curl them. They
exist to answer one question honestly: **is this feed contributing anything, and if
not, why not?** With the flag off, or before the §8 probe has run, the answer is "no,
and here is the reason" — which is a useful answer and the one this integration will
give for a while.

Every endpoint reports staleness rather than hiding it. A snapshot past
`MAX_SNAPSHOT_AGE_SECONDS` is returned WITH `fresh: false` and its age, because a UI
that renders an old probability as a current one is the exact failure the store's
getter refuses at the read layer.

READ-ONLY, STILL
----------------
This module sits in `api/`, so `graphs/`'s import ban does not apply to it by
location. `tests/test_polymarket.py` checks it by AST anyway: the ccxt Polymarket
adapter carries `create_order` on the same class we import for reads, and an HTTP
route is the last place that should be reachable from.
"""

from __future__ import annotations

import logging
import time
from typing import Annotated, Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from backend.algorithms import prediction_market as pm
from backend.core.auth import require_write_auth
from backend.services import polymarket_registry as registry
from backend.services import polymarket_store as store

logger = logging.getLogger(__name__)

router = APIRouter()


def _enabled() -> bool:
    from backend.core.config import settings

    return settings.POLYMARKET_ENABLED


# ===========================================================================
# Status
# ===========================================================================

@router.get("")
async def status() -> Dict[str, Any]:
    """Is this feed contributing anything, and if not, why not?

    Deliberately answers the negative case in full. Three independent things must
    all be true before a single number reaches the panel — the flag, the adapter,
    and a human-confirmed mapping — and an operator seeing "no contribution" needs
    to know which one is missing.
    """
    from backend.services.polymarket_client import PolymarketClient

    enabled = _enabled()
    mappings = await store.get_mappings()
    confirmed = [m for m in mappings if m.get("confirmed") is True]

    return {
        "enabled": enabled,
        "adapterAvailable": PolymarketClient.is_available(),
        "adapterBlocker": PolymarketClient.unavailable_reason(),
        "mappingsDiscovered": len(mappings),
        "mappingsConfirmed": len(confirmed),
        "confirmedDirectional": sum(
            1 for m in confirmed if m.get("role") == registry.ROLE_DIRECTIONAL
        ),
        "confirmedEventRisk": sum(
            1 for m in confirmed if m.get("role") == registry.ROLE_EVENT_RISK
        ),
        "series": await store.series_summary(),
        "role": (
            "SUPPLEMENTARY. The prediction specialist carries weight 1.0 of 8.0 panel "
            "weight and cannot outvote the market specialist (3.0); event risk is a "
            f"CONSTRAINT capped at {registry.MAX_EVENT_RISK_CONCERN}, so it can dampen "
            "conviction but never veto a trade on its own"
        ),
        "notApplicableMeaning": (
            "when no market resolves to a symbol, the prediction specialist's weight "
            "leaves the coverage denominator entirely — so an inapplicable source "
            "costs that symbol nothing. A mapped market we FAILED to read does count "
            "against coverage, because that is an engineering gap rather than an "
            "inapplicable source"
        ),
        "readOnlyMeaning": (
            "this integration never places an order on any venue. Trading on "
            "Polymarket would be a second execution path, outside the Supervisor gate, "
            "the leverage ceiling and the mandatory stop-loss"
        ),
        "gateMeaning": (
            "three things must ALL hold before a number reaches the panel: "
            f"POLYMARKET_ENABLED ({enabled}), a usable ccxt adapter "
            f"({PolymarketClient.is_available()}), and at least one HUMAN-CONFIRMED "
            f"mapping ({len(confirmed)})"
        ),
    }


@router.get("/signals")
async def signals() -> Dict[str, Any]:
    """The signal inventory, including what is NOT implemented and why.

    Declared as data rather than computed, so this answers "what can this system do
    with prediction-market data" without a market being mapped. Same convention as
    `/api/graphs/nodes` and `algorithms/footprint.FOOTPRINT_SIGNALS`: a signal that
    silently never fires is indistinguishable from one that fires and finds nothing.
    """
    return {
        "signals": list(pm.PREDICTION_SIGNALS),
        "total": len(pm.PREDICTION_SIGNALS),
        "unimplemented": pm.UNIMPLEMENTED_SIGNALS,
        "directionalPaths": {
            "expected_price_drift": (
                "probability-weighted expected price over BOUNDED buckets of a "
                "mutually-exclusive event. Needs NO volatility model, which is why it "
                "is preferred"
            ),
            "delta_stance": (
                "direction from a CHANGE in probability. Needs an explicit above/below "
                "sense and refuses to guess it — a wrong guess inverts the signal "
                "undetectably"
            ),
        },
        "refusedPath": (
            "a probability LEVEL alone is not a directional view. Converting one would "
            "need an implied-volatility model of the underlying, which this system does "
            "not have; inventing one would produce a confident, precise, unfalsifiable "
            "number driving real position sizing"
        ),
        "thresholds": {
            "minPointsForDelta": pm.MIN_POINTS_FOR_DELTA,
            "minPointsForVolatility": pm.MIN_POINTS_FOR_VOLATILITY,
            "zscoreFullConfidence": pm.ZSCORE_FULL_CONFIDENCE,
            "volumeFullConfidenceUsd": pm.VOLUME_FULL_CONFIDENCE_USD,
            "eventProximityHorizonSeconds": pm.EVENT_PROXIMITY_HORIZON_SECONDS,
            "maxEventRiskConcern": registry.MAX_EVENT_RISK_CONCERN,
        },
    }


# ===========================================================================
# Mappings
# ===========================================================================

@router.get("/mappings")
async def mappings(
    # `Annotated[...] = <plain default>` rather than `= Query(...)`.
    #
    # The old form makes the DEFAULT a `Query` object, so the parameter only holds a
    # real value when FastAPI's dependency injection fills it in. Called directly —
    # by a test, or by any other Python caller — `symbol` was a `Query` instance,
    # which is not None, so the filter matched nothing and the endpoint silently
    # returned zero rows. The `series` endpoint had the same bug and it surfaced
    # louder there: `points[-limit:]` raised `TypeError: bad operand type for unary
    # -: 'Query'`.
    #
    # The annotated form keeps the alias while leaving the default a genuine value,
    # so the function is correct whether FastAPI calls it or a person does.
    symbol: Annotated[Optional[str], Query()] = None,
    confirmed_only: Annotated[bool, Query(alias="confirmedOnly")] = False,
) -> Dict[str, Any]:
    """Discovered symbol -> market mappings and their confirmation state."""
    rows = await store.get_mappings(symbol=symbol, confirmed_only=confirmed_only)
    return {
        "mappings": rows,
        "count": len(rows),
        "roles": list(registry.ROLES),
        "confirmationMeaning": (
            "discovery is automated; ATTRIBUTION is not. A keyword search cannot decide "
            "that 'Will ETH flip BTC?' is not a BTC-long signal, and the cost of being "
            "wrong is a real stance with a real confidence attributed to the wrong "
            "instrument. Only a human sets `confirmed`"
        ),
        "basisMeaning": (
            "`directionalBasis` names WHICH computation a directional mapping can feed. "
            "A mapping with no basis could not produce a signal at all, so such markets "
            "are classified unusable rather than stored as directional"
        ),
    }


class ConfirmRequest(BaseModel):
    symbol: str = Field(..., min_length=1)
    outcome: str = Field(..., min_length=1)
    confirmed: bool
    note: Optional[str] = None


@router.post("/mappings/confirm")
async def confirm(
    body: ConfirmRequest,
    _auth: None = Depends(require_write_auth),
) -> Dict[str, Any]:
    """Confirm or un-confirm one mapping. THE human gate.

    Auth-gated because it changes what the reasoning layer will treat as evidence.
    `set_by_human=True` is passed here and NOWHERE else in the codebase — that is
    what makes `confirm_mapping`'s refusal meaningful rather than decorative.

    Un-confirming needs no special handling: withdrawing trust must never be harder
    than granting it.
    """
    try:
        row = await store.confirm_mapping(
            body.symbol, body.outcome, body.confirmed,
            set_by_human=True, note=body.note,
        )
    except PermissionError as exc:  # pragma: no cover - set_by_human is passed above
        raise HTTPException(status_code=403, detail=str(exc)) from exc

    if row is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"no mapping {body.symbol} -> {body.outcome}. Run "
                f"POST /api/polymarket/discover/{body.symbol} first — a mapping has to "
                f"be discovered before it can be confirmed."
            ),
        )
    return {"mapping": row, "confirmedBy": "operator"}


@router.post("/discover/{symbol:path}")
async def discover(
    symbol: str,
    _auth: None = Depends(require_write_auth),
) -> Dict[str, Any]:
    """Search Polymarket for markets relevant to `symbol` and record candidates.

    Auth-gated because it costs API quota against a rate-limited public venue. It
    cannot trade and it cannot confirm: everything it writes is UNCONFIRMED, so this
    route by itself changes nothing the panel reads.
    """
    if not _enabled():
        raise HTTPException(
            status_code=409,
            detail=(
                "POLYMARKET_ENABLED is false. Discovery would write mappings that "
                "nothing reads, and enabling the feature later changes every "
                "confidence number — so it is an explicit decision, not a side effect "
                "of calling this route."
            ),
        )

    result = await registry.discover_for_symbol(symbol)
    return result.as_dict()


# ===========================================================================
# Snapshots and series
# ===========================================================================

@router.get("/snapshots")
async def snapshots() -> Dict[str, Any]:
    """The latest computed signal per symbol, WITH its age.

    Returns stale snapshots rather than hiding them, flagged `fresh: false`. The
    store's getter refuses a stale record because a CALLER would otherwise present it
    as current; a monitoring endpoint has the opposite job — an operator needs to see
    that the poller stopped, and an empty response cannot distinguish "stopped" from
    "never started".
    """
    from backend.workers.polymarket_worker import WATCH_SYMBOLS

    raw = store._read(store.SNAPSHOT_FILE, {})
    now = time.time()
    out: List[Dict[str, Any]] = []

    for symbol in WATCH_SYMBOLS:
        record = raw.get(symbol) if isinstance(raw, dict) else None
        if not isinstance(record, dict):
            out.append({
                "symbol": symbol,
                "present": False,
                "fresh": False,
                "reason": (
                    "no snapshot has ever been written for this symbol — the poller has "
                    "not run, or the feature is disabled"
                ),
            })
            continue

        computed_at = record.get("computedAt")
        age = (
            now - float(computed_at)
            if isinstance(computed_at, (int, float)) else None
        )
        out.append({
            **record,
            "present": True,
            "ageSeconds": age,
            "fresh": (
                age is not None and abs(age) <= store.MAX_SNAPSHOT_AGE_SECONDS
            ),
        })

    return {
        "snapshots": out,
        "watchSymbols": list(WATCH_SYMBOLS),
        "maxAgeSeconds": store.MAX_SNAPSHOT_AGE_SECONDS,
        "stalenessMeaning": (
            "a snapshot past maxAgeSeconds is NOT read by the specialists — it is shown "
            "here so a stopped poller is visible rather than silent. A stale "
            "probability weighted as a live reading is the failure this limit prevents"
        ),
        "applicableMeaning": (
            "`applicable: false` means no confirmed mapping exists for the symbol, "
            "which costs the panel nothing. `directional: null` with "
            "`applicable: true` means a mapping exists and the signal could not be "
            "computed, which DOES count against coverage"
        ),
    }


@router.get("/series")
async def series(
    outcome: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=2000)] = 200,
) -> Dict[str, Any]:
    """Stored probability history. Without `outcome`, a summary of every series."""
    if outcome is None:
        return await store.series_summary()

    points = await store.get_series(outcome)
    trimmed = points[-limit:]
    return {
        "outcome": outcome,
        "points": trimmed,
        "count": len(trimmed),
        "totalStored": len(points),
        "retentionSeconds": store.RETENTION_SECONDS,
        "emptyMeaning": (
            "an empty series means NO HISTORY, never 'the probability has not moved'. "
            "A caller inferring a zero change from it would report a measured "
            "non-event where nothing was measured"
        ),
    }
