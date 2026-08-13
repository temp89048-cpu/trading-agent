"""Market API (`/api/market`) — spec Section 8: *"Serves normalized market data
to all agents."*

This module was `router = APIRouter()` and nothing else — no routes at all —
yet `main.py` mounted it at `/api/market`. Every documented market endpoint
returned 404 while the prefix appeared in the OpenAPI schema, so the API looked
present and answered nothing.

NORMALIZATION IS THE POINT
--------------------------
"Normalized" is the operative word in the spec. `services/market_data` returns
klines as dicts keyed `openTime/open/high/low/close/volume`, and prices come
from two places (a websocket cache and a polled HTTP cache) with different
freshness. These routes expose one shape and state which source answered, so a
caller can tell a live tick from a stale poll rather than treating both as
"the price".

MISSING DATA IS REPORTED, NOT SUBSTITUTED
-----------------------------------------
`get_price` returns 0.0 for an unknown symbol. Passing that through as a price
would let a caller compute a position size against zero. Every route below
converts it to an explicit null plus an `available: false` flag.
"""

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query

from backend.services.live_market_data import get_live_price
from backend.services.market_data import fetch_klines, fetch_prices, get_price

logger = logging.getLogger(__name__)

router = APIRouter()

VALID_TIMEFRAMES = ("1m", "5m", "15m", "30m", "1h", "4h", "1d")


@router.get("/price/{symbol:path}")
async def get_symbol_price(symbol: str) -> Dict[str, Any]:
    """Current price for one symbol, with its provenance.

    `symbol:path` because symbols contain a slash (BTC/USDT) which would
    otherwise be parsed as a path separator and never match.
    """
    live = get_live_price(symbol)
    if live > 0:
        return {
            "status": "success",
            "symbol": symbol,
            "price": live,
            "available": True,
            # Named so a caller can distinguish a websocket tick from a poll
            # that may be up to a fetch-interval old.
            "source": "websocket",
        }

    polled = get_price(symbol)
    if polled > 0:
        return {
            "status": "success",
            "symbol": symbol,
            "price": polled,
            "available": True,
            "source": "polled-http-cache",
        }

    # 404 rather than a 200 with price 0.0. Zero is a value a caller could
    # divide by or size against; "we don't have it" is not.
    raise HTTPException(
        status_code=404,
        detail=(
            f"No price available for {symbol}. It is not in the live websocket feed and not "
            f"in the polled cache — the symbol may be unwatched or the feed may be down."
        ),
    )


@router.get("/prices")
async def get_all_prices(refresh: bool = Query(False, description="Force a fetch before returning")) -> Dict[str, Any]:
    """Every cached price. `refresh=true` polls the exchange first."""
    if refresh:
        await fetch_prices()

    from backend.services.market_data import _prices

    # A copy: handing out the module's live dict would let a caller mutate the
    # price cache every agent reads from.
    prices = dict(_prices)
    return {
        "status": "success",
        "count": len(prices),
        "prices": prices,
        # Distinguishes "the feed returned nothing" from "no symbols watched".
        "note": None if prices else "Price cache is empty — the market data feed may not have started.",
    }


@router.get("/klines/{symbol:path}")
async def get_klines(
    symbol: str,
    timeframe: str = Query("15m", description="Candle interval"),
    limit: int = Query(100, ge=1, le=1000),
) -> Dict[str, Any]:
    """Normalized OHLCV candles.

    Returns an empty list with `count: 0` rather than a 404 when the exchange
    has no data: an unknown symbol and a symbol with no history are different
    situations, and the caller can tell them apart from `count`.
    """
    if timeframe not in VALID_TIMEFRAMES:
        raise HTTPException(
            status_code=422,
            detail=f"timeframe must be one of {VALID_TIMEFRAMES}, got {timeframe!r}",
        )

    klines = await fetch_klines(symbol, timeframe, limit=limit)
    return {
        "status": "success",
        "symbol": symbol,
        "timeframe": timeframe,
        "count": len(klines),
        "klines": klines,
        # Stated because several downstream checks (ATR, and therefore the
        # mandatory stop-loss) need at least 15 candles and silently degrade
        # without them.
        "sufficientForAtr": len(klines) >= 15,
    }


@router.get("/regime/{symbol:path}")
async def get_regime(symbol: str, timeframe: str = Query("15m")) -> Dict[str, Any]:
    """Current market regime classification for a symbol."""
    from backend.agents.regime_agent import detect_market_regime

    klines = await fetch_klines(symbol, timeframe, limit=100)
    regime = detect_market_regime(klines)
    return {
        "status": "success",
        "symbol": symbol,
        "timeframe": timeframe,
        "regime": regime,
        "candlesUsed": len(klines),
        # 'Unknown' is a real answer from the classifier, not an error — it
        # means there wasn't enough history to classify. Flagged so a caller
        # doesn't treat it as a regime name.
        "classified": regime != "Unknown",
    }


@router.get("/analysis/{symbol:path}")
async def get_analysis(symbol: str) -> Dict[str, Any]:
    """Multi-timeframe structure analysis — what the Market Intelligence agent
    publishes as FEATURES_COMPUTED, exposed for inspection."""
    from backend.agents.market_intelligence import run_multi_timeframe_analysis

    features = await run_multi_timeframe_analysis(symbol)
    return {"status": "success", "symbol": symbol, "features": features}
