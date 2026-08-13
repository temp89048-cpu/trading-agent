import httpx
import time
import logging
from typing import Dict, Any

logger = logging.getLogger(__name__)

_cache = {
    "timestamp": 0,
    "data": None
}

CACHE_TTL = 300 # 5 minutes

async def fetch_macro_data() -> Dict[str, Any]:
    """Fetches Fear & Greed, Funding Rate, and Open Interest.

    Every field starts as None and an `unavailable` list records what could not
    be fetched.

    WHY NOT DEFAULTS: this used to seed `{"fng": 50, "fng_classification":
    "Neutral", "funding_rate": 0.0}` and return that dict unchanged when the
    request failed. A network error was therefore indistinguishable from a
    genuinely neutral market — and 50/"Neutral"/0.0 are not arbitrary
    placeholders, they are exactly the values a real balanced reading produces.
    Any consumer reasoning over sentiment was being handed a fabricated neutral
    and had no way to know. CLAUDE.md invariant 6: if something isn't
    computable, return null and say so.
    """
    now = time.time()
    if _cache["data"] and (now - _cache["timestamp"]) < CACHE_TTL:
        return _cache["data"]

    data: Dict[str, Any] = {
        "fng": None,
        "fng_classification": None,
        "funding_rate": None,
        "oi": None,
        "unavailable": [],
    }

    try:
        async with httpx.AsyncClient() as client:
            # 1. Fear and Greed
            fng_resp = await client.get("https://api.alternative.me/fng/")
            if fng_resp.status_code == 200:
                fng_data = fng_resp.json()
                if "data" in fng_data and len(fng_data["data"]) > 0:
                    data["fng"] = int(fng_data["data"][0]["value"])
                    data["fng_classification"] = fng_data["data"][0]["value_classification"]
                    
            # 2. Funding Rate (Binance Futures BTCUSDT)
            fund_resp = await client.get("https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT")
            if fund_resp.status_code == 200:
                fund_data = fund_resp.json()
                data["funding_rate"] = float(fund_data.get("lastFundingRate", 0.0))
                
            # 3. Open Interest approximation (Just getting current to see if it's high/low)
            # True OI delta requires history, but we can fetch current OI.
            oi_resp = await client.get("https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT")
            if oi_resp.status_code == 200:
                oi_data = oi_resp.json()
                # For this free API without history, we just log it, but we can't easily tell trend 
                # without database storage. So we rely heavily on FNG and Funding.
                data["oi"] = float(oi_data.get("openInterest", 0))
                
        # Record what genuinely didn't arrive, so a consumer can scale its
        # conviction by coverage instead of trusting a full-looking payload.
        for key in ("fng", "funding_rate", "oi"):
            if data.get(key) is None:
                data["unavailable"].append(key)

        # Only cache a payload that actually contains something. Caching an
        # all-None result would keep serving the failure for CACHE_TTL even
        # after the network recovered.
        if len(data["unavailable"]) < 3:
            _cache["timestamp"] = now
            _cache["data"] = data
    except Exception as e:
        logger.error(f"Error fetching macro data: {e}")
        data["unavailable"] = ["fng", "funding_rate", "oi"]
        data["error"] = str(e)

    return data

async def get_current_sentiment() -> Dict[str, Any]:
    """
    Level 4: News Intelligence Agent
    Synthesizes macro metrics into a final sentiment score.
    """
    macro = await fetch_macro_data()
    
    reasons = []
    bullish_score = 0
    bearish_score = 0
    
    fng = macro["fng"]
    fng_class = macro["fng_classification"]
    funding = macro["funding_rate"]
    
    reasons.append(f"Fear & Greed at {fng} ({fng_class})")
    
    # Analyze Fear and Greed (Contrarian)
    if fng >= 75:
        # Extreme Greed is often a top signal (Bearish contrarian)
        bearish_score += 2
        reasons.append("Extreme Greed indicates potential market top")
    elif fng <= 25:
        # Extreme Fear is often a bottom signal (Bullish contrarian)
        bullish_score += 2
        reasons.append("Extreme Fear indicates potential market bottom")
    else:
        # Trend following in the middle
        if fng > 50:
            bullish_score += 1
        else:
            bearish_score += 1
            
    # Analyze Funding Rates
    # High positive funding means longs pay shorts (over-leveraged long -> bearish)
    # Negative funding means shorts pay longs (over-leveraged short -> bullish squeeze)
    reasons.append(f"Funding Rate: {funding:.5f}")
    
    if funding > 0.0005: # > 0.05% per 8h is very high
        bearish_score += 2
        reasons.append("High positive funding (Longs are over-leveraged)")
    elif funding < -0.0001: 
        bullish_score += 2
        reasons.append("Negative funding (Short squeeze incoming)")
    else:
        reasons.append("Funding rates are neutral")
        
    total_signals = bullish_score + bearish_score
    if total_signals == 0:
        return {
            "sentiment": "neutral",
            "confidence": 50,
            "reasons": reasons
        }
        
    if bullish_score > bearish_score:
        confidence = int((bullish_score / total_signals) * 100)
        sentiment = "bullish"
    elif bearish_score > bullish_score:
        confidence = int((bearish_score / total_signals) * 100)
        sentiment = "bearish"
    else:
        confidence = 50
        sentiment = "neutral"
        
    return {
        "sentiment": sentiment,
        "confidence": confidence,
        "reasons": reasons
    }
