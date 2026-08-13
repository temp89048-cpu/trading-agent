"""Exchange API (`/api/exchange`) — spec Section 8: *"Wraps Binance/Bybit/OKX/etc.
connectors behind one interface."*

This module was `router = APIRouter()` with no routes, mounted at
`/api/exchange`, so every documented endpoint 404'd.

READ-ONLY BY DESIGN — THIS IS NOT AN ORDER ENDPOINT
---------------------------------------------------
Spec Section 8: *"the Execution API is a hard chokepoint — no agent talks to an
exchange directly, ever. This is what makes the Risk/Compliance layer able to
actually enforce anything."*

So there is deliberately **no** order-placement route here, even though this is
"the exchange API" and putting one here would read as natural. An HTTP endpoint
that placed an order would be a path to the exchange that bypasses the
Supervisor, the CRO, and the leverage ceiling — reachable by anything that can
reach the port. Orders exist only as a consequence of an approved TAR flowing
through `agents/execution_agent.py`.

Balance and connection status ARE exposed, because knowing whether the venue is
reachable and what it holds is exactly what an operator needs when deciding
whether to intervene.
"""

import logging
from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Query

from backend.core.config import settings
from backend.services.exchange_client import get_exchange_client

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/status")
async def get_exchange_status() -> Dict[str, Any]:
    """Connection and mode. The first thing to check before anything else.

    Reports `credentialsConfigured` as a boolean and never echoes the key
    itself — spec Section 16 requires that credentials are protected, and an
    endpoint that returned even a masked key would still confirm its length
    and prefix.
    """
    client = get_exchange_client()
    return {
        "status": "success",
        "exchange": "binance",
        "market": "futures",
        # Both stated separately: testnet with live-trading enabled is a very
        # different situation from mainnet with it disabled, and collapsing
        # them into one "mode" string hides which is which.
        "useTestnet": settings.USE_TESTNET,
        "liveTradingEnabled": settings.LIVE_TRADING,
        "credentialsConfigured": client.has_credentials(),
        "ordersRoutedTo": (
            "simulation (no exchange orders)"
            if not settings.LIVE_TRADING
            else ("binance futures TESTNET" if settings.USE_TESTNET else "binance futures LIVE — REAL FUNDS")
        ),
        "note": (
            "This API is read-only. Orders cannot be placed through it — they exist only as a "
            "consequence of an approved TAR reaching the Execution Engine (spec Section 8)."
        ),
    }


@router.get("/balance")
async def get_balance() -> Dict[str, Any]:
    """Account balance from the exchange.

    Requires credentials; returns 503 rather than an empty balance when they
    are absent, because `{}` would be indistinguishable from a genuinely empty
    account.
    """
    client = get_exchange_client()
    if not client.has_credentials():
        raise HTTPException(
            status_code=503,
            detail=(
                "No exchange credentials configured (BINANCE_API_KEY / BINANCE_SECRET are "
                "empty), so balance cannot be read. This is not an empty account — it is an "
                "unauthenticated client."
            ),
        )

    balance = await client.fetch_balance()
    if balance is None:
        raise HTTPException(
            status_code=502,
            detail="The exchange did not return a balance. See server logs for the underlying error.",
        )

    # Only the non-zero holdings plus totals. The raw ccxt payload includes an
    # entry for every asset the venue lists, which buries the few that matter.
    totals = {k: v for k, v in (balance.get("total") or {}).items() if v}
    free = {k: v for k, v in (balance.get("free") or {}).items() if v}
    return {
        "status": "success",
        "total": totals,
        "free": free,
        "testnet": settings.USE_TESTNET,
    }


@router.get("/tickers")
async def get_tickers(limit: int = Query(50, ge=1, le=500)) -> Dict[str, Any]:
    """USDT-quoted tickers from the exchange."""
    client = get_exchange_client()
    tickers = await client.fetch_tickers()
    if not tickers:
        raise HTTPException(
            status_code=502,
            detail="The exchange returned no tickers. The venue may be unreachable.",
        )

    rows = [
        {"symbol": symbol, "last": data.get("last"), "quoteVolume": data.get("quoteVolume")}
        for symbol, data in tickers.items()
        if symbol.endswith("/USDT") and data.get("last")
    ]
    # Sorted by volume so the truncation keeps the liquid markets rather than
    # an arbitrary alphabetical slice.
    rows.sort(key=lambda r: r.get("quoteVolume") or 0, reverse=True)
    return {
        "status": "success",
        "count": len(rows),
        "returned": min(limit, len(rows)),
        "tickers": rows[:limit],
    }


@router.get("/compare/{symbol:path}")
async def compare_across_exchanges(symbol: str) -> Dict[str, Any]:
    """Same symbol priced across several venues.

    Uses `agents/exchange_agent.scan_global_exchanges`, which queries Binance,
    Bybit, Coinbase and Kraken. Useful for spotting a stale or dislocated feed
    before trusting a price — a venue disagreeing with the others by more than
    the spread is usually a data problem, not an arbitrage.
    """
    from backend.agents.exchange_agent import scan_global_exchanges

    result = await scan_global_exchanges(symbol)
    return {"status": "success", "symbol": symbol, **result}
